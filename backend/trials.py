"""One selected karaoke song per proxy-authenticated anonymous browser session."""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from functools import lru_cache
import logging
import math
from pathlib import Path
import re
import sqlite3
import time
from typing import Callable, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import config, identity, search
from .jobs import JobManager, manager

SESSION_SECONDS = 24 * 60 * 60
MAX_SONG_SECONDS = 900
PLAYBACK_GRACE_SECONDS = 300
MAX_PLAYBACK_SECONDS = 1200
CATALOG_LIMIT = 50
AUDIO_EXTENSIONS = frozenset({".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".webm"})
_JOB_ID = re.compile(r"[0-9a-f]{12}")
_log = logging.getLogger(__name__)


def require_enabled() -> None:
    if not config.GUEST_TRIAL_ENABLED or not identity.enabled():
        raise HTTPException(404, "访客试唱功能未启用。")


@dataclass(frozen=True)
class Guest:
    id: str
    expires_at: int


def current_guest(request: Request) -> Guest:
    require_enabled()
    payload = identity.proxy_payload(
        request, "X-OpenK-Guest",
        required="请从试唱入口进入，即可免登录唱一首。",
        invalid="访客会话无效，请登录后继续。",
    )
    try:
        if set(payload) != {"id", "expires_at"}:
            raise ValueError("Unexpected guest assertion fields")
        guest = Guest(**payload)
        if not isinstance(guest.id, str) or str(UUID(guest.id)) != guest.id:
            raise ValueError("Invalid guest identity")
        if type(guest.expires_at) is not int or not 0 < guest.expires_at <= time.time() + SESSION_SECONDS + 60:
            raise ValueError("Invalid guest expiry")
        if request.headers.get("X-OpenK-Account"):
            raise ValueError("Account and guest assertions cannot be combined")
    except (TypeError, ValueError):
        raise HTTPException(401, "访客会话无效，请登录后继续。") from None
    if guest.expires_at <= time.time():
        raise HTTPException(410, "这个访客会话已过期，登录后即可继续演唱。")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and not request.headers.get("Origin"):
        raise HTTPException(403, "访客操作必须来自试唱页面。")
    return guest


class TrialBoundaryMiddleware:
    """A trial assertion never authorizes ordinary application routes."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_trial = scope["path"].startswith("/api/trial/")
        if Headers(scope=scope).get("X-OpenK-Guest") and not is_trial:
            response = JSONResponse(
                {"detail": "访客会话只能使用一首歌的试唱功能。"},
                status_code=403,
                headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
            )
            await response(scope, receive, send)
            return

        async def send_private(message: Message) -> None:
            if is_trial and message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "private, no-store"
                headers["X-Content-Type-Options"] = "nosniff"
            await send(message)

        await self.app(scope, receive, send_private)


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str = Field(pattern=r"^[0-9a-f]{12}$")


class Completion(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TrialStore:
    def __init__(self, path: Path, songs: JobManager, clock: Callable[[], float] = time.time):
        self.path = path
        self.songs = songs
        self.clock = clock
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS guest_trials (
                    id TEXT PRIMARY KEY,
                    session_expires_at INTEGER NOT NULL,
                    job_id TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    completed_at REAL
                );
                CREATE INDEX IF NOT EXISTS guest_trial_expiry
                    ON guest_trials(session_expires_at);
            """)
        self.path.chmod(0o600)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def _row(self, connection: sqlite3.Connection, guest: Guest) -> sqlite3.Row | None:
        row = connection.execute("SELECT * FROM guest_trials WHERE id = ?", (guest.id,)).fetchone()
        if row is not None and row["session_expires_at"] != guest.expires_at:
            raise HTTPException(401, "访客会话的有效期不能被修改。")
        return row

    @staticmethod
    def _eligible(job: dict) -> bool:
        duration = job.get("duration")
        stems = job.get("stems")
        return (
            job.get("state") == "done"
            and isinstance(job.get("id"), str) and bool(_JOB_ID.fullmatch(job["id"]))
            and type(duration) in {int, float} and 0 < duration <= MAX_SONG_SECONDS
            and math.isfinite(duration)
            and isinstance(stems, dict) and isinstance(stems.get("instrumental"), str)
            and bool(stems["instrumental"])
        )

    @staticmethod
    def _metadata(job: dict) -> dict:
        def label(key: str) -> str:
            value = job.get(key)
            return value.strip()[:400] if isinstance(value, str) else ""

        title = label("title") or label("track") or "Untitled song"
        return {
            "id": job["id"], "title": title,
            "track": label("track") or title, "artist": label("artist"),
            "duration": float(job["duration"]),
        }

    def _job(self, job_id: str) -> dict:
        job = self.songs.get(job_id)
        if job is None or not self._eligible(job):
            raise HTTPException(404, "这首歌不能用于访客试唱。")
        return job

    def _asset(self, job: dict, kind: str) -> str:
        if kind == "lyrics":
            value = job.get("lyrics_file")
            allowed = {".json"}
            prefix = Path()
        else:
            value = (job.get("stems") or {}).get(kind)
            allowed = AUDIO_EXTENSIONS
            prefix = Path("stems")
        if (not isinstance(value, str) or not value or "\\" in value or "\0" in value
                or Path(value).is_absolute() or ".." in Path(value).parts):
            raise HTTPException(404, "所选歌曲的音频或歌词不可用。")
        directory = self.songs.job_dir(job["id"])
        if directory.is_symlink():
            raise HTTPException(404, "所选歌曲的音频或歌词不可用。")
        relative = prefix / value
        candidate = (directory / relative).resolve()
        if (not candidate.is_relative_to(directory.resolve())
                or candidate.suffix.lower() not in allowed or not candidate.is_file()):
            raise HTTPException(404, "所选歌曲的音频或歌词不可用。")
        return (Path(job["id"]) / relative).as_posix()

    def _optional_asset(self, job: dict, kind: str) -> str | None:
        declared = job.get("lyrics_file") if kind == "lyrics" else (job.get("stems") or {}).get(kind)
        if not declared:
            return None
        try:
            return self._asset(job, kind)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            _log.warning("Guest trial optional asset unavailable: job=%s kind=%s", job["id"], kind)
            return None

    def _song(self, job: dict) -> dict:
        self._asset(job, "instrumental")
        vocals = self._optional_asset(job, "vocals")
        lyrics = self._optional_asset(job, "lyrics")
        media = {"instrumental": "/api/trial/media/instrumental"}
        if vocals:
            media["vocals"] = "/api/trial/media/vocals"
        if lyrics:
            media["lyrics"] = "/api/trial/lyrics"
        return {
            **self._metadata(job), "has_vocals": bool(vocals), "has_lyrics": bool(lyrics),
            "media": media,
        }

    def _state(self, guest: Guest, row: sqlite3.Row | None) -> dict:
        now = self.clock()
        expiry = row["expires_at"] if row is not None else guest.expires_at
        status = "available" if row is None else "active"
        if guest.expires_at <= now or expiry <= now:
            status = "expired"
        if row is not None and row["completed_at"] is not None:
            status = "complete"
        return {
            "status": status,
            "song": self._song(self._job(row["job_id"])) if status == "active" else None,
            "started_at": row["started_at"] if row is not None else None,
            "expires_at": expiry,
            "remaining_seconds": max(0, expiry - now) if status in {"available", "active"} else 0,
        }

    def state(self, guest: Guest) -> dict:
        with closing(self._connect()) as connection:
            return self._state(guest, self._row(connection, guest))

    def catalog(self, guest: Guest, query: str | None) -> dict:
        status = self.state(guest)["status"]
        if status not in {"available", "active"}:
            raise HTTPException(410, "你的试唱歌曲已经结束，登录后即可继续演唱。")
        songs = [self._metadata(job) for job in self.songs.list() if self._eligible(job)]
        return {"songs": search.search_jobs(songs, query)[:CATALOG_LIMIT], "limit": CATALOG_LIMIT}

    def select(self, guest: Guest, job_id: str) -> dict:
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._row(connection, guest)
            state = self._state(guest, row)
            if state["status"] not in {"available", "active"}:
                raise HTTPException(410, "你的试唱歌曲已经结束，登录后即可继续演唱。")
            if row is not None:
                if row["job_id"] != job_id:
                    raise HTTPException(409, "这个访客会话已经选定了它唯一的一首歌。")
                return state
            job = self._job(job_id)
            self._song(job)
            now = self.clock()
            if now >= guest.expires_at:
                raise HTTPException(410, "这个访客会话已过期，请登录。")
            expires_at = min(guest.expires_at, now + min(
                float(job["duration"]) + PLAYBACK_GRACE_SECONDS, MAX_PLAYBACK_SECONDS))
            connection.execute("DELETE FROM guest_trials WHERE session_expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO guest_trials (id, session_expires_at, job_id, started_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (guest.id, guest.expires_at, job_id, now, expires_at),
            )
            return self._state(guest, self._row(connection, guest))

    def complete(self, guest: Guest) -> dict:
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            row = self._row(connection, guest)
            if row is None:
                raise HTTPException(409, "请先选择试唱歌曲，再完成本次试唱。")
            if row["completed_at"] is None and self.clock() < min(row["expires_at"], guest.expires_at):
                connection.execute(
                    "UPDATE guest_trials SET completed_at = ? WHERE id = ?", (self.clock(), guest.id))
            return self._state(guest, self._row(connection, guest))

    def asset(self, guest: Guest, kind: str) -> str:
        with closing(self._connect()) as connection:
            row = self._row(connection, guest)
            status = self._state(guest, row)["status"]
            if status == "available":
                raise HTTPException(409, "请先选择试唱歌曲，再开始播放。")
            if status != "active":
                raise HTTPException(410, "你的试唱歌曲已经结束，登录后即可继续演唱。")
            return self._asset(self._job(row["job_id"]), kind)


@lru_cache(maxsize=1)
def get_store() -> TrialStore:
    return TrialStore(config.DATA_DIR / "guest-trials.sqlite3", manager)


def create_router(media: StaticFiles) -> APIRouter:
    router = APIRouter(prefix="/api/trial", tags=["guest trial"])

    @router.get("/state")
    def state(guest: Guest = Depends(current_guest)):
        return get_store().state(guest)

    @router.get("/catalog")
    def catalog(q: str | None = Query(None, max_length=120), guest: Guest = Depends(current_guest)):
        return get_store().catalog(guest, q)

    @router.post("/select")
    def select(selection: Selection, guest: Guest = Depends(current_guest)):
        return get_store().select(guest, selection.job_id)

    @router.post("/complete")
    def complete(completion: Completion, guest: Guest = Depends(current_guest)):
        return get_store().complete(guest)

    @router.api_route("/media/{kind}", methods=["GET", "HEAD"])
    async def audio(kind: Literal["instrumental", "vocals"], request: Request,
                    guest: Guest = Depends(current_guest)):
        path = await run_in_threadpool(lambda: get_store().asset(guest, kind))
        return await media.get_response(path, request.scope)

    @router.api_route("/lyrics", methods=["GET", "HEAD"])
    async def lyrics(request: Request, guest: Guest = Depends(current_guest)):
        path = await run_in_threadpool(lambda: get_store().asset(guest, "lyrics"))
        return await media.get_response(path, request.scope)

    return router
