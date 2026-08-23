"""服务端任务队列：把重活挂起，等 worker 机器来领。

设计要点（决定了 worker 离线时服务不受影响）：

* **worker 主动拉，服务端从不推。** 服务端不需要知道 worker 的地址，
  也不做健康检查——worker 不在线，任务就静静躺在队列里。
* **租约（lease）。** 领走的任务带一个到期时间，靠进度心跳续租。
  worker 中途断电/断网，租约到期后任务自动回到待领取状态，换下一个
  worker 接着做（分离结果已落盘的部分会被 pipeline 复用，不会白干）。
* **提交方阻塞等待。** ``submit()`` 在 pipeline 线程里阻塞，返回值与
  本地执行完全一致，因此 pipeline / 前端不需要任何改动。
"""
from __future__ import annotations

import itertools
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

ProgressCb = Optional[Callable[[int, str], None]]

PENDING = "pending"
CLAIMED = "claimed"
DONE = "done"
FAILED = "failed"


class TaskCancelled(RuntimeError):
    """任务在等待或执行期间被取消（例如对应的作业被删除）。"""


class Task:
    __slots__ = ("id", "kind", "args", "state", "result", "error", "claimed_by",
                 "lease_expires", "created_at", "attempts", "on_progress",
                 "done_event", "last_message", "last_percent")

    def __init__(self, kind: str, args: Dict[str, Any], on_progress: ProgressCb):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.args = args
        self.state = PENDING
        self.result: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None
        self.claimed_by: Optional[str] = None
        self.lease_expires: float = 0.0
        self.created_at = time.time()
        self.attempts = 0
        self.on_progress = on_progress
        self.done_event = threading.Event()
        self.last_message = ""
        self.last_percent = 0

    def public(self) -> Dict[str, Any]:
        return {
            "task_id": self.id,
            "kind": self.kind,
            "args": self.args,
            "attempts": self.attempts,
        }


