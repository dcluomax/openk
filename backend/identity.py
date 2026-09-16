"""Account assertions accepted only from a separately authenticated proxy hop."""
from __future__ import annotations

import base64
import binascii
from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from . import config


def _load_key(path: str) -> bytes:
    if not path:
        return b""
    key = Path(path).read_bytes().strip()
    if not re.fullmatch(rb"[A-Za-z0-9_-]{43,128}", key):
        raise ValueError("OPENK_IDENTITY_KEY_FILE must contain a separate, strong URL-safe proxy key")
    return key


KEY = _load_key(config.IDENTITY_KEY_FILE)


@dataclass(frozen=True)
class Account:
    id: str
    username: str
    display_name: str
    is_staff: bool = False


def enabled() -> bool:
    return bool(KEY)


def proxy_payload(request: Request, header: str, *,
                  required: str = "请先登录 OpenK",
                  invalid: str = "登录资料无效，请重新登录 OpenK") -> dict:
    """Decode an assertion only after authenticating its private proxy hop."""
    supplied = request.headers.get("X-OpenK-Identity-Key", "").encode("utf-8")
    assertion = request.headers.get(header, "")
    if not enabled() or not secrets.compare_digest(KEY, supplied) or not assertion or len(assertion) > 4096:
        raise HTTPException(401, required)
    try:
        encoded = assertion.encode("ascii")
        encoded += b"=" * (-len(encoded) % 4)
        payload = json.loads(base64.b64decode(encoded, altchars=b"-_", validate=True))
        if not isinstance(payload, dict):
            raise ValueError("Invalid assertion object")
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        raise HTTPException(401, invalid) from None
    return payload


def current_account(request: Request) -> Account | None:
    if not enabled():
        return None
    payload = proxy_payload(request, "X-OpenK-Account")
    try:
        if set(payload) != {"id", "username", "display_name", "is_staff"}:
            raise ValueError("Invalid account fields")
        account = Account(**payload)
        if not isinstance(account.id, str) or str(UUID(account.id)) != account.id:
            raise ValueError("Invalid account identity")
        if type(account.is_staff) is not bool:
            raise ValueError("Invalid account role")
        for value, limit in ((account.username, 150), (account.display_name, 40)):
            if (not isinstance(value, str) or not value or value.strip() != value or len(value) > limit
                    or any(ord(character) < 32 or ord(character) == 127 for character in value)):
                raise ValueError("Invalid account label")
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        raise HTTPException(401, "登录资料无效，请重新登录 OpenK") from None
    expected = request.headers.get("X-OpenK-Expected-Account")
    if expected and expected != account.id:
        raise HTTPException(409, {
            "code": "account_changed", "message": "登录账号已改变，请确认当前账号后重试",
        })
    return account


router = APIRouter(tags=["account"])


@router.get("/api/account")
def account_status(response: Response, account: Account | None = Depends(current_account)):
    response.headers["Cache-Control"] = "private, no-store"
    if account is None:
        return {"enabled": False}
    return {
        "enabled": True, "user": asdict(account),
        "profile_url": "/auth/", "login_url": "/auth/login/", "logout_url": "/auth/logout/",
    }
