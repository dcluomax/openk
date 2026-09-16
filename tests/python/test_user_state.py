#!/usr/bin/env python3
"""Account settings, device topology and playback history.

No live accounts, real songs or network calls: every identity is synthetic and
the store is a throwaway SQLite file.
"""
from __future__ import annotations

import base64
from dataclasses import asdict
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend import identity, rooms, user_state
from backend.identity import Account
from tests.python.test_rooms import Songs

ALICE_DEVICE = "a" * 32
BOB_DEVICE = "b" * 32


class UserStateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".user-state-test-", dir=PROJECT_ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.now = [100000.0]
        self.path = self.root / "user-state.sqlite3"
        self.store = user_state.UserStateStore(self.path, lambda: self.now[0])
        self.alice = Account("00000000-0000-4000-8000-000000000001", "alice", "Alice")
        self.bob = Account("00000000-0000-4000-8000-000000000002", "bob", "Bob")
        self.key = b"test-only-identity-key-" + b"a" * 32

    # --- helpers -----------------------------------------------------------
    def fails(self, code, function, *args, **kwargs):
        with self.assertRaises(HTTPException) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.status_code, code)
        return caught.exception

    def headers(self, account, device=None):
        values = {
            "X-OpenK-Identity-Key": self.key.decode(),
            "X-OpenK-Account": base64.urlsafe_b64encode(json.dumps(asdict(account)).encode()).decode(),
        }
        if device:
            values["X-OpenK-Device"] = device
        return values

    def client(self):
        app = FastAPI()
        app.include_router(user_state.router)
        return app

    # --- isolation ---------------------------------------------------------
    def test_settings_are_isolated_by_account_even_in_the_same_browser(self):
        self.store.register(self.alice, ALICE_DEVICE, "Living room")
        state = self.store.snapshot(self.alice, ALICE_DEVICE)
        self.store.save_defaults(self.alice, {"reverb": "hall", "mic_volume": 40}, state["revision"])
        state = self.store.snapshot(self.alice, ALICE_DEVICE)
        self.store.update_device(self.alice, ALICE_DEVICE, {"overrides": {"mic_volume": 70}},
                                 state["device"]["revision"])
        alice = self.store.snapshot(self.alice, ALICE_DEVICE)
        self.assertEqual(alice["settings"]["reverb"], "hall")
        self.assertEqual(alice["settings"]["mic_volume"], 70, "the device override wins over the account default")
        self.assertEqual(alice["defaults"]["mic_volume"], 40)

        # The same browser, a different person: nothing is inherited or exposed.
        bob = self.store.snapshot(self.bob, ALICE_DEVICE)
        self.assertIsNone(bob["device"])
        self.assertEqual(bob["devices"], [])
        self.assertEqual(bob["settings"], user_state.EFFECTIVE_DEFAULTS)
        self.assertEqual(bob["revision"], 0)
        registered = self.store.register(self.bob, ALICE_DEVICE, "Bob's profile")
        self.assertEqual(registered["device"]["label"], "Bob's profile")
        self.assertEqual(registered["settings"], user_state.EFFECTIVE_DEFAULTS)
        self.assertEqual(self.store.snapshot(self.alice, ALICE_DEVICE)["device"]["label"], "Living room")

    def test_devices_belong_to_the_account_that_registered_them(self):
        self.store.register(self.alice, ALICE_DEVICE, "Living room")
        self.fails(404, self.store.update_device, self.bob, ALICE_DEVICE, {"label": "Stolen"}, 1)
        self.fails(404, self.store.remove_device, self.bob, ALICE_DEVICE)
        self.fails(404, self.store.save_topology, self.bob, ALICE_DEVICE, 0)
        self.assertEqual(self.store.snapshot(self.alice, ALICE_DEVICE)["device"]["label"], "Living room")

    # --- validation --------------------------------------------------------
    def test_invalid_settings_are_refused_before_they_reach_the_player(self):
        self.store.register(self.alice, ALICE_DEVICE)
        for values in (
            {"mic_volume": 201}, {"mic_volume": -1}, {"mic_volume": 1.5}, {"mic_volume": True},
            {"mic_monitor": "yes"}, {"mic_monitor": 1}, {"reverb": "stadium"},
            {"sing_mode": "duet"}, {"view": "tiles"}, {"accompaniment_volume": 101},
            {"unknown": 1}, {"audio_output": "x" * 201},
        ):
            with self.subTest(values=values):
                self.fails(422, user_state.settings, values, user_state.DEVICE_KEYS)
        # Device-only keys never live at the account level.
        for key in ("output_volume", "audio_input", "audio_output"):
            self.fails(422, user_state.settings, {key: 50 if key == "output_volume" else ""},
                       user_state.ACCOUNT_KEYS)
        self.fails(422, user_state.settings, {f"k{index}": 1 for index in range(40)},
                   user_state.DEVICE_KEYS)
        self.fails(422, user_state.settings, ["mic_volume"], user_state.DEVICE_KEYS)

    def test_labels_roles_and_device_ids_are_bounded(self):
        for value in ("", "   ", "x" * 41, "bad\nname", "bell\x07"):
            self.fails(422, user_state.label, value)
        self.assertEqual(user_state.label("  Living room  "), "Living room")
        for value in ("", "zz", "A" * 32, "a" * 31, "a" * 33):
            self.fails(422, user_state.device_id, value, required=True)
        self.assertIsNone(user_state.device_id(None))
        self.fails(422, user_state.roles, ["player", "speaker"])
        self.fails(422, user_state.roles, "player")
        self.assertEqual(user_state.roles(["player", "player", "controller"]), ["player", "controller"])
        self.fails(422, user_state.capabilities, {"playback": "yes"})
        self.fails(422, user_state.capabilities, {"unknown": True})

    # --- concurrency -------------------------------------------------------
    def test_revisions_stop_one_device_overwriting_another(self):
        self.store.register(self.alice, ALICE_DEVICE)
        state = self.store.snapshot(self.alice)
        phone = self.store.save_defaults(self.alice, {"reverb": "hall"}, state["revision"])
        # A second browser still holding the old revision must be told to refresh.
        conflict = self.fails(409, self.store.save_defaults, self.alice, {"reverb": "room"},
                              state["revision"])
        self.assertEqual(conflict.detail["code"], "revision_conflict")
        self.assertEqual(self.store.snapshot(self.alice)["defaults"]["reverb"], "hall")
        # Retrying against the fresh revision keeps the other device's untouched keys.
        merged = self.store.save_defaults(self.alice, {"sing_mode": "orig"}, phone["revision"])
        self.assertEqual(merged["defaults"]["reverb"], "hall")
        self.assertEqual(merged["defaults"]["sing_mode"], "orig")

        device = merged["devices"][0]
        self.store.update_device(self.alice, ALICE_DEVICE, {"label": "Kitchen"}, device["revision"])
        self.fails(409, self.store.update_device, self.alice, ALICE_DEVICE,
                   {"label": "Stale"}, device["revision"])
        self.assertEqual(self.store.snapshot(self.alice, ALICE_DEVICE)["device"]["label"], "Kitchen")

    def test_state_survives_a_restart_of_the_store(self):
        self.store.register(self.alice, ALICE_DEVICE, "Living room")
        state = self.store.snapshot(self.alice, ALICE_DEVICE)
        self.store.save_defaults(self.alice, {"reverb": "church"}, state["revision"])
        state = self.store.snapshot(self.alice, ALICE_DEVICE)
        self.store.update_device(self.alice, ALICE_DEVICE,
                                 {"overrides": {"output_volume": 40, "audio_output": "sink-1"}},
                                 state["device"]["revision"])
        self.store.save_topology(self.alice, ALICE_DEVICE, self.store.snapshot(self.alice)["revision"])
        self.store.record_playback(self.alice.id, device=ALICE_DEVICE, play_key="room:item",
                                   song={"job_id": "job", "title": "T", "artist": "A", "duration": 90},
                                   position=30)

        restarted = user_state.UserStateStore(self.path, lambda: self.now[0])
        state = restarted.snapshot(self.alice, ALICE_DEVICE)
        self.assertEqual(state["settings"]["reverb"], "church")
        self.assertEqual(state["settings"]["output_volume"], 40)
        self.assertEqual(state["settings"]["audio_output"], "sink-1")
        self.assertEqual(state["preferred_player"], ALICE_DEVICE)
        self.assertEqual(state["device"]["label"], "Living room")
        self.assertEqual(restarted.history(self.alice)["entries"][0]["title"], "T")
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    # --- topology ----------------------------------------------------------
    def test_preferred_player_follows_real_devices_only(self):
        self.store.register(self.alice, ALICE_DEVICE, "Television")
        self.store.register(self.alice, BOB_DEVICE, "Phone")
        state = self.store.snapshot(self.alice, ALICE_DEVICE)
        self.fails(404, self.store.save_topology, self.alice, "c" * 32, state["revision"])
        chosen = self.store.save_topology(self.alice, ALICE_DEVICE, state["revision"])
        self.assertEqual(chosen["preferred_player"], ALICE_DEVICE)
        television = next(item for item in chosen["devices"] if item["id"] == ALICE_DEVICE)
        self.assertIn("player", television["roles"], "the preferred player gains the player role")
        self.assertTrue(television["preferred_player"])
        # Dropping the player role, or the device itself, must not leave a dangling target.
        cleared = self.store.update_device(self.alice, ALICE_DEVICE, {"roles": ["controller"]},
                                           television["revision"])
        self.assertIsNone(cleared["preferred_player"])
        state = self.store.snapshot(self.alice)
        self.store.save_topology(self.alice, BOB_DEVICE, state["revision"])
        self.assertIsNone(self.store.remove_device(self.alice, BOB_DEVICE)["preferred_player"])

    def test_device_count_is_bounded(self):
        for index in range(user_state.MAX_DEVICES):
            self.store.register(self.alice, f"{index:032x}")
        self.fails(429, self.store.register, self.alice, "f" * 32)
        self.assertEqual(len(self.store.snapshot(self.alice)["devices"]), user_state.MAX_DEVICES)

    # --- history -----------------------------------------------------------
    def song(self, title="Song", duration=120.0):
        return {"job_id": "job-1", "title": title, "artist": "Artist", "duration": duration}

    def test_history_deduplicates_and_stays_private(self):
        self.store.register(self.alice, ALICE_DEVICE, "Television")
        for position in (5, 40, 90):
            self.store.record_playback(self.alice.id, device=ALICE_DEVICE, play_key="room:item-1",
                                       song=self.song(), position=position)
        self.store.record_playback(self.alice.id, device=ALICE_DEVICE, play_key="room:item-2",
                                   song=self.song("Second"), position=8)
        history = self.store.history(self.alice)
        self.assertEqual(history["total"], 2, "retries and heartbeats update one record")
        self.assertEqual([entry["title"] for entry in history["entries"]], ["Second", "Song"])
        first = history["entries"][1]
        self.assertEqual(first["position"], 90)
        self.assertFalse(first["completed"])
        self.assertEqual(first["device_label"], "Television")
        self.assertNotIn("room_id", first)

        # Another account cannot read or delete it by guessing identifiers.
        self.assertEqual(self.store.history(self.bob)["entries"], [])
        self.fails(404, self.store.delete_entry, self.bob, first["id"])
        self.assertEqual(self.store.clear_history(self.bob)["removed"], 0)
        self.assertEqual(self.store.history(self.alice)["total"], 2)

    def test_completion_never_invents_a_record(self):
        self.store.register(self.alice, ALICE_DEVICE, "Television")
        self.assertFalse(self.store.finish_playback(self.alice.id, "room:never-played", 10))
        self.assertEqual(self.store.history(self.alice)["total"], 0)
        self.store.record_playback(self.alice.id, device=ALICE_DEVICE, play_key="room:item-1",
                                   song=self.song(), position=10)
        self.assertTrue(self.store.finish_playback(self.alice.id, "room:item-1", 119))
        entry = self.store.history(self.alice)["entries"][0]
        self.assertTrue(entry["completed"])
        self.assertEqual(entry["position"], 119)
        # A late heartbeat cannot rewind a finished record.
        self.store.record_playback(self.alice.id, device=ALICE_DEVICE, play_key="room:item-1",
                                   song=self.song(), position=3)
        entry = self.store.history(self.alice)["entries"][0]
        self.assertEqual(entry["position"], 119)
        self.assertTrue(entry["completed"])

    def test_history_is_paginated_bounded_and_survives_a_deleted_song(self):
        self.store.register(self.alice, ALICE_DEVICE, "Television")
        for index in range(user_state.MAX_HISTORY + 5):
            self.store.record_playback(self.alice.id, device=ALICE_DEVICE,
                                       play_key=f"room:item-{index}",
                                       song=self.song(f"Song {index}"), position=10)
        self.assertEqual(self.store.history(self.alice)["total"], user_state.MAX_HISTORY)
        page = self.store.history(self.alice, limit=10)
        self.assertEqual(len(page["entries"]), 10)
        older = self.store.history(self.alice, limit=10, before=page["next_before"])
        self.assertTrue(set(entry["id"] for entry in older["entries"])
                        .isdisjoint(entry["id"] for entry in page["entries"]))
        self.assertEqual(len(self.store.history(self.alice, limit=10**6)["entries"]),
                         user_state.MAX_HISTORY_PAGE)

        # Removing the device keeps the snapshot that was taken when it played.
        self.store.remove_device(self.alice, ALICE_DEVICE)
        self.assertEqual(self.store.history(self.alice)["entries"][0]["device_label"], "Television")
        # A history row carries only its own snapshot; the catalog is not consulted.
        entry = self.store.history(self.alice)["entries"][0]
        self.assertEqual(set(entry), {"id", "job_id", "title", "artist", "duration", "device_label",
                                      "device_id", "started_at", "updated_at", "position", "completed"})

    def test_deleting_and_clearing_history_is_explicit(self):
        self.store.register(self.alice, ALICE_DEVICE)
        for index in range(3):
            self.store.record_playback(self.alice.id, device=ALICE_DEVICE,
                                       play_key=f"room:item-{index}", song=self.song(), position=10)
        entry = self.store.history(self.alice)["entries"][0]
        self.assertEqual(self.store.delete_entry(self.alice, entry["id"])["removed"], 1)
        self.assertEqual(self.store.history(self.alice)["total"], 2)
        self.assertEqual(self.store.clear_history(self.alice)["removed"], 2)
        self.assertEqual(self.store.history(self.alice)["total"], 0)

    def test_unwritable_storage_reports_failure_instead_of_a_silent_success(self):
        self.store.register(self.alice, ALICE_DEVICE)
        with patch.object(user_state.UserStateStore, "_write", side_effect=OSError("read-only")), \
                self.assertLogs(user_state._log, "WARNING"):
            self.assertFalse(self.store.record_playback(
                self.alice.id, device=ALICE_DEVICE, play_key="room:item", song=self.song(), position=9))
            self.assertFalse(self.store.finish_playback(self.alice.id, "room:item", 9))
        self.assertEqual(self.store.history(self.alice)["total"], 0)

    # --- library statistics -------------------------------------------------
    def play(self, account, job, key, *, position=10.0, at=None, device=ALICE_DEVICE):
        """One confirmed play, written exactly the way a validated lease writes it."""
        if at is not None:
            self.now[0] = at
        return self.store.record_playback(
            account.id, device=device, play_key=key, position=position,
            song={"job_id": job, "title": job, "artist": "Artist", "duration": 240.0})

    def test_library_stats_rank_the_songs_this_account_really_sang(self):
        self.store.register(self.alice, ALICE_DEVICE, "Television")
        clock = 1000.0
        for job, total in (("often", 80), ("sometimes", 30), ("rare", 1)):
            for index in range(total):
                clock += 1
                self.play(self.alice, job, f"room:{job}-{index}", at=clock)
        # A play the person stopped early is still a play, exactly as history shows it.
        self.play(self.alice, "partial", "room:partial", position=4.0, at=clock + 1)
        # The same active play reporting progress again, then finishing, is one play.
        self.play(self.alice, "often", "room:often-0", position=60.0, at=clock + 2)
        self.store.finish_playback(self.alice.id, "room:often-0", 239.0)

        stats = self.store.library_stats(self.alice)
        self.assertEqual(stats["account_id"], self.alice.id)
        self.assertEqual(stats["history_limit"], user_state.MAX_HISTORY)
        self.assertEqual(stats["total_plays"], 112)
        self.assertEqual([(song["job_id"], song["play_count"]) for song in stats["songs"]],
                         [("often", 80), ("sometimes", 30), ("partial", 1), ("rare", 1)])
        self.assertEqual(set(stats["songs"][0]), {"job_id", "play_count", "last_played_at"},
                         "the ranking carries no song text, device or personal detail")
        counts = {song["job_id"]: song for song in stats["songs"]}
        self.assertEqual(counts["often"]["last_played_at"], 1080.0,
                         "a repeat report belongs to the play that already started")
        self.assertEqual(counts["sometimes"]["last_played_at"], 1110.0)
        self.assertEqual(counts["rare"]["last_played_at"], 1111.0)
        self.assertEqual(counts["partial"]["last_played_at"], 1112.0)

        # Equal counts on the same date stay in a stable, explainable order.
        for job in ("zebra", "apple"):
            self.play(self.alice, job, f"room:tie-{job}", at=2000.0)
        ranked = [song["job_id"] for song in self.store.library_stats(self.alice)["songs"]]
        self.assertEqual(ranked[:2], ["often", "sometimes"])
        self.assertEqual(ranked[2:], ["apple", "zebra", "partial", "rare"])

    def test_library_stats_read_every_retained_row_not_the_first_page(self):
        self.store.register(self.alice, ALICE_DEVICE)
        for index in range(user_state.MAX_HISTORY):
            self.play(self.alice, f"job-{index % 25}", f"room:item-{index}", at=1000.0 + index)
        stats = self.store.library_stats(self.alice)
        self.assertEqual(stats["total_plays"], user_state.MAX_HISTORY)
        self.assertEqual(len(stats["songs"]), 25)
        self.assertEqual({song["play_count"] for song in stats["songs"]}, {20})
        self.assertGreater(stats["total_plays"], self.store.history(self.alice)["limit"],
                           "a single history page could not have produced these counts")

        # Retention prunes the oldest rows, so the ranking follows what is kept.
        for index in range(10):
            self.play(self.alice, "newcomer", f"room:new-{index}", at=9000.0 + index)
        counts = {song["job_id"]: song["play_count"]
                  for song in self.store.library_stats(self.alice)["songs"]}
        self.assertEqual(counts["newcomer"], 10)
        self.assertEqual(counts["job-0"], 19, "the pruned play is gone from the count too")
        self.assertEqual(counts["job-10"], 20)
        self.assertEqual(sum(counts.values()), user_state.MAX_HISTORY)

    def test_library_stats_are_one_bounded_indexed_pass(self):
        self.store.register(self.alice, ALICE_DEVICE)
        for index in range(120):
            self.play(self.alice, f"job-{index % 7}", f"room:item-{index}", at=1000.0 + index)
        statements: list[str] = []
        connect = user_state.UserStateStore._connect

        def traced(store):
            connection = connect(store)
            connection.set_trace_callback(statements.append)
            return connection

        with patch.object(user_state.UserStateStore, "_connect", traced):
            self.store.library_stats(self.alice)
        self.assertEqual(len(statements), 1, "one aggregate query, not one query per song or page")
        self.assertIn("LIMIT", statements[0].upper(), "the result stays bounded")
        connection = sqlite3.connect(self.path)
        try:
            plan = [str(row[3]) for row in
                    connection.execute("EXPLAIN QUERY PLAN " + statements[0]).fetchall()]
        finally:
            connection.close()
        self.assertTrue(any("history" in step and "USING INDEX" in step for step in plan), plan)
        self.assertFalse([step for step in plan if step.startswith("SCAN history")], plan)

    def test_library_stats_never_mix_two_accounts(self):
        for index in range(3):
            self.play(self.alice, "shared", f"room:item-{index}", at=1000.0 + index)
        for index in range(7):
            # The same play keys and the same song: only the account separates them.
            self.play(self.bob, "shared", f"room:item-{index}", at=2000.0 + index)
        self.play(self.bob, "bob-only", "room:solo", at=2100.0)
        alice = self.store.library_stats(self.alice)
        self.assertEqual(alice["account_id"], self.alice.id)
        self.assertEqual(alice["songs"],
                         [{"job_id": "shared", "play_count": 3, "last_played_at": 1002.0}])
        self.assertEqual(alice["total_plays"], 3)
        bob = self.store.library_stats(self.bob)
        self.assertEqual(bob["account_id"], self.bob.id)
        self.assertEqual([song["job_id"] for song in bob["songs"]], ["shared", "bob-only"])
        self.assertEqual(bob["total_plays"], 8)

        carol = Account("00000000-0000-4000-8000-000000000003", "carol", "Carol")
        self.assertEqual(self.store.library_stats(carol),
                         {"account_id": carol.id, "songs": [], "total_plays": 0,
                          "history_limit": user_state.MAX_HISTORY})

    def test_deleting_history_changes_the_ranking_immediately(self):
        for index in range(3):
            self.play(self.alice, "often", f"room:often-{index}", at=1000.0 + index)
        self.play(self.alice, "once", "room:once", at=1010.0)
        self.play(self.bob, "often", "room:bob", at=1020.0)
        entries = {(entry["job_id"], entry["started_at"]): entry["id"]
                   for entry in self.store.history(self.alice)["entries"]}

        self.store.delete_entry(self.alice, entries[("often", 1002.0)])
        stats = self.store.library_stats(self.alice)
        self.assertEqual(stats["songs"][0], {"job_id": "often", "play_count": 2,
                                             "last_played_at": 1001.0})
        self.assertEqual(stats["total_plays"], 3)

        self.store.delete_entry(self.alice, entries[("once", 1010.0)])
        self.assertEqual([song["job_id"] for song in self.store.library_stats(self.alice)["songs"]],
                         ["often"], "a song with no remaining play leaves the ranking")

        self.store.clear_history(self.alice)
        self.assertEqual(self.store.library_stats(self.alice),
                         {"account_id": self.alice.id, "songs": [], "total_plays": 0,
                          "history_limit": user_state.MAX_HISTORY})
        self.assertEqual(self.store.library_stats(self.bob)["total_plays"], 1,
                         "one person clearing their history never touches another's")

    def test_unreadable_storage_reports_503_instead_of_an_empty_ranking(self):
        self.play(self.alice, "often", "room:item-0", at=1000.0)
        for failure in (sqlite3.OperationalError("disk I/O error"), OSError("read-only")):
            with self.subTest(failure=type(failure).__name__):
                with patch.object(user_state.UserStateStore, "_connect", side_effect=failure), \
                        self.assertLogs(user_state._log, "WARNING"):
                    error = self.fails(503, self.store.library_stats, self.alice)
                self.assertEqual(error.detail, "暂时无法读取常唱统计，请稍后重试")
        self.assertEqual(self.store.library_stats(self.alice)["total_plays"], 1)


class UserStateApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".user-api-test-", dir=PROJECT_ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = user_state.UserStateStore(self.root / "user-state.sqlite3")
        self.alice = Account("00000000-0000-4000-8000-000000000001", "alice", "Alice")
        self.bob = Account("00000000-0000-4000-8000-000000000002", "bob", "Bob")
        self.key = b"test-only-identity-key-" + b"a" * 32
        self.app = FastAPI()
        self.app.include_router(user_state.router)

    def headers(self, account, device=None):
        values = {
            "X-OpenK-Identity-Key": self.key.decode(),
            "X-OpenK-Account": base64.urlsafe_b64encode(json.dumps(asdict(account)).encode()).decode(),
        }
        if device:
            values["X-OpenK-Device"] = device
        return values

    def signed_in(self):
        return patch.multiple(user_state, KEY=self.key, store=lambda: self.store), None

    def context(self):
        return patch.object(identity, "KEY", self.key), patch.object(user_state, "store", lambda: self.store)

    def test_guest_and_standalone_contexts_are_never_authorized(self):
        guest = base64.urlsafe_b64encode(json.dumps({"id": self.alice.id, "expires_at": 1}).encode()).decode()
        with patch.object(user_state, "store", lambda: self.store), TestClient(self.app) as client:
            # Accounts are not configured at all: the feature does not exist.
            with patch.object(identity, "KEY", b""):
                for path in ("/api/user/state", "/api/user/history"):
                    self.assertEqual(client.get(path).status_code, 404)
                self.assertEqual(client.put("/api/user/defaults",
                                            json={"revision": 0, "settings": {}}).status_code, 404)
            with patch.object(identity, "KEY", self.key):
                self.assertEqual(client.get("/api/user/state").status_code, 401)
                # A guest assertion is not an account assertion.
                self.assertEqual(client.get("/api/user/state", headers={
                    "X-OpenK-Identity-Key": self.key.decode(), "X-OpenK-Guest": guest,
                }).status_code, 401)
                forged = self.headers(self.alice) | {"X-OpenK-Identity-Key": "wrong"}
                self.assertEqual(client.get("/api/user/state", headers=forged).status_code, 401)
                self.assertEqual(client.get("/api/user/history", headers=forged).status_code, 401)

    def test_account_fence_and_device_header_are_enforced(self):
        first, second = self.context()
        with first, second, TestClient(self.app) as client:
            device = "a" * 32
            created = client.post("/api/user/state", headers=self.headers(self.alice, device), json={})
            self.assertEqual(created.status_code, 200)
            self.assertIn("private", created.headers["cache-control"])
            self.assertEqual(created.json()["device"]["id"], device)

            stale = self.headers(self.bob, device) | {"X-OpenK-Expected-Account": self.alice.id}
            response = client.get("/api/user/state", headers=stale)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["detail"]["code"], "account_changed")

            self.assertEqual(client.post("/api/user/state", headers=self.headers(self.alice),
                                         json={}).status_code, 422)
            self.assertEqual(client.get("/api/user/state",
                                        headers=self.headers(self.alice, "nope")).status_code, 422)
            self.assertEqual(client.patch(f"/api/user/devices/{device}",
                                          headers=self.headers(self.bob, device),
                                          json={"revision": 1, "label": "Stolen"}).status_code, 404)
            self.assertEqual(client.request("DELETE", f"/api/user/devices/{device}",
                                            headers=self.headers(self.bob)).status_code, 404)

    def test_settings_history_and_extra_fields_over_http(self):
        first, second = self.context()
        device = "a" * 32
        with first, second, TestClient(self.app) as client:
            headers = self.headers(self.alice, device)
            client.post("/api/user/state", headers=headers,
                        json={"label": "Living room", "capabilities": {"microphone": True}})
            self.assertEqual(client.put("/api/user/defaults", headers=headers,
                                        json={"revision": 0, "settings": {"reverb": "hall"},
                                              "extra": 1}).status_code, 422)
            saved = client.put("/api/user/defaults", headers=headers,
                               json={"revision": 0, "settings": {"reverb": "hall"}})
            self.assertEqual(saved.status_code, 200)
            self.assertEqual(saved.json()["settings"]["reverb"], "hall")
            self.assertEqual(client.put("/api/user/defaults", headers=headers,
                                        json={"revision": 0, "settings": {"reverb": "room"}}
                                        ).status_code, 409)
            self.assertEqual(client.put("/api/user/defaults", headers=headers,
                                        json={"revision": 1, "settings": {"output_volume": 10}}
                                        ).status_code, 422)
            topology = client.put("/api/user/topology", headers=headers,
                                  json={"revision": 1, "preferred_player": device})
            self.assertEqual(topology.status_code, 200)
            self.assertEqual(topology.json()["preferred_player"], device)

            self.store.record_playback(self.alice.id, device=device, play_key="room:item",
                                       song={"job_id": "job", "title": "T", "artist": "A",
                                             "duration": 60}, position=30)
            listing = client.get("/api/user/history?limit=5", headers=headers)
            self.assertEqual(listing.status_code, 200)
            self.assertEqual(listing.json()["total"], 1)
            self.assertEqual(client.get("/api/user/history?limit=0", headers=headers).status_code, 422)
            self.assertEqual(client.get("/api/user/history", headers=self.headers(self.bob, device))
                             .json()["entries"], [])
            entry = listing.json()["entries"][0]["id"]
            self.assertEqual(client.request("DELETE", f"/api/user/history/{entry}",
                                            headers=self.headers(self.bob)).status_code, 404)
            self.assertEqual(client.request("DELETE", f"/api/user/history/{entry}",
                                            headers=headers).status_code, 200)
            self.assertEqual(client.get("/api/user/history", headers=headers).json()["total"], 0)

    def test_library_statistics_over_http_stay_private_to_the_signed_in_account(self):
        first, second = self.context()
        device = "a" * 32
        song = {"job_id": "job", "title": "T", "artist": "A", "duration": 60}
        with first, second, TestClient(self.app) as client:
            headers = self.headers(self.alice, device)
            client.post("/api/user/state", headers=headers, json={})
            for index in range(2):
                self.store.record_playback(self.alice.id, device=device,
                                           play_key=f"room:item-{index}", song=song, position=30)
            self.store.record_playback(self.bob.id, device=device, play_key="room:item-0",
                                       song=song | {"job_id": "other"}, position=30)

            response = client.get("/api/user/library-stats", headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertIn("private", response.headers["cache-control"])
            self.assertIn("no-store", response.headers["cache-control"])
            self.assertEqual(response.headers["referrer-policy"], "no-referrer")
            body = response.json()
            self.assertEqual(body["account_id"], self.alice.id)
            self.assertEqual(body["total_plays"], 2)
            self.assertEqual(body["history_limit"], user_state.MAX_HISTORY)
            self.assertEqual(len(body["songs"]), 1)
            self.assertEqual(body["songs"][0]["job_id"], "job")
            self.assertEqual(body["songs"][0]["play_count"], 2)
            self.assertGreater(body["songs"][0]["last_played_at"], 0)
            # The browser refuses anything that is not a whole count and a real date.
            self.assertIsInstance(body["songs"][0]["play_count"], int)
            self.assertIsInstance(body["total_plays"], int)
            self.assertIsInstance(body["songs"][0]["last_played_at"], float)
            self.assertEqual(set(body), {"account_id", "songs", "total_plays", "history_limit"})

            other = client.get("/api/user/library-stats", headers=self.headers(self.bob, device))
            self.assertEqual([song["job_id"] for song in other.json()["songs"]], ["other"])
            self.assertEqual(other.json()["account_id"], self.bob.id)

            stale = self.headers(self.bob, device) | {"X-OpenK-Expected-Account": self.alice.id}
            conflict = client.get("/api/user/library-stats", headers=stale)
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(conflict.json()["detail"]["code"], "account_changed")

            self.assertEqual(client.get("/api/user/library-stats").status_code, 401)
            forged = headers | {"X-OpenK-Identity-Key": "wrong"}
            self.assertEqual(client.get("/api/user/library-stats", headers=forged).status_code, 401)
            guest = base64.urlsafe_b64encode(
                json.dumps({"id": self.alice.id, "expires_at": 1}).encode()).decode()
            self.assertEqual(client.get("/api/user/library-stats", headers={
                "X-OpenK-Identity-Key": self.key.decode(), "X-OpenK-Guest": guest,
            }).status_code, 401)

            with patch.object(user_state, "store", side_effect=OSError("read-only")), \
                    self.assertLogs(user_state._log, "WARNING"):
                unavailable = client.get("/api/user/library-stats", headers=headers)
            self.assertEqual(unavailable.status_code, 503)
            self.assertEqual(unavailable.json()["detail"], "暂时无法读取常唱统计，请稍后重试")

        # A standalone deployment has no accounts, so the feature does not exist.
        with patch.object(identity, "KEY", b""), \
                patch.object(user_state, "store", lambda: self.store), TestClient(self.app) as client:
            self.assertEqual(client.get("/api/user/library-stats").status_code, 404)
            self.assertEqual(client.get("/api/user/library-stats",
                                        headers=self.headers(self.alice)).status_code, 404)


class PlaybackHistoryFromRoomsTests(unittest.TestCase):
    """History is written from a validated player lease, not from a play command."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".room-history-test-", dir=PROJECT_ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.songs = Songs(self.root / "jobs")
        self.now = [100000.0]
        self.records = []
        self.state = user_state.UserStateStore(self.root / "user-state.sqlite3", lambda: self.now[0])
        self.store = rooms.RoomStore(self.root, self.songs, lambda: self.now[0],
                                     history=self.recorder)
        self.alice = Account("00000000-0000-4000-8000-000000000001", "alice", "Alice")
        self.bob = Account("00000000-0000-4000-8000-000000000002", "bob", "Bob")
        self.device = "a" * 32

    def recorder(self, account_id, **payload):
        self.records.append({"account_id": account_id, **payload})
        return user_state.observe(account_id, **payload)

    def heartbeat(self, room_id, token, player_token, **report):
        state = self.store.state(room_id, token)
        payload = {"current_id": (state["current"] or {}).get("id"),
                   "generation": state["playback"]["seek_version"],
                   "position": 0.0, "status": "playing", "device_id": self.device}
        return self.store.heartbeat(room_id, token, player_token, payload | report)

    def advance(self, seconds):
        """Move the fake clock the way real time moves between heartbeats."""
        self.now[0] += seconds

    def command(self, room_id, account, action, **payload):
        return self.store.command(room_id, account, {
            "action": action, "command_id": uuid.uuid4().hex, **payload})

    def paced(self, room_id, player, item, *, token=None, start=0.0, steps=3, step=2.0):
        """Report continuous playback: the position and the clock move together."""
        token = token or self.alice
        position = start
        self.heartbeat(room_id, token, player, current_id=item["id"], position=position)
        for _ in range(steps):
            self.advance(step)
            position += step
            self.heartbeat(room_id, token, player, current_id=item["id"], position=position)
        return position

    def armed(self, account=None, play=True):
        account = account or self.alice
        session = self.store.current(account)
        room_id = session["room_id"]
        self.command(room_id, account, "add", job_id="song-a")
        claim = self.store.claim(room_id, account)
        if play:
            self.command(room_id, account, "play")
        item = self.store.state(room_id, account)["current"]
        return room_id, claim["player_token"], item

    def total(self, account=None):
        return self.state.history(account or self.alice)["total"]

    def test_only_continuous_playback_creates_history(self):
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed()
            # A desired "playing" flag with no advancement is not evidence.
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=0.0)
            self.advance(1.5)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=1.5)
            self.assertEqual(self.total(), 0)
            # A blocked or paused receiver never records either.
            self.advance(1.5)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"],
                           position=3.0, status="blocked")
            self.advance(1.5)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"],
                           position=3.0, status="paused")
            self.assertEqual(self.total(), 0)
            self.assertEqual(self.records, [], "no write is even attempted without evidence")

            position = self.paced(room_id, player, item, start=3.0)
            history = self.state.history(self.alice)
            self.assertEqual(history["total"], 1)
            self.assertEqual(history["entries"][0]["title"], item["title"])
            self.assertEqual(history["entries"][0]["device_label"], "未知设备")
            self.assertLessEqual(history["entries"][0]["position"], position)

    def test_a_forward_seek_is_not_playback(self):
        """A seek moves the position without any audio being heard."""
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed()
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=0.0)
            self.command(room_id, self.alice, "seek", item_id=item["id"], position=3.5)
            # The room advanced its seek generation; the receiver follows it instantly.
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=3.5)
            self.assertEqual(self.total(), 0, "a seek with no elapsed time is not playback")
            for _ in range(3):
                self.advance(8)
                self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=3.5)
            self.assertEqual(self.total(), 0, "waiting at a seeked position is not playback")
            self.assertEqual(self.records, [])
            # Repeating the jump inside one generation stays unrecorded too.
            self.command(room_id, self.alice, "seek", item_id=item["id"], position=60.0)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=60.0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=90.0)
            self.assertEqual(self.total(), 0, "the media cannot outrun the clock")
            # Only genuine playback after the seek is recorded.
            self.paced(room_id, player, item, start=90.0)
            self.assertEqual(self.total(), 1)

    def test_a_position_jump_without_elapsed_time_is_refused(self):
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed()
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=0.0)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=30.0)
            self.assertEqual(self.total(), 0, "zero elapsed time cannot produce history")
            self.advance(10)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=30.0)
            self.assertEqual(self.total(), 0, "a frozen position is not progress")
            # The window rebased on the jump, so honest playback still works afterwards.
            self.paced(room_id, player, item, start=30.0)
            self.assertEqual(self.total(), 1)

    def test_buffering_and_pausing_restart_the_evidence_window(self):
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed()
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=0.0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=2.0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"],
                           position=4.0, status="buffering")
            self.advance(2)
            # Resuming starts a new window: the earlier stretch cannot be reused.
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=6.0)
            self.assertEqual(self.total(), 0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=8.0)
            self.assertEqual(self.total(), 0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=10.0)
            self.assertEqual(self.total(), 1, "continuous playback after buffering is recorded")

    def test_a_paused_room_is_never_playback(self):
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed(play=False)
            self.paced(room_id, player, item)
            self.assertEqual(self.total(), 0, "a room that is not playing cannot produce history")
            self.assertEqual(self.records, [])
            self.command(room_id, self.alice, "play")
            self.paced(room_id, player, item, start=8.0)
            self.assertEqual(self.total(), 1)
            self.command(room_id, self.alice, "pause")
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=60.0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=62.0)
            entry = self.state.history(self.alice)["entries"][0]
            self.assertLess(entry["position"], 60.0, "a paused room cannot advance the record")

    def test_reloads_and_repeated_heartbeats_stay_one_entry(self):
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed()
            position = self.paced(room_id, player, item)
            self.assertEqual(self.total(), 1)
            for _ in range(3):
                self.advance(5)
                position += 5
                self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=position)
            # A reload takes a fresh lease for the same queue item.
            self.store.release(room_id, self.alice, player)
            player = self.store.claim(room_id, self.alice)["player_token"]
            self.command(room_id, self.alice, "play")
            self.advance(5)
            position = self.paced(room_id, player, item, start=position, step=5, steps=2)
            history = self.state.history(self.alice)
            self.assertEqual(history["total"], 1, "a reload continues the same play")
            recorded = history["entries"][0]["position"]
            self.assertTrue(0 < recorded <= position,
                            "progress is written at the throttled rate, never beyond the report")
            self.assertFalse(history["entries"][0]["completed"])

            self.store.ended(room_id, self.alice, player, {
                "command_id": uuid.uuid4().hex, "item_id": item["id"],
                "generation": self.store.state(room_id, self.alice)["playback"]["seek_version"],
                "device_id": self.device})
            finished = self.state.history(self.alice)["entries"][0]
            self.assertTrue(finished["completed"])
            self.assertEqual(finished["position"], position,
                             "completion records the last confirmed position")
            self.assertEqual(self.total(), 1)

    def test_history_names_the_device_and_stays_with_the_receiving_account(self):
        with patch.object(user_state, "store", lambda: self.state):
            self.state.register(self.alice, self.device, "Living room TV")
            party = self.store.create(account=self.alice, name="Party", discoverable=True,
                                      allow_screens=True)
            room_id = party["room_id"]
            self.store.current(self.bob)
            self.store.join(room_id, party["pairing_code"], account=self.bob)
            self.command(room_id, self.bob, "add", job_id="song-a")
            player = self.store.claim(room_id, self.alice)["player_token"]
            self.command(room_id, self.alice, "play")
            item = self.store.state(room_id, self.alice)["current"]
            self.paced(room_id, player, item)
            alice = self.state.history(self.alice)
            self.assertEqual(alice["total"], 1)
            self.assertEqual(alice["entries"][0]["device_label"], "Living room TV")
            # The song was requested by Bob but played by Alice's television.
            self.assertEqual(self.total(self.bob), 0)

    def test_paired_rooms_without_accounts_write_no_history(self):
        with patch.object(user_state, "store", lambda: self.state):
            created = self.store.create(display_name="TV")
            room_id, token = created["room_id"], created["host_token"]
            self.command(room_id, token, "add", job_id="song-a")
            player = self.store.claim(room_id, token)["player_token"]
            self.command(room_id, token, "play")
            item = self.store.state(room_id, token)["current"]
            self.paced(room_id, player, item, token=token)
            self.assertEqual(self.records, [])
            self.assertEqual(self.total(), 0)

    def test_restarting_the_same_queue_item_updates_one_entry(self):
        with patch.object(user_state, "store", lambda: self.state):
            room_id, player, item = self.armed()
            position = self.paced(room_id, player, item, start=60.0)
            self.assertEqual(self.total(), 1)
            recorded = self.state.history(self.alice)["entries"][0]["position"]
            self.assertTrue(60.0 < recorded <= position)
            self.command(room_id, self.alice, "restart", item_id=item["id"])
            self.advance(2)
            # The restart opened a new generation: it has to earn its own evidence.
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=0.0)
            self.advance(2)
            self.heartbeat(room_id, self.alice, player, current_id=item["id"], position=2.0)
            history = self.state.history(self.alice)
            self.assertEqual(history["total"], 1, "one queue entry is one play")
            self.assertEqual(history["entries"][0]["position"], recorded,
                             "progress keeps the furthest confirmed position")

    def test_a_failed_history_write_never_breaks_playback(self):
        with patch.object(user_state, "store", side_effect=OSError("no storage")), \
                self.assertLogs(user_state._log, "WARNING"):
            room_id, player, item = self.armed()
            self.paced(room_id, player, item)
            state = self.store.state(room_id, self.alice)
            self.assertTrue(state["player"]["online"])

    def test_room_snapshots_keep_their_schema_so_the_deployment_can_roll_back(self):
        """Settings and history live beside rooms.json, never inside it."""
        with patch.object(user_state, "store", lambda: self.state):
            self.state.register(self.alice, self.device, "Living room")
            room_id, player, item = self.armed()
            self.paced(room_id, player, item)
        self.assertEqual(self.state.history(self.alice)["total"], 1)

        text = (self.root / "rooms.json").read_text(encoding="utf-8")
        payload = json.loads(text)
        self.assertEqual(set(payload), {"schema", "rooms"})
        self.assertEqual(payload["schema"], 1)
        self.assertEqual(set(payload["rooms"][0]), {
            "id", "host", "pair", "controllers", "screens", "created_at", "updated_at", "revision",
            "queue", "current", "commands", "name", "discoverable", "allow_screens", "members",
            "invite_version", "account_mode", "playback",
        })
        for key in ("device_id", "progress", "lease", "seen_at", "preferred_player", "overrides",
                    "presence", "client_id", "devices", "roles"):
            self.assertNotIn(key, text, "room snapshots must not carry user-state fields")
        # The store an older image would build: no history sink, same file.
        rolled_back = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        self.assertEqual(len(rolled_back.rooms), 1)
        self.assertEqual(rolled_back.rooms[room_id]["current"]["id"], item["id"])
        self.assertIsNone(rolled_back.rooms[room_id]["lease"])
        # Settings and history are a separate file that an older image simply ignores.
        self.assertTrue(self.state.path.exists())
        self.state.path.unlink()
        self.assertEqual(len(rooms.RoomStore(self.root, self.songs, lambda: self.now[0]).rooms), 1)


class RoomDeviceProfileTests(unittest.TestCase):
    """Room device lists read the account's own registry and nothing else."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".room-device-test-", dir=PROJECT_ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.songs = Songs(self.root / "jobs")
        self.now = [100000.0]
        self.state = user_state.UserStateStore(self.root / "user-state.sqlite3", lambda: self.now[0])
        self.store = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        self.alice = Account("00000000-0000-4000-8000-000000000001", "alice", "Alice")
        self.bob = Account("00000000-0000-4000-8000-000000000002", "bob", "Bob")
        self.television = "c" * 32

    def presence(self, room_id, account, **body):
        payload = {"client_id": uuid.uuid4().hex, "device_id": None,
                   "label": "浏览器", "roles": ["controller"], **body}
        return self.store.presence(room_id, account, payload)

    def register(self, account, device, label, roles):
        snapshot = self.state.register(account, device, label)
        self.state.update_device(account, device, {"roles": roles},
                                 snapshot["device"]["revision"])

    def test_registered_browsers_name_themselves_from_their_own_account(self):
        with patch.object(user_state, "store", lambda: self.state):
            self.register(self.alice, self.television, "客厅电视", ["player"])
            self.register(self.bob, self.television, "鲍勃的电视", ["microphone"])
            seen = self.state.snapshot(self.alice, self.television)["device"]["last_seen_at"]
            room_id = self.store.current(self.alice)["room_id"]
            client = "e" * 32
            value = self.presence(room_id, self.alice, client_id=client,
                                  device_id=self.television, roles=["controller"])
            row = value["devices"][0]
            self.assertEqual(row["id"], value["presence_id"])
            self.assertEqual(row["name"], "客厅电视", "the account's own label wins")
            self.assertEqual(row["roles"], ["player", "controller"],
                             "assigned roles and live page roles combine")
            spare = self.presence(room_id, self.alice, device_id="d" * 32, label="备用手机",
                                  roles=["microphone"])
            rows = {item["id"]: item for item in spare["devices"]}
            self.assertEqual(rows[spare["presence_id"]]["name"], "备用手机",
                             "an unregistered browser reports only itself")
            self.assertEqual(rows[spare["presence_id"]]["roles"], ["microphone"])
            self.assertEqual(self.state.snapshot(self.alice, self.television)["device"]["last_seen_at"],
                             seen, "a room poll only reads the registry")
            # Renaming the device in the account settings reaches the room list at
            # the next poll, even for a page that did not make the change.
            snapshot = self.state.snapshot(self.alice, self.television)
            self.state.update_device(self.alice, self.television, {"label": "大电视"},
                                     snapshot["device"]["revision"])
            self.now[0] += 1.5
            renamed = self.presence(room_id, self.alice, client_id=client,
                                    device_id=self.television, roles=["controller"])
            named = {item["id"]: item["name"] for item in renamed["devices"]}
            self.assertEqual(named[renamed["presence_id"]], "大电视")
            self.assertNotIn("鲍勃的电视", json.dumps(renamed, ensure_ascii=False))
            self.assertEqual(self.state.snapshot(self.alice, self.television)["device"]["last_seen_at"],
                             seen, "a room poll still only reads the registry")

    def test_a_renamed_device_is_authoritative_over_a_stale_tab(self):
        with patch.object(user_state, "store", lambda: self.state):
            self.register(self.alice, self.television, "客厅电视", ["player"])
            room_id = self.store.current(self.alice)["room_id"]
            main, second = "a" * 32, "b" * 32
            for client in (main, second):
                value = self.presence(room_id, self.alice, client_id=client,
                                      device_id=self.television, label="客厅电视",
                                      roles=["controller"])
            self.assertEqual(value["devices"][0]["name"], "客厅电视")
            snapshot = self.state.snapshot(self.alice, self.television)
            self.state.update_device(self.alice, self.television,
                                     {"label": "大电视", "roles": ["player", "microphone"]},
                                     snapshot["device"]["revision"])
            self.now[0] += 2
            # The tab that renamed the device reports its new name, so the room
            # asks the registry again instead of waiting out the cache.
            fresh = self.presence(room_id, self.alice, client_id=main,
                                  device_id=self.television, label="大电视",
                                  roles=["controller"])
            self.assertEqual(fresh["devices"][0]["name"], "大电视")
            self.assertEqual(fresh["devices"][0]["roles"],
                             ["player", "controller", "microphone"])
            self.now[0] += 1
            # The other tab still advertises the name it cached before the rename.
            stale = self.presence(room_id, self.alice, client_id=second,
                                  device_id=self.television, label="客厅电视",
                                  roles=["controller"])
            self.assertEqual(len(stale["devices"]), 1)
            self.assertEqual(stale["devices"][0]["name"], "大电视",
                             "the stored name wins over a tab that has not noticed")
            snapshot = self.state.snapshot(self.alice, self.television)
            self.state.update_device(self.alice, self.television, {"roles": ["player"]},
                                     snapshot["device"]["revision"])
            self.now[0] += 1.5
            later = self.presence(room_id, self.alice, client_id=second,
                                  device_id=self.television, label="客厅电视",
                                  roles=["controller"])
            self.assertEqual(later["devices"][0]["roles"], ["player", "controller"],
                             "a withdrawn assignment is not remembered")

    def test_registry_changes_are_announced_only_after_their_transaction_commits(self):
        snapshots = []
        changed = user_state._directory_changed

        def observe():
            snapshots.append(self.state.device_profile(self.alice.id, self.television))
            changed()

        with patch.object(user_state, "_directory_changed", side_effect=observe):
            value = self.state.register(self.alice, self.television, "旧名称")
            value = self.state.update_device(self.alice, self.television,
                                             {"label": "新名称", "roles": []},
                                             value["device"]["revision"], self.television)
            self.state.save_topology(self.alice, self.television, value["revision"], self.television)
            self.state.remove_device(self.alice, self.television)
        self.assertEqual(snapshots, [
            {"label": "旧名称", "roles": ["controller"]},
            {"label": "新名称", "roles": []},
            {"label": "新名称", "roles": ["player"]},
            None,
        ], "a cache invalidation observer can already read the committed directory")

    def test_removed_profile_beats_a_stale_tab_even_at_the_same_clock_time(self):
        with patch.object(user_state, "store", lambda: self.state):
            self.register(self.alice, self.television, "旧的设备名称", ["microphone"])
            room_id = self.store.current(self.alice)["room_id"]
            for client in ("a" * 32, "b" * 32):
                self.presence(room_id, self.alice, client_id=client, device_id=self.television,
                              label="当前浏览器", roles=["controller"])
            self.state.remove_device(self.alice, self.television)
            value = self.presence(room_id, self.alice, client_id="a" * 32, device_id=self.television,
                                  label="当前浏览器", roles=["controller"])
            self.assertEqual(value["devices"][0]["name"], "当前浏览器")
            self.assertEqual(value["devices"][0]["roles"], ["controller"])

    def test_the_claiming_browser_is_the_player_and_history_follows_the_receiver(self):
        with patch.object(user_state, "store", lambda: self.state):
            self.register(self.alice, self.television, "客厅电视", ["player"])
            room_id = self.store.current(self.alice)["room_id"]
            client = "a" * 32
            screen = self.presence(room_id, self.alice, client_id=client,
                                   device_id=self.television, roles=["player"])
            phone = self.presence(room_id, self.alice, device_id="b" * 32, label="我的手机",
                                  roles=["controller"])
            started = self.store.command(room_id, self.alice, {
                "action": "add", "job_id": "song-a", "command_id": uuid.uuid4().hex})
            self.assertTrue(started["playback"]["playing"], "a queued list starts by itself")
            self.assertEqual(self.state.history(self.alice)["total"], 0,
                             "asking to play is not evidence that anything played")
            claim = self.store.claim(room_id, self.alice, client_id=client,
                                     device_id=self.television)
            rows = {row["id"]: row for row in claim["state"]["devices"]}
            self.assertTrue(rows[screen["presence_id"]]["player"])
            self.assertFalse(rows[phone["presence_id"]]["player"],
                             "another browser of the same account is not the player")
            self.store.command(room_id, self.alice,
                               {"action": "play", "command_id": uuid.uuid4().hex})
            state = self.store.state(room_id, self.alice)
            report = {"current_id": state["current"]["id"],
                      "generation": state["playback"]["seek_version"],
                      "position": 0.0, "status": "playing", "device_id": self.television}
            self.store.heartbeat(room_id, self.alice, claim["player_token"], report)
            for step in range(3):
                self.now[0] += 2
                self.store.heartbeat(room_id, self.alice, claim["player_token"],
                                     {**report, "position": 2.0 * (step + 1)})
            entry = self.state.history(self.alice)["entries"][0]
            self.assertEqual(entry["title"], state["current"]["title"])
            self.assertEqual(entry["device_label"], "客厅电视",
                             "history still names the receiver's own browser")
            playing = {row["id"]: row for row in self.store.state(room_id, self.alice)["devices"]}
            self.assertTrue(playing[screen["presence_id"]]["player"])
            self.store.release(room_id, self.alice, claim["player_token"])
            released = self.store.state(room_id, self.alice)
            self.assertFalse(any(row["player"] for row in released["devices"]))
            self.assertEqual(len(released["devices"]), 2, "releasing keeps both devices online")

    def test_an_unavailable_registry_is_reported_but_room_state_remains_readable(self):
        with patch.object(user_state, "store", side_effect=OSError("no storage")), \
                self.assertLogs(user_state._log, "WARNING"):
            room_id = self.store.current(self.alice)["room_id"]
            with self.assertRaises(HTTPException) as failed:
                self.presence(room_id, self.alice, device_id=self.television,
                              label="电视", roles=["player"])
            self.assertEqual(failed.exception.status_code, 503)
            self.assertEqual(self.store.state(room_id, self.alice)["devices"], [])

    def test_presence_is_never_written_to_disk_or_restored(self):
        with patch.object(user_state, "store", lambda: self.state):
            self.register(self.alice, self.television, "客厅电视", ["player"])
            room_id = self.store.current(self.alice)["room_id"]
            self.presence(room_id, self.alice, device_id=self.television, roles=["player"])
            text = (self.root / "rooms.json").read_text(encoding="utf-8")
            for private in (self.television, "客厅电视", "presence", "devices"):
                self.assertNotIn(private, text)
            restored = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
            self.assertEqual(restored.state(room_id, self.alice)["devices"], [])
            self.assertEqual(restored.connections, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
