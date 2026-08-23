"""步骤侧的远程调用入口。

每个重活函数只需在开头加三行即可支持远程执行，签名与 ``on_progress``
契约完全不变，因此 pipeline.py 与前端不用改。
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from .. import config
from .queue import queue

ProgressCb = Optional[Callable[[int, str], None]]


def enabled(kind: str) -> bool:
    return kind in config.REMOTE_STEPS


def run(kind: str, args: Dict[str, Any],
        on_progress: ProgressCb = None,
        local: Optional[Callable[[], Dict[str, Any]]] = None) -> Dict[str, Any]:
    """把步骤交给远程 worker；必要时退回本地执行。

    ``config.REMOTE_WAIT_TIMEOUT`` 为 0 时无限等待，这是「worker 可选择性
    在线」的默认语义：没人在线就排队，不报错。
    """
    timeout = config.REMOTE_WAIT_TIMEOUT or None
    try:
        return queue.submit(kind, args, on_progress=on_progress, timeout=timeout)
    except TimeoutError:
        if config.REMOTE_FALLBACK_LOCAL and local is not None:
            if on_progress:
                on_progress(0, "远程节点未响应，改用本机执行（会明显更慢）…")
            return local()
        raise
