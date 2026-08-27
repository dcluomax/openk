"""音质评估：从已分离的伴奏里反推源文件的实际带宽。

为什么不看文件大小或码率？分离出来的 stem 一律按固定码率重编码，源是
128kbps 还是无损，出来的 mp3 字节数一模一样——**容器信息全丢了**。

但**频谱骗不了人**：有损编码会在某个频率上砖墙式切掉高频，这条截止线会
原样保留在分离结果里。实测本曲库的截止基本落在 13–16kHz，正是 YouTube
那档 AAC 的特征——也就是说同一首歌的几个版本，源的档次其实相当接近，
真正拉开差距的是 8–16kHz 这段高频还剩多少（翻录、二次转码、过度压限都
会把它啃掉）。所以这里同时给出两个量：

* ``cutoff_khz`` —— 砖墙位置，判断源的编码档次；
* ``hf_db``     —— 8–16kHz 相对中频的能量，判断实际的通透度。

只解码中间一小段：卡拉OK带的前奏尾奏常是静音或渐入，拿整首平均反而把
截止线糊掉了。
"""
from __future__ import annotations

import subprocess
from typing import Any, Dict, Optional

try:
    import numpy as np
except ImportError:  # pragma: no cover - 只有频谱分析要 numpy
    # 打分和排序是纯算术。没装 numpy 时让模块照样能导入，这样除重的判断
    # 逻辑在没有科学计算栈的机器上也能跑自检，只是分析函数会直接返回 None。
    np = None

SAMPLE_RATE = 44100
WINDOW = 8192
SLICE_SECONDS = 60.0
# 判定「高频到此为止」的相对阈值。-30dB 是实测扫出来的：再松（-40dB 以下）
# 会把有损编码留下的量化噪声也算成信号，所有文件一律顶到奈奎斯特，失去区分度。
FLOOR_DB = 30.0
# 认为削波的样本电平。留一点余量，别把正常的满刻度峰值当成削波。
CLIP_LEVEL = 0.985


def _decode(path: str, start: float, seconds: float) -> Optional[np.ndarray]:
    """解出一段单声道 PCM。失败返回 ``None``（坏文件不该让整个流程崩掉）。"""
    cmd = ["ffmpeg", "-v", "error", "-ss", "%.2f" % max(0.0, start),
           "-t", "%.2f" % seconds, "-i", path,
           "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=300).stdout
    except Exception:  # noqa: BLE001
        return None
    if len(out) < WINDOW * 2:
        return None
    return np.frombuffer(out, dtype="<i2").astype(np.float32) / 32768.0


def analyse(path: str, duration: Optional[float] = None) -> Optional[Dict[str, Any]]:
    """量一段音频的带宽与削波情况。取不到返回 ``None``。"""
    if np is None:
        return None
    start = 30.0
    if duration and duration > SLICE_SECONDS + 60:
        start = (duration - SLICE_SECONDS) / 2.0    # 从中间取，避开前奏尾奏
    pcm = _decode(path, start, SLICE_SECONDS)
    if pcm is None:
        pcm = _decode(path, 0.0, SLICE_SECONDS)     # 短曲子退回从头取
    if pcm is None:
        return None

    n = (len(pcm) // WINDOW) * WINDOW
    if n < WINDOW:
        return None
    frames = pcm[:n].reshape(-1, WINDOW) * np.hanning(WINDOW)
    power = (np.abs(np.fft.rfft(frames, axis=1)) ** 2).mean(axis=0)
    if not np.isfinite(power).all() or power.max() <= 0:
        return None
    db = 10.0 * np.log10(power + 1e-20)
    # 平滑掉单个频点的抖动，免得一根杂散谱线把截止线拉高
    db = np.convolve(db, np.ones(9) / 9.0, mode="same")
    freqs = np.fft.rfftfreq(WINDOW, 1.0 / SAMPLE_RATE)

    ref = float(np.mean(db[(freqs >= 1000) & (freqs < 4000)]))
    above = np.nonzero(db > ref - FLOOR_DB)[0]
    cutoff = float(freqs[above[-1]] / 1000.0) if len(above) else 0.0
    hf = float(np.mean(db[(freqs >= 8000) & (freqs < 16000)])) - ref
    return {
        "cutoff_khz": round(cutoff, 2),
        "hf_db": round(hf, 2),
        "clip_pct": round(float(np.mean(np.abs(pcm) > CLIP_LEVEL) * 100), 3),
        "rms_db": round(float(20 * np.log10(np.sqrt(np.mean(pcm ** 2)) + 1e-12)), 2),
    }


def quality_score(m: Optional[Dict[str, Any]]) -> float:
    """把几项指标压成一个可比的分数，越大越好。量不出来的排最后。

    两项权重刻意调成同一量级：本曲库里 ``cutoff`` 的实测跨度约 3kHz，
    ``hf_db`` 约 13dB，各乘系数后都落在十几分，谁也不会单独压倒对方。
    削波是硬伤，罚得重——爆掉的伴奏在音响上格外难听。
    """
    if not m:
        return float("-inf")
    return (m["cutoff_khz"] * 4.0) + m["hf_db"] - (m["clip_pct"] * 5.0)
