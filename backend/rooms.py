"""LAN karaoke rooms. One API process owns the store; media remains in JOBS_DIR.

Thread-safe commands and atomic snapshots provide durable queue state. Player
leases/observations are deliberately not restored: a restarted TV must be armed
by a fresh user gesture. This is pairing, not an Internet-facing auth service.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import secrets
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field

from . import config
from .identity import Account, current_account
from .jobs import manager


def _digest(value: str | Account) -> str:
    if isinstance(value, Account):
        value = "account:" + value.id
    return hashlib.sha256(value.encode()).hexdigest()


def _fail(code: int, message: str) -> None:
    raise HTTPException(code, message)


def _user_state():
    """Functional device roles and the device registry live with account state.

    Imported lazily so a standalone deployment never touches account storage.
    """
    from . import user_state
    return user_state


class RoomStore:
    LEASE_SECONDS = 12
    MEMBER_SECONDS = 30
    IDLE_SECONDS = 12 * 3600
    MAX_AGE = 48 * 3600
    MAX_ROOMS = 64
    MAX_QUEUE = 200
    MAX_CONTROLLERS = 32
    MAX_SCREENS = 8
    MAX_COMMANDS = 256
    # Live browser connections. Presence describes who is connected right now, is
    # never written to rooms.json and grants nothing: every row is scoped to a
    # member credential that room membership already validated.
    MAX_PRESENCE = 128
    MAX_MEMBER_PRESENCE = 64
    PROFILE_SECONDS = 15.0
    # A validated lease must advance the media by this much, over at least this
    # much real time, inside one uninterrupted window before a queued song
    # becomes account playback history.
    PLAYBACK_EVIDENCE_SECONDS = 3.0
    HISTORY_REFRESH_SECONDS = 10.0

    def __init__(self, data_dir=None, jobs=None, clock=None, history=None, profiles=None):
        self.path = Path(data_dir or config.DATA_DIR) / "rooms.json"
        self.jobs = jobs or manager
        self.clock = clock or time.time
        self.history = history
        self.profiles = profiles
        self.lock = threading.RLock()
        self.rooms: dict[str, dict] = {}
        self.attempts: dict[str, list[float]] = {}
        # (member credential digest, connection id) -> volatile connection record.
        self.connections: dict[str, dict[tuple[str, str], dict]] = {}
        self.arrivals = 0
        self._load()
        self._committed = copy.deepcopy(self.rooms)

    def _load(self):
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("schema") != 1:
                return
            for room in payload.get("rooms", [])[:self.MAX_ROOMS]:
                if not isinstance(room, dict):
                    continue
                if not all(k in room for k in (
                    "id", "created_at", "updated_at", "host", "pair", "controllers",
                    "queue", "current", "playback", "revision", "commands",
                )):
                    continue
                if self._expired(room):
                    continue
                self._members(room)
                for member in room["members"].values():
                    member["seen_at"] = None
                room["lease"] = None
                room["playback"]["playing"] = False
                room["playback"]["seek_version"] += 1
                room["revision"] += 1
                self.rooms[room["id"]] = room
        except (OSError, ValueError, TypeError, KeyError):
            # A partial/corrupt NAS snapshot must not prevent the rest of OpenK starting.
            self.rooms = {}

    def _save(self):
        rooms = []
        for room in self.rooms.values():
            value = copy.deepcopy(room)
            value.pop("lease", None)
            for member in value.get("members", {}).values():
                member.pop("seen_at", None)
            rooms.append(value)
        target = self.path.with_suffix(".json.new")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with target.open("w", encoding="utf-8") as handle:
                json.dump({"schema": 1, "rooms": rooms}, handle, ensure_ascii=False)
                handle.flush()
                import os
                os.fsync(handle.fileno())
            target.replace(self.path)
        except OSError:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
            self.rooms = copy.deepcopy(self._committed)
            _fail(503, "房间状态无法保存，请检查 NAS 写入权限后重试")
        self._committed = copy.deepcopy(self.rooms)

    def _expired(self, room):
        now = self.clock()
        return (now - room["updated_at"] > self.IDLE_SECONDS
                or now - room["created_at"] > self.MAX_AGE)

    def _cleanup(self):
        expired = [key for key, room in self.rooms.items() if self._expired(room)]
        for key in expired:
            del self.rooms[key]
            self.attempts.pop(key, None)
        for key in list(self.connections):
            if key not in self.rooms:
                del self.connections[key]
        if expired:
            self._save()

    def _room(self, room_id):
        room = self.rooms.get(room_id)
        if room is None or self._expired(room):
            self._cleanup()
            _fail(404, "房间已过期，请在电视上创建新房间")
        return room

    @staticmethod
    def _label(value, limit, default=None):
        if value is None and default is not None:
            return default
        if (not isinstance(value, str) or not value.strip()
                or len(value.strip()) > limit
                or any(ord(character) < 32 or ord(character) == 127 for character in value)):
            _fail(422, "名称不能为空、过长或包含控制字符")
        return value.strip()

    def _members(self, room):
        room.setdefault("name", "Room " + room["id"])
        room.setdefault("discoverable", False)
        room.setdefault("allow_screens", False)
        room.setdefault("invite_version", 1)
        room.setdefault("screens", [])
        members = room.setdefault("members", {})
        credentials = [(room["host"], "host", "Host")]
        credentials.extend((value, "controller", f"Guest {index + 1}")
                           for index, value in enumerate(room["controllers"]))
        credentials.extend((value, "screen", f"TV {index + 1}")
                           for index, value in enumerate(room["screens"]))
        for hashed, role, name in credentials:
            members.setdefault(hashed, {
                # A room-scoped pseudonym is stable for old snapshots without exposing a capability.
                "id": _digest("openk-member:" + room["id"] + ":" + hashed)[:16],
                "name": name, "role": role, "seen_at": None,
            })
            members[hashed]["role"] = role

    def _auth(self, room, token, host=False, player=False):
        account = token if isinstance(token, Account) else None
        if bool(room.get("account_mode")) != bool(account):
            _fail(403, "房间登录方式已改变，请返回当前房间")
        hashed = _digest(token or "")
        is_host = secrets.compare_digest(hashed, room["host"])
        is_screen = hashed in room["screens"]
        if account and hashed not in room["members"]:
            raise HTTPException(409, {"code": "room_changed", "message": "当前房间已切换，正在返回你的房间"})
        if (not is_host and (host or hashed not in room["controllers"] and not is_screen)
                or player and not (is_host or is_screen or account and room["allow_screens"])):
            _fail(403, "配对凭据无效，请重新扫码")
        member = room["members"][hashed]
        if account:
            if member.get("account_id") != account.id:
                _fail(403, "房间成员与当前账号不一致")
            if member["name"] != account.display_name or member.get("username") != account.username:
                self._rename_member(room, member, account.display_name)
                member["username"] = account.username
                self._touch(room)
                self._save()
        member["seen_at"] = self.clock()
        room["updated_at"] = self.clock()
        return member

    @staticmethod
    def _rename_member(room, member, name):
        member["name"] = name
        for item in ([room["current"]] if room["current"] else []) + room["queue"]:
            values = item.get("singers", []) + ([item["requested_by"]] if item.get("requested_by") else [])
            for value in values:
                if value["id"] == member["id"]:
                    value["name"] = name

    def _member_public(self, member):
        seen = member.get("seen_at")
        return {key: member[key] for key in ("id", "name", "role")} | {
            "online": seen is not None and self.clock() - seen < self.MEMBER_SECONDS,
        }

    def _player_public(self, room):
        lease = room.get("lease")
        online = bool(lease and self.clock() - lease["seen_at"] < self.LEASE_SECONDS)
        owner = room["members"].get(lease.get("owner")) if lease else None
        return {
            "online": online, "status": lease["status"] if online else "offline",
            "position": self._position(room), "seen_at": lease["seen_at"] if lease else None,
            "member_id": owner["id"] if online and owner else None,
        }

    # --- live device presence ----------------------------------------------
    # A room member is one account or one pairing credential, so it cannot say
    # which browser is the television and which is the microphone. Presence adds
    # that view without touching membership: it is volatile, bounded, scoped to
    # an already authorized member, and it never confers a permission.
    @staticmethod
    def _presence_id(room, hashed, group):
        # Opaque and room-scoped: it names a device row without ever exposing the
        # account id, the browser installation id or the connection id.
        return _digest("openk-device:" + room["id"] + ":" + hashed + ":" + group)[:16]

    def _live_presence(self, room_id, create=False):
        """Expired connections and departed members disappear before anything reads them."""
        live = self.connections.get(room_id)
        if live is None:
            if not create:
                return {}
            live = self.connections[room_id] = {}
        now = self.clock()
        members = (self.rooms.get(room_id) or {}).get("members") or {}
        for key, entry in list(live.items()):
            if now - entry["seen_at"] >= self.MEMBER_SECONDS or key[0] not in members:
                del live[key]
        if not live and not create:
            self.connections.pop(room_id, None)
        return live

    def _forget_presence(self, room_id, hashed=None):
        live = self.connections.get(room_id)
        if live is None:
            return
        for key in [key for key in live if hashed is None or key[0] == hashed]:
            del live[key]
        if not live:
            self.connections.pop(room_id, None)

    def _registered(self, account_id, device):
        """The label and roles this account actually assigned to this browser."""
        if self.profiles is None:
            self.profiles = _user_state().device_profile
        try:
            value = self.profiles(account_id, device)
        except OSError as error:
            raise HTTPException(503, "暂时无法读取设备设置，请稍后重试") from error
        if value is None:
            return None
        if not isinstance(value, dict):
            _fail(503, "已保存的设备资料无效，请检查设备设置")
        try:
            label = self._label(value.get("label"), 40)
            roles = _user_state().roles(value.get("roles"))
        except HTTPException as error:
            raise HTTPException(503, "已保存的设备资料无效，请检查设备设置") from error
        return {"label": label, "roles": roles}

    def _profile(self, room, entry, live, changed=False):
        """Resolve the native registration for this member's own browser only."""
        if not room.get("account_mode") or not entry["device"]:
            entry.update(profile=None, profile_at=0.0, profile_version=-1)
            return
        now = self.clock()
        version = _user_state().directory_version()
        # One lookup serves every tab of one browser. A browser that reports a new
        # name, and any rename made in this process, refresh it at the next poll
        # instead of waiting out the interval.
        latest = max((value for value in live.values() if value["member"] == entry["member"]
                      and value["device"] == entry["device"]),
                     key=lambda value: (value["profile_version"], value["profile_at"]), default=None)
        if (not changed and latest and latest["profile_version"] == version
                and now - latest["profile_at"] < self.PROFILE_SECONDS):
            entry.update(profile=latest["profile"], profile_at=latest["profile_at"],
                         profile_version=version)
            return
        account_id = (room["members"].get(entry["member"]) or {}).get("account_id")
        profile = self._registered(account_id, entry["device"]) if account_id else None
        entry.update(profile=profile, profile_at=now, profile_version=version)

    def _register_presence(self, room, hashed, report):
        label = self._label(report.get("label"), 40)
        roles = _user_state().roles(report.get("roles") or [])
        device = report.get("device_id") or None
        client_id = report["client_id"]
        live = self._live_presence(room["id"], create=True)
        key = (hashed, client_id)
        entry, now = live.get(key), self.clock()
        if entry is None:
            if sum(item[0] == hashed for item in live) >= self.MAX_MEMBER_PRESENCE:
                _fail(429, "当前成员连接的页面过多，请关闭不用的页面后重试")
            if len(live) >= self.MAX_PRESENCE:
                _fail(429, "房间设备连接数量已达上限，请关闭不用的页面后重试")
            self.arrivals += 1
            # Device rows follow the order the connections arrived, which stays
            # stable even when several of them are seen in the same instant.
            entry = {"member": hashed, "order": self.arrivals, "device": None,
                     "label": None, "roles": [], "profile": None,
                     "profile_at": 0.0, "profile_version": -1}
        else:
            entry = dict(entry)
        renamed = (entry["device"], entry["label"], entry["roles"]) != (device, label, roles)
        entry.update(device=device, label=label, roles=roles, seen_at=now)
        self._profile(room, entry, live, renamed)
        live[key] = entry
        return self._presence_id(room, hashed, device or "client:" + client_id)

    def _presence_group(self, live, hashed, client_id, device_id):
        """Only this member's own live connection can be credited with playback."""
        for key, entry in sorted(live.items()):
            if key[0] == hashed and client_id and key[1] == client_id:
                return entry["device"] or "client:" + key[1]
        for key, entry in sorted(live.items()):
            if key[0] == hashed and device_id and entry["device"] == device_id:
                return device_id
        return None

    def _devices(self, room):
        """One row per live member device: tabs of one browser are one device."""
        lease = room.get("lease")
        live = self._live_presence(room["id"])
        if lease and not lease.get("presence"):
            # A user may activate before the first presence request has completed.
            group = self._presence_group(live, lease["owner"], lease.get("client_id"),
                                         lease.get("device_id"))
            if group:
                lease["presence"] = self._presence_id(room, lease["owner"], group)
        holder = (lease.get("presence")
                  if lease and self.clock() - lease["seen_at"] < self.LEASE_SECONDS else None)
        groups: dict[tuple[str, str], dict] = {}
        for (hashed, client_id), entry in sorted(live.items()):
            key = (hashed, entry["device"] or "client:" + client_id)
            group = groups.get(key)
            if group is None:
                group = groups[key] = {
                    "id": self._presence_id(room, hashed, key[1]),
                    "member_id": (room["members"].get(hashed) or {})["id"],
                    "order": entry["order"], "seen_at": entry["seen_at"],
                    "label": entry["label"], "roles": set(),
                    "profile": None, "profile_at": -1.0, "profile_version": -2,
                }
            group["order"] = min(group["order"], entry["order"])
            group["roles"].update(entry["roles"])
            if entry["seen_at"] >= group["seen_at"]:
                group.update(seen_at=entry["seen_at"], label=entry["label"])
            if ((entry["profile_version"], entry["profile_at"])
                    > (group["profile_version"], group["profile_at"])):
                # The freshest reading of the owner's own registry wins, so a rename
                # is never held back by another tab's cached copy of the old name.
                group.update(profile=entry["profile"], profile_at=entry["profile_at"],
                             profile_version=entry["profile_version"])
        now = self.clock()
        for group in groups.values():
            group["roles"].update((group["profile"] or {}).get("roles") or [])
        return [{
            "id": group["id"], "member_id": group["member_id"],
            "name": (group["profile"] or {}).get("label") or group["label"],
            "roles": [role for role in _user_state().ROLES if role in group["roles"]],
            "online": now - group["seen_at"] < self.MEMBER_SECONDS,
            "player": group["id"] == holder,
        } for group in sorted(groups.values(), key=lambda value: (value["order"], value["id"]))]

    def presence(self, room_id, token, report, after=None):
        """Refresh one browser connection of one member and return room state."""
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token)
            self._reconcile(room)
            group = self._register_presence(room, _digest(token), report)
            value = self._public(room, after, token)
            value["presence_id"] = group
            return value

    def drop_presence(self, room_id, token, client_id):
        """Close one connection of the calling member. Player leases are separate."""
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token)
            live = self._live_presence(room["id"])
            live.pop((_digest(token), client_id), None)
            if not live:
                self.connections.pop(room["id"], None)
            return self._public(room, token=token)

    def _release_player(self, room):
        room["playback"]["position"] = self._position(room)
        room["playback"]["playing"] = False
        room["lease"] = None

    def _touch(self, room):
        room["playback"]["position"] = self._position(room)
        room["revision"] += 1
        room["updated_at"] = self.clock()

    def _media_file(self, job_id, relative):
        if not isinstance(relative, str) or not relative:
            return None
        base = self.jobs.job_dir(job_id).resolve()
        candidate = (base / relative).resolve()
        if not candidate.is_relative_to(base) or not candidate.is_file():
            return None
        return "/media/" + quote(job_id, safe="") + "/" + quote(relative, safe="/")

    def _song(self, job_id):
        job = self.jobs.get(job_id)
        if not job or job.get("state") != "done":
            return None
        stems = job.get("stems") or {}
        instrumental = self._media_file(job_id, "stems/" + str(stems.get("instrumental") or ""))
        if not instrumental:
            return None
        media = {"instrumental": instrumental}
        for key, relative in (
            ("vocals", "stems/" + str(stems.get("vocals") or "")),
            ("lyrics", job.get("lyrics_file")),
        ):
            value = self._media_file(job_id, relative)
            if value:
                media[key] = value
        thumbnail = job.get("thumbnail")
        # Do not contact external artwork servers from paired screens.
        if isinstance(thumbnail, str) and not thumbnail.startswith(("http:", "https:")):
            marker = f"/jobs/{job_id}/"
            relative = thumbnail.split(marker, 1)[-1]
            if thumbnail.startswith(f"/media/{job_id}/"):
                relative = thumbnail[len(f"/media/{job_id}/"):]
            thumbnail = self._media_file(job_id, relative)
        else:
            thumbnail = None
        return {
            "job_id": job_id, "title": job.get("track") or job.get("title") or "未命名歌曲",
            "artist": job.get("artist") or "", "duration": job.get("duration") or 0,
            "thumbnail": thumbnail, "media": media,
        }

    def _advance(self, room):
        room["current"] = room["queue"].pop(0) if room["queue"] else None
        room["playback"]["position"] = 0
        room["playback"]["seek_version"] += 1

    def _reconcile(self, room):
        changed = False
        valid = []
        for item in room["queue"]:
            song = self._song(item["job_id"])
            if song:
                updated = self._refresh_item(item, song)
                changed = changed or updated != item
                valid.append(updated)
            else:
                changed = True
        room["queue"] = valid
        if room["current"]:
            song = self._song(room["current"]["job_id"])
            if not song:
                self._advance(room)
                changed = True
            else:
                updated = self._refresh_item(room["current"], song)
                changed = changed or updated != room["current"]
                room["current"] = updated
        lease = room.get("lease")
        if lease and self.clock() - lease["seen_at"] >= self.LEASE_SECONDS:
            room["playback"]["position"] = self._position(room)
            room["playback"]["playing"] = False
            room["lease"] = None
            changed = True
        if changed:
            self._touch(room)
            self._save()

    def _position(self, room):
        lease = room.get("lease")
        if (lease and lease["current_id"] == (room["current"] or {}).get("id")
                and lease["generation"] == room["playback"]["seek_version"]):
            return lease["position"]
        return room["playback"]["position"]

    @staticmethod
    def _refresh_item(item, song):
        return {"id": item["id"], **song, **{
            key: copy.deepcopy(item[key]) for key in ("requested_by", "singers") if key in item
        }}

    def _public(self, room, after=None, token=None):
        value = {
            "id": room["id"], "revision": room["revision"], "player": self._player_public(room),
            "name": room["name"], "discoverable": room["discoverable"],
            "allow_screens": room["allow_screens"], "observed_at": self.clock(),
            "invite_version": room["invite_version"],
            "account_mode": bool(room.get("account_mode")),
            "solo": bool(room.get("account_mode") and len(room["members"]) == 1),
            "members": [self._member_public(member) for member in room["members"].values()],
            "devices": self._devices(room),
            "expires_at": min(room["updated_at"] + self.IDLE_SECONDS,
                              room["created_at"] + self.MAX_AGE),
        }
        if token is not None:
            value["viewer"] = self._member_public(room["members"][_digest(token)])
        if after == room["revision"]:
            value["unchanged"] = True
        else:
            value.update(queue=copy.deepcopy(room["queue"]),
                         current=copy.deepcopy(room["current"]),
                         playback=copy.deepcopy(room["playback"]))
        return value

    def directory(self, account=None):
        with self.lock:
            self._cleanup()
            values = []
            for room in sorted(self.rooms.values(), key=lambda value: value["created_at"], reverse=True):
                if not room["discoverable"] or bool(room.get("account_mode")) != bool(account):
                    continue
                members = [self._member_public(member) for member in room["members"].values()]
                current = room["current"]
                player = self._player_public(room)
                values.append({
                    "id": room["id"], "name": room["name"], "allow_screens": room["allow_screens"],
                    "created_at": room["created_at"],
                    "expires_at": min(room["updated_at"] + self.IDLE_SECONDS,
                                      room["created_at"] + self.MAX_AGE),
                    "members_online": sum(member["online"] for member in members
                                          if member["role"] != "screen"),
                    "screens_online": sum(member["online"] for member in members
                                          if member["role"] == "screen"),
                    "queue_length": len(room["queue"]),
                    "player": {"online": player["online"], "status": player["status"]},
                    "current": {key: current[key] for key in ("title", "artist")} if current else None,
                })
            return values

    def _account_room(self, account):
        hashed = _digest(account)
        matches = [room for room in self.rooms.values()
                   if room.get("account_mode") and hashed in room["members"]]
        if len(matches) > 1:
            _fail(503, "账号房间状态冲突，请联系管理员")
        return matches[0] if matches else None

    def _admit(self, account=None):
        # Reserve a solo-room slot for each account even while it is in a party.
        # Leaving/disbanding must not strand existing members when rooms are full.
        accounts = {member["account_id"] for room in self.rooms.values()
                    if room.get("account_mode") for member in room["members"].values()}
        occupied = len(accounts) + sum(not room.get("account_mode") for room in self.rooms.values())
        if (account is None or account.id not in accounts) and occupied >= self.MAX_ROOMS:
            _fail(429, "房间名额已满，请稍后重试")

    def _session(self, room, account, code=None):
        value = {
            "account_mode": True, "account_id": account.id, "room_id": room["id"],
            "role": room["members"][_digest(account)]["role"],
            "state": self._public(room, token=account),
        }
        if code is not None:
            value["pairing_code"] = code
        return value

    def _fresh_room(self, token, name, display_name, discoverable, allow_screens):
        room_id = secrets.token_hex(5)
        while room_id in self.rooms:
            room_id = secrets.token_hex(5)
        code, now = f"{secrets.randbelow(1000000):06}", self.clock()
        account = token if isinstance(token, Account) else None
        room = {
            "id": room_id, "host": _digest(token), "pair": _digest(code),
            "controllers": [], "created_at": now, "updated_at": now, "revision": 1,
            "queue": [], "current": None, "lease": None, "commands": [],
            "name": name or (account.display_name + " 的房间" if account else "Room " + room_id),
            "discoverable": discoverable, "allow_screens": allow_screens,
            "account_mode": bool(account),
            "playback": {"playing": False, "guide": False, "position": 0, "seek_version": 0},
        }
        self._members(room)
        member = room["members"][room["host"]]
        member.update(name=display_name, seen_at=now)
        if account:
            member.update(account_id=account.id, username=account.username)
        return room, code

    def _move_account(self, account, destination):
        hashed = _digest(account)
        for room_id, room in list(self.rooms.items()):
            if room_id == destination or not room.get("account_mode") or hashed not in room["members"]:
                continue
            member = room["members"].pop(hashed)
            self._forget_presence(room_id, hashed)
            if room.get("lease") and room["lease"]["owner"] == hashed:
                self._release_player(room)
            for role in ("controllers", "screens"):
                if hashed in room[role]:
                    room[role].remove(hashed)
            if not room["members"]:
                del self.rooms[room_id]
                self.attempts.pop(room_id, None)
                self.connections.pop(room_id, None)
                continue
            if room["host"] == hashed:
                successor = next((key for key, value in room["members"].items()
                                  if self._member_public(value)["online"]), next(iter(room["members"])))
                room["controllers"].remove(successor)
                room["host"] = successor
                self._members(room)
            for item in ([room["current"]] if room["current"] else []) + room["queue"]:
                if "singers" in item:
                    item["singers"] = [value for value in item["singers"] if value["id"] != member["id"]]
            self._touch(room)

    def current(self, account):
        if not isinstance(account, Account):
            _fail(404, "当前部署未启用账号房间")
        with self.lock:
            self._cleanup()
            room = self._account_room(account)
            if room is None:
                return self.create(account=account, allow_screens=True)
            self._auth(room, account)
            self._reconcile(room)
            return self._session(room, account)

    def create(self, name=None, display_name=None, discoverable=False, allow_screens=False, account=None):
        with self.lock:
            if not isinstance(discoverable, bool) or not isinstance(allow_screens, bool):
                _fail(422, "房间设置无效")
            if name is not None:
                name = self._label(name, 60)
            display_name = account.display_name if account else self._label(display_name, 40, "Host")
            self._cleanup()
            self._admit(account)
            token = account or secrets.token_urlsafe(32)
            room, code = self._fresh_room(token, name, display_name, discoverable, allow_screens)
            if account:
                self._move_account(account, room["id"])
            self.rooms[room["id"]] = room
            self._save()
            if account:
                return self._session(room, account, code)
            return {"room_id": room["id"], "host_token": token, "pairing_code": code,
                    "state": self._public(room, token=token)}

    def join(self, room_id, code, display_name=None, role="controller", account=None):
        with self.lock:
            if role not in {"controller", "screen"}:
                _fail(422, "配对角色无效")
            name = account.display_name if account else self._label(
                display_name, 40, "TV" if role == "screen" else "Guest")
            room = self._room(room_id)
            if bool(room.get("account_mode")) != bool(account):
                _fail(403, "房间登录方式已改变，请重新创建或选择房间")
            now = self.clock()
            attempts = [t for t in self.attempts.get(room_id, []) if now - t < 60]
            self.attempts[room_id] = attempts
            if len(attempts) >= 8:
                _fail(429, "配对尝试过多，请一分钟后重试")
            if not secrets.compare_digest(_digest(code), room["pair"]):
                attempts.append(now)
                _fail(403, "配对码不正确")
            if role == "screen" and not room["allow_screens"]:
                _fail(403, "房主尚未允许其他电视加入，请先在房间设置中开启")
            if account and _digest(account) in room["members"]:
                self._auth(room, account)
                return self._session(room, account, code)
            credentials = room["screens"] if role == "screen" and not account else room["controllers"]
            limit = self.MAX_SCREENS if role == "screen" and not account else self.MAX_CONTROLLERS
            if len(credentials) >= limit:
                _fail(429, "本房间配对设备已满，请创建新房间")
            if account:
                self._admit(account)
            self._reconcile(room)
            token = account or secrets.token_urlsafe(32)
            credentials.append(_digest(token))
            self._members(room)
            if account:
                room["members"][_digest(account)].update(
                    account_id=account.id, username=account.username, name=name)
                self._move_account(account, room_id)
            self._auth(room, token)["name"] = name
            self._touch(room)
            self._save()
            if account:
                return self._session(room, account, code)
            return {("screen_token" if role == "screen" else "controller_token"): token,
                    "state": self._public(room, token=token)}

    def state(self, room_id, token, after=None):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token)
            self._reconcile(room)
            return self._public(room, after, token)

    def _dedupe(self, room, command_id, signature, legacy_signature=None):
        for entry in room["commands"]:
            if entry[0] == command_id:
                if entry[1] != signature and entry[1] != legacy_signature:
                    _fail(409, "同一命令编号不能用于不同操作")
                return True
        return False

    def _remember(self, room, command_id, signature):
        room["commands"].append([command_id, signature])
        room["commands"] = room["commands"][-self.MAX_COMMANDS:]

    def command(self, room_id, token, command):
        with self.lock:
            room = self._room(room_id)
            member = self._auth(room, token)
            self._reconcile(room)
            action = command["action"]
            if member["role"] == "screen" and action not in {
                "play", "pause", "guide", "seek", "restart", "next",
            }:
                _fail(403, "电视配对只能操作播放，点歌请使用手机加入房间")
            payload = {k: v for k, v in command.items()
                       if k not in {"command_id", "expected_revision"}}
            legacy = json.dumps(payload, sort_keys=True) if action == "add" else None
            if action in {"add", "sing", "unsing"}:
                payload["member_id"] = member["id"]
            signature = json.dumps(payload, sort_keys=True)
            if self._dedupe(room, command["command_id"], signature, legacy):
                return self._public(room, token=token)
            expected = command.get("expected_revision")
            if expected is not None and expected != room["revision"]:
                _fail(409, "队列已更新，请重试")
            if action == "add":
                song = self._song(command.get("job_id"))
                if not song:
                    _fail(422, "歌曲尚未就绪或伴奏文件已不存在")
                if len(room["queue"]) >= self.MAX_QUEUE:
                    _fail(422, "队列已满")
                singer = {key: member[key] for key in ("id", "name")}
                item = {"id": secrets.token_hex(8), **song,
                        "requested_by": singer, "singers": [dict(singer)]}
                room["queue"].append(item)
                if room["current"] is None:
                    self._advance(room)
                    # Starting an empty queue is what the singer asked for: an armed
                    # receiver has no current song to resume, so the first song asks
                    # for playback. Appending behind a paused song changes nothing.
                    room["playback"]["playing"] = True
            elif action in {"remove", "top"}:
                index = next((i for i, item in enumerate(room["queue"])
                              if item["id"] == command.get("item_id")), None)
                if index is None:
                    _fail(409, "歌曲已开始播放或已移出队列")
                item = room["queue"].pop(index)
                if action == "top":
                    room["queue"].insert(0, item)
            elif action == "clear":
                room["queue"] = []
            elif action in {"sing", "unsing"}:
                items = ([room["current"]] if room["current"] else []) + room["queue"]
                item = next((value for value in items if value["id"] == command.get("item_id")), None)
                if item is None:
                    _fail(409, "歌曲已切换或已移出队列")
                singers = [value for value in item.get("singers", []) if value["id"] != member["id"]]
                if action == "sing":
                    singers.append({key: member[key] for key in ("id", "name")})
                item["singers"] = singers
            elif action in {"next", "restart", "seek"}:
                if not room["current"] or command.get("item_id") != room["current"]["id"]:
                    _fail(409, "当前歌曲已切换")
                if action == "next":
                    self._advance(room)
                    # An explicit skip starts the next song, even after a pause.
                    room["playback"]["playing"] = room["current"] is not None
                else:
                    position = command.get("position", 0) if action == "seek" else 0
                    if not isinstance(position, (int, float)) or not math.isfinite(position) or position < 0:
                        _fail(422, "播放位置无效")
                    duration = room["current"].get("duration") or 86400
                    room["playback"]["position"] = min(position, duration)
                    room["playback"]["seek_version"] += 1
            elif action in {"play", "pause"}:
                room["playback"]["playing"] = action == "play"
            elif action == "guide":
                if not isinstance(command.get("enabled"), bool):
                    _fail(422, "请选择开启或关闭原唱")
                room["playback"]["guide"] = command["enabled"]
            else:
                _fail(422, "不支持的操作")
            self._remember(room, command["command_id"], signature)
            self._touch(room)
            self._save()
            return self._public(room, token=token)

    def update(self, room_id, token, options):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token, host=True)
            if not options or set(options) - {"name", "discoverable", "allow_screens"}:
                _fail(422, "请选择有效的房间设置")
            changes = dict(options)
            if "name" in changes:
                changes["name"] = self._label(changes["name"], 60)
            for flag in ("discoverable", "allow_screens"):
                if flag in changes and not isinstance(changes[flag], bool):
                    _fail(422, "房间设置无效")
            if changes.get("allow_screens") is False:
                if room.get("lease") and (room["lease"]["owner"] in room["screens"]
                        or room.get("account_mode") and room["lease"]["owner"] != room["host"]):
                    self._release_player(room)
                for hashed in room["screens"]:
                    room["members"].pop(hashed)
                room["screens"] = []
            room.update(changes)
            self._touch(room)
            self._save()
            return self._public(room, token=token)

    def update_member(self, room_id, token, display_name):
        name = self._label(display_name, 40)
        with self.lock:
            room = self._room(room_id)
            member = self._auth(room, token)
            if isinstance(token, Account):
                _fail(409, "请在个人资料中修改昵称，房间会自动更新")
            self._rename_member(room, member, name)
            self._touch(room)
            self._save()
            return self._public(room, token=token)

    def leave(self, room_id, token):
        with self.lock:
            room = self._room(room_id)
            member = self._auth(room, token)
            if isinstance(token, Account):
                if len(room["members"]) == 1 and not room["discoverable"]:
                    return {"left": False, "current": self._session(room, token)}
                return {"left": True, "current": self.create(account=token, allow_screens=True)}
            hashed = _digest(token)
            if room.get("lease") and room["lease"]["owner"] == hashed:
                self._release_player(room)
            self._forget_presence(room_id, hashed)
            if member["role"] != "host":
                credentials = room["screens"] if member["role"] == "screen" else room["controllers"]
                credentials.remove(hashed)
                del room["members"][hashed]
            else:
                member["seen_at"] = None
            for item in ([room["current"]] if room["current"] else []) + room["queue"]:
                if "singers" in item:
                    item["singers"] = [value for value in item["singers"] if value["id"] != member["id"]]
            self._touch(room)
            self._save()
            return {"left": True}

    def close(self, room_id, token):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token, host=True)
            if isinstance(token, Account):
                members = [Account(member["account_id"], member["username"], member["name"])
                           for member in room["members"].values()]
                del self.rooms[room_id]
                self.connections.pop(room_id, None)
                own_room, own_code = None, None
                for member in members:
                    solo, code = self._fresh_room(member, None, member.display_name, False, True)
                    if member.id == token.id:
                        own_room, own_code = solo, code
                    else:
                        solo["members"][_digest(member)]["seen_at"] = None
                    self.rooms[solo["id"]] = solo
                self._save()
                self.attempts.pop(room_id, None)
                return {"closed": True, "current": self._session(own_room, token, own_code)}
            del self.rooms[room_id]
            self._save()
            self.attempts.pop(room_id, None)
            self.connections.pop(room_id, None)
            return {"closed": True}

    def invitation(self, room_id, token):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token, host=True)
            code = f"{secrets.randbelow(1000000):06}"
            while secrets.compare_digest(room["pair"], _digest(code)):
                code = f"{secrets.randbelow(1000000):06}"
            room["pair"] = _digest(code)
            room["invite_version"] += 1
            self._touch(room)
            self._save()
            self.attempts.pop(room_id, None)
            return {"pairing_code": code, "state": self._public(room, token=token)}

    def claim(self, room_id, token, client_id=None, device_id=None):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token, player=True)
            self._reconcile(room)
            if room.get("lease"):
                _fail(409, "另一台电视正在播放；关闭旧屏幕后等待 12 秒")
            player_token = secrets.token_urlsafe(32)
            hashed = _digest(token)
            # Credit the browser that is actually receiving, not every device of
            # the account: an unproven claim simply names no device.
            group = self._presence_group(
                self._live_presence(room["id"]), hashed, client_id, device_id)
            room["playback"]["playing"] = False
            room["lease"] = {
                "token": _digest(player_token), "seen_at": self.clock(), "status": "ready",
                "owner": hashed,
                "presence": self._presence_id(room, hashed, group) if group else None,
                "client_id": client_id, "device_id": device_id,
                "position": room["playback"]["position"],
                "current_id": (room["current"] or {}).get("id"),
                "generation": room["playback"]["seek_version"],
            }
            self._touch(room)
            self._save()
            return {"player_token": player_token, "lease_seconds": self.LEASE_SECONDS,
                    "state": self._public(room, token=token)}

    def _player(self, room, token, player_token):
        self._auth(room, token, player=True)
        self._reconcile(room)
        lease = room.get("lease")
        if (not lease or not secrets.compare_digest(lease["token"], _digest(player_token or ""))
                or not secrets.compare_digest(lease["owner"], _digest(token))):
            _fail(409, "播放租约已过期，请在电视上重新启用")
        return lease

    def heartbeat(self, room_id, token, player_token, report):
        with self.lock:
            room = self._room(room_id)
            lease = self._player(room, token, player_token)
            if (report["current_id"] != (room["current"] or {}).get("id")
                    or report["generation"] != room["playback"]["seek_version"]):
                _fail(409, "歌曲状态已更新")
            position = report["position"]
            if not math.isfinite(position):
                _fail(422, "播放位置无效")
            lease.update(report)
            lease["seen_at"] = self.clock()
            self._observe(room, lease, report)
            # Activity can be volatile; queue/transport commands are the durable boundary.
            room["updated_at"] = self.clock()
            return self._public(room, room["revision"], token)

    def release(self, room_id, token, player_token):
        with self.lock:
            room = self._room(room_id)
            self._player(room, token, player_token)
            self._release_player(room)
            self._touch(room)
            self._save()
            return self._public(room, token=token)

    def ended(self, room_id, token, player_token, report):
        with self.lock:
            room = self._room(room_id)
            lease = self._player(room, token, player_token)
            signature = "ended:" + str(report["item_id"]) + ":" + str(report["generation"])
            if self._dedupe(room, report["command_id"], signature):
                return self._public(room, token=token)
            if (report["item_id"] == (room["current"] or {}).get("id")
                    and report["generation"] == room["playback"]["seek_version"]):
                self._complete(room, lease, report)
                self._advance(room)
                self._touch(room)
                self._remember(room, report["command_id"], signature)
                self._save()
            return self._public(room, token=token)

    # --- account playback history ------------------------------------------
    def _record(self):
        """Resolved lazily so a deployment without accounts never opens the store."""
        if self.history is None:
            from . import user_state
            self.history = user_state.observe
        return self.history

    def _receiver(self, room, lease):
        """The account whose own device holds the lease, or None outside account rooms."""
        if not room.get("account_mode") or not lease:
            return None
        member = room["members"].get(lease.get("owner")) or {}
        return member.get("account_id") or None

    def _observe(self, room, lease, report):
        """Evidence is continuous playback: the room wants to play, this validated
        receiver reports playing, and both the media position and the clock moved
        forward inside one uninterrupted window. Any seek, restart, pause, buffer
        or stop starts a new window, so a jump can never stand in for playing."""
        item = room["current"]
        account_id = self._receiver(room, lease)
        progress = lease.get("progress")
        if (not account_id or not item or report.get("status") != "playing"
                or not room["playback"]["playing"]):
            # Not confirmed playback: the next playing report has to earn a new window.
            if progress:
                progress["from"] = None
            return
        key = room["id"] + ":" + item["id"]
        now = self.clock()
        if (not progress or progress["key"] != key
                or progress["generation"] != report["generation"]):
            # A different song or a new seek generation is a different stretch of audio.
            lease["progress"] = {"key": key, "generation": report["generation"],
                                 "from": report["position"], "since": now,
                                 "at": progress["at"] if progress and progress.get("key") == key else 0.0}
            return
        if progress["from"] is None or report["position"] < progress["from"]:
            progress.update({"from": report["position"], "since": now})
            return
        advanced = report["position"] - progress["from"]
        elapsed = now - progress["since"]
        if advanced > elapsed + self.PLAYBACK_EVIDENCE_SECONDS:
            # The media cannot outrun the clock: treat the jump as a new window
            # instead of accepting it, or refusing this receiver forever.
            progress.update({"from": report["position"], "since": now})
            return
        if advanced < self.PLAYBACK_EVIDENCE_SECONDS or elapsed < self.PLAYBACK_EVIDENCE_SECONDS:
            return
        if progress["at"] and now - progress["at"] < self.HISTORY_REFRESH_SECONDS:
            return
        progress["at"] = now
        self._record()(account_id, device=report.get("device_id"), play_key=key, song={
            "job_id": item.get("job_id"), "title": item.get("title"),
            "artist": item.get("artist"), "duration": item.get("duration"),
        }, position=report["position"])

    def _complete(self, room, lease, report):
        """Completing only updates a play that was already confirmed by progress."""
        account_id = self._receiver(room, lease)
        if not account_id:
            return
        self._record()(account_id, device=report.get("device_id"),
                       play_key=room["id"] + ":" + str(report["item_id"]), song={},
                       position=lease.get("position") or 0, completed=True)


