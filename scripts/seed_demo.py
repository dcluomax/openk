#!/usr/bin/env python3
"""生成一个「演示」任务，无需任何机器学习依赖即可体验卡拉OK播放器。

仅使用 Python 标准库合成两条音轨（伴奏 / 人声）与一份带词级时间戳的歌词，
写入 ``data/jobs/demo/``，并标记为已完成。启动服务后即可在页面「我的曲库」中打开。

用法:
    python scripts/seed_demo.py
"""
from __future__ import annotations

import json
import math
import struct
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO_DIR = ROOT / "data" / "jobs" / "demo"
STEMS_DIR = DEMO_DIR / "stems"
SR = 22050
DURATION = 18.0

# 演示歌词（词级时间戳，单位秒）
LINES = [
    {"text": "欢迎 使用 openk 卡拉OK", "words": [
        ("欢迎", 0.5, 1.3), ("使用", 1.3, 2.1), ("openk", 2.1, 3.1), ("卡拉OK", 3.1, 4.2)]},
    {"text": "人声 已经 被 干净 分离", "words": [
        ("人声", 4.8, 5.6), ("已经", 5.6, 6.3), ("被", 6.3, 6.7), ("干净", 6.7, 7.5), ("分离", 7.5, 8.4)]},
    {"text": "歌词 正在 逐字 高亮", "words": [
        ("歌词", 9.0, 9.8), ("正在", 9.8, 10.6), ("逐字", 10.6, 11.4), ("高亮", 11.4, 12.3)]},
    {"text": "现在 就 开始 尽情 唱吧", "words": [
        ("现在", 12.9, 13.6), ("就", 13.6, 14.0), ("开始", 14.0, 14.8), ("尽情", 14.8, 15.6), ("唱吧", 15.6, 16.6)]},
]

# 简单音阶（用于让人声轨大致跟着字走，纯属演示）
SCALE = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25]


def _write_wav(path: Path, samples: list[float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in samples:
            v = max(-1.0, min(1.0, s))
            frames += struct.pack("<h", int(v * 32000))
        w.writeframes(bytes(frames))


def _instrumental() -> list[float]:
    """柔和的持续和弦 + 缓慢颤音，作为伴奏。"""
    chord = [220.0, 277.18, 329.63]  # A3 / C#4 / E4
    n = int(SR * DURATION)
    out = []
    for i in range(n):
        t = i / SR
        trem = 0.85 + 0.15 * math.sin(2 * math.pi * 0.7 * t)
        v = sum(math.sin(2 * math.pi * f * t) for f in chord) / len(chord)
        # 首尾淡入淡出
        env = min(1.0, t / 0.8, (DURATION - t) / 0.8)
        out.append(0.22 * v * trem * max(0.0, env))
    return out


def _vocals() -> list[float]:
    """按歌词逐字发出音符，作为「导唱人声」。"""
    n = int(SR * DURATION)
    out = [0.0] * n
    wi = 0
    for line in LINES:
        for word, ws, we in line["words"]:
            freq = SCALE[wi % len(SCALE)]
            wi += 1
            a, b = int(ws * SR), int(we * SR)
            for i in range(a, min(b, n)):
                t = (i - a) / SR
                dur = (b - a) / SR
                env = min(1.0, t / 0.05, (dur - t) / 0.08)
                out[i] = 0.35 * math.sin(2 * math.pi * freq * (i / SR)) * max(0.0, env)
    return out


def _lyrics() -> dict:
    lines = []
    for line in LINES:
        words = [{"text": w, "start": s, "end": e} for (w, s, e) in line["words"]]
        lines.append({
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "text": line["text"],
            "words": words,
        })
    return {"language": "zh", "lines": lines}


def main() -> None:
    STEMS_DIR.mkdir(parents=True, exist_ok=True)
    print("合成伴奏轨 …")
    _write_wav(STEMS_DIR / "instrumental.wav", _instrumental())
    print("合成人声轨 …")
    _write_wav(STEMS_DIR / "vocals.wav", _vocals())

    (DEMO_DIR / "lyrics.json").write_text(
        json.dumps(_lyrics(), ensure_ascii=False, indent=2), encoding="utf-8")

    now = time.time()
    status = {
        "id": "demo",
        "url": "demo://openk",
        "webpage_url": None,
        "title": "🎵 openk 演示曲（合成音频）",
        "thumbnail": None,
        "duration": DURATION,
        "state": "done",
        "step": "done",
        "progress": 100,
        "message": "演示数据，可直接播放体验",
        "error": None,
        "language": "zh",
        "stems": {"instrumental": "instrumental.wav", "vocals": "vocals.wav"},
        "lyrics_file": "lyrics.json",
        "line_count": len(LINES),
        "created_at": now,
        "updated_at": now,
    }
    (DEMO_DIR / "status.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"✅ 演示任务已生成： {DEMO_DIR}")
    print("   启动服务后在页面「我的曲库」中打开「openk 演示曲」即可体验。")


if __name__ == "__main__":
    main()
