"""Durable playback settings, device topology and playback history for one account.

Settings follow both the person and the machine: an account owns portable
defaults, every registered browser device owns hardware-sensitive overrides, and
the value a surface applies is the account default overlaid by that device's
override. A device id only names a browser installation. It is not a credential,
not a hardware fingerprint, and it grants nothing on its own: every row is keyed
by the authenticated account first, so the same shared browser never carries one
person's settings into another person's profile.

History is written from validated player leases in :mod:`backend.rooms` after a
receiver reports real progress, never from a queue insertion or a bare "play"
flag, and it records what the account's own device played rather than claiming
any measurement of the sound in the room.

Library statistics are a read-only view of those same retained rows, so they say
"what this account actually played here", never "what is popular" on the internet or
across the deployment.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
from functools import lru_cache
import json
import logging
import math
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Callable, Iterator

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from . import config, identity
from .identity import Account

_log = logging.getLogger(__name__)

DEVICE_ID = re.compile(r"^[0-9a-f]{32}$")
LABEL_LIMIT = 40
MAX_DEVICES = 24
MAX_HISTORY = 500
HISTORY_PAGE = 50
MAX_HISTORY_PAGE = 100
MAX_SETTING_KEYS = 32

ROLES = ("player", "controller", "microphone")
CAPABILITIES = ("playback", "microphone", "input_select", "output_select")

# Portable preferences: the style a person likes wherever they sign in.
ENUM_SETTINGS = {
    "sing_mode": ("inst", "orig"),
    "reverb": ("none", "room", "ktv", "hall", "church"),
    "view": ("list", "grid"),
}
RANGE_SETTINGS = {
    "accompaniment_volume": (0, 100),
    "guide_volume": (0, 100),
    "mic_volume": (0, 200),
    "output_volume": (0, 100),
}
FLAG_SETTINGS = ("mic_monitor", "howl_guard")
# Opaque browser-origin media ids. They mean nothing on another device, so they
# are device-only and are never copied into account defaults.
TEXT_SETTINGS = {"audio_input": 200, "audio_output": 200}

ACCOUNT_DEFAULTS = {
    "sing_mode": "inst",
    "reverb": "ktv",
    "view": "list",
    "accompaniment_volume": 100,
    "guide_volume": 0,
    "mic_monitor": True,
    "mic_volume": 110,
    "howl_guard": True,
}
DEVICE_ONLY_DEFAULTS = {"output_volume": 100, "audio_input": "", "audio_output": ""}
ACCOUNT_KEYS = frozenset(ACCOUNT_DEFAULTS)
DEVICE_KEYS = ACCOUNT_KEYS | frozenset(DEVICE_ONLY_DEFAULTS)
EFFECTIVE_DEFAULTS = ACCOUNT_DEFAULTS | DEVICE_ONLY_DEFAULTS

# A receiver must report this much real advancement before a play is history.
PLAYBACK_EVIDENCE_SECONDS = 3.0


def require_enabled() -> None:
    """These APIs and pages exist only where a trusted account hop is configured."""
    if not identity.enabled():
        raise HTTPException(404, "当前部署未启用账号设置")


def current(request: Request) -> Account:
    """Guests and standalone browsers never reach account settings or history."""
    require_enabled()
    account = identity.current_account(request)
    if account is None:
        raise HTTPException(401, "请先登录 OpenK 后再管理设备")
    return account


def _conflict(message: str) -> HTTPException:
    return HTTPException(409, {"code": "revision_conflict", "message": message})


def device_id(value: str | None, *, required: bool = False) -> str | None:
    if value is None or value == "":
        if required:
            raise HTTPException(422, "这个浏览器没有提供设备编号")
        return None
    if not isinstance(value, str) or not DEVICE_ID.match(value):
        raise HTTPException(422, "设备编号不是有效的浏览器安装标识")
    return value


def label(value: str, fallback: str | None = None) -> str:
    if value is None and fallback is not None:
        return fallback
    if not isinstance(value, str):
        raise HTTPException(422, "设备名称必须是文本")
    cleaned = value.strip()
    if (not cleaned or len(cleaned) > LABEL_LIMIT
            or any(ord(character) < 32 or ord(character) == 127 for character in cleaned)):
        raise HTTPException(422, f"设备名称需为 1-{LABEL_LIMIT} 个字符，且不能包含控制字符")
    return cleaned


def settings(values: object, allowed: frozenset[str]) -> dict:
    """Accept only known keys inside their documented type, range or preset list."""
    if not isinstance(values, dict):
        raise HTTPException(422, "设置必须是一个对象")
    if len(values) > MAX_SETTING_KEYS:
        raise HTTPException(422, "一次提交的设置项过多")
    cleaned: dict = {}
    for key, value in values.items():
        if key not in allowed:
            raise HTTPException(422, "这里不支持该设置项")
        if key in ENUM_SETTINGS:
            if value not in ENUM_SETTINGS[key]:
                raise HTTPException(422, f"{key} 只能是以下之一：{', '.join(ENUM_SETTINGS[key])}")
        elif key in RANGE_SETTINGS:
            low, high = RANGE_SETTINGS[key]
            if type(value) is not int or not low <= value <= high:
                raise HTTPException(422, f"{key} 必须是 {low} 到 {high} 之间的整数")
        elif key in FLAG_SETTINGS:
            if type(value) is not bool:
                raise HTTPException(422, f"{key} 必须是 true 或 false")
        elif key in TEXT_SETTINGS:
            limit = TEXT_SETTINGS[key]
            if (not isinstance(value, str) or len(value) > limit
                    or any(ord(character) < 32 or ord(character) == 127 for character in value)):
                raise HTTPException(422, f"{key} 必须是不超过 {limit} 个字符的纯文本")
        else:  # pragma: no cover - the allow-list above is exhaustive.
            raise HTTPException(422, "这里不支持该设置项")
        cleaned[key] = value
    return cleaned


def roles(values: object) -> list[str]:
    if not isinstance(values, list) or len(values) > len(ROLES):
        raise HTTPException(422, "设备角色必须是一个简短的列表")
    cleaned = []
    for value in values:
        if value not in ROLES:
            raise HTTPException(422, f"设备角色只能从以下选择：{', '.join(ROLES)}")
        if value not in cleaned:
            cleaned.append(value)
    return cleaned


def capabilities(values: object) -> dict:
    """What the browser reports it can do. Advisory only; it authorizes nothing."""
    if not isinstance(values, dict) or len(values) > len(CAPABILITIES):
        raise HTTPException(422, "设备能力必须是一个很小的对象")
    cleaned = {}
    for key, value in values.items():
        if key not in CAPABILITIES or type(value) is not bool:
            raise HTTPException(422, "设备能力只能是已知的 true/false 标记")
        cleaned[key] = value
    return cleaned


class DefaultsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, le=2**31)
    settings: dict = Field(default_factory=dict)


class TopologyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, le=2**31)
    preferred_player: str | None = Field(default=None, max_length=64)


class DeviceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=0, le=2**31)
    label: str | None = Field(default=None, max_length=LABEL_LIMIT)
    roles: list[str] | None = Field(default=None, max_length=len(ROLES))
    overrides: dict | None = None
    capabilities: dict | None = None
    clear_overrides: bool = False


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str | None = Field(default=None, max_length=LABEL_LIMIT)
    capabilities: dict | None = None


_directory = 0
_directory_lock = threading.Lock()


def directory_version() -> int:
    """Counts renames, role changes and removals of registered devices.

    Room device lists keep a short-lived copy of a device's stored name; this
    lets them notice a change on the next poll instead of waiting it out.
    """
    with _directory_lock:
        return _directory


def _directory_changed() -> None:
    global _directory
    with _directory_lock:
        _directory += 1


class UserStateStore:
    """One SQLite file under the NAS data directory; Django keeps only identities."""

    def __init__(self, path: Path, clock: Callable[[], float] = time.time):
        self.path = Path(path)
        self.clock = clock
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection:
            connection.executescript("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS accounts (
                    account_id TEXT PRIMARY KEY,
                    defaults TEXT NOT NULL,
                    preferred_player TEXT,
                    revision INTEGER NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS devices (
                    account_id TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    label TEXT NOT NULL,
                    roles TEXT NOT NULL,
                    overrides TEXT NOT NULL,
                    capabilities TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    last_seen_at REAL NOT NULL,
                    revision INTEGER NOT NULL,
                    PRIMARY KEY (account_id, device_id)
                );
                CREATE TABLE IF NOT EXISTS history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT NOT NULL,
                    play_key TEXT NOT NULL,
                    job_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    artist TEXT NOT NULL,
                    duration REAL NOT NULL,
                    device_id TEXT NOT NULL,
                    device_label TEXT NOT NULL,
                    started_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    position REAL NOT NULL,
                    completed INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS history_play ON history(account_id, play_key);
                CREATE INDEX IF NOT EXISTS history_recent ON history(account_id, id DESC);
                COMMIT;
            """)
        try:
            self.path.chmod(0o600)
        except OSError:  # pragma: no cover - depends on the NAS mount options.
            _log.warning("Could not restrict permissions on %s", self.path)

    # --- plumbing ---------------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        """One writer at a time, so a read-modify-write cannot interleave."""
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
            except BaseException:
                connection.rollback()
                raise
            connection.commit()

    @staticmethod
    def _json(value: str, allowed: frozenset[str] | None = None) -> dict:
        try:
            parsed = json.loads(value)
        except ValueError:  # pragma: no cover - only a hand-edited file gets here.
            return {}
        if not isinstance(parsed, dict):
            return {}
        return {key: item for key, item in parsed.items() if allowed is None or key in allowed}

    def _account_row(self, connection: sqlite3.Connection, account: Account) -> sqlite3.Row | None:
        return connection.execute(
            "SELECT * FROM accounts WHERE account_id = ?", (account.id,)).fetchone()

    def _account(self, connection: sqlite3.Connection, account: Account) -> dict:
        row = self._account_row(connection, account)
        if row is None:
            return {"defaults": {}, "preferred_player": None, "revision": 0}
        return {
            "defaults": self._json(row["defaults"], ACCOUNT_KEYS),
            "preferred_player": row["preferred_player"],
            "revision": row["revision"],
        }

    def _devices(self, connection: sqlite3.Connection, account: Account) -> list[sqlite3.Row]:
        return connection.execute(
            "SELECT * FROM devices WHERE account_id = ? ORDER BY created_at, device_id",
            (account.id,)).fetchall()

    def _device_public(self, row: sqlite3.Row, preferred: str | None, current_id: str | None) -> dict:
        return {
            "id": row["device_id"],
            "label": row["label"],
            "roles": [value for value in self._list(row["roles"]) if value in ROLES],
            "overrides": self._json(row["overrides"], DEVICE_KEYS),
            "capabilities": self._json(row["capabilities"], frozenset(CAPABILITIES)),
            "created_at": row["created_at"],
            "last_seen_at": row["last_seen_at"],
            "revision": row["revision"],
            "preferred_player": row["device_id"] == preferred,
            "current": row["device_id"] == current_id,
        }

    @staticmethod
    def _list(value: str) -> list:
        try:
            parsed = json.loads(value)
        except ValueError:  # pragma: no cover
            return []
        return parsed if isinstance(parsed, list) else []

    def _state(self, connection: sqlite3.Connection, account: Account,
               device: str | None) -> dict:
        state = self._account(connection, account)
        rows = self._devices(connection, account)
        preferred = state["preferred_player"]
        if preferred and not any(row["device_id"] == preferred for row in rows):
            preferred = None
        devices = [self._device_public(row, preferred, device) for row in rows]
        own = next((value for value in devices if value["id"] == device), None)
        effective = EFFECTIVE_DEFAULTS | state["defaults"] | (own["overrides"] if own else {})
        return {
            "enabled": True,
            "account_id": account.id,
            "revision": state["revision"],
            "defaults": ACCOUNT_DEFAULTS | state["defaults"],
            "preferred_player": preferred,
            "device": own,
            "devices": devices,
            "settings": effective,
            "limits": {
                "max_devices": MAX_DEVICES,
                "history_page": HISTORY_PAGE,
                "max_history": MAX_HISTORY,
                "label_limit": LABEL_LIMIT,
                "roles": list(ROLES),
                "account_keys": sorted(ACCOUNT_KEYS),
                "device_keys": sorted(DEVICE_KEYS),
            },
        }

    def _bump(self, connection: sqlite3.Connection, account: Account, state: dict,
              defaults: dict, preferred: str | None) -> None:
        connection.execute(
            """INSERT INTO accounts (account_id, defaults, preferred_player, revision, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(account_id) DO UPDATE SET
                 defaults = excluded.defaults,
                 preferred_player = excluded.preferred_player,
                 revision = excluded.revision,
                 updated_at = excluded.updated_at""",
            (account.id, json.dumps(defaults, sort_keys=True), preferred,
             state["revision"] + 1, self.clock()))

    def _expect(self, state: dict, revision: int) -> None:
        if revision != state["revision"]:
            raise _conflict("你的设置已在另一台设备上更新，请确认新的数值后重试")

    # --- account settings and devices -------------------------------------
    def snapshot(self, account: Account, device: str | None = None) -> dict:
        with closing(self._connect()) as connection:
            return self._state(connection, account, device)

    def register(self, account: Account, device: str, suggested: str | None = None,
                 reported: dict | None = None) -> dict:
        """Create or refresh this browser's row. Presence is per account, never global."""
        with self._write() as connection:
            row = connection.execute(
                "SELECT * FROM devices WHERE account_id = ? AND device_id = ?",
                (account.id, device)).fetchone()
            now = self.clock()
            flags = json.dumps(reported or {}, sort_keys=True)
            if row is None:
                existing = connection.execute(
                    "SELECT COUNT(*) AS total FROM devices WHERE account_id = ?",
                    (account.id,)).fetchone()["total"]
                if existing >= MAX_DEVICES:
                    raise HTTPException(
                        429, "账号的设备数量已达上限，请先在「设备设置」页面移除一台。")
                name = suggested or f"设备 {existing + 1}"
                connection.execute(
                    """INSERT INTO devices (account_id, device_id, label, roles, overrides,
                                            capabilities, created_at, last_seen_at, revision)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                    (account.id, device, name, json.dumps(["controller"]), "{}", flags, now, now))
            else:
                # A rename belongs to the account; presence and capabilities are refreshed.
                connection.execute(
                    """UPDATE devices SET last_seen_at = ?, capabilities = ?
                       WHERE account_id = ? AND device_id = ?""",
                    (now, flags if reported is not None else row["capabilities"], account.id, device))
            result = self._state(connection, account, device)
        if row is None:
            _directory_changed()
        return result

    def save_defaults(self, account: Account, values: dict, revision: int,
                      device: str | None = None) -> dict:
        with self._write() as connection:
            state = self._account(connection, account)
            self._expect(state, revision)
            self._bump(connection, account, state, ACCOUNT_DEFAULTS | state["defaults"] | values,
                       state["preferred_player"])
            return self._state(connection, account, device)

    def save_topology(self, account: Account, preferred: str | None, revision: int,
                      device: str | None = None) -> dict:
        changed = False
        with self._write() as connection:
            state = self._account(connection, account)
            self._expect(state, revision)
            if preferred is not None:
                row = connection.execute(
                    "SELECT * FROM devices WHERE account_id = ? AND device_id = ?",
                    (account.id, preferred)).fetchone()
                if row is None:
                    raise HTTPException(404, "这台设备不属于当前账号")
                assigned = self._list(row["roles"])
                if "player" not in assigned:
                    connection.execute(
                        """UPDATE devices SET roles = ?, revision = revision + 1
                           WHERE account_id = ? AND device_id = ?""",
                        (json.dumps(assigned + ["player"]), account.id, preferred))
                    changed = True
            self._bump(connection, account, state, ACCOUNT_DEFAULTS | state["defaults"], preferred)
            result = self._state(connection, account, device)
        if changed:
            _directory_changed()
        return result

    def update_device(self, account: Account, target: str, changes: dict, revision: int,
                      device: str | None = None) -> dict:
        with self._write() as connection:
            row = connection.execute(
                "SELECT * FROM devices WHERE account_id = ? AND device_id = ?",
                (account.id, target)).fetchone()
            if row is None:
                raise HTTPException(404, "这台设备不属于当前账号")
            if revision != row["revision"]:
                raise _conflict("这台设备的信息已在别处修改，请刷新页面后重试")
            values = {
                "label": row["label"], "roles": row["roles"],
                "overrides": row["overrides"], "capabilities": row["capabilities"],
            }
            if "label" in changes:
                values["label"] = changes["label"]
            if "roles" in changes:
                values["roles"] = json.dumps(changes["roles"])
            if "overrides" in changes:
                merged = ({} if changes.get("clear") else self._json(row["overrides"], DEVICE_KEYS))
                merged.update(changes["overrides"])
                values["overrides"] = json.dumps(
                    {key: item for key, item in merged.items() if key in DEVICE_KEYS}, sort_keys=True)
            if "capabilities" in changes:
                values["capabilities"] = json.dumps(changes["capabilities"], sort_keys=True)
            connection.execute(
                """UPDATE devices SET label = ?, roles = ?, overrides = ?, capabilities = ?,
                                      revision = revision + 1
                   WHERE account_id = ? AND device_id = ?""",
                (values["label"], values["roles"], values["overrides"], values["capabilities"],
                 account.id, target))
            changed = (values["label"], values["roles"]) != (row["label"], row["roles"])
            if changes.get("roles") is not None and "player" not in changes["roles"]:
                state = self._account(connection, account)
                if state["preferred_player"] == target:
                    self._bump(connection, account, state,
                               ACCOUNT_DEFAULTS | state["defaults"], None)
            result = self._state(connection, account, device)
        if changed:
            _directory_changed()
        return result

    def remove_device(self, account: Account, target: str, device: str | None = None) -> dict:
        with self._write() as connection:
            removed = connection.execute(
                "DELETE FROM devices WHERE account_id = ? AND device_id = ?",
                (account.id, target)).rowcount
            if not removed:
                raise HTTPException(404, "这台设备不属于当前账号")
            state = self._account(connection, account)
            if state["preferred_player"] == target:
                self._bump(connection, account, state, ACCOUNT_DEFAULTS | state["defaults"], None)
            result = self._state(connection, account, device)
        _directory_changed()
        return result

    # --- playback history --------------------------------------------------
    def record_playback(self, account_id: str, *, device: str | None, play_key: str,
                        song: dict, position: float, completed: bool = False) -> bool:
        """Persist confirmed playback. Called only after a validated player advanced."""
        if not isinstance(account_id, str) or not account_id or not isinstance(play_key, str):
            return False
        try:
            with self._write() as connection:
                name = "未知设备"
                if device:
                    row = connection.execute(
                        "SELECT label FROM devices WHERE account_id = ? AND device_id = ?",
                        (account_id, device)).fetchone()
                    if row is not None:
                        name = row["label"]
                        connection.execute(
                            "UPDATE devices SET last_seen_at = ? WHERE account_id = ? AND device_id = ?",
                            (self.clock(), account_id, device))
                now = self.clock()
                connection.execute(
                    """INSERT INTO history (account_id, play_key, job_id, title, artist, duration,
                                            device_id, device_label, started_at, updated_at,
                                            position, completed)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(account_id, play_key) DO UPDATE SET
                         updated_at = excluded.updated_at,
                         position = MAX(history.position, excluded.position),
                         completed = MAX(history.completed, excluded.completed),
                         device_id = excluded.device_id,
                         device_label = excluded.device_label""",
                    (account_id, play_key[:120], str(song.get("job_id") or "")[:120],
                     str(song.get("title") or "未命名歌曲")[:200],
                     str(song.get("artist") or "")[:200],
                     float(song.get("duration") or 0), device or "", name,
                     now, now, max(0.0, float(position)), int(bool(completed))))
                connection.execute(
                    """DELETE FROM history WHERE account_id = ? AND id NOT IN (
                           SELECT id FROM history WHERE account_id = ? ORDER BY id DESC LIMIT ?)""",
                    (account_id, account_id, MAX_HISTORY))
            return True
        except (sqlite3.Error, OSError, ValueError, TypeError):
            # Singing must never stop because a history row could not be written.
            _log.warning("Could not record playback history", exc_info=True)
            return False

    def finish_playback(self, account_id: str, play_key: str, position: float) -> bool:
        """Mark an existing record complete. A bare 'ended' never creates a record."""
        try:
            with self._write() as connection:
                changed = connection.execute(
                    """UPDATE history SET completed = 1, updated_at = ?,
                                          position = MAX(position, ?)
                       WHERE account_id = ? AND play_key = ?""",
                    (self.clock(), max(0.0, float(position)), account_id, play_key[:120])).rowcount
            return bool(changed)
        except (sqlite3.Error, OSError, ValueError, TypeError):
            _log.warning("Could not complete playback history", exc_info=True)
            return False

    def history(self, account: Account, limit: int = HISTORY_PAGE,
                before: int | None = None) -> dict:
        size = max(1, min(int(limit), MAX_HISTORY_PAGE))
        query = ("SELECT h.*, d.label AS current_label FROM history h "
                 "LEFT JOIN devices d ON d.account_id = h.account_id AND d.device_id = h.device_id "
                 "WHERE h.account_id = ?")
        values: list = [account.id]
        if before is not None:
            query += " AND h.id < ?"
            values.append(int(before))
        query += " ORDER BY h.id DESC LIMIT ?"
        values.append(size + 1)
        with closing(self._connect()) as connection:
            rows = connection.execute(query, values).fetchall()
            total = connection.execute(
                "SELECT COUNT(*) AS total FROM history WHERE account_id = ?",
                (account.id,)).fetchone()["total"]
        entries = [{
            "id": row["id"],
            "job_id": row["job_id"],
            "title": row["title"],
            "artist": row["artist"],
            "duration": row["duration"],
            "device_label": row["current_label"] or row["device_label"],
            "device_id": row["device_id"] or None,
            "started_at": row["started_at"],
            "updated_at": row["updated_at"],
            "position": row["position"],
            "completed": bool(row["completed"]),
        } for row in rows[:size]]
        return {
            "entries": entries, "total": total, "limit": size,
            "next_before": entries[-1]["id"] if len(rows) > size and entries else None,
        }

    def library_stats(self, account: Account) -> dict:
        """Rank one account's songs by retained, confirmed playback.

        This is derived, never stored: the retained history rows are the only
        source, so deleting one entry or clearing history lowers the ranking on
        the very next read and no counter can outlive the record it came from.
        A play is one retained row, which the unique ``(account_id, play_key)``
        index already collapses per active play, so repeated progress reports
        and a finish for the same play stay one play. Partial plays count
        exactly as the history page shows them.

        One account-indexed pass covers every retained row rather than the first
        history page, and retention caps both the scan and the result. A row
        whose song had no catalog job cannot be browsed, so it stays out of both
        the list and the total.
        """
        try:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    """SELECT job_id, COUNT(*) AS plays, MAX(started_at) AS last_played_at
                       FROM history WHERE account_id = ? AND job_id <> ''
                       GROUP BY job_id
                       ORDER BY plays DESC, last_played_at DESC, job_id ASC
                       LIMIT ?""",
                    (account.id, MAX_HISTORY)).fetchall()
        except (sqlite3.Error, OSError) as error:
            # An empty ranking would look like a valid account with no plays.
            _log.warning("Could not read library statistics", exc_info=True)
            raise HTTPException(503, "暂时无法读取常唱统计，请稍后重试") from error
        songs = [{
            "job_id": row["job_id"],
            "play_count": row["plays"],
            "last_played_at": float(row["last_played_at"] or 0.0),
        } for row in rows]
        return {
            "account_id": account.id,
            "songs": songs,
            "total_plays": sum(song["play_count"] for song in songs),
            "history_limit": MAX_HISTORY,
        }

    def device_profile(self, account_id: str, device: str) -> dict | None:
        """Read-only label and assigned roles for one browser of one account.

        Used by room device lists so a live device can show what its owner
        actually named and configured. It never creates or touches a row.
        """
        try:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT label, roles FROM devices WHERE account_id = ? AND device_id = ?",
                    (account_id, device)).fetchone()
        except (sqlite3.Error, OSError) as error:  # pragma: no cover - unreadable NAS mount.
            _log.warning("Could not read device profile", exc_info=True)
            raise HTTPException(503, "暂时无法读取设备设置，请稍后重试") from error
        if row is None:
            return None
        return {"label": row["label"],
                "roles": [value for value in self._list(row["roles"]) if value in ROLES]}

    def clear_history(self, account: Account) -> dict:
        with self._write() as connection:
            removed = connection.execute(
                "DELETE FROM history WHERE account_id = ?", (account.id,)).rowcount
        return {"removed": removed}

    def delete_entry(self, account: Account, entry: int) -> dict:
        with self._write() as connection:
            removed = connection.execute(
                "DELETE FROM history WHERE account_id = ? AND id = ?",
                (account.id, entry)).rowcount
        if not removed:
            raise HTTPException(404, "这条记录不在你的播放历史里")
        return {"removed": removed}


@lru_cache(maxsize=1)
def store() -> UserStateStore:
    return UserStateStore(config.DATA_DIR / "user-state.sqlite3")


router = APIRouter(prefix="/api/user", tags=["user state"])


def _private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Referrer-Policy"] = "no-referrer"


def _device(value: str | None = Header(default=None, alias="X-OpenK-Device")) -> str | None:
    return device_id(value)


@router.get("/state")
def read_state(response: Response, account: Account = Depends(current),
               device: str | None = Depends(_device)):
    _private(response)
    return store().snapshot(account, device)


@router.post("/state")
def register_device(response: Response, request: RegisterRequest | None = Body(default=None),
                    account: Account = Depends(current), device: str | None = Depends(_device)):
    _private(response)
    device_id(device, required=True)
    body = request or RegisterRequest()
    return store().register(
        account, device,
        label(body.label) if body.label is not None else None,
        capabilities(body.capabilities) if body.capabilities is not None else None,
    )


@router.put("/defaults")
def save_defaults(request: DefaultsRequest, response: Response,
                  account: Account = Depends(current), device: str | None = Depends(_device)):
    _private(response)
    values = settings(request.settings, ACCOUNT_KEYS)
    return store().save_defaults(account, values, request.revision, device)


@router.put("/topology")
def save_topology(request: TopologyRequest, response: Response,
                  account: Account = Depends(current), device: str | None = Depends(_device)):
    _private(response)
    preferred = device_id(request.preferred_player) if request.preferred_player else None
    return store().save_topology(account, preferred, request.revision, device)


@router.patch("/devices/{target}")
def update_device(target: str, request: DeviceRequest, response: Response,
                  account: Account = Depends(current), device: str | None = Depends(_device)):
    _private(response)
    changes: dict = {"clear": request.clear_overrides}
    if request.label is not None:
        changes["label"] = label(request.label)
    if request.roles is not None:
        changes["roles"] = roles(request.roles)
    if request.overrides is not None or request.clear_overrides:
        changes["overrides"] = settings(request.overrides or {}, DEVICE_KEYS)
    if request.capabilities is not None:
        changes["capabilities"] = capabilities(request.capabilities)
    return store().update_device(
        account, device_id(target, required=True), changes, request.revision, device)


@router.delete("/devices/{target}")
def remove_device(target: str, response: Response, account: Account = Depends(current),
                  device: str | None = Depends(_device)):
    _private(response)
    return store().remove_device(account, device_id(target, required=True), device)


@router.get("/history")
def read_history(response: Response, account: Account = Depends(current),
                 limit: int = Query(default=HISTORY_PAGE, ge=1, le=MAX_HISTORY_PAGE),
                 before: int | None = Query(default=None, ge=1)):
    _private(response)
    return store().history(account, limit, before)


@router.delete("/history")
def clear_history(response: Response, account: Account = Depends(current)):
    _private(response)
    return store().clear_history(account)


@router.delete("/history/{entry}")
def delete_entry(entry: int, response: Response, account: Account = Depends(current)):
    _private(response)
    if entry < 1 or entry > 2**62:
        raise HTTPException(404, "这条记录不在你的播放历史里")
    return store().delete_entry(account, entry)


@router.get("/library-stats")
def read_library_stats(response: Response, account: Account = Depends(current)):
    """How often the signed-in account played each song, for its own browsing.

    Guarded exactly like the history it is derived from: no account, no numbers.
    """
    _private(response)
    try:
        target = store()
    except (sqlite3.Error, OSError) as error:
        _log.warning("Library statistics storage is unavailable", exc_info=True)
        raise HTTPException(503, "暂时无法读取常唱统计，请稍后重试") from error
    return target.library_stats(account)


def device_profile(account_id: str, device: str) -> dict | None:
    """Room-facing lookup; absence is distinct from an unavailable registry."""
    if not isinstance(account_id, str) or not account_id or not isinstance(device, str):
        raise ValueError("A device profile requires an account and browser identifier")
    if not DEVICE_ID.match(device):
        raise ValueError("Invalid browser identifier")
    try:
        target = store()
    except (sqlite3.Error, OSError) as error:  # pragma: no cover - unwritable NAS mount.
        _log.warning("Device registry is unavailable", exc_info=True)
        raise HTTPException(503, "暂时无法读取设备设置，请稍后重试") from error
    return target.device_profile(account_id, device)


def observe(account_id: str, *, device: str | None, play_key: str, song: dict,
            position: float, completed: bool = False) -> bool:
    """Entry point used by the room player lease; safe when storage is unavailable."""
    if not math.isfinite(position):
        return False
    try:
        target = store()
    except (sqlite3.Error, OSError):  # pragma: no cover - unwritable NAS mount.
        _log.warning("Playback history storage is unavailable", exc_info=True)
        return False
    if completed:
        return target.finish_playback(account_id, play_key, position)
    return target.record_playback(
        account_id, device=device, play_key=play_key, song=song, position=position)