class CreateRoomRequest(BaseModel):
    model_config = {"extra": "forbid"}
    name: str | None = Field(default=None, max_length=60)
    display_name: str | None = Field(default=None, max_length=40)
    discoverable: bool = False
    allow_screens: bool = False


class RoomSettingsRequest(BaseModel):
    model_config = {"extra": "forbid"}
    name: str | None = Field(default=None, max_length=60)
    discoverable: bool | None = None
    allow_screens: bool | None = None


class MemberRequest(BaseModel):
    model_config = {"extra": "forbid"}
    display_name: str = Field(min_length=1, max_length=40)


class JoinRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    display_name: str | None = Field(default=None, max_length=40)
    role: Literal["controller", "screen"] = "controller"


class CommandRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=100)
    expected_revision: int | None = Field(default=None, ge=0)
    action: Literal["add", "remove", "top", "clear", "next", "restart", "seek", "play", "pause", "guide",
                    "sing", "unsing"]
    job_id: str | None = Field(default=None, max_length=100)
    item_id: str | None = Field(default=None, max_length=100)
    position: float = Field(default=0, ge=0, le=86400)
    enabled: bool | None = None


class HeartbeatRequest(BaseModel):
    current_id: str | None = Field(default=None, max_length=100)
    generation: int = Field(ge=0)
    position: float = Field(ge=0, le=86400)
    status: Literal["ready", "playing", "paused", "buffering", "blocked", "error"]
    # Names the browser installation that is actually making sound, so playback
    # history can say which of the account's devices played. Not a credential.
    device_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


