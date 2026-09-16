#!/usr/bin/env python3
"""Authenticated users always enter a room; no live accounts or network required."""
from __future__ import annotations

import base64
import copy
from dataclasses import asdict, replace
import json
from pathlib import Path
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

from backend import identity, rooms
from backend.identity import Account
from tests.python.test_rooms import Songs


class AccountRoomTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix=".account-room-test-", dir=PROJECT_ROOT)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.songs = Songs(self.root / "jobs")
        self.now = [100000.0]
        # Registered browsers of synthetic accounts; the real registry is
        # exercised against a throwaway SQLite store in test_user_state.py.
        self.registered: dict[tuple[str, str], dict] = {}
        self.store = rooms.RoomStore(self.root, self.songs, lambda: self.now[0],
                                     profiles=lambda account_id, device:
                                     self.registered.get((account_id, device)))
        self.alice = Account("00000000-0000-4000-8000-000000000001", "alice", "Alice")
        self.bob = Account("00000000-0000-4000-8000-000000000002", "bob", "Bob")
        self.carol = Account("00000000-0000-4000-8000-000000000003", "carol", "Carol")
        self.key = b"test-only-identity-key-" + b"a" * 32

    def fails(self, code, function, *args, **kwargs):
        with self.assertRaises(HTTPException) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.status_code, code)
        return caught.exception

    def command(self, room_id, account, action, **payload):
        return self.store.command(room_id, account, {
            "action": action, "command_id": uuid.uuid4().hex, **payload,
        })

    def party(self, *members):
        created = self.store.create(account=self.alice, name="Party", discoverable=True, allow_screens=True)
        for member in members:
            self.store.current(member)
            self.store.join(created["room_id"], created["pairing_code"], account=member)
        return created

    def headers(self, account):
        return {
            "X-OpenK-Identity-Key": self.key.decode(),
            "X-OpenK-Account": base64.urlsafe_b64encode(json.dumps(asdict(account)).encode()).decode(),
        }

    def presence(self, room_id, account, after=None, **body):
        payload = {"client_id": uuid.uuid4().hex, "device_id": None,
                   "label": "浏览器", "roles": ["controller"], **body}
        return self.store.presence(room_id, account, payload, after)

    # --- live device presence in account rooms ------------------------------
    def test_one_browser_shared_by_two_accounts_stays_two_devices(self):
        party = self.party(self.bob)
        room_id = party["room_id"]
        browser = "c" * 32
        alice = self.presence(room_id, self.alice, device_id=browser, label="平板",
                              roles=["player"])
        bob = self.presence(room_id, self.bob, device_id=browser, label="平板",
                            roles=["controller"])
        self.assertNotEqual(alice["presence_id"], bob["presence_id"],
                            "one browser used by two people is two devices")
        rows = {row["id"]: row for row in bob["devices"]}
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[bob["presence_id"]]["member_id"], bob["viewer"]["id"])
        self.assertEqual(len({row["member_id"] for row in rows.values()}), 2)
        again = self.presence(room_id, self.alice, device_id=browser, label="平板",
                              roles=["microphone"])
        self.assertEqual(again["presence_id"], alice["presence_id"], "two tabs are one device")
        listed = {row["id"]: row for row in again["devices"]}
        self.assertEqual(len(listed), 2)
        self.assertEqual(listed[alice["presence_id"]]["roles"], ["player", "microphone"])
        serialized = json.dumps(again, ensure_ascii=False)
        for private in (self.alice.id, self.bob.id, browser, self.alice.username):
            self.assertNotIn(private, serialized)

    def test_presence_cannot_survive_a_move_or_revive_a_membership(self):
        party = self.party(self.bob)
        room_id = party["room_id"]
        self.presence(room_id, self.alice, device_id="d" * 32, label="电视", roles=["player"])
        bob = self.presence(room_id, self.bob, label="手机")
        self.assertEqual(len(self.store.state(room_id, self.bob)["devices"]), 2)
        moved = self.store.create(account=self.alice, name="New room")
        self.assertEqual(moved["state"]["devices"], [], "a new room starts with no devices")
        self.assertEqual([row["id"] for row in self.store.state(room_id, self.bob)["devices"]],
                         [bob["presence_id"]], "a departed account takes its devices with it")
        error = self.fails(409, self.store.presence, room_id, self.alice,
                           {"client_id": uuid.uuid4().hex, "label": "电视", "roles": ["player"]})
        self.assertEqual(error.detail["code"], "room_changed")
        self.assertEqual([row["id"] for row in self.store.state(room_id, self.bob)["devices"]],
                         [bob["presence_id"]], "a refused poll never adds a device")
        closed = self.store.close(room_id, self.bob)
        self.assertEqual(closed["current"]["state"]["devices"], [])
        self.assertEqual(self.store.connections, {}, "closing a room releases its connections")

    def test_registered_devices_prefer_their_own_account_profile(self):
        room_id = self.store.current(self.alice)["room_id"]
        browser = "e" * 32
        self.registered[(self.alice.id, browser)] = {"label": "客厅电视", "roles": ["player"]}
        self.registered[(self.bob.id, browser)] = {"label": "鲍勃的电视", "roles": ["microphone"]}
        value = self.presence(room_id, self.alice, device_id=browser, label="浏览器",
                              roles=["controller"])
        row = value["devices"][0]
        self.assertEqual(row["name"], "客厅电视", "the account's own name wins over a page default")
        self.assertEqual(row["roles"], ["player", "controller"],
                         "assigned roles and live page roles combine")
        spare = self.presence(room_id, self.alice, device_id="1" * 32, label="备用手机",
                              roles=["microphone"])
        rows = {item["id"]: item for item in spare["devices"]}
        self.assertEqual(rows[spare["presence_id"]]["name"], "备用手机",
                         "an unregistered browser reports itself and nothing else")
        self.assertEqual(rows[spare["presence_id"]]["roles"], ["microphone"])

    def test_invalid_or_unreadable_profiles_are_reported_without_replacing_last_good_presence(self):
        room_id = self.store.current(self.alice)["room_id"]
        client = "7" * 32
        self.registered[(self.alice.id, "2" * 32)] = {"label": "  ", "roles": ["player", "fake"]}
        self.fails(503, self.presence, room_id, self.alice, client_id=client, device_id="2" * 32,
                   label="电视", roles=["controller"])
        self.assertEqual(self.store.state(room_id, self.alice)["devices"], [])
        self.registered[(self.alice.id, "2" * 32)] = {"label": "客厅电视", "roles": ["player"]}
        value = self.presence(room_id, self.alice, client_id=client, device_id="2" * 32,
                              label="电视", roles=["controller"])
        self.assertEqual(value["devices"][0]["name"], "客厅电视")
        self.assertEqual(value["devices"][0]["roles"], ["player", "controller"])
        self.store.profiles = lambda *_: (_ for _ in ()).throw(OSError("registry offline"))
        self.now[0] += self.store.PROFILE_SECONDS + 1
        for _ in range(2):
            self.fails(503, self.presence, room_id, self.alice, client_id=client, device_id="2" * 32,
                       label="其他名字", roles=["microphone"])
        saved = self.store.state(room_id, self.alice)["devices"][0]
        self.assertEqual(saved["name"], "客厅电视")
        self.assertEqual(saved["roles"], ["player", "controller"])

    def test_presence_http_requires_the_authenticated_hop_and_the_members_own_room(self):
        app = FastAPI()
        app.include_router(identity.router)
        app.include_router(rooms.router)
        with patch.object(identity, "KEY", self.key), patch.object(rooms, "store", self.store), \
                TestClient(app) as client:
            current = client.post("/api/rooms/current", headers=self.headers(self.alice)).json()
            base = "/api/rooms/" + current["room_id"]
            body = {"client_id": "a" * 32, "device_id": "b" * 32, "label": "客厅电视",
                    "roles": ["player", "microphone"]}
            self.assertEqual(client.post(base + "/presence", json=body).status_code, 401)
            self.assertEqual(client.post(base + "/presence", json=body, headers={
                "Authorization": "Bearer guessed"}).status_code, 401)
            self.fails(403, self.store.presence, current["room_id"], "a-pairing-token", body)
            value = client.post(base + "/presence", headers=self.headers(self.alice), json=body)
            self.assertEqual(value.status_code, 200)
            self.assertEqual(value.headers["cache-control"], "no-store")
            listed = value.json()
            self.assertEqual(listed["presence_id"], listed["devices"][0]["id"])
            self.assertEqual(listed["devices"][0]["roles"], ["player", "microphone"])
            for private in (self.alice.id, "b" * 32, "a" * 32):
                self.assertNotIn(private, json.dumps(listed, ensure_ascii=False))
            other = client.post(base + "/presence", headers=self.headers(self.bob), json=body)
            self.assertEqual(other.status_code, 409)
            self.assertEqual(other.json()["detail"]["code"], "room_changed")
            self.assertEqual(client.request("DELETE", base + "/presence/" + "a" * 32,
                                            headers=self.headers(self.bob)).status_code, 409)
            self.assertEqual(len(client.get(base, headers=self.headers(self.alice))
                                 .json()["devices"]), 1)
            removed = client.request("DELETE", base + "/presence/" + "a" * 32,
                                     headers=self.headers(self.alice))
            self.assertEqual(removed.status_code, 200)
            self.assertEqual(removed.json()["devices"], [])

    def test_current_creates_private_solo_and_resumes_on_another_device(self):
        first = self.store.current(self.alice)
        self.assertTrue(first["account_mode"])
        self.assertTrue(first["state"]["solo"])
        self.assertFalse(first["state"]["discoverable"])
        self.assertTrue(first["state"]["allow_screens"])
        self.assertEqual(first["role"], "host")
        self.assertEqual(first["state"]["viewer"]["name"], "Alice")
        self.assertEqual(first["state"]["members"], [first["state"]["viewer"]])
        self.assertNotIn("host_token", first)
        self.assertNotIn("token", first)
        second = self.store.current(replace(self.alice))
        self.assertEqual(first["room_id"], second["room_id"])
        self.assertEqual(first["state"]["viewer"]["id"], second["state"]["viewer"]["id"])
        self.assertNotIn("pairing_code", second)
        self.assertEqual(len(self.store.rooms), 1)
        self.assertEqual(self.store.directory(self.alice), [])
        self.assertNotIn(first["pairing_code"], self.store.path.read_text())

    def test_join_moves_only_after_valid_code_and_does_not_trust_nickname(self):
        old = self.store.current(self.bob)
        queued = self.command(old["room_id"], self.bob, "add", job_id="song-a")
        target = self.party()
        wrong = "000000" if target["pairing_code"] != "000000" else "000001"
        self.fails(403, self.store.join, target["room_id"], wrong, account=self.bob)
        self.assertEqual(self.store.current(self.bob)["room_id"], old["room_id"])
        self.assertEqual(self.store.state(old["room_id"], self.bob)["current"], queued["current"])
        joined = self.store.join(target["room_id"], target["pairing_code"],
                                 display_name="Alice", account=self.bob)
        self.assertEqual(joined["state"]["viewer"]["name"], "Bob")
        self.assertEqual(joined["role"], "controller")
        self.assertFalse(joined["state"]["solo"])
        self.assertNotIn(old["room_id"], self.store.rooms)
        self.assertEqual(self.store.current(self.bob)["room_id"], target["room_id"])
        repeated = self.store.join(target["room_id"], target["pairing_code"],
                                   role="screen", account=replace(self.bob))
        self.assertEqual(len(repeated["state"]["members"]), 2)
        self.assertEqual(len(self.store.rooms[target["room_id"]]["controllers"]), 1)

    def test_create_moves_all_devices_and_leaves_other_members_in_the_party(self):
        party = self.party(self.bob)
        self.command(party["room_id"], self.bob, "add", job_id="song-a")
        replacement = self.store.create(account=self.alice, name="Next room")
        self.assertNotEqual(replacement["room_id"], party["room_id"])
        self.assertEqual(self.store.current(replace(self.alice))["room_id"], replacement["room_id"])
        error = self.fails(409, self.store.state, party["room_id"], self.alice)
        self.assertEqual(error.detail["code"], "room_changed")
        remaining = self.store.state(party["room_id"], self.bob)
        self.assertEqual(remaining["viewer"]["role"], "host")
        self.assertEqual(remaining["current"]["job_id"], "song-a")
        self.assertEqual(len(remaining["members"]), 1)
        self.fails(409, self.store.close, party["room_id"], self.alice)

    def test_leaving_releases_only_the_departing_accounts_player(self):
        party = self.party(self.bob, self.carol)
        room_id = party["room_id"]
        self.command(room_id, self.alice, "add", job_id="song-a")
        self.store.claim(room_id, self.bob)
        self.command(room_id, self.bob, "play")
        alice_solo = self.store.leave(room_id, self.alice)["current"]
        self.assertTrue(alice_solo["state"]["solo"])
        self.assertFalse(alice_solo["state"]["discoverable"])
        remaining = self.store.state(room_id, self.bob)
        self.assertEqual(remaining["viewer"]["role"], "host")
        self.assertTrue(remaining["player"]["online"])
        self.assertTrue(remaining["playback"]["playing"])
        bob_solo = self.store.leave(room_id, self.bob)["current"]
        self.assertNotEqual(bob_solo["room_id"], alice_solo["room_id"])
        remaining = self.store.state(room_id, self.carol)
        self.assertEqual(remaining["viewer"]["role"], "host")
        self.assertFalse(remaining["player"]["online"])
        self.assertFalse(remaining["playback"]["playing"])
        self.assertEqual(remaining["current"]["singers"], [])

    def test_leaving_an_existing_private_solo_room_is_idempotent(self):
        solo = self.store.current(self.alice)
        state = self.command(solo["room_id"], self.alice, "add", job_id="song-a")
        response = self.store.leave(solo["room_id"], self.alice)
        self.assertFalse(response["left"])
        self.assertEqual(response["current"]["room_id"], solo["room_id"])
        self.assertEqual(response["current"]["state"]["current"], state["current"])

    def test_host_transfer_prefers_a_member_still_online(self):
        party = self.party(self.bob, self.carol)
        self.now[0] += self.store.MEMBER_SECONDS + 1
        self.store.state(party["room_id"], self.carol)
        self.store.leave(party["room_id"], self.alice)
        state = self.store.state(party["room_id"], self.carol)
        self.assertEqual(state["viewer"]["role"], "host")
        self.assertEqual(self.store.state(party["room_id"], self.bob)["viewer"]["role"], "controller")

    def test_disband_returns_every_member_to_an_independent_private_room(self):
        party = self.party(self.bob, self.carol)
        self.fails(403, self.store.close, party["room_id"], self.bob)
        result = self.store.close(party["room_id"], self.alice)
        self.assertTrue(result["closed"])
        self.assertNotIn(party["room_id"], self.store.rooms)
        current = [self.store.current(member) for member in (self.alice, self.bob, self.carol)]
        self.assertEqual(len({room["room_id"] for room in current}), 3)
        self.assertEqual(result["current"]["room_id"], current[0]["room_id"])
        for room in current:
            self.assertEqual(room["role"], "host")
            self.assertTrue(room["state"]["solo"])
            self.assertFalse(room["state"]["discoverable"])
            self.assertFalse(room["state"]["player"]["online"])
            self.assertEqual(room["state"]["queue"], [])
        self.assertEqual(self.store.directory(self.alice), [])

    def test_capacity_reserves_a_solo_slot_so_existing_members_can_always_leave(self):
        self.store.MAX_ROOMS = 3
        party = self.party(self.bob, self.carol)
        newcomer = replace(self.carol, id="00000000-0000-4000-8000-000000000004")
        self.fails(429, self.store.current, newcomer)
        self.store.leave(party["room_id"], self.bob)
        self.store.close(party["room_id"], self.alice)
        self.assertEqual(len(self.store.rooms), 3)
        for member in (self.alice, self.bob, self.carol):
            self.assertTrue(self.store.current(member)["state"]["solo"])

    def test_failed_move_or_disband_preserves_all_old_memberships(self):
        party = self.party(self.bob, self.carol)
        before = copy.deepcopy(self.store.rooms)
        self.fails(422, self.store.create, account=self.alice, name="")
        self.assertEqual(self.store.rooms, before)
        for operation in (
            lambda: self.store.create(account=self.alice, name="Replacement"),
            lambda: self.store.leave(party["room_id"], self.bob),
            lambda: self.store.close(party["room_id"], self.alice),
        ):
            with patch.object(Path, "replace", side_effect=OSError("read-only fixture")):
                self.fails(503, operation)
            self.assertEqual(self.store.rooms, before)

    def test_account_profile_names_are_stable_across_devices_and_persisted(self):
        party = self.party(self.bob)
        room_id = party["room_id"]
        initial = self.command(room_id, self.bob, "add", job_id="song-a")
        member_id = initial["viewer"]["id"]
        updated = self.store.current(replace(self.bob, display_name="测试歌手"))
        self.assertEqual(updated["state"]["viewer"]["id"], member_id)
        self.assertEqual(updated["state"]["viewer"]["name"], "测试歌手")
        self.assertEqual(updated["state"]["current"]["requested_by"]["name"], "测试歌手")
        self.assertEqual(updated["state"]["current"]["singers"][0]["name"], "测试歌手")
        self.fails(409, self.store.update_member, room_id, self.bob, "Impersonation")
        reloaded = rooms.RoomStore(self.root, self.songs, lambda: self.now[0])
        restored = reloaded.current(replace(self.bob, display_name="测试歌手"))
        self.assertEqual(restored["room_id"], room_id)
        self.assertEqual(restored["state"]["viewer"]["id"], member_id)
        self.assertFalse(restored["state"]["player"]["online"])

    def test_other_account_and_legacy_bearer_cannot_use_a_room(self):
        solo = self.store.current(self.alice)
        other = self.store.current(self.bob)
        self.fails(409, self.store.state, solo["room_id"], self.bob)
        self.fails(403, self.store.state, solo["room_id"], "account:" + self.alice.id)
        self.fails(409, self.store.close, other["room_id"], replace(self.alice, is_staff=True))
        legacy = self.store.create()
        self.fails(403, self.store.join, legacy["room_id"], legacy["pairing_code"], account=self.alice)
        self.fails(403, self.store.join, solo["room_id"], solo["pairing_code"])
        self.assertNotIn(legacy["room_id"], [room["id"] for room in self.store.directory(self.alice)])

    def test_invitation_rotation_does_not_rotate_account_identity(self):
        party = self.party(self.bob)
        room_id = party["room_id"]
        old_id = self.store.current(self.alice)["state"]["viewer"]["id"]
        self.fails(403, self.store.invitation, room_id, self.bob)
        invitation = self.store.invitation(room_id, self.alice)
        self.assertNotEqual(invitation["pairing_code"], party["pairing_code"])
        self.assertEqual(invitation["state"]["invite_version"], party["state"]["invite_version"] + 1)
        self.assertEqual(self.store.current(replace(self.alice))["state"]["invite_version"],
                         invitation["state"]["invite_version"])
        self.assertEqual(invitation["state"]["viewer"]["id"], old_id)
        self.fails(403, self.store.join, room_id, party["pairing_code"], account=self.carol)
        joined = self.store.join(room_id, invitation["pairing_code"], account=self.carol)
        self.assertEqual(joined["room_id"], room_id)
        self.assertNotIn(invitation["pairing_code"], self.store.path.read_text())

    def test_screen_permission_and_one_player_are_room_scoped(self):
        party = self.party(self.bob)
        room_id = party["room_id"]
        self.store.update(room_id, self.alice, {"allow_screens": False})
        self.fails(403, self.store.claim, room_id, self.bob)
        self.store.update(room_id, self.alice, {"allow_screens": True})
        player = self.store.claim(room_id, self.bob)["player_token"]
        self.fails(409, self.store.claim, room_id, replace(self.bob))
        self.fails(409, self.store.release, room_id, self.alice, player)
        separate = self.store.current(self.carol)
        self.store.claim(separate["room_id"], self.carol)
        state = self.store.update(room_id, self.alice, {"allow_screens": False})
        self.assertFalse(state["player"]["online"])
        self.assertTrue(self.store.state(separate["room_id"], self.carol)["player"]["online"])

    def test_http_identity_requires_authenticated_hop_and_not_browser_claims(self):
        app = FastAPI()
        app.include_router(identity.router)
        app.include_router(rooms.router)
        with patch.object(identity, "KEY", self.key), patch.object(rooms, "store", self.store), TestClient(app) as client:
            self.assertEqual(client.get("/api/account").status_code, 401)
            self.assertEqual(client.post("/api/rooms/current").status_code, 401)
            forged = self.headers(self.alice) | {"X-OpenK-Identity-Key": "wrong"}
            self.assertEqual(client.get("/api/account", headers=forged).status_code, 401)
            self.assertEqual(client.post("/api/rooms", headers=forged, json={}).status_code, 401)
            invalid = self.headers(self.alice) | {"X-OpenK-Account": "not base64"}
            self.assertEqual(client.get("/api/account", headers=invalid).status_code, 401)
            info = client.get("/api/account", headers=self.headers(self.alice))
            self.assertEqual(info.status_code, 200)
            self.assertIn("no-store", info.headers["cache-control"])
            self.assertEqual(info.json()["user"], asdict(self.alice))
            unpadded = self.headers(self.alice)
            unpadded["X-OpenK-Account"] = unpadded["X-OpenK-Account"].rstrip("=")
            self.assertEqual(client.get("/api/account", headers=unpadded).json()["user"], asdict(self.alice))
            current = client.post("/api/rooms/current", headers=self.headers(self.alice)).json()
            base = "/api/rooms/" + current["room_id"]
            self.assertEqual(client.get(base, headers=self.headers(self.alice)).status_code, 200)
            self.assertEqual(client.get(base, headers=self.headers(self.bob)).json()["detail"]["code"], "room_changed")
            self.assertEqual(client.get(base, headers={"Authorization": "Bearer account:" + self.alice.id}).status_code, 401)
            posted = client.post(base + "/commands", headers=self.headers(self.alice),
                                 json={"action": "add", "job_id": "song-a", "command_id": "account-command"})
            self.assertEqual(posted.status_code, 200)
            self.assertEqual(posted.json()["current"]["requested_by"]["name"], "Alice")
            invitation = client.post(base + "/invitation", headers=self.headers(self.alice))
            self.assertEqual(invitation.status_code, 200)

    def test_cookie_switch_rejects_stale_room_requests_before_mutation(self):
        party = self.party(self.bob)
        app = FastAPI()
        app.include_router(identity.router)
        app.include_router(rooms.router)
        expected = self.headers(self.bob) | {"X-OpenK-Expected-Account": self.alice.id}
        with patch.object(identity, "KEY", self.key), patch.object(rooms, "store", self.store), TestClient(app) as client:
            before = copy.deepcopy(self.store.rooms)
            for path, body in (
                ("/api/rooms/current", None),
                ("/api/rooms", {"name": "Wrong account"}),
                (f"/api/rooms/{party['room_id']}/commands",
                 {"action": "add", "job_id": "song-a", "command_id": "stale-browser"}),
            ):
                response = client.post(path, headers=expected, json=body)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["detail"]["code"], "account_changed")
                self.assertEqual(self.store.rooms, before)
            actual = client.get("/api/account", headers=self.headers(self.bob)).json()
            self.assertEqual(actual["user"]["id"], self.bob.id)
            correct = self.headers(self.bob) | {"X-OpenK-Expected-Account": self.bob.id}
            self.assertEqual(client.post("/api/rooms/current", headers=correct).json()["room_id"],
                             party["room_id"])
            self.assertEqual(client.post("/api/rooms/current", headers={
                "X-OpenK-Expected-Account": self.bob.id,
            }).status_code, 401)

    def test_identity_payload_labels_types_and_uuid_are_validated(self):
        app = FastAPI()
        app.include_router(identity.router)
        with patch.object(identity, "KEY", self.key), TestClient(app) as client:
            values = [
                asdict(self.alice) | {"id": "alice"},
                asdict(self.alice) | {"id": 1},
                asdict(self.alice) | {"display_name": ""},
                asdict(self.alice) | {"display_name": "A\nB"},
                asdict(self.alice) | {"display_name": "x" * 41},
                asdict(self.alice) | {"username": "x" * 151},
                asdict(self.alice) | {"is_staff": "true"},
                asdict(self.alice) | {"extra": "untrusted"},
            ]
            for payload in values:
                with self.subTest(payload=payload):
                    headers = self.headers(self.alice) | {
                        "X-OpenK-Account": base64.urlsafe_b64encode(json.dumps(payload).encode()).decode(),
                    }
                    self.assertEqual(client.get("/api/account", headers=headers).status_code, 401)
            self.assertEqual(client.get("/api/account", headers=self.headers(
                replace(self.alice, display_name="中文昵称"))).json()["user"]["display_name"], "中文昵称")

    def test_explicit_standalone_mode_and_key_configuration(self):
        app = FastAPI()
        app.include_router(identity.router)
        app.include_router(rooms.router)
        with patch.object(identity, "KEY", b""), patch.object(rooms, "store", self.store), TestClient(app) as client:
            self.assertEqual(client.get("/api/account").json(), {"enabled": False})
            self.assertEqual(client.post("/api/rooms/current").status_code, 404)
            legacy = client.post("/api/rooms").json()
            self.assertIn("host_token", legacy)
        key_file = self.root / "fixture-key"
        key_file.write_bytes(self.key + b"\n")
        self.assertEqual(identity._load_key(str(key_file)), self.key)
        key_file.write_bytes(b"weak")
        with self.assertRaises(ValueError):
            identity._load_key(str(key_file))
        with self.assertRaises(OSError):
            identity._load_key(str(self.root / "missing-key"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
