"""Pull queue with per-claim leases, cancellation and fenced artifact publication."""
from __future__ import annotations

import contextvars
import copy
import logging
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional

from .artifacts import InvalidResult, PROTOCOL_VERSION, prepare

ProgressCb = Optional[Callable[[int, str], None]]
log = logging.getLogger("openk.remote")
PENDING, CLAIMED, DONE, FAILED, CANCELLED = "pending", "claimed", "done", "failed", "cancelled"


class TaskCancelled(RuntimeError):
    """The owning job or this queued attempt was cancelled."""


class Task:
    def __init__(self, kind: str, args: dict, on_progress: ProgressCb,
                 job_id: Optional[str], generation: Optional[str]):
        self.id = uuid.uuid4().hex
        self.kind, self.args = kind, copy.deepcopy(args)
        self.job_id, self.generation = job_id, generation
        self.state = PENDING
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.claimed_by: Optional[str] = None
        self.claim_token: Optional[str] = None
        self.staging_dir: Optional[Path] = None
        self.lease_expires = 0.0
        self.created_at = time.time()
        self.attempts = 0
        self.publishing = False
        self.on_progress = on_progress
        self.context = contextvars.copy_context()
        self.done_event = threading.Event()
        self.last_message, self.last_percent = "", 0

    def public(self, lease_seconds: float) -> dict:
        return {"protocol_version": PROTOCOL_VERSION, "task_id": self.id,
                "kind": self.kind, "args": copy.deepcopy(self.args),
                "attempts": self.attempts, "claim_token": self.claim_token,
                "job_id": self.job_id, "generation": self.generation,
                "lease_seconds": lease_seconds, "staging_dir": str(self.staging_dir)}