class PresenceRequest(BaseModel):
    """One live browser connection of an already authorized member."""
    model_config = {"extra": "forbid"}
    client_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    device_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    label: str = Field(min_length=1, max_length=40)
    roles: list[str] = Field(default_factory=list, max_length=3)


class ClaimRequest(BaseModel):
    """Optional: which of the member's own browsers is taking the player lease."""
    model_config = {"extra": "forbid"}
    client_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    device_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


class EndedRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=100)
    item_id: str = Field(max_length=100)
    generation: int = Field(ge=0)
    device_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")


router = APIRouter(prefix="/api/rooms", tags=["rooms"])
store = RoomStore()


def _token(authorization: str | None = Header(default=None),
           account: Account | None = Depends(current_account)):
    if account is not None:
        return account
    if not authorization or not authorization.startswith("Bearer "):
        _fail(401, "请先配对房间")
    return authorization[7:]


def _private(response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"


@router.post("")
def create_room(response: Response, request: CreateRoomRequest | None = None,
                account: Account | None = Depends(current_account)):
    _private(response)
    return store.create(**(request.model_dump() if request else {}), account=account)


@router.get("")
def list_rooms(response: Response, account: Account | None = Depends(current_account)):
    _private(response)
    return {"rooms": store.directory(account)}


@router.post("/current")
def current_room(response: Response, account: Account | None = Depends(current_account)):
    _private(response)
    return store.current(account)


@router.post("/{room_id}/join")
def join_room(room_id: str, request: JoinRequest, response: Response,
              account: Account | None = Depends(current_account)):
    _private(response)
    return store.join(room_id, **request.model_dump(), account=account)


@router.patch("/{room_id}")
def update_room(room_id: str, request: RoomSettingsRequest, response: Response,
                token: str | Account = Depends(_token)):
    _private(response)
    return store.update(room_id, token, request.model_dump(exclude_unset=True))


@router.patch("/{room_id}/member")
def update_member(room_id: str, request: MemberRequest, response: Response,
                  token: str | Account = Depends(_token)):
    _private(response)
    return store.update_member(room_id, token, request.display_name)


@router.post("/{room_id}/leave")
def leave_room(room_id: str, response: Response, token: str | Account = Depends(_token)):
    _private(response)
    return store.leave(room_id, token)


@router.delete("/{room_id}")
def close_room(room_id: str, response: Response, token: str | Account = Depends(_token)):
    _private(response)
    return store.close(room_id, token)


@router.post("/{room_id}/invitation")
def room_invitation(room_id: str, response: Response, token: str | Account = Depends(_token)):
    _private(response)
    return store.invitation(room_id, token)


@router.get("/{room_id}")
def room_state(room_id: str, response: Response, after: int | None = Query(default=None, ge=0),
               token: str | Account = Depends(_token)):
    _private(response)
    return store.state(room_id, token, after)


@router.post("/{room_id}/commands")
def room_command(room_id: str, request: CommandRequest, response: Response,
                 token: str | Account = Depends(_token)):
    _private(response)
    return store.command(room_id, token, request.model_dump())


@router.post("/{room_id}/presence")
def room_presence(room_id: str, request: PresenceRequest, response: Response,
                  after: int | None = Query(default=None, ge=0),
                  token: str | Account = Depends(_token)):
    _private(response)
    return store.presence(room_id, token, request.model_dump(), after)


@router.delete("/{room_id}/presence/{client_id}")
def end_presence(room_id: str, client_id: str, response: Response,
                 token: str | Account = Depends(_token)):
    _private(response)
    return store.drop_presence(room_id, token, client_id)


@router.post("/{room_id}/player/claim")
def claim_player(room_id: str, response: Response, request: ClaimRequest | None = None,
                 token: str | Account = Depends(_token)):
    _private(response)
    return store.claim(room_id, token, **(request.model_dump() if request else {}))


@router.post("/{room_id}/player/heartbeat")
def player_heartbeat(room_id: str, request: HeartbeatRequest, response: Response,
                     token: str | Account = Depends(_token),
                     x_player_token: str | None = Header(default=None)):
    _private(response)
    return store.heartbeat(room_id, token, x_player_token, request.model_dump())


@router.post("/{room_id}/player/release")
def release_player(room_id: str, response: Response,
                   token: str | Account = Depends(_token),
                   x_player_token: str | None = Header(default=None)):
    _private(response)
    return store.release(room_id, token, x_player_token)


@router.post("/{room_id}/player/ended")
def player_ended(room_id: str, request: EndedRequest, response: Response,
                 token: str | Account = Depends(_token),
                 x_player_token: str | None = Header(default=None)):
    _private(response)
    return store.ended(room_id, token, x_player_token, request.model_dump())
