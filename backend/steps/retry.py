"""ML 步骤的瞬时故障重试。

跑长批量（几百首）时，audio-separator / whisperX 偶尔会以原生崩溃收场：

    人声分离失败（退出码 -6）：libc++abi: terminating due to uncaught exception
    of type std::__1::system_error: recursive_mutex lock failed: Invalid argument
    人声分离失败（退出码 1）：Separation produced no output files

这类失败和歌本身没关系——同一首重跑一次基本就过了，属于底层库在长时间
高负载下的偶发问题。但一次崩溃就让这首歌永久停在「失败」状态，几百首的
批量里会静默少掉好几首，得手动一个个去点重试。

所以这里对**明显是崩溃**的失败自动重试；像「未安装依赖」「文件不存在」
这种重试多少次都一样的错误则原样抛出，免得白白多花几分钟。
"""
from __future__ import annotations

import re
import time
from typing import Callable, TypeVar

T = TypeVar("T")

# 崩溃类特征：信号退出（SIGABRT/SIGSEGV 等）、C++ 运行时异常、分离器空输出。
_TRANSIENT = re.compile(
    r"退出码 -\d+"
    r"|libc\+\+abi"
    r"|std::__1::system_error"
    r"|recursive_mutex"
    r"|Segmentation fault"
    r"|produced no output files"
    r"|Bus error"
    r"|Resource temporarily unavailable",
    re.IGNORECASE,
)


def is_transient(exc: BaseException) -> bool:
    """这个异常看起来是偶发崩溃、值得重试吗？"""
    return bool(_TRANSIENT.search(str(exc)))


def with_retry(fn: Callable[[], T], *, attempts: int = 2, delay: float = 3.0,
               label: str = "", on_progress=None) -> T:
    """执行 fn，遇到瞬时崩溃就重试。

    attempts 是总次数（默认 2 = 首次 + 重试一次）。重试之间稍等一下，
    给系统一点回收内存和句柄的时间——崩溃常常发生在资源吃紧的时候。
    """
    last: BaseException | None = None
    for i in range(max(1, attempts)):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - 需要按内容判断是否重试
            last = exc
            if i == attempts - 1 or not is_transient(exc):
                raise
            msg = f"{label}遇到偶发崩溃，正在重试（第 {i + 2} 次）…"
            print(f"[retry] {msg} 原因：{exc}", flush=True)
            if on_progress:
                try:
                    on_progress(0, msg)
                except Exception:  # noqa: BLE001 - 进度回调失败不该影响重试
                    pass
            time.sleep(delay)
    raise last  # type: ignore[misc]  # 循环必然 return 或 raise，这行只为类型收敛