class TaskQueue:
    def __init__(self, lease_seconds: int = 120, offline_after: int = 90):
        self.lease_seconds = lease_seconds
        self.offline_after = offline_after
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._tasks: Dict[str, Task] = {}
        self._order: List[str] = []
        self._workers: Dict[str, Dict[str, Any]] = {}
        self._reaper: Optional[threading.Thread] = None
        self._seq = itertools.count(1)

    # ---- 生产端（pipeline 线程调用）----

    def submit(self, kind: str, args: Dict[str, Any],
               on_progress: ProgressCb = None,
               timeout: Optional[float] = None) -> Dict[str, Any]:
        """把一个步骤交给远程 worker 执行，阻塞直到拿到结果。

        ``timeout`` 为 None 表示无限等待——这正是「worker 可以选择性在线」
        所需要的语义：没人在线时任务不失败，只是等着。
        """
        task = Task(kind, args, on_progress)
        with self._cond:
            self._tasks[task.id] = task
            self._order.append(task.id)
            self._ensure_reaper()
            self._cond.notify_all()

        if on_progress and not self.worker_online():
            on_progress(0, "已排队，等待处理节点上线…")

        if not task.done_event.wait(timeout):
            with self._cond:
                self._drop(task.id)
            raise TimeoutError(
                f"等待远程 worker 执行 {kind} 超时（{timeout:.0f}s 内无人接手）")

        with self._cond:
            self._drop(task.id)
        if task.state == FAILED:
            raise RuntimeError(task.error or f"远程 {kind} 执行失败")
        if task.state != DONE:
            raise TaskCancelled(f"远程 {kind} 任务已取消")
        return task.result or {}

    def cancel_where(self, predicate: Callable[[Task], bool]) -> int:
        """取消满足条件的等待中任务（例如作业被删除时）。"""
        n = 0
        with self._cond:
            for task in list(self._tasks.values()):
                if task.state in (DONE, FAILED) or not predicate(task):
                    continue
                task.state = FAILED
                task.error = "任务已取消"
                task.done_event.set()
                n += 1
            self._cond.notify_all()
        return n

    # ---- 消费端（worker 通过 HTTP 调用）----

    def claim(self, worker_id: str, kinds: List[str],
              wait_seconds: float = 25.0) -> Optional[Dict[str, Any]]:
        """长轮询领取一个任务；没有活时挂起到超时再返回 None。

        长轮询而不是密集轮询：空闲时约每 25s 一次请求，派发延迟却接近 0。
        """
        deadline = time.monotonic() + max(0.0, wait_seconds)
        with self._cond:
            self._touch_worker(worker_id, kinds)
            while True:
                task = self._next_pending(kinds)
                if task is not None:
                    task.state = CLAIMED
                    task.claimed_by = worker_id
                    task.attempts += 1
                    task.lease_expires = time.time() + self.lease_seconds
                    self._ensure_reaper()
                    return task.public()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._cond.wait(remaining)
                self._touch_worker(worker_id, kinds)

    def progress(self, task_id: str, worker_id: str,
                 percent: int, message: str) -> bool:
        """上报进度，同时续租。返回 False 表示任务已不属于该 worker（应放弃）。"""
        with self._cond:
            self._touch_worker(worker_id)
            task = self._tasks.get(task_id)
            if task is None or task.state != CLAIMED or task.claimed_by != worker_id:
                return False
            task.lease_expires = time.time() + self.lease_seconds
            task.last_percent = percent
            task.last_message = message
            cb = task.on_progress
        if cb:
            try:
                cb(percent, message)
            except Exception:  # noqa: BLE001 - 进度回调失败不该影响任务
                pass
        return True

    def finish(self, task_id: str, worker_id: str,
               result: Optional[Dict[str, Any]] = None,
               error: Optional[str] = None) -> bool:
        with self._cond:
            self._touch_worker(worker_id)
            task = self._tasks.get(task_id)
            if task is None or task.state != CLAIMED or task.claimed_by != worker_id:
                return False
            if error:
                task.state = FAILED
                task.error = error
            else:
                task.state = DONE
                task.result = result or {}
            task.done_event.set()
            self._cond.notify_all()
        return True

    # ---- 状态 ----

    def worker_online(self) -> bool:
        cutoff = time.time() - self.offline_after
        with self._lock:
            return any(w["last_seen"] >= cutoff for w in self._workers.values())

    def status(self) -> Dict[str, Any]:
        now = time.time()
        cutoff = now - self.offline_after
        with self._lock:
            workers = [
                {
                    "id": wid,
                    "online": info["last_seen"] >= cutoff,
                    "idle_seconds": round(now - info["last_seen"], 1),
                    "kinds": info.get("kinds", []),
                }
                for wid, info in sorted(self._workers.items())
            ]
            waiting = sum(1 for t in self._tasks.values() if t.state == PENDING)
            running = [
                {
                    "kind": t.kind,
                    "worker": t.claimed_by,
                    "percent": t.last_percent,
                    "message": t.last_message,
                }
                for t in self._tasks.values() if t.state == CLAIMED
            ]
        return {
            "online": any(w["online"] for w in workers),
            "workers": workers,
            "waiting": waiting,
            "running": running,
        }

    # ---- 内部 ----

    def _next_pending(self, kinds: List[str]) -> Optional[Task]:
        for tid in self._order:
            task = self._tasks.get(tid)
            if task is not None and task.state == PENDING and task.kind in kinds:
                return task
        return None

    def _drop(self, task_id: str) -> None:
        self._tasks.pop(task_id, None)
        try:
            self._order.remove(task_id)
        except ValueError:
            pass

    def _touch_worker(self, worker_id: str,
                      kinds: Optional[List[str]] = None) -> None:
        info = self._workers.setdefault(worker_id, {})
        info["last_seen"] = time.time()
        if kinds:
            info["kinds"] = list(kinds)

    def _ensure_reaper(self) -> None:
        if self._reaper is not None and self._reaper.is_alive():
            return
        self._reaper = threading.Thread(
            target=self._reap_loop, name="openk-lease-reaper", daemon=True)
        self._reaper.start()

    def _reap_loop(self) -> None:
        while True:
            time.sleep(5)
            with self._cond:
                if not self._tasks:
                    self._reaper = None
                    return
                now = time.time()
                requeued = 0
                for task in self._tasks.values():
                    if task.state == CLAIMED and task.lease_expires < now:
                        task.state = PENDING
                        task.claimed_by = None
                        task.lease_expires = 0.0
                        requeued += 1
                if requeued:
                    self._cond.notify_all()
            if requeued:
                print(f"[remote] {requeued} 个任务租约到期，已重新排队"
                      f"（worker 可能已离线）", flush=True)


queue = TaskQueue()
