"""歌词编排：按优先级选择来源并生成最终的 lyrics.json。

优先级（越靠前质量越高）：
    1. LRCLIB 同步歌词（歌词文本准确 + 逐行时间戳）
    2. YouTube 字幕（官方 > 自动）
    → 以上两者若拿到，交给 whisperX 强制对齐纯人声，细化为**逐词**时间戳；
      对齐不可用/失败时回退为逐行时间戳（仍可用）。
    3. Whisper 全自动转写 + 对齐（前面都没有时的兜底）
"""
from __future__ import annotations

import traceback
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import lyrics_sources, transcribe

ProgressCb = Optional[Callable[[int, str], None]]


def build(
    info: Dict[str, Any],
    vocals_path: str | Path,
    out_dir: Path,
    language: Optional[str] = None,
    model: Optional[str] = None,
    on_progress: ProgressCb = None,
) -> Dict[str, Any]:
    """生成歌词并落盘，返回结果摘要（含 source）。"""
    # 1) 寻找现成的逐行歌词
    candidate: Optional[Dict[str, Any]] = None
    if on_progress:
        on_progress(3, "正在查找歌词（歌词库 / 字幕）…")
    try:
        candidate = lyrics_sources.from_lrclib(info)
    except Exception:  # noqa: BLE001 - 网络等问题不应中断流程
        traceback.print_exc()
        candidate = None
    if not candidate:
        try:
            candidate = lyrics_sources.from_subtitles(info.get("subtitles"))
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            candidate = None

    # 2) 有现成歌词 → 尝试逐词强制对齐，失败则保留逐行
    if candidate:
        lang = (language or candidate.get("language")
                or lyrics_sources.detect_language(candidate["lines"]))
        source = candidate["source"]
        try:
            if on_progress:
                on_progress(8, f"已获取歌词（{source}），正在逐词对齐…")
            return transcribe.align_known_lyrics(
                vocals_path, candidate["lines"], lang, out_dir, source, on_progress)
        except Exception:  # noqa: BLE001 - 对齐失败则优雅降级
            traceback.print_exc()
            if on_progress:
                on_progress(90, f"逐词对齐不可用，使用逐行歌词（{source}）")
            return transcribe.save_line_lyrics(
                candidate["lines"], lang, source, out_dir, on_progress)

    # 3) 兜底：whisperX 转写 + 对齐
    if on_progress:
        on_progress(10, "未找到现成歌词，改用语音识别…")
    return transcribe.transcribe(
        vocals_path, out_dir, model=model, language=language or None, on_progress=on_progress)
