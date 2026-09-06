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

from fastapi import APIRouter, Header, HTTPException, Query, Response
from pydantic import BaseModel, Field

from . import config
from .jobs import manager


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _fail(code: int, message: str) -> None:
    raise HTTPException(code, message)


class RoomStore:
    LEASE_SECONDS = 12
    IDLE_SECONDS = 12 * 3600
    MAX_AGE = 48 * 3600
    MAX_ROOMS = 64
    MAX_QUEUE = 200
    MAX_CONTROLLERS = 32
    MAX_COMMANDS = 256

    def __init__(self, data_dir=None, jobs=None, clock=None):
        self.path = Path(data_dir or config.DATA_DIR) / "rooms.json"
        self.jobs = jobs or manager
        self.clock = clock or time.time
        self.lock = threading.RLock()
        self.rooms: dict[str, dict] = {}
        self.attempts: dict[str, list[float]] = {}
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
        if expired:
            self._save()

    def _room(self, room_id):
        room = self.rooms.get(room_id)
        if room is None or self._expired(room):
            self._cleanup()
            _fail(404, "房间已过期，请在电视上创建新房间")
        return room

    def _auth(self, room, token, host=False):
        hashed = _digest(token or "")
        is_host = secrets.compare_digest(hashed, room["host"])
        if not is_host and (host or hashed not in room["controllers"]):
            _fail(403, "配对凭据无效，请重新扫码")

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
                updated = {"id": item["id"], **song}
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
                updated = {"id": room["current"]["id"], **song}
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

    def _public(self, room, after=None):
        lease = room.get("lease")
        player = {
            "online": bool(lease), "status": lease["status"] if lease else "offline",
            "position": self._position(room), "seen_at": lease["seen_at"] if lease else None,
        }
        value = {
            "id": room["id"], "revision": room["revision"], "player": player,
            "expires_at": min(room["updated_at"] + self.IDLE_SECONDS,
                              room["created_at"] + self.MAX_AGE),
        }
        if after == room["revision"]:
            value["unchanged"] = True
        else:
            value.update(queue=copy.deepcopy(room["queue"]),
                         current=copy.deepcopy(room["current"]),
                         playback=copy.deepcopy(room["playback"]))
        return value

    def create(self):
        with self.lock:
            self._cleanup()
            if len(self.rooms) >= self.MAX_ROOMS:
                _fail(429, "房间数量已达上限，请稍后重试")
            token, code, room_id = secrets.token_urlsafe(32), f"{secrets.randbelow(1000000):06}", secrets.token_hex(5)
            now = self.clock()
            room = {
                "id": room_id, "host": _digest(token), "pair": _digest(code),
                "controllers": [], "created_at": now, "updated_at": now, "revision": 1,
                "queue": [], "current": None, "lease": None, "commands": [],
                "playback": {"playing": False, "guide": False, "position": 0, "seek_version": 0},
            }
            self.rooms[room_id] = room
            self._save()
            return {"room_id": room_id, "host_token": token, "pairing_code": code,
                    "state": self._public(room)}

    def join(self, room_id, code):
        with self.lock:
            room = self._room(room_id)
            now = self.clock()
            attempts = [t for t in self.attempts.get(room_id, []) if now - t < 60]
            self.attempts[room_id] = attempts
            if len(attempts) >= 8:
                _fail(429, "配对尝试过多，请一分钟后重试")
            attempts.append(now)
            if not secrets.compare_digest(_digest(code), room["pair"]):
                _fail(403, "配对码不正确")
            if len(room["controllers"]) >= self.MAX_CONTROLLERS:
                _fail(429, "本房间配对设备已满，请创建新房间")
            token = secrets.token_urlsafe(32)
            room["controllers"].append(_digest(token))
            self._touch(room)
            self._reconcile(room)
            self._save()
            return {"controller_token": token, "state": self._public(room)}

    def state(self, room_id, token, after=None):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token)
            self._reconcile(room)
            return self._public(room, after)

    def _dedupe(self, room, command_id, signature):
        for entry in room["commands"]:
            if entry[0] == command_id:
                if entry[1] != signature:
                    _fail(409, "同一命令编号不能用于不同操作")
                return True
        return False

    def _remember(self, room, command_id, signature):
        room["commands"].append([command_id, signature])
        room["commands"] = room["commands"][-self.MAX_COMMANDS:]

    def command(self, room_id, token, command):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token)
            self._reconcile(room)
            signature = json.dumps({k: v for k, v in command.items()
                                    if k not in {"command_id", "expected_revision"}}, sort_keys=True)
            if self._dedupe(room, command["command_id"], signature):
                return self._public(room)
            expected = command.get("expected_revision")
            if expected is not None and expected != room["revision"]:
                _fail(409, "队列已更新，请重试")
            action = command["action"]
            if action == "add":
                song = self._song(command.get("job_id"))
                if not song:
                    _fail(422, "歌曲尚未就绪或伴奏文件已不存在")
                if len(room["queue"]) >= self.MAX_QUEUE:
                    _fail(422, "队列已满")
                item = {"id": secrets.token_hex(8), **song}
                room["queue"].append(item)
                if room["current"] is None:
                    self._advance(room)
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
            elif action in {"next", "restart", "seek"}:
                if not room["current"] or command.get("item_id") != room["current"]["id"]:
                    _fail(409, "当前歌曲已切换")
                if action == "next":
                    self._advance(room)
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
            return self._public(room)

    def claim(self, room_id, token):
        with self.lock:
            room = self._room(room_id)
            self._auth(room, token, host=True)
            self._reconcile(room)
            if room.get("lease"):
                _fail(409, "另一台电视正在播放；关闭旧屏幕后等待 12 秒")
            player_token = secrets.token_urlsafe(32)
            room["playback"]["playing"] = False
            room["lease"] = {
                "token": _digest(player_token), "seen_at": self.clock(), "status": "ready",
                "position": room["playback"]["position"],
                "current_id": (room["current"] or {}).get("id"),
                "generation": room["playback"]["seek_version"],
            }
            self._touch(room)
            self._save()
            return {"player_token": player_token, "lease_seconds": self.LEASE_SECONDS,
                    "state": self._public(room)}

    def _player(self, room, token, player_token):
        self._auth(room, token, host=True)
        self._reconcile(room)
        lease = room.get("lease")
        if not lease or not secrets.compare_digest(lease["token"], _digest(player_token or "")):
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
            # Activity can be volatile; queue/transport commands are the durable boundary.
            room["updated_at"] = self.clock()
            return self._public(room, room["revision"])

    def ended(self, room_id, token, player_token, report):
        with self.lock:
            room = self._room(room_id)
            self._player(room, token, player_token)
            signature = "ended:" + str(report["item_id"]) + ":" + str(report["generation"])
            if self._dedupe(room, report["command_id"], signature):
                return self._public(room)
            if (report["item_id"] == (room["current"] or {}).get("id")
                    and report["generation"] == room["playback"]["seek_version"]):
                self._advance(room)
                self._touch(room)
                self._remember(room, report["command_id"], signature)
                self._save()
            return self._public(room)


class JoinRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


class CommandRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=100)
    expected_revision: int | None = Field(default=None, ge=0)
    action: Literal["add", "remove", "top", "clear", "next", "restart", "seek", "play", "pause", "guide"]
    job_id: str | None = Field(default=None, max_length=100)
    item_id: str | None = Field(default=None, max_length=100)
    position: float = Field(default=0, ge=0, le=86400)
    enabled: bool | None = None


class HeartbeatRequest(BaseModel):
    current_id: str | None = Field(default=None, max_length=100)
    generation: int = Field(ge=0)
    position: float = Field(ge=0, le=86400)
    status: Literal["ready", "playing", "paused", "buffering", "blocked", "error"]


class EndedRequest(BaseModel):
    command_id: str = Field(min_length=8, max_length=100)
    item_id: str = Field(max_length=100)
    generation: int = Field(ge=0)


router = APIRouter(prefix="/api/rooms", tags=["rooms"])
store = RoomStore()


def _token(authorization: str | None):
    if not authorization or not authorization.startswith("Bearer "):
        _fail(401, "请先配对房间")
    return authorization[7:]


def _private(response: Response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"


@router.post("")
def create_room(response: Response):
    _private(response)
    return store.create()


@router.post("/{room_id}/join")
def join_room(room_id: str, request: JoinRequest, response: Response):
    _private(response)
    return store.join(room_id, request.code)


@router.get("/{room_id}")
def room_state(room_id: str, response: Response, after: int | None = Query(default=None, ge=0),
               authorization: str | None = Header(default=None)):
    _private(response)
    return store.state(room_id, _token(authorization), after)


@router.post("/{room_id}/commands")
def room_command(room_id: str, request: CommandRequest, response: Response,
                 authorization: str | None = Header(default=None)):
    _private(response)
    return store.command(room_id, _token(authorization), request.model_dump())


@router.post("/{room_id}/player/claim")
def claim_player(room_id: str, response: Response, authorization: str | None = Header(default=None)):
    _private(response)
    return store.claim(room_id, _token(authorization))


@router.post("/{room_id}/player/heartbeat")
def player_heartbeat(room_id: str, request: HeartbeatRequest, response: Response,
                     authorization: str | None = Header(default=None),
                     x_player_token: str | None = Header(default=None)):
    _private(response)
    return store.heartbeat(room_id, _token(authorization), x_player_token, request.model_dump())


@router.post("/{room_id}/player/ended")
def player_ended(room_id: str, request: EndedRequest, response: Response,
                 authorization: str | None = Header(default=None),
                 x_player_token: str | None = Header(default=None)):
    _private(response)
    return store.ended(room_id, _token(authorization), x_player_token, request.model_dump())
