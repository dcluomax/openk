"""ML 步骤瞬时崩溃重试的测试。

重点是**别把不该重试的错误也重试了**：依赖没装、文件不存在这类问题
重试多少次都一样，白等几分钟还掩盖了真正的原因。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from backend.steps.retry import is_transient, with_retry  # noqa: E402

PASS = FAIL = 0


def ok(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  ✗ {name}")


def main():
    # 真实日志里出现过的崩溃，都应当判定为可重试
    for msg in [
        "人声分离失败（退出码 -6）：libc++abi: terminating due to uncaught exception "
        "of type std::__1::system_error: recursive_mutex lock failed: Invalid argument",
        "人声分离失败（退出码 1）：ERROR - cli - Separation produced no output files",
        "歌词识别失败（退出码 -11）：Segmentation fault",
    ]:
        ok(is_transient(RuntimeError(msg)), f"应判为瞬时：{msg[:34]}")

    # 这些重试也没用，必须立刻抛出
    for msg in [
        "未找到 audio-separator，请先安装 ML 依赖",
        "分离完成但未找到 vocals / instrumental 输出文件",
        "人声分离超时（超过 30 分钟）",
        "路径不存在，或不在允许的媒体目录内",
    ]:
        ok(not is_transient(RuntimeError(msg)), f"不该重试：{msg[:24]}")

    # 崩溃一次后重试成功
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("人声分离失败（退出码 -6）：libc++abi: terminating")
        return "ok"

    ok(with_retry(flaky, delay=0) == "ok" and calls["n"] == 2, "崩溃一次后重试成功")

    # 一直崩溃，最终仍要抛出（而不是无限重试）
    calls2 = {"n": 0}

    def always():
        calls2["n"] += 1
        raise RuntimeError("退出码 -6：libc++abi")

    try:
        with_retry(always, delay=0)
        ok(False, "始终崩溃应最终抛出")
    except RuntimeError:
        ok(calls2["n"] == 2, "始终崩溃时只试 2 次")

    # 非瞬时错误必须一次就抛，不能浪费时间重试
    calls3 = {"n": 0}

    def hard():
        calls3["n"] += 1
        raise RuntimeError("未找到 audio-separator")

    try:
        with_retry(hard, delay=0)
        ok(False, "非瞬时错误应抛出")
    except RuntimeError:
        ok(calls3["n"] == 1, "非瞬时错误不重试")

    # 进度回调抛异常不该影响重试本身
    calls4 = {"n": 0}

    def flaky2():
        calls4["n"] += 1
        if calls4["n"] == 1:
            raise RuntimeError("退出码 -6：libc++abi")
        return "ok"

    def bad_progress(pct, msg):
        raise ValueError("回调自己坏了")

    ok(with_retry(flaky2, delay=0, on_progress=bad_progress) == "ok",
       "进度回调出错不影响重试")

    print(f"\n通过 {PASS} 项，失败 {FAIL} 项")
    return 1 if FAIL else 0


if __name__ == "__main__":
    print("== 瞬时崩溃重试 ==")
    sys.exit(main())
