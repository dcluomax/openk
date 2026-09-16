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

from backend import identity, rooms


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
        for private in ("host", "pair", "controllers", "screens", "commands"):
            self.assertNotIn(private, self.state())
        self.assertNotIn(self.store.rooms[self.room]["host"], public)

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

    def test_lyric_revision_reconciles_without_changing_playback_identity(self):
        current = self.command("add", job_id="song-a")["current"]
        before = self.command("seek", item_id=current["id"], position=37)
        relative = ".openk-results/new-lyrics/lyrics.json"
        destination = self.songs.job_dir("song-a") / relative
        destination.parent.mkdir(parents=True)
        destination.write_text('{"lines":[]}', encoding="utf-8")
        self.songs.values["song-a"]["lyrics_file"] = relative
        after = self.store.state(self.room, self.phone, before["revision"])
        self.assertNotIn("unchanged", after)
        self.assertGreater(after["revision"], before["revision"])
        self.assertEqual(after["current"]["id"], before["current"]["id"])
        self.assertEqual(after["current"]["media"]["lyrics"], f"/media/song-a/{relative}")
        self.assertEqual(after["playback"], before["playback"])
        self.assertEqual(after["current"]["media"]["instrumental"], before["current"]["media"]["instrumental"])

    def test_bounded_rooms_queue_pairing_and_expiry(self):
        self.store.MAX_ROOMS = 1
        self.fails(429, self.store.create)
        self.store.MAX_QUEUE = 1
        self.command("add", job_id="song-a")
        self.command("add", job_id="song-b")
        self.fails(422, self.command, "add", job_id="song-c")
        for _ in range(8):
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

    def test_directory_is_explicit_and_does_not_expose_pairing_or_private_state(self):
        self.assertEqual(self.store.directory(), [])
        second = self.store.create(name="Friday karaoke", display_name="Private nickname",
                                   discoverable=True, allow_screens=True)
        token = self.store.join(second["room_id"], second["pairing_code"],
                                display_name="Private singer")["controller_token"]
        self.store.command(second["room_id"], token, {
            "action": "add", "job_id": "song-a", "command_id": "directory-song",
        })
        with patch.object(self.songs, "get", side_effect=AssertionError("directory must not scan media")):
            listing = self.store.directory()
        self.assertEqual([room["id"] for room in listing], [second["room_id"]])
        summary = listing[0]
        self.assertEqual(summary["name"], "Friday karaoke")
        self.assertEqual(summary["members_online"], 2)
        self.assertTrue(summary["allow_screens"])
        self.assertEqual(summary["current"], {"title": "song-a", "artist": ""})
        serialized = json.dumps(listing)
        for value in (second["host_token"], token, "Private nickname", "Private singer", "/media/"):
            self.assertNotIn(value, serialized)
        for private in ("queue", "members", "pairing_code", "host", "controllers", "screens"):
            self.assertNotIn(private, summary)
        self.assertNotIn(self.store.rooms[second["room_id"]]["pair"], serialized)

    def test_roster_presence_updates_without_revisions_or_disk_writes(self):
        self.store.update(self.room, self.host, {"discoverable": True})
        before = self.state()
        disk = self.store.path.read_bytes()
        self.now[0] += self.store.MEMBER_SECONDS + 1
        listing = self.store.directory()
        self.assertEqual(listing[0]["members_online"], 0)
        state = self.store.state(self.room, self.phone, before["revision"])
        self.assertTrue(state["unchanged"])
        self.assertEqual(state["revision"], before["revision"])
        self.assertTrue(state["viewer"]["online"])
        self.assertEqual(sum(member["online"] for member in state["members"]), 1)
        self.assertEqual(self.store.path.read_bytes(), disk)
        self.assertEqual(self.store.directory()[0]["members_online"], 1)

    def test_directory_polling_does_not_extend_room_lifetime(self):
        self.store.update(self.room, self.host, {"discoverable": True})
        for _ in range(3):
            self.now[0] += self.store.IDLE_SECONDS / 3
            self.assertEqual(len(self.store.directory()), 1)
        self.now[0] += 1
        self.assertEqual(self.store.directory(), [])

    def test_old_room_snapshots_remain_private_and_keep_stable_member_ids(self):
        current = self.command("add", job_id="song-a")["current"]
        identity = self.state()["viewer"]["id"]
        payload = json.loads(self.store.path.read_text())
        for room in payload["rooms"]:
            for key in ("name", "discoverable", "allow_screens", "members", "screens"):
                room.pop(key, None)
        self.store.path.write_text(json.dumps(payload))
        restored = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        state = restored.state(self.room, self.phone)
        self.assertFalse(state["discoverable"])
        self.assertFalse(state["allow_screens"])
        self.assertEqual(state["viewer"]["id"], identity)
        self.assertEqual(state["current"], current)
        self.assertEqual(restored.directory(), [])

    def test_correct_party_joins_do_not_consume_the_failed_code_budget(self):
        for index in range(20):
            joined = self.store.join(self.room, self.code, display_name=f"Singer {index}")
            self.assertEqual(joined["state"]["viewer"]["name"], f"Singer {index}")
        self.assertEqual(self.store.attempts[self.room], [])
        self.assertEqual(len(self.state()["members"]), 22)
        for _ in range(8):
            self.fails(403, self.store.join, self.room, "wrong")
        self.fails(429, self.store.join, self.room, self.code)
        self.now[0] += 61
        self.assertIn("controller_token", self.store.join(self.room, self.code))

    def test_rooms_and_member_pseudonyms_do_not_grant_cross_room_access(self):
        other = self.store.create(name="Other party", discoverable=True)
        before = self.store.state(other["room_id"], other["host_token"])
        self.fails(403, self.store.state, other["room_id"], self.phone)
        self.fails(403, self.store.command, other["room_id"], self.phone, {
            "action": "add", "job_id": "song-a", "command_id": "wrong-room",
        })
        self.fails(403, self.store.state, self.room, self.state()["viewer"]["id"])
        self.assertEqual(self.store.state(other["room_id"], other["host_token"]), before)

    def test_singers_and_requester_survive_catalog_refresh_and_restart(self):
        self.store.update_member(self.room, self.phone, "Alice")
        second = self.store.join(self.room, self.code, display_name="Bob")["controller_token"]
        state = self.command("add", job_id="song-a")
        item_id = state["current"]["id"]
        state = self.command("sing", token=second, item_id=item_id)
        self.assertEqual(state["current"]["requested_by"]["name"], "Alice")
        self.assertEqual([person["name"] for person in state["current"]["singers"]], ["Alice", "Bob"])
        self.command("sing", token=second, item_id=item_id)
        self.assertEqual(len(self.state()["current"]["singers"]), 2)
        self.songs.values["song-a"]["track"] = "Updated song"
        changed = self.state()
        self.assertEqual(changed["current"]["title"], "Updated song")
        self.assertEqual(len(changed["current"]["singers"]), 2)
        renamed = self.store.update_member(self.room, second, "Bobby")
        self.assertEqual(renamed["current"]["singers"][1]["name"], "Bobby")
        restored = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        self.assertEqual(restored.state(self.room, second)["current"], renamed["current"])
        state = self.command("unsing", token=second, item_id=item_id)
        self.assertEqual([person["name"] for person in state["current"]["singers"]], ["Alice"])
        self.fails(409, self.command, "sing", item_id="already-ended")

    def test_member_specific_commands_are_idempotent_and_actor_bound(self):
        second = self.store.join(self.room, self.code)["controller_token"]
        item_id = self.command("add", job_id="song-a")["current"]["id"]
        command = {"action": "sing", "item_id": item_id, "command_id": "one-singer-command"}
        first = self.store.command(self.room, self.phone, command)
        self.assertEqual(first, self.store.command(self.room, self.phone, command))
        self.fails(409, self.store.command, self.room, second, command)
        add = {"action": "add", "job_id": "song-b", "command_id": "one-requester-command"}
        self.store.command(self.room, self.phone, add)
        self.fails(409, self.store.command, self.room, second, add)

    def test_legacy_add_retries_are_not_reapplied_after_upgrade(self):
        command = {"action": "add", "job_id": "song-a", "command_id": "legacy-add-command"}
        self.store.command(self.room, self.phone, command)
        self.store.rooms[self.room]["commands"][-1][1] = json.dumps(
            {"action": "add", "job_id": "song-a"}, sort_keys=True)
        self.store._save()
        state = self.store.command(self.room, self.phone, command)
        self.assertEqual(state["queue"], [])
        self.assertEqual(state["current"]["job_id"], "song-a")

    def test_explicit_screen_pairing_never_grants_host_or_queue_permissions(self):
        self.fails(403, self.store.join, self.room, self.code, role="screen")
        self.store.update(self.room, self.host, {"allow_screens": True})
        joined = self.store.join(self.room, self.code, display_name="Living room TV", role="screen")
        screen = joined["screen_token"]
        self.assertNotIn("host_token", joined)
        self.assertEqual(joined["state"]["viewer"]["role"], "screen")
        self.fails(403, self.store.update, self.room, screen, {"discoverable": True})
        self.fails(403, self.store.close, self.room, screen)
        self.fails(403, self.command, "add", token=screen, job_id="song-a")
        current = self.command("add", job_id="song-a")["current"]
        player = self.store.claim(self.room, screen)["player_token"]
        self.fails(409, self.store.claim, self.room, self.host)
        self.command("play", token=screen)
        report = {"current_id": current["id"], "generation": self.state()["playback"]["seek_version"],
                  "position": 18, "status": "playing"}
        self.store.heartbeat(self.room, screen, player, report)
        self.fails(409, self.store.heartbeat, self.room, self.host, player, report)
        released = self.store.release(self.room, screen, player)
        self.assertFalse(released["player"]["online"])
        self.assertFalse(released["playback"]["playing"])
        self.assertEqual(released["playback"]["position"], 18)
        self.fails(409, self.store.heartbeat, self.room, screen, player, report)
        self.store.claim(self.room, self.host)

    def test_disabling_screen_pairing_revokes_old_screen_capabilities_and_playback(self):
        self.store.update(self.room, self.host, {"allow_screens": True})
        screen = self.store.join(self.room, self.code, role="screen")["screen_token"]
        self.store.claim(self.room, screen)
        self.command("play")
        state = self.store.update(self.room, self.host, {"allow_screens": False})
        self.assertFalse(state["player"]["online"])
        self.assertFalse(state["playback"]["playing"])
        self.assertFalse(any(member["role"] == "screen" for member in state["members"]))
        self.fails(403, self.store.state, self.room, screen)
        self.fails(403, self.store.claim, self.room, screen)

    def test_leaving_revokes_membership_without_deleting_the_shared_queue(self):
        item_id = self.command("add", job_id="song-a")["current"]["id"]
        self.assertTrue(self.store.leave(self.room, self.phone)["left"])
        self.fails(403, self.store.state, self.room, self.phone)
        state = self.store.state(self.room, self.host)
        self.assertEqual(state["current"]["id"], item_id)
        self.assertEqual(state["current"]["singers"], [])
        self.assertEqual(len(state["members"]), 1)
        self.store.claim(self.room, self.host)
        self.store.leave(self.room, self.host)
        resumed = self.store.state(self.room, self.host)
        self.assertFalse(resumed["player"]["online"])
        self.assertEqual(resumed["current"]["id"], item_id)

    def test_only_the_host_can_close_and_every_capability_is_revoked(self):
        self.store.update(self.room, self.host, {"discoverable": True, "allow_screens": True})
        screen = self.store.join(self.room, self.code, role="screen")["screen_token"]
        self.fails(403, self.store.close, self.room, self.phone)
        self.assertTrue(self.store.close(self.room, self.host)["closed"])
        for token in (self.host, self.phone, screen):
            self.fails(404, self.store.state, self.room, token)
        self.assertEqual(self.store.directory(), [])
        self.assertEqual(rooms.RoomStore(self.root, self.songs, lambda: self.now[0]).rooms, {})

    def test_room_and_member_updates_validate_labels_and_roll_back_on_disk_failure(self):
        self.fails(403, self.store.update, self.room, self.phone, {"name": "Other name"})
        for name in ("", " \t ", "x" * 61, "bad\nname"):
            self.fails(422, self.store.update, self.room, self.host, {"name": name})
        self.fails(422, self.store.update, self.room, self.host, {"discoverable": None})
        self.fails(422, self.store.update, self.room, self.host, {})
        self.fails(422, self.store.update_member, self.room, self.phone, "x" * 41)
        state = self.store.update(self.room, self.host, {"name": "  Friends  ", "discoverable": True})
        self.assertEqual(state["name"], "Friends")
        before = self.state()
        with patch.object(Path, "replace", side_effect=OSError("NAS read only")):
            self.fails(503, self.store.leave, self.room, self.phone)
        self.assertEqual(self.state(), before)
        with patch.object(Path, "replace", side_effect=OSError("NAS read only")):
            self.fails(503, self.store.close, self.room, self.host)
        self.assertEqual(self.state(), before)

    def presence(self, token=None, after=None, **body):
        payload = {"client_id": uuid.uuid4().hex, "device_id": None,
                   "label": "手机", "roles": ["controller"], **body}
        return self.store.presence(self.room, token or self.phone, payload, after)

    # --- automatic playback of a queued list --------------------------------
    def test_first_song_starts_playback_without_resuming_a_paused_song(self):
        start = self.state()
        self.assertIsNone(start["current"])
        self.assertFalse(start["playback"]["playing"])
        first = self.command("add", job_id="song-a")
        self.assertEqual(first["current"]["job_id"], "song-a")
        self.assertTrue(first["playback"]["playing"], "an enqueued list starts playing by itself")
        self.assertFalse(first["player"]["online"], "asking to play is not a receiver playing")
        self.assertEqual(first["player"]["status"], "offline")
        appended = self.command("add", job_id="song-b")
        self.assertEqual(appended["current"]["id"], first["current"]["id"])
        self.assertTrue(appended["playback"]["playing"])
        paused = self.command("pause")
        self.assertFalse(paused["playback"]["playing"])
        behind = self.command("add", job_id="song-c")
        self.assertFalse(behind["playback"]["playing"], "appending never resumes a paused song")
        self.assertEqual(len(behind["queue"]), 2)
        skipped = self.command("next", item_id=behind["current"]["id"])
        self.assertTrue(skipped["playback"]["playing"], "an explicit skip starts the next song")

    def test_manual_next_resumes_from_zero_and_stops_when_the_queue_is_empty(self):
        first = self.command("add", job_id="song-a")
        self.command("add", job_id="song-b")
        self.command("pause")
        paused = self.command("seek", item_id=first["current"]["id"], position=47)
        next_song = self.command("next", item_id=first["current"]["id"])
        self.assertEqual(next_song["current"]["job_id"], "song-b")
        self.assertTrue(next_song["playback"]["playing"])
        self.assertEqual(next_song["playback"]["position"], 0)
        self.assertEqual(next_song["playback"]["seek_version"], paused["playback"]["seek_version"] + 1)
        drained = self.command("next", item_id=next_song["current"]["id"])
        self.assertIsNone(drained["current"])
        self.assertEqual(drained["queue"], [])
        self.assertFalse(drained["playback"]["playing"])

    def test_retried_or_stale_next_cannot_resume_a_later_pause_or_skip_twice(self):
        first = self.command("add", job_id="song-a")
        self.command("add", job_id="song-b")
        self.command("add", job_id="song-c")
        command = {"action": "next", "item_id": first["current"]["id"], "command_id": "retried-next"}
        promoted = self.store.command(self.room, self.phone, command)
        self.command("pause")
        duplicate = self.store.command(self.room, self.phone, command)
        self.assertEqual(duplicate["current"]["id"], promoted["current"]["id"])
        self.assertFalse(duplicate["playback"]["playing"])
        self.fails(409, self.command, "next", item_id=first["current"]["id"])
        self.assertEqual(self.state()["current"]["id"], promoted["current"]["id"])
        self.assertFalse(self.state()["playback"]["playing"])
        fresh = self.command("next", item_id=promoted["current"]["id"])
        self.assertEqual(fresh["current"]["job_id"], "song-c")
        self.assertTrue(fresh["playback"]["playing"])

    def test_a_retried_add_does_not_restart_a_deliberately_paused_room(self):
        command = {"action": "add", "job_id": "song-a", "command_id": "retried-add"}
        self.assertTrue(self.store.command(self.room, self.phone, command)["playback"]["playing"])
        self.command("pause")
        repeated = self.store.command(self.room, self.phone, command)
        self.assertFalse(repeated["playback"]["playing"], "a retry is not a new request")
        self.assertEqual(repeated["queue"], [])

    def test_armed_empty_room_starts_the_first_song_and_continues_the_queue(self):
        claim = self.store.claim(self.room, self.host)
        player = claim["player_token"]
        self.assertIsNone(claim["state"]["current"])
        self.assertFalse(claim["state"]["playback"]["playing"], "arming a screen is not playing")
        state = self.command("add", job_id="song-a")
        self.assertTrue(state["playback"]["playing"], "the armed screen is asked to start")
        self.assertTrue(self.store.state(self.room, self.host)["player"]["online"])
        self.command("add", job_id="song-b")
        ended = self.store.ended(self.room, self.host, player, {
            "command_id": "first-song-ended", "item_id": state["current"]["id"],
            "generation": state["playback"]["seek_version"]})
        self.assertEqual(ended["current"]["job_id"], "song-b")
        self.assertTrue(ended["playback"]["playing"], "the list continues without a new gesture")
        drained = self.store.ended(self.room, self.host, player, {
            "command_id": "second-song-ended", "item_id": ended["current"]["id"],
            "generation": ended["playback"]["seek_version"]})
        self.assertIsNone(drained["current"])
        self.assertEqual(self.command("pause")["playback"]["playing"], False)
        restarted = self.command("add", job_id="song-c")
        self.assertEqual(restarted["current"]["job_id"], "song-c")
        self.assertTrue(restarted["playback"]["playing"],
                        "a pause with nothing playing cannot mute the next request")

    # --- live device presence ----------------------------------------------
    def test_live_devices_group_browser_tabs_and_expire_without_persisting(self):
        browser = "1" * 32
        before = self.state()
        disk = self.store.path.read_bytes()
        first = self.presence(client_id="a" * 32, device_id=browser, label="客厅电视",
                              roles=["player"])
        second = self.presence(client_id="b" * 32, device_id=browser, label="客厅电视",
                               roles=["microphone", "player"])
        self.assertEqual(first["presence_id"], second["presence_id"], "one browser is one device")
        self.assertEqual(len(second["devices"]), 1)
        row = second["devices"][0]
        self.assertEqual(row["id"], second["presence_id"])
        self.assertEqual(row["roles"], ["player", "microphone"], "roles are a deterministic union")
        self.assertEqual(row["member_id"], before["viewer"]["id"])
        self.assertEqual(row["name"], "客厅电视")
        self.assertTrue(row["online"])
        self.assertFalse(row["player"])
        self.assertEqual(sorted(row), ["id", "member_id", "name", "online", "player", "roles"])
        phone = self.presence(client_id="c" * 32, label="手机", roles=["controller"])
        self.assertNotEqual(phone["presence_id"], row["id"], "an unnamed browser is its own row")
        self.assertEqual([value["name"] for value in self.state()["devices"]], ["客厅电视", "手机"])
        self.assertEqual(self.state()["revision"], before["revision"], "presence is not a change")
        self.assertEqual(self.store.path.read_bytes(), disk)
        stored = self.store.path.read_text()
        for private in (browser, "a" * 32, "客厅电视", row["id"]):
            self.assertNotIn(private, stored)
        restored = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        self.assertEqual(restored.state(self.room, self.phone)["devices"], [],
                         "a restarted process starts with no live devices")
        self.now[0] += self.store.MEMBER_SECONDS + 1
        self.assertEqual(self.state()["devices"], [])
        self.assertEqual(self.store.connections, {}, "expired connections are not kept")

    def test_closing_one_tab_takes_only_that_tabs_roles(self):
        browser, other = "1" * 32, "2" * 32
        main, remote = "a" * 32, "b" * 32
        self.presence(client_id=main, device_id=browser, label="演播室",
                      roles=["player", "controller", "microphone"])
        self.presence(client_id=remote, device_id=browser, label="演播室",
                      roles=["controller"])
        away = self.presence(client_id="c" * 32, device_id=other, label="电视",
                             roles=["player"])
        rows = self.state()["devices"]
        self.assertEqual(len(rows), 2, "three tabs on two browsers are two devices")
        self.assertEqual(rows[0]["roles"], ["player", "controller", "microphone"])
        # A microphone that stops is gone at the next poll: live roles are merged,
        # never accumulated.
        quiet = self.presence(client_id=main, device_id=browser, label="演播室",
                              roles=["player", "controller"])
        rows = {row["id"]: row for row in quiet["devices"]}
        self.assertEqual(rows[quiet["presence_id"]]["roles"], ["player", "controller"])
        closed = self.store.drop_presence(self.room, self.phone, main)
        rows = {row["id"]: row for row in closed["devices"]}
        self.assertEqual(len(rows), 2, "the other tab of that browser is still here")
        self.assertEqual(rows[quiet["presence_id"]]["roles"], ["controller"])
        self.assertTrue(rows[quiet["presence_id"]]["online"])
        self.assertEqual(rows[away["presence_id"]]["roles"], ["player"])
        # A restarted page takes a new connection id, so a teardown request that
        # arrives late can never close the connection that replaced it.
        again = self.presence(client_id="d" * 32, device_id=browser, label="演播室",
                              roles=["player", "controller", "microphone"])
        self.store.drop_presence(self.room, self.phone, main)
        rows = {row["id"]: row for row in self.state()["devices"]}
        self.assertEqual(rows[again["presence_id"]]["roles"],
                         ["player", "controller", "microphone"])
        self.assertTrue(rows[again["presence_id"]]["online"])

    def test_presence_replies_follow_the_same_after_contract_as_polling(self):
        state = self.command("add", job_id="song-a")
        unchanged = self.presence(client_id="d" * 32, after=state["revision"])
        self.assertTrue(unchanged["unchanged"])
        self.assertNotIn("queue", unchanged)
        self.assertEqual(len(unchanged["devices"]), 1)
        self.assertEqual(unchanged["viewer"]["id"], state["viewer"]["id"])
        full = self.presence(client_id="d" * 32, after=state["revision"] + 5)
        self.assertNotIn("unchanged", full)
        self.assertEqual(full["current"]["job_id"], "song-a")

    def test_presence_is_scoped_to_the_calling_member_and_removable(self):
        shared = "f" * 32
        mine = self.presence(client_id="1" * 32, device_id=shared, label="我的电视",
                             roles=["player"])
        host = self.presence(token=self.host, client_id="2" * 32, device_id=shared,
                             label="房主电视", roles=["player"])
        self.assertNotEqual(mine["presence_id"], host["presence_id"],
                            "one browser shared by two members is two devices")
        impostor = self.presence(token=self.host, client_id="1" * 32, label="冒充",
                                 roles=["controller"])
        self.assertNotEqual(impostor["presence_id"], mine["presence_id"])
        rows = {row["id"]: row for row in self.state()["devices"]}
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[mine["presence_id"]]["name"], "我的电视")
        self.assertEqual(rows[mine["presence_id"]]["member_id"], self.state()["viewer"]["id"])
        self.store.drop_presence(self.room, self.host, "1" * 32)
        remaining = {row["id"] for row in self.state()["devices"]}
        self.assertEqual(remaining, {mine["presence_id"], host["presence_id"]},
                         "a member only ever closes a connection of their own")
        left = self.store.drop_presence(self.room, self.phone, "1" * 32)
        self.assertEqual([row["id"] for row in left["devices"]], [host["presence_id"]],
                         "other members and other tabs stay online")
        self.assertEqual(self.store.drop_presence(self.room, self.phone, "1" * 32)["id"], self.room)
        self.fails(403, self.store.presence, self.room, "not-the-token",
                   {"client_id": "9" * 32, "label": "外人", "roles": []})
        self.presence(client_id="3" * 32, label="手机")
        self.store.leave(self.room, self.phone)
        self.assertEqual([row["id"] for row in self.store.state(self.room, self.host)["devices"]],
                         [host["presence_id"]], "leaving takes the member's devices with it")

    def test_presence_is_bounded_per_member_and_per_room(self):
        self.store.MAX_MEMBER_PRESENCE = 3
        viewer = self.state()["viewer"]["id"]
        created = []
        for index in range(self.store.MAX_MEMBER_PRESENCE):
            self.now[0] += 1
            created.append(self.presence(client_id=f"{index:032x}",
                                         label=f"标签 {index}")["presence_id"])
        rows = [row for row in self.state()["devices"] if row["member_id"] == viewer]
        self.assertEqual(len(rows), self.store.MAX_MEMBER_PRESENCE)
        self.assertEqual([row["name"] for row in rows],
                         [f"标签 {index}" for index in range(len(created))])
        self.fails(429, self.presence, client_id="d" * 32, label="额外页面")
        self.assertEqual([row["id"] for row in self.state()["devices"]], created,
                         "capacity pressure never evicts an active connection")
        self.store.MAX_PRESENCE = len(rows) + 1
        other = self.store.join(self.room, self.code)["controller_token"]
        accepted = self.presence(token=self.host, client_id="e" * 32, label="房主")
        self.fails(429, self.presence, token=other, client_id="f" * 32, label="迟到的设备")
        self.assertIsNotNone(accepted.get("presence_id"))
        self.assertEqual(len(self.state()["devices"]), self.store.MAX_PRESENCE)
        self.now[0] += 1
        again = self.presence(client_id=f"{len(created) - 1:032x}", label="标签 回来了")
        self.assertEqual(again["presence_id"], created[-1], "known connections keep refreshing")
        self.now[0] += self.store.MEMBER_SECONDS + 1
        self.assertIn("presence_id", self.presence(token=other, client_id="f" * 32, label="新的页面"),
                      "expired connections free capacity")

    def test_a_claim_before_announcement_is_attributed_when_the_device_arrives(self):
        client, device = "a" * 32, "b" * 32
        claim = self.store.claim(self.room, self.host, client_id=client, device_id=device)
        self.assertEqual(claim["state"]["devices"], [])
        value = self.presence(token=self.host, client_id=client, device_id=device,
                              label="播放器", roles=["player"])
        self.assertTrue(value["devices"][0]["player"])
        self.assertEqual(value["presence_id"], value["devices"][0]["id"])

    def test_only_the_claiming_browser_is_shown_as_the_player(self):
        television = "3" * 32
        screen = self.presence(token=self.host, client_id=television, label="电视",
                               roles=["player"])
        phone = self.presence(client_id="4" * 32, label="手机", roles=["controller"])
        self.command("add", job_id="song-a")
        self.store.claim(self.room, self.host, client_id=television)
        rows = {row["id"]: row for row in self.state()["devices"]}
        self.assertTrue(rows[screen["presence_id"]]["player"])
        self.assertFalse(rows[phone["presence_id"]]["player"])
        self.now[0] += self.store.LEASE_SECONDS + 1
        self.presence(token=self.host, client_id=television, label="电视", roles=["player"])
        expired = {row["id"]: row for row in self.state()["devices"]}
        self.assertFalse(expired[screen["presence_id"]]["player"], "an expired lease plays nothing")
        self.store.claim(self.room, self.host)
        self.assertFalse(any(row["player"] for row in self.state()["devices"]),
                         "a claim that names no browser attributes playback to none of them")

    def test_standalone_rooms_never_read_the_account_device_registry(self):
        def refuse(*_):
            raise AssertionError("a paired room must not touch account storage")

        self.store.profiles = refuse
        value = self.presence(client_id="5" * 32, device_id="6" * 32, label="电视",
                              roles=["player"])
        self.assertEqual(value["devices"][0]["name"], "电视")
        self.assertEqual(value["devices"][0]["roles"], ["player"])

    def test_public_directory_never_lists_room_devices(self):
        self.store.update(self.room, self.host, {"discoverable": True})
        self.presence(client_id="7" * 32, device_id="8" * 32, label="私人手机")
        listing = self.store.directory()
        self.assertEqual(len(listing), 1)
        self.assertNotIn("devices", listing[0])
        self.assertNotIn("私人手机", json.dumps(listing, ensure_ascii=False))

    def test_presence_http_contract_and_credential_fences(self):
        app = FastAPI()
        app.include_router(rooms.router)
        with patch.object(rooms, "store", self.store), TestClient(app) as client:
            base = "/api/rooms/" + self.room
            headers = {"Authorization": "Bearer " + self.phone}
            body = {"client_id": "a" * 32, "device_id": None, "label": "手机",
                    "roles": ["controller"]}
            self.assertEqual(client.post(base + "/presence", json=body).status_code, 401)
            self.assertEqual(client.post(base + "/presence", json=body, headers={
                "Authorization": "Bearer not-a-member"}).status_code, 403)
            result = client.post(base + "/presence", headers=headers, json=body)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers["cache-control"], "no-store")
            value = result.json()
            self.assertEqual(len(value["devices"]), 1)
            self.assertEqual(value["presence_id"], value["devices"][0]["id"])
            unchanged = client.post(base + "/presence?after=" + str(value["revision"]),
                                    headers=headers, json=body).json()
            self.assertTrue(unchanged["unchanged"])
            self.assertNotIn("queue", unchanged)
            self.assertEqual(unchanged["devices"], value["devices"])
            for invalid in ({**body, "roles": ["host"]}, {**body, "roles": ["player"] * 4},
                            {**body, "client_id": "short"}, {**body, "label": ""},
                            {**body, "device_id": "xyz"}, {**body, "surprise": True}):
                self.assertEqual(client.post(base + "/presence", headers=headers,
                                             json=invalid).status_code, 422)
            legacy = client.get(base, headers=headers).json()
            self.assertEqual(legacy["devices"], value["devices"])
            self.assertNotIn("presence_id", legacy)
            blank = client.post(base + "/presence", headers=headers,
                                json={**body, "label": " "})
            self.assertEqual(blank.status_code, 422, "invalid presence is not accepted as a successful announcement")
            removed = client.delete(base + "/presence/" + "a" * 32, headers=headers)
            self.assertEqual(removed.status_code, 200)
            self.assertEqual(removed.json()["devices"], [])
            self.assertEqual(client.delete(base + "/presence/" + "a" * 32,
                                           headers=headers).status_code, 200)
            host_headers = {"Authorization": "Bearer " + self.host}
            self.assertEqual(client.post(base + "/player/claim",
                                         headers=host_headers).status_code, 200)

    def test_party_http_contracts_keep_capabilities_out_of_query_parameters(self):
        app = FastAPI()
        app.include_router(rooms.router)
        with patch.object(rooms, "store", self.store), TestClient(app) as client:
            created = client.post("/api/rooms", json={
                "name": "Saturday party", "display_name": "Alice",
                "discoverable": True, "allow_screens": True,
            })
            self.assertEqual(created.status_code, 200)
            room = created.json()
            base = "/api/rooms/" + room["room_id"]
            host = {"Authorization": "Bearer " + room["host_token"]}
            directory = client.get("/api/rooms")
            self.assertEqual(directory.headers["cache-control"], "no-store")
            self.assertEqual(directory.json()["rooms"][0]["name"], "Saturday party")
            joined = client.post(base + "/join", json={
                "code": room["pairing_code"], "display_name": "TV", "role": "screen",
            })
            self.assertEqual(joined.status_code, 200)
            screen = {"Authorization": "Bearer " + joined.json()["screen_token"]}
            self.assertEqual(client.patch(base, headers=screen, json={"name": "No"}).status_code, 403)
            renamed = client.patch(base + "/member", headers=screen,
                                   json={"display_name": "Projector"})
            self.assertEqual(renamed.json()["viewer"]["name"], "Projector")
            player = client.post(base + "/player/claim", headers=screen).json()["player_token"]
            self.assertEqual(client.post(base + "/player/release", headers={
                **screen, "X-Player-Token": player,
            }).status_code, 200)
            self.assertEqual(client.patch(base, headers=host, json={"discoverable": False}).status_code, 200)
            self.assertEqual(client.get("/api/rooms").json(), {"rooms": []})
            self.assertEqual(client.post(base + "/leave", headers=screen).status_code, 200)
            self.assertEqual(client.get(base, headers=screen).status_code, 403)
            self.assertEqual(client.delete(base, params={"token": room["host_token"]}).status_code, 401)
            self.assertEqual(client.delete(base, headers=host).status_code, 200)
            self.assertEqual(client.get(base, headers=host).status_code, 404)


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
        app.include_router(identity.router)

        def public_job(job):
            return {**job, "media": {
                "instrumental": f"/media/{job['id']}/stems/instrumental.mp3",
                "vocals": f"/media/{job['id']}/stems/vocals.mp3",
                "lyrics": f"/media/{job['id']}/{job['lyrics_file']}",
            }}

        @app.get("/api/jobs")
        def jobs():
            return [public_job(job) for job in songs.values.values()]

        @app.get("/api/jobs/{job_id}")
        def job_detail(job_id: str):
            if job_id not in songs.values:
                raise HTTPException(status_code=404, detail="Missing synthetic song")
            return public_job(songs.values[job_id])

        @app.put("/api/jobs/{job_id}/lyrics")
        def publish_lyrics(job_id: str, payload: dict):
            if job_id not in songs.values:
                raise HTTPException(status_code=404, detail="Missing synthetic song")
            relative = f".openk-results/{uuid.uuid4().hex}/lyrics.json"
            destination = songs.job_dir(job_id) / relative
            destination.parent.mkdir(parents=True)
            destination.write_text(json.dumps(payload), encoding="utf-8")
            songs.values[job_id]["lyrics_file"] = relative
            return {"ok": True, "lyrics_file": relative}

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
