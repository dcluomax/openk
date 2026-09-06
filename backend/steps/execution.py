"""Bounded CLI execution shared by ML steps and the worker task supervisor."""
from __future__ import annotations

from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar
import logging
import os
import queue
import signal
import subprocess
import threading
import time
from typing import Callable, Optional

log = logging.getLogger("openk.execution")
_cancel_check: ContextVar = ContextVar("processing_cancel_check", default=None)


class StepTimeout(RuntimeError):
    pass


@contextmanager
def cancellation_checks(check):
    token = _cancel_check.set(check)
    try:
        yield
    finally:
        _cancel_check.reset(token)


def task_supervised() -> bool:
    """Only a worker child with a whole-task deadline may set this flag."""
    return os.environ.get("OPENK_TASK_SUPERVISED") == "1"


def run_cli(command: list[str], *, timeout: float, label: str,
            env: Optional[dict] = None, on_line: Optional[Callable[[str], None]] = None,
            input_text: Optional[str] = None) -> tuple[int, list[str]]:
    if timeout <= 0:
        raise ValueError("ML 执行时限必须大于零")
    check = _cancel_check.get()
    if check:
        check()
    own_group = os.name == "posix" and not task_supervised()
    started = time.monotonic()
    proc = subprocess.Popen(
        command, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
        bufsize=1, env=env, start_new_session=own_group,
    )
    messages: queue.Queue = queue.Queue(maxsize=64)
    stopped = threading.Event()
    expired = threading.Event()
    termination_lock = threading.Lock()
    terminated = False
    recent: deque[str] = deque(maxlen=40)

    def terminate() -> None:
        nonlocal terminated
        with termination_lock:
            if terminated:
                return
            if own_group:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except PermissionError:
                    # Some process supervisors restrict group signalling even
                    # for an owned child; still reap the explicitly owned PID.
                    if proc.poll() is None:
                        proc.kill()
            elif proc.poll() is None:
                proc.kill()
            terminated = True

    def expire() -> None:
        expired.set()
        terminate()

    def publish(value) -> None:
        while not stopped.is_set():
            try:
                messages.put(value, timeout=0.1)
                return
            except queue.Full:
                pass

    def read() -> None:
        try:
            for line in proc.stdout:
                publish(line.rstrip())
        finally:
            publish(None)

    def write() -> None:
        try:
            proc.stdin.write(input_text)
            proc.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    writer = None
    if input_text is not None:
        writer = threading.Thread(target=write, daemon=True)
        writer.start()
    deadline = started + timeout
    timer = threading.Timer(timeout, expire)
    timer.daemon = True
    timer.start()
    try:
        while True:
            if check:
                check()
            remaining = deadline - time.monotonic()
            if remaining <= 0 or expired.is_set():
                raise StepTimeout(f"{label}超时（超过 {timeout:g} 秒）")
            try:
                line = messages.get(timeout=min(remaining, 0.1))
            except queue.Empty:
                continue
            if line is None:
                try:
                    code = proc.wait(timeout=max(0.001, deadline - time.monotonic()))
                except subprocess.TimeoutExpired as exc:
                    raise StepTimeout(f"{label}超时（超过 {timeout:g} 秒）") from exc
                if expired.is_set():
                    raise StepTimeout(f"{label}超时（超过 {timeout:g} 秒）")
                return code, list(recent)
            if line:
                recent.append(line)
                if on_line:
                    on_line(line)
    finally:
        stopped.set()
        timer.cancel()
        # A supervised worker owns the whole inherited group. Standalone calls
        # own their group, including decoder/model descendants.
        terminate()
        proc.wait()
        reader.join(timeout=2)
        if writer is not None:
            writer.join(timeout=2)
        proc.stdout.close()
        log.info("ml_execution step=%s duration_seconds=%.3f",
                 label, time.monotonic() - started)
