"""Shared validation for downloaded and local media."""
from __future__ import annotations

import math

from .. import config


def check_duration(duration: object) -> None:
    """Reject known oversized sources before copying, and again after acquisition."""
    try:
        seconds = float(duration)
    except (TypeError, ValueError):
        return
    if not math.isfinite(seconds) or seconds <= 0:
        return
    if config.MAX_SONG_SECONDS and seconds > config.MAX_SONG_SECONDS:
        raise RuntimeError(
            f"视频时长约 {int(seconds // 60)} 分 {int(seconds % 60)} 秒，超过 "
            f"{config.MAX_SONG_SECONDS // 60} 分钟，判定不是单曲。"
            "（如需处理长音频，可调高环境变量 OPENK_MAX_SONG_SECONDS）"
        )