class TaskQueue:
    def __init__(self, lease_seconds: float = 120, offline_after: float = 90,
                 job_manager: Any = None, staging_root: Optional[Path] = None):
        self.lease_seconds, self.offline_after = lease_seconds, offline_after
        self.job_manager = None
        self.staging_root = Path(staging_root).resolve() if staging_root else None
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._tasks: Dict[str, Task] = {}
        self._order: List[str] = []
        self._workers: Dict[str, dict] = {}
        self._receipts: OrderedDict = OrderedDict()
        self._reaper: Optional[threading.Thread] = None
        self._cancel_error = TaskCancelled
        if job_manager is not None:
            self.bind_manager(job_manager)

    def bind_manager(self, manager: Any) -> None:
        from ..jobs import JobCancelledError

        with self._cond:
            if self.job_manager is not None and self.job_manager is not manager:
                raise RuntimeError("Queue already bound to another job manager")
            self.job_manager = manager
            self._cancel_error = JobCancelledError
            manager.register_queue(self)
            if self.staging_root is None:
                self.staging_root = manager.jobs_dir / ".remote-staging"

    def _guard(self, task: Task):
        if task.job_id:
            return self.job_manager.guard(task.job_id, task.generation)
        return nullcontext()

    def submit(self, kind: str, args: dict, on_progress: ProgressCb = None,
               timeout: Optional[float] = None, *, job_id: Optional[str] = None,
               generation: Optional[str] = None) -> dict:
        if kind not in {"separate", "transcribe", "align"}:
            raise ValueError(f"Unsupported remote task: {kind}")
        if self.job_manager is not None:
            context = self.job_manager.current_execution()
            if context:
                job_id, generation = context
        if job_id and (not self.job_manager or not generation):
            raise ValueError("Job-bound submissions require a manager and generation")
        if self.job_manager is not None and not job_id:
            raise ValueError("Controller submissions require a job execution generation")
        out = Path(args.get("out_dir", "")).resolve()
        if not args.get("out_dir") or not out.is_dir():
            raise ValueError("Remote output directory must already exist")
        if self.staging_root is None:
            raise ValueError("Remote queue requires an explicit shared staging root")
        if job_id:
            root = self.job_manager.job_dir(job_id).resolve()
            if not out.is_relative_to(root):
                raise ValueError("Remote output directory is outside the owning job")
        args = {**args, "out_dir": str(out)}
        task = Task(kind, args, on_progress, job_id, generation)
        with self._cond:
            with self._guard(task):
                self._tasks[task.id] = task
                self._order.append(task.id)
            self._ensure_reaper()
            self._cond.notify_all()
        try:
            if on_progress and not self.worker_online():
                self._notify(task, 0, "已排队，等待处理节点上线…")
            if not task.done_event.wait(timeout):
                with self._cond:
                    if not task.done_event.is_set():
                        self._cancel(task)
                        raise TimeoutError(f"等待远程 worker 执行 {kind} 超时（{timeout:g}s）")
            if task.state == CANCELLED:
                raise TaskCancelled(task.error or "远程任务已取消")
            if task.state == FAILED:
                raise RuntimeError(task.error or f"远程 {kind} 执行失败")
            return copy.deepcopy(task.result or {})
        finally:
            with self._cond:
                if task.state not in {DONE, FAILED, CANCELLED}:
                    self._cancel(task)
                self._tasks.pop(task.id, None)
                if task.id in self._order:
                    self._order.remove(task.id)
                self._cond.notify_all()

    def _cleanup(self, task: Task) -> None:
        path, task.staging_dir = task.staging_dir, None
        if path and path.exists():
            try:
                shutil.rmtree(path)
            except OSError:
                log.exception("Cannot remove cancelled/completed attempt staging: %s", path)

    def _cancel(self, task: Task) -> None:
        task.state, task.error = CANCELLED, "任务已取消"
        task.claim_token = None
        self._cleanup(task)
        task.done_event.set()

    def cancel_where(self, predicate: Callable[[Task], bool]) -> int:
        with self._cond:
            tasks = [task for task in self._tasks.values()
                     if task.state not in {DONE, FAILED, CANCELLED} and predicate(task)]
            for task in tasks:
                self._cancel(task)
            self._cond.notify_all()
            return len(tasks)

    def _expire(self) -> None:
        now = time.monotonic()
        for task in self._tasks.values():
            if task.state == CLAIMED and task.lease_expires <= now:
                self._cleanup(task)
                task.state, task.claimed_by, task.claim_token = PENDING, None, None
                task.publishing = False
                task.lease_expires = 0
        self._cond.notify_all()

    def claim(self, worker_id: str, kinds: List[str], wait_seconds: float = 25) -> Optional[dict]:
        deadline = time.monotonic() + max(0, wait_seconds)
        with self._cond:
            self._touch_worker(worker_id, kinds)
            while True:
                self._expire()
                for tid in self._order:
                    task = self._tasks.get(tid)
                    if not task or task.state != PENDING or task.kind not in kinds:
                        continue
                    try:
                        with self._guard(task):
                            self.staging_root.mkdir(parents=True, exist_ok=True)
                            if self.staging_root.is_symlink():
                                raise ValueError("Staging root must not be a symlink")
                            token = uuid.uuid4().hex
                            stage = self.staging_root / f"{task.id}-{token}"
                            stage.mkdir()
                            task.staging_dir = stage
                            task.state, task.claimed_by, task.claim_token = CLAIMED, worker_id, token
                            task.attempts += 1
                            task.lease_expires = time.monotonic() + self.lease_seconds
                            return task.public(self.lease_seconds)
                    except self._cancel_error:
                        self._cancel(task)
                        continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(min(remaining, max(0.05, self.lease_seconds)))
                self._touch_worker(worker_id, kinds)

    def _matches(self, task: Optional[Task], worker_id: str, claim_token: Optional[str]) -> bool:
        return bool(task and claim_token and task.state == CLAIMED
                    and task.claimed_by == worker_id and task.claim_token == claim_token
                    and task.lease_expires > time.monotonic())

    def _notify(self, task: Task, percent: int, message: str) -> None:
        if task.on_progress:
            task.context.copy().run(task.on_progress, percent, message)

    def progress(self, task_id: str, worker_id: str, percent: int, message: str,
                 claim_token: Optional[str] = None) -> bool:
        with self._cond:
            self._touch_worker(worker_id)
            task = self._tasks.get(task_id)
            if not self._matches(task, worker_id, claim_token):
                return False
            try:
                with self._guard(task):
                    task.lease_expires = time.monotonic() + self.lease_seconds
                    changed = (percent, message) != (task.last_percent, task.last_message)
                    task.last_percent, task.last_message = percent, message
                    if changed:
                        self._notify(task, percent, message)
            except self._cancel_error:
                self._cancel(task)
                return False
        return True

    def finish(self, task_id: str, worker_id: str, result: Optional[dict] = None,
               error: Optional[str] = None, claim_token: Optional[str] = None) -> bool:
        with self._cond:
            self._touch_worker(worker_id)
            key = (task_id, worker_id, claim_token)
            receipt = self._receipts.get(key)
            if receipt:
                job_id, generation = receipt
                if job_id:
                    try:
                        self.job_manager.check_active(job_id, generation)
                    except self._cancel_error:
                        return False
                return True
            task = self._tasks.get(task_id)
            if not self._matches(task, worker_id, claim_token):
                return False
            if task.publishing:
                raise OSError("This claim is already being validated; retry its receipt")
            task.publishing = True
            snapshot = SimpleNamespace(id=task.id, kind=task.kind, args=copy.deepcopy(task.args),
                                       claim_token=task.claim_token, generation=task.generation,
                                       staging_dir=task.staging_dir)
        try:
            artifacts = nullcontext(None) if error else prepare(snapshot, result)
            with artifacts as prepared:
                with self._cond, self._guard(task):
                    if not self._matches(task, worker_id, claim_token):
                        return False
                    if error:
                        task.state, task.error = FAILED, error
                    else:
                        task.result = prepared.commit()
                        task.state = DONE
                    self._receipts[key] = (task.job_id, task.generation)
                    while len(self._receipts) > 1024:
                        self._receipts.popitem(last=False)
                    self._cleanup(task)
                    task.done_event.set()
                    self._cond.notify_all()
                    return True
        except InvalidResult as exc:
            with self._cond:
                if not self._matches(task, worker_id, claim_token):
                    return False
                task.state, task.error = FAILED, str(exc)
                self._cleanup(task)
                task.done_event.set()
                self._cond.notify_all()
            raise
        except self._cancel_error:
            with self._cond:
                if task.claim_token == claim_token:
                    self._cancel(task)
            return False
        except OSError:
            with self._cond:
                if not self._matches(task, worker_id, claim_token):
                    return False
            raise
        finally:
            with self._cond:
                if task.claim_token == claim_token:
                    task.publishing = False

    def worker_online(self) -> bool:
        with self._lock:
            cutoff = time.time() - self.offline_after
            return any(w["last_seen"] >= cutoff for w in self._workers.values())

    def status(self) -> dict:
        now = time.time()
        with self._lock:
            workers = [{"id": wid, "online": now - info["last_seen"] <= self.offline_after,
                        "idle_seconds": round(now - info["last_seen"], 1),
                        "kinds": info.get("kinds", [])}
                       for wid, info in sorted(self._workers.items())]
            return {"protocol_version": PROTOCOL_VERSION,
                    "online": any(w["online"] for w in workers), "workers": workers,
                    "waiting": sum(t.state == PENDING for t in self._tasks.values()),
                    "running": [{"kind": t.kind, "worker": t.claimed_by,
                                 "percent": t.last_percent, "message": t.last_message}
                                for t in self._tasks.values() if t.state == CLAIMED]}

    def _touch_worker(self, worker_id: str, kinds: Optional[List[str]] = None) -> None:
        info = self._workers.setdefault(worker_id, {})
        info["last_seen"] = time.time()
        if kinds is not None:
            info["kinds"] = list(kinds)

    def _ensure_reaper(self) -> None:
        if self._reaper and self._reaper.is_alive():
            return
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True,
                                        name="openk-lease-reaper")
        self._reaper.start()

    def _reap_loop(self) -> None:
        with self._cond:
            while self._tasks:
                self._expire()
                self._cond.wait(min(5, max(0.05, self.lease_seconds / 2)))
            self._reaper = None


queue = TaskQueue()
