"""共享的合成曲目生成器：演示和浏览器回归使用同一套虚构数据。"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
import wave
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def create_cover(path: Path, index: int, background: str, accent: str) -> None:
    size = 256
    dark = tuple(bytes.fromhex(background.removeprefix("#")))
    light = tuple(bytes.fromhex(accent.removeprefix("#")))
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            radius = math.hypot(x - 128, y - 128)
            blend = 0.08 + 0.12 * (1 - y / size)
            if math.hypot(x - (164 - index * 3), y - 96) < 116:
                blend += 0.12
            if radius < 70:
                blend += 0.15
            if y > 192 + 18 * math.sin(2 * math.pi * x / size):
                blend += 0.12
            if any(abs(radius - ring) < 0.7 for ring in (24, 82, 94)):
                blend = 0.8
            if radius < 9:
                blend = 0.95
            pixels.extend(round(a + (b - a) * blend) for a, b in zip(dark, light))

    def chunk(kind: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + kind + payload
                + struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff))

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )


def create_jobs(jobs_dir: Path, *, showcase: bool = False) -> None:
    titles = ("一起唱首歌", "星光练习曲")
    if showcase:
        titles += ("纸飞机电台", "云端散步", "晚风慢半拍", "把月光装进口袋",
                   "萤火和弦", "Pixel Lanterns")
    folders = [Path(jobs_dir) / f"{index:012x}" for index in range(1, len(titles) + 1)]
    for folder in folders:
        if folder.exists() or folder.is_symlink():
            raise FileExistsError(f"演示目录已存在，不会覆盖：{folder}")
    palette = (("#123b43", "#91ded1"), ("#292955", "#c1a1ef"),
               ("#542e4b", "#f5afbc"), ("#16425b", "#9dcfe7"))
    for index, title in enumerate(titles, start=1):
        job_id = f"{index:012x}"
        folder = folders[index - 1]
        stems = folder / "stems"
        folder.mkdir(parents=True, exist_ok=False)
        stems.mkdir()
        duration, rate = 18, 16000
        for name, frequency in (("instrumental", 220), ("vocals", 440)):
            with wave.open(str(stems / f"{name}.wav"), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(rate)
                second = b"".join(struct.pack("<h", int(700 * math.sin(2 * math.pi * frequency * n / rate)))
                                  for n in range(rate))
                for _ in range(duration):
                    audio.writeframesraw(second)
        lines = []
        for line_index, text in enumerate(("一起唱这首歌", "让声音慢慢飞", "把快乐留在这里")):
            start = 1 + line_index * 5
            lines.append({
                "start": start, "end": start + 4, "text": text,
                "words": [{"start": start + i * 0.5, "end": start + (i + 1) * 0.5, "text": char}
                          for i, char in enumerate(text)],
            })
        (folder / "lyrics.json").write_text(
            json.dumps({"language": "zh", "source": "合成回归样本", "lines": lines}, ensure_ascii=False),
            encoding="utf-8",
        )
        status = {
            "id": job_id, "url": "", "webpage_url": "", "title": title,
            "artist": "OpenK", "track": title, "thumbnail": None, "duration": duration,
            "state": "done", "step": "done", "progress": 100, "message": "合成回归样本",
            "error": None, "language": "zh", "stems": {
                "instrumental": "instrumental.wav", "vocals": "vocals.wav",
            },
            "lyrics_file": "lyrics.json", "line_count": len(lines), "lyrics_status": "ok",
            "lyrics_source": "合成回归样本", "video_id": None, "recordings": [],
            "created_at": time.time() + index, "updated_at": time.time(),
        }
        if showcase:
            background, accent = palette[(index - 1) % len(palette)]
            create_cover(folder / "cover.png", index, background, accent)
            status.update(
                artist="OpenK Demo", thumbnail="cover.png",
                created_at=1700000000 + len(titles) - index, updated_at=1700000000,
            )
        (folder / "status.json").write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")


def create(root: Path, *, showcase: bool = False) -> None:
    create_jobs(Path(root) / "jobs", showcase=showcase)


def main(argv: list[str] | None = None, *, require_directory: bool = False) -> int:
    parser = argparse.ArgumentParser(
        description="生成合成演示曲目，不下载音乐、不读取真实麦克风；已有目录不会覆盖")
    parser.add_argument("directory", nargs=None if require_directory else "?", type=Path,
                        help="演示工作区根目录，任务写到其 jobs/ 子目录")
    parser.add_argument("--jobs-dir", type=Path,
                        help="直接指定任务目录；不指定时使用 OPENK_JOBS_DIR / OPENK_DATA_DIR")
    parser.add_argument("--showcase", action="store_true",
                        help="Optional fictional catalog and generated covers for public screenshots")
    args = parser.parse_args(argv)
    if args.directory is not None and args.jobs_dir is not None:
        parser.error("directory 和 --jobs-dir 不能同时使用")
    if args.jobs_dir is not None:
        jobs_dir = args.jobs_dir
    elif args.directory is not None:
        jobs_dir = args.directory / "jobs"
    else:
        from backend import config
        jobs_dir = config.JOBS_DIR
    try:
        create_jobs(jobs_dir, showcase=args.showcase)
    except OSError as exc:
        print(f"生成演示失败：{exc}", file=sys.stderr)
        return 1
    print(f"已生成 {'8' if args.showcase else '2'} 首合成曲目：{jobs_dir}")
    print("启动服务后即可使用；运行中的服务需重新加载才能发现外部新增的演示任务。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
