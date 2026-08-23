#!/usr/bin/env python3
"""歌词时间轴的自检脚本：python test_lyrics.py

针对的是一个很隐蔽、但几乎每首带片头的 MV 都会中招的问题：
歌词库（LRCLIB 等）的时间轴对的是录音室单曲，而我们处理的是 YouTube 视频，
两者常常整体错开几秒。whisperX 的 align() 只在给定窗口内部细化词位置
（alignment.py 里 ``audio[:, f1:f2]``），救不回整体偏移——输出会带着漂亮的
逐词时间戳，整段却是错位的，光看结果根本发现不了。

所以这里专门验证「先估平移量、再对齐」这一步：估得准，且在本来就准的歌上
不乱动。用合成音频，不需要 torch / whisperX。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)


SR = 16000


def _synth(line_times, bleed=0.0):
    """合成一段人声轨：给定区间是唱歌，其余是底噪。

    bleed 模拟分离后残留的伴奏——实测里人声轨几乎从不真正安静，
    估计器必须在这种条件下依然找得准。
    """
    import numpy as np
    rng = np.random.default_rng(1234)
    total = int((max(e for _, e in line_times) + 10) * SR)
    audio = rng.normal(0, bleed, total).astype("float32") if bleed > 0 \
        else np.zeros(total, dtype="float32")
    for a, b in line_times:
        i, j = int(a * SR), int(b * SR)
        audio[i:j] += rng.normal(0, 0.25, j - i).astype("float32")
    return audio


def _lines(line_times, shift=0.0):
    return [{"start": a + shift, "end": b + shift, "text": f"line {i}"}
            for i, (a, b) in enumerate(line_times)]


def test_recovers_known_offset() -> None:
    from backend.steps.transcribe import estimate_lyrics_offset
    times = [(10 + i * 4.0, 12 + i * 4.0) for i in range(14)]
    audio = _synth(times, bleed=0.02)
    for truth in (-9.0, -5.8, -2.0, 3.5, 11.0):
        # 歌词整体比音频早/晚 truth 秒，估计器应当给出 -truth 把它拉回来
        got, snr = estimate_lyrics_offset(audio, _lines(times, shift=truth))
        check(f"能找回 {truth:+.1f}s 的整体偏移",
              abs(got + truth) <= 0.5, f"估计 {got:+.2f}s（信噪比 {snr:.1f}）")


def test_leaves_correct_timeline_alone() -> None:
    """本来就对的歌不能被挪动，否则这个功能是负收益。"""
    from backend.steps.transcribe import estimate_lyrics_offset
    from backend import config
    times = [(10 + i * 4.0, 12 + i * 4.0) for i in range(14)]
    audio = _synth(times, bleed=0.02)
    got, _ = estimate_lyrics_offset(audio, _lines(times))
    check("时间轴已正确时落在死区内",
          abs(got) < config.LYRICS_OFFSET_MIN, f"估计 {got:+.2f}s")


def test_degrades_safely() -> None:
    from backend.steps.transcribe import estimate_lyrics_offset
    import numpy as np
    times = [(10 + i * 4.0, 12 + i * 4.0) for i in range(14)]
    check("没有歌词行时返回 0",
          estimate_lyrics_offset(_synth(times), [])[0] == 0.0)
    check("音频太短时返回 0",
          estimate_lyrics_offset(np.zeros(10, dtype="float32"), _lines(times))[0] == 0.0)


def test_search_range_is_respected() -> None:
    """搜索范围要能收窄——范围越大越容易被副歌的重复段带偏。"""
    from backend.steps.transcribe import estimate_lyrics_offset
    times = [(10 + i * 4.0, 12 + i * 4.0) for i in range(14)]
    audio = _synth(times, bleed=0.02)
    got, _ = estimate_lyrics_offset(audio, _lines(times, shift=-9.0), max_shift=3.0)
    check("估计值不会超出给定的搜索范围", abs(got) <= 3.0 + 1e-6, f"估计 {got:+.2f}s")


def test_ignores_contiguous_end_times() -> None:
    """歌词库常把 end 直接补成下一行的起点，行行首尾相接。

    掩码若照搬这个 end，整首歌就连成一整块，句间空档消失——而空档恰恰是
    最有对齐价值的信号。实测中这会让偏移整体偏掉半秒以上，是真实踩过的坑。
    """
    from backend.steps.transcribe import estimate_lyrics_offset
    times = [(10 + i * 4.0, 12 + i * 4.0) for i in range(14)]
    audio = _synth(times, bleed=0.02)
    starts = [a for a, _ in times]
    contiguous = [{"start": s + (-6.0), "text": f"line {i}",
                   "end": (starts[i + 1] if i + 1 < len(starts) else s + 4.0) + (-6.0)}
                  for i, s in enumerate(starts)]
    got, _ = estimate_lyrics_offset(audio, contiguous)
    check("end 被补成下一行起点时依然估得准",
          abs(got - 6.0) <= 0.5, f"估计 {got:+.2f}s，期望 +6.00s")


def main() -> int:
    try:
        import numpy  # noqa: F401
    except ImportError:
        print("跳过：本机没有 numpy（时间轴校正只在装了 ML 依赖的机器上执行）")
        return 0

    for fn in (test_recovers_known_offset, test_leaves_correct_timeline_alone,
               test_ignores_contiguous_end_times,
               test_degrades_safely, test_search_range_is_respected):
        print(f"\n── {fn.__name__} ──")
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            check(fn.__name__, False, str(exc))

    print()
    if _failures:
        print(f"❌ {len(_failures)} 项失败：{', '.join(_failures)}")
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
