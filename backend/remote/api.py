"""worker 侧 HTTP 接口：领取任务、上报进度、交付结果。

只暴露给内网的 worker 使用，用 Bearer 口令保护。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, Field

from .. import config
from .queue import queue

queue.lease_seconds = config.WORKER_LEASE_SECONDS
queue.offline_after = config.WORKER_OFFLINE_AFTER

router = APIRouter(prefix="/worker", tags=["worker"])


def _auth(authorization: Optional[str]) -> None:
    if not config.WORKER_TOKEN:
        return
    expected = f"Bearer {config.WORKER_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="worker 口令不正确")


class ClaimRequest(BaseModel):
    worker_id: str
    kinds: List[str] = Field(default_factory=list)
    wait: float = 25.0


class ProgressRequest(BaseModel):
    worker_id: str
    percent: int = 0
    message: str = ""


class FinishRequest(BaseModel):
    worker_id: str
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


@router.post("/claim")
def claim(req: ClaimRequest, authorization: str | None = Header(None)) -> Response:
    """长轮询领取任务；没有活时挂起到超时返回 204。"""
    _auth(authorization)
    task = queue.claim(req.worker_id, req.kinds, min(max(req.wait, 0.0), 60.0))
    if task is None:
        return Response(status_code=204)
    from fastapi.responses import JSONResponse
    return JSONResponse(task)


@router.post("/tasks/{task_id}/progress")
def progress(task_id: str, req: ProgressRequest,
             authorization: str | None = Header(None)) -> dict:
    _auth(authorization)
    ok = queue.progress(task_id, req.worker_id, req.percent, req.message)
    return {"ok": ok}


@router.post("/tasks/{task_id}/finish")
def finish(task_id: str, req: FinishRequest,
           authorization: str | None = Header(None)) -> dict:
    _auth(authorization)
    ok = queue.finish(task_id, req.worker_id, req.result, req.error)
    return {"ok": ok}


@router.get("/status")
def status() -> dict:
    """worker 在线状态；前端用它提示「处理节点离线，任务已排队」。"""
    data = queue.status()
    data["remote_steps"] = sorted(config.REMOTE_STEPS)
    return data
