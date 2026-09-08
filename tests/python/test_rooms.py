#!/usr/bin/env python3
"""Room contract tests: .venv/bin/python tests/python/test_rooms.py (no ML models/server needed)."""
from __future__ import annotations

import copy
import json
import shutil
import sys
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend import rooms


class Songs:
    def __init__(self, root):
        self.root = root
        self.values = {}
        for name in ("song-a", "song-b", "song-c"):
            directory = self.job_dir(name) / "stems"
            directory.mkdir(parents=True)
            (directory / "instrumental.mp3").write_bytes(b"test-audio")
            (directory / "vocals.mp3").write_bytes(b"test-audio")
            (self.job_dir(name) / "lyrics.json").write_text('{"lines":[]}')
            self.values[name] = {
                "id": name, "state": "done", "title": name, "duration": 180,
                "stems": {"instrumental": "instrumental.mp3", "vocals": "vocals.mp3"},
                "lyrics_file": "lyrics.json",
            }

    def get(self, name):
        return copy.deepcopy(self.values.get(name))

    def job_dir(self, name):
        return self.root / str(name)


class RoomTests(unittest.TestCase):
    def setUp(self):
        self.root = PROJECT_ROOT / (".room-test-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.songs = Songs(self.root / "jobs")
        self.now = [100000.0]
        self.store = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        self.created = self.store.create()
        self.room = self.created["room_id"]
        self.host = self.created["host_token"]
        self.code = self.created["pairing_code"]
        self.phone = self.store.join(self.room, self.code)["controller_token"]

    def tearDown(self):
        shutil.rmtree(self.root)

    def command(self, action, token=None, **kwargs):
        return self.store.command(self.room, token or self.phone,
                                  {"action": action, "command_id": uuid.uuid4().hex, **kwargs})

    def state(self):
        return self.store.state(self.room, self.phone)

    def fails(self, code, function, *args, **kwargs):
        with self.assertRaises(HTTPException) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.status_code, code)

    def test_pairing_and_private_state(self):
        self.assertEqual(len(self.code), 6)
        self.fails(403, self.store.join, self.room, "000000" if self.code != "000000" else "000001")
        self.fails(403, self.store.state, self.room, "not-the-token")
        self.fails(403, self.store.claim, self.room, self.phone)
        public = json.dumps(self.state())
        disk = self.store.path.read_text()
        for secret in (self.host, self.phone, self.code):
            self.assertNotIn(secret, public)
            self.assertNotIn(secret, disk)
        self.assertNotIn("host", public)
        self.assertNotIn("controllers", public)

    def test_duplicate_song_ids_and_command_deduplication(self):
        command = {"action": "add", "job_id": "song-a", "command_id": "unique-command"}
        first = self.store.command(self.room, self.phone, command)
        duplicate = self.store.command(self.room, self.phone, command)
        self.assertEqual(first, duplicate)
        state = self.command("add", job_id="song-a")
        self.assertEqual(state["current"]["job_id"], state["queue"][0]["job_id"])
        self.assertNotEqual(state["current"]["id"], state["queue"][0]["id"])
        self.fails(409, self.store.command, self.room, self.phone,
                   {**command, "job_id": "song-b"})

    def test_concurrent_phones_do_not_lose_additions(self):
        second = self.store.join(self.room, self.code)["controller_token"]
        barrier = threading.Barrier(8)

        def add(index):
            barrier.wait()
            return self.command("add", token=self.phone if index % 2 else second, job_id="song-a")

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(add, range(8)))
        state = self.state()
        items = [state["current"], *state["queue"]]
        self.assertEqual(len(items), 8)
        self.assertEqual(len({item["id"] for item in items}), 8)

    def test_queue_operations_and_stale_revision(self):
        self.command("add", job_id="song-a")
        self.command("add", job_id="song-b")
        state = self.command("add", job_id="song-c")
        stale = state["revision"]
        b, c = state["queue"]
        state = self.command("top", item_id=c["id"])
        self.assertEqual(state["queue"][0]["id"], c["id"])
        self.fails(409, self.command, "clear", expected_revision=stale)
        state = self.command("remove", item_id=b["id"])
        self.assertEqual([item["id"] for item in state["queue"]], [c["id"]])
        self.fails(409, self.command, "remove", item_id=state["current"]["id"])
        state = self.command("clear", expected_revision=state["revision"])
        self.assertEqual(state["queue"], [])
        self.assertIsNotNone(state["current"])

    def test_player_lease_takeover_and_heartbeat(self):
        state = self.command("add", job_id="song-a")
        claim = self.store.claim(self.room, self.host)
        player = claim["player_token"]
        self.fails(409, self.store.claim, self.room, self.host)
        self.command("play")
        report = {"current_id": state["current"]["id"], "generation": state["playback"]["seek_version"],
                  "position": 37.5, "status": "playing"}
        previous_bytes = self.store.path.read_bytes()
        for _ in range(3):
            self.now[0] += 2
            self.store.heartbeat(self.room, self.host, player, report)
        self.assertEqual(self.store.path.read_bytes(), previous_bytes)
        self.assertEqual(self.state()["player"]["position"], 37.5)
        self.fails(403, self.store.heartbeat, self.room, self.phone, player, report)
        self.fails(409, self.store.heartbeat, self.room, self.host, "wrong", report)
        self.now[0] += 13
        expired = self.state()
        self.assertFalse(expired["player"]["online"])
        self.assertFalse(expired["playback"]["playing"])
        self.assertEqual(expired["playback"]["position"], 37.5)
        replacement = self.store.claim(self.room, self.host)
        self.assertNotEqual(player, replacement["player_token"])
        self.fails(409, self.store.heartbeat, self.room, self.host, player, report)

    def test_end_is_idempotent_and_restart_fences_old_reports(self):
        self.command("add", job_id="song-a")
        self.command("add", job_id="song-a")
        state = self.command("add", job_id="song-b")
        player = self.store.claim(self.room, self.host)["player_token"]
        report = {"command_id": "ended-one", "item_id": state["current"]["id"],
                  "generation": state["playback"]["seek_version"]}
        self.fails(403, self.store.ended, self.room, self.phone, player, report)
        next_state = self.store.ended(self.room, self.host, player, report)
        duplicate = self.store.ended(self.room, self.host, player, report)
        self.assertEqual(next_state, duplicate)
        self.assertEqual(next_state["current"]["job_id"], "song-a")
        self.assertEqual(len(next_state["queue"]), 1)
        different_id = self.store.ended(self.room, self.host, player,
                                       {**report, "command_id": "ended-two"})
        self.assertEqual(different_id["current"]["id"], next_state["current"]["id"])
        stale = {"command_id": "before-restart", "item_id": next_state["current"]["id"],
                 "generation": next_state["playback"]["seek_version"]}
        restarted = self.command("restart", item_id=next_state["current"]["id"])
        self.store.ended(self.room, self.host, player, stale)
        self.assertEqual(self.state()["current"], restarted["current"])

    def test_play_pause_guide_seek_and_stale_next(self):
        state = self.command("add", job_id="song-a")
        current = state["current"]["id"]
        self.assertTrue(self.command("play")["playback"]["playing"])
        self.assertFalse(self.command("pause")["playback"]["playing"])
        self.assertTrue(self.command("guide", enabled=True)["playback"]["guide"])
        self.assertEqual(self.command("seek", item_id=current, position=45)["playback"]["position"], 45)
        self.fails(422, self.command, "seek", item_id=current, position=float("nan"))
        self.command("next", item_id=current)
        self.fails(409, self.command, "next", item_id=current)

    def test_restore_preserves_queue_capabilities_and_expires_lease(self):
        self.command("add", job_id="song-a")
        state = self.command("add", job_id="song-b")
        self.store.claim(self.room, self.host)
        self.command("seek", item_id=state["current"]["id"], position=12)
        self.command("play")
        before = self.state()
        restored = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        after = restored.state(self.room, self.phone)
        self.assertEqual(after["queue"], before["queue"])
        self.assertEqual(after["current"], before["current"])
        self.assertFalse(after["playback"]["playing"])
        self.assertFalse(after["player"]["online"])
        self.assertEqual(after["playback"]["position"], 12)
        self.assertGreater(after["playback"]["seek_version"], before["playback"]["seek_version"])
        restored.claim(self.room, self.host)

    def test_meaningful_mutation_checkpoints_observed_position(self):
        state = self.command("add", job_id="song-a")
        player = self.store.claim(self.room, self.host)["player_token"]
        self.command("play")
        self.store.heartbeat(self.room, self.host, player, {
            "current_id": state["current"]["id"], "generation": state["playback"]["seek_version"],
            "position": 47, "status": "playing",
        })
        paused = self.command("pause")
        self.assertEqual(paused["playback"]["position"], 47)
        restored = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        self.assertEqual(restored.state(self.room, self.phone)["playback"]["position"], 47)

    def test_invalid_jobs_and_invalidation(self):
        self.fails(422, self.command, "add", job_id="missing")
        self.songs.values["song-b"]["state"] = "running"
        self.fails(422, self.command, "add", job_id="song-b")
        self.command("add", job_id="song-a")
        self.command("add", job_id="song-c")
        (self.songs.job_dir("song-a") / "stems/instrumental.mp3").unlink()
        state = self.state()
        self.assertEqual(state["current"]["job_id"], "song-c")
        self.fails(422, self.command, "add", job_id="song-a")
        self.songs.values["song-c"]["state"] = "error"
        self.assertIsNone(self.state()["current"])

    def test_media_paths_cannot_escape_job(self):
        self.songs.values["song-a"]["stems"]["instrumental"] = "../../song-b/stems/instrumental.mp3"
        self.fails(422, self.command, "add", job_id="song-a")

    def test_nested_fenced_worker_artifacts_are_playable(self):
        directory = self.songs.job_dir("song-a")
        nested = directory / "stems/.openk-results/fenced-result"
        nested.mkdir(parents=True)
        for name in ("instrumental", "vocals"):
            (directory / f"stems/{name}.mp3").replace(nested / f"{name}.mp3")
            self.songs.values["song-a"]["stems"][name] = f".openk-results/fenced-result/{name}.mp3"
        lyrics = directory / ".openk-results/fenced-align"
        lyrics.mkdir(parents=True)
        (directory / "lyrics.json").replace(lyrics / "lyrics.json")
        self.songs.values["song-a"]["lyrics_file"] = ".openk-results/fenced-align/lyrics.json"
        current = self.command("add", job_id="song-a")["current"]
        self.assertEqual(current["media"]["instrumental"],
                         "/media/song-a/stems/.openk-results/fenced-result/instrumental.mp3")
        self.assertEqual(current["media"]["lyrics"],
                         "/media/song-a/.openk-results/fenced-align/lyrics.json")

    def test_bounded_rooms_queue_pairing_and_expiry(self):
        self.store.MAX_ROOMS = 1
        self.fails(429, self.store.create)
        self.store.MAX_QUEUE = 1
        self.command("add", job_id="song-a")
        self.command("add", job_id="song-b")
        self.fails(422, self.command, "add", job_id="song-c")
        for _ in range(7):
            self.fails(403, self.store.join, self.room, "bad")
        self.fails(429, self.store.join, self.room, self.code)
        self.now[0] += self.store.IDLE_SECONDS + 1
        self.fails(404, self.store.state, self.room, self.host)
        self.assertEqual(self.store.rooms, {})
        self.assertIsNotNone(self.store.create())

    def test_failed_disk_write_rolls_back_command(self):
        self.command("add", job_id="song-a")
        before = self.state()
        disk = self.store.path.read_bytes()
        with patch.object(Path, "replace", side_effect=OSError("NAS read only")):
            self.fails(503, self.command, "add", job_id="song-b")
        self.assertEqual(self.state(), before)
        self.assertEqual(self.store.path.read_bytes(), disk)
        self.assertFalse(self.store.path.with_suffix(".json.new").exists())

    def test_fastapi_contract_validation_and_no_query_tokens(self):
        app = FastAPI()
        app.include_router(rooms.router)
        with patch.object(rooms, "store", self.store), TestClient(app) as client:
            base = "/api/rooms/" + self.room
            headers = {"Authorization": "Bearer " + self.phone}
            self.assertEqual(client.get(base).status_code, 401)
            self.assertEqual(client.get(base + "?token=" + self.phone).status_code, 401)
            result = client.get(base, headers=headers)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers["cache-control"], "no-store")
            unchanged = client.get(base + "?after=" + str(result.json()["revision"]), headers=headers)
            self.assertTrue(unchanged.json()["unchanged"])
            self.assertNotIn("queue", unchanged.json())
            result = client.post(base + "/commands", headers=headers, json={
                "action": "add", "job_id": "song-a", "command_id": "api-add-command",
            })
            self.assertEqual(result.status_code, 200)
            self.assertEqual(client.post(base + "/commands", headers=headers,
                                        json={"action": "unknown", "command_id": "long-enough"}).status_code, 422)
            self.assertEqual(client.post(base + "/player/claim", headers=headers).status_code, 403)
            host_headers = {"Authorization": "Bearer " + self.host}
            claimed = client.post(base + "/player/claim", headers=host_headers)
            self.assertEqual(claimed.status_code, 200)
            current = claimed.json()["state"]
            heartbeat = client.post(base + "/player/heartbeat", headers={
                **host_headers, "X-Player-Token": claimed.json()["player_token"],
            }, json={"current_id": current["current"]["id"], "generation": current["playback"]["seek_version"],
                     "position": 5, "status": "playing"})
            self.assertEqual(heartbeat.status_code, 200)


