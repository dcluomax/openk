"""可恢复的后台操作；操作状态与正在演唱的歌曲状态分开保存。"""
from __future__ import annotations

import copy
import json
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)


class OperationStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()
        self._operations: dict[str, dict] = {}
        if path.exists():
            self._operations = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(self._operations, dict):
                raise ValueError("后台操作状态文件格式错误")
            changed = False
            for op in self._operations.values():
                if op["state"] in ("queued", "running"):
                    op.update(state="queued", message="服务重启，等待继续处理", updated_at=time.time())
                    changed = True
            if changed:
                self._persist()

    def _persist(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._operations, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self.path)

    def create(self, job_id: str, generation: str | int, payload: dict) -> tuple[dict, bool]:
        with self._lock:
            active = self.active_for(job_id)
            if active:
                return active, True
            now = time.time()
            # 保留最近的历史；进行中的操作不因数量限制而消失。
            finished = sorted(
                (op for op in self._operations.values() if op["state"] in ("done", "error")),
                key=lambda op: op["updated_at"], reverse=True,
            )
            for old in finished[199:]:
                self._operations.pop(old["id"], None)
            op = {
                "id": uuid.uuid4().hex, "job_id": job_id, "generation": generation,
                "state": "queued", "message": "歌词重对齐已排队", "error": None,
                "result": None, "request": copy.deepcopy(payload),
                "created_at": now, "updated_at": now,
            }
            self._operations[op["id"]] = op
            self._persist()
            return copy.deepcopy(op), False

    def get(self, operation_id: str) -> dict | None:
        with self._lock:
            op = self._operations.get(operation_id)
            return copy.deepcopy(op) if op else None

    def active_for(self, job_id: str) -> dict | None:
        with self._lock:
            return next((copy.deepcopy(op) for op in self._operations.values()
                         if op["job_id"] == job_id and op["state"] in ("queued", "running")), None)

    def pending(self) -> list[dict]:
        with self._lock:
            return sorted((copy.deepcopy(op) for op in self._operations.values()
                           if op["state"] == "queued"), key=lambda op: op["created_at"])

    def cancel_for(self, job_id: str) -> None:
        with self._lock:
            changed = False
            for op in self._operations.values():
                if op["job_id"] == job_id and op["state"] in ("queued", "running"):
                    op.update(state="error", error="歌曲已删除，操作已取消",
                              message="操作已取消", updated_at=time.time())
                    changed = True
            if changed:
                self._persist()

    def run(self, operation_id: str, action: Callable[[dict], dict]) -> None:
        with self._lock:
            op = self._operations.get(operation_id)
            if not op or op["state"] != "queued":
                return
            op.update(state="running", message="正在获取歌词并对齐", updated_at=time.time())
            self._persist()
            snapshot = copy.deepcopy(op)
        try:
            result = action(snapshot)
        except Exception as exc:
            # 后台线程没有 HTTP 调用栈，错误必须落盘并通过轮询交给发起者。
            log.exception("后台歌词操作 %s 失败", operation_id)
            self._finish(operation_id, state="error",
                         error=str(getattr(exc, "detail", exc)), message="歌词重对齐失败")
        else:
            self._finish(operation_id, state="done", result=result,
                         error=None, message="歌词已更新")

    def _finish(self, operation_id: str, **fields) -> None:
        with self._lock:
            op = self._operations.get(operation_id)
            if not op or op["state"] != "running":
                return
            op.update(**fields, updated_at=time.time())
            self._persist()


def public_operation(op: dict) -> dict:
    return {key: value for key, value in op.items() if key not in ("request", "generation")}
