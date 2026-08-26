#!/usr/bin/env python3
"""给歌词太少的歌重新取一次歌词，取不到的标记成「无歌词」不再重试。

    python -m tools.refetch_lyrics              # 试运行，只报告
    python -m tools.refetch_lyrics --apply      # 写盘

为什么会有一批歌只有零星几行：取歌词是按「歌手 - 歌名」查歌词库的，
而这些歌当初入库时名字还是 ``似是故人來 梅艷芳 Karaoke MP4_AAC Stereo``
这种从 YouTube 标题硬猜出来的东西，查不中；查不中就退回语音识别，
偏偏它们本身多是 KTV 伴奏带（没有原唱人声），于是一行也认不出来。

名字修好之后，这些歌大多能直接从歌词库取回逐行歌词。真的取不到的
（歌词库确实没有收录）标记 ``lyrics_status="none"``，点歌台照常能唱伴奏，
只是不显示字幕，也不会再被反复重试。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config                              # noqa: E402
from backend.steps import lyrics_sources, transcribe    # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-lines", type=int, default=5,
                    help="歌词行数不超过这个值就重取（默认 5）")
    ap.add_argument("--sleep", type=float, default=0.3)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    rows = []
    for st in sorted(config.JOBS_DIR.glob("*/status.json")):
        try:
            job = json.loads(st.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if job.get("state") != "done":
            continue
        if (job.get("line_count") or 0) > args.max_lines:
            continue
        rows.append((st, job))
    if args.limit:
        rows = rows[: args.limit]

    print(f"待重取 {len(rows)} 首，模式：{'写回' if args.apply else '试运行'}")
    fixed = skipped = failed = 0
    for st, job in rows:
        artist = (job.get("artist") or "").strip()
        track = (job.get("track") or "").strip()
        label = f"{artist or '?'} - {track or '?'}"
        if not track:
            print(f"  ─ {label}：没有歌名，跳过")
            skipped += 1
            continue

        try:
            meta = {"artist": artist or None, "track": track, "album": None}
            rec = (lyrics_sources.fetch_lrclib(meta, job.get("duration"))
                   or lyrics_sources.fetch_lrclib_relaxed(meta, job.get("duration")))
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {label}：查询出错 {exc}")
            failed += 1
            continue

        lines = lyrics_sources.parse_lrc(rec["syncedLyrics"]) if rec else []
        # 歌词库里有些是残缺记录（只有一句标题行）。行数还不如现状就别换，
        # 拿一行「歌名」替掉原有歌词是纯粹的倒退。
        cur = job.get("line_count") or 0
        if len(lines) < 5 or len(lines) <= cur:
            print(f"  ─ {label}：歌词库没有可用歌词，标记为无歌词")
            skipped += 1
            if args.apply:
                job["lyrics_status"] = "none"
                _save(st, job)
            if args.sleep:
                time.sleep(args.sleep)
            continue

        print(f"  ✓ {label}：{job.get('line_count') or 0} 行 → {len(lines)} 行")
        if args.apply:
            lang = lyrics_sources.detect_language(lines)
            res = transcribe.save_line_lyrics(lines, lang, "LRCLIB", st.parent)
            job.update({
                "language": res.get("language"),
                "lyrics_file": res.get("lyrics_file"),
                "line_count": res.get("line_count"),
                "lyrics_source": res.get("source"),
                "lyrics_status": "ok",
            })
            _save(st, job)
        fixed += 1
        if args.sleep:
            time.sleep(args.sleep)

    print(f"\n取回 {fixed}，标记无歌词 {skipped}，出错 {failed}")
    if fixed and not args.apply:
        print("这是试运行。确认无误后加 --apply。")
    return 0


def _save(st: Path, job: dict) -> None:
    tmp = st.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(st)


if __name__ == "__main__":
    raise SystemExit(main())