def serve_frontend_fixture(port):
    """A real HTTP API for the jsdom phone → server → TV contract test."""
    import uvicorn
    from fastapi.staticfiles import StaticFiles

    root = PROJECT_ROOT / (".room-js-test-" + uuid.uuid4().hex)
    root.mkdir()
    try:
        songs = Songs(root / "jobs")
        songs.values["song-a"].update(title="周杰倫 - 稻香", track="稻香", artist="周杰倫")
        songs.values["song-b"].update(title="Beyond - 海闊天空", track="海闊天空", artist="Beyond")
        songs.values["song-c"].update(state="running")
        (songs.job_dir("song-a") / "lyrics.json").write_text(json.dumps({"lines": [
            {"start": 4, "end": 8, "text": "一起唱歌", "words": [
                {"text": "一起", "start": 4, "end": 6},
                {"text": "唱歌", "start": 6, "end": 8},
            ]},
            {"start": 15, "end": 18, "text": "下一行"},
        ]}))
        rooms.store = rooms.RoomStore(root, songs)

        @asynccontextmanager
        async def lifespan(_app):
            yield
            # Uvicorn may re-raise SIGTERM after shutdown, before outer finally.
            shutil.rmtree(root, ignore_errors=True)

        app = FastAPI(lifespan=lifespan)
        app.include_router(rooms.router)

        @app.get("/api/jobs")
        def jobs():
            return [{**job, "media": {"instrumental": f"/media/{job['id']}/stems/instrumental.mp3",
                                     "vocals": f"/media/{job['id']}/stems/vocals.mp3",
                                     "lyrics": f"/media/{job['id']}/lyrics.json"}}
                    for job in songs.values.values()]

        @app.get("/api/zh-map")
        def mapping():
            return {"倫": "伦", "闊": "阔"}

        @app.get("/health")
        def health():
            return {"ok": True}

        app.mount("/media", StaticFiles(directory=songs.root))
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="error")
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--serve":
        serve_frontend_fixture(int(sys.argv[2]))
    else:
        unittest.main(verbosity=2)
