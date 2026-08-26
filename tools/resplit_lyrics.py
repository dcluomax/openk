#!/usr/bin/env python3
"""把已有曲库里过长的歌词行重新切短。

    python -m tools.resplit_lyrics             # 试运行，只报告
    python -m tools.resplit_lyrics --apply     # 写回 lyrics.json / lyrics.lrc

新歌在转写时就已经切好了（见 transcribe._write_lyrics），这个脚本只用来
补救存量。切行只依赖歌词文件本身的词级时间戳，不需要重跑流水线、不碰音频。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config                                    # noqa: E402
from backend.steps.lyrics_layout import split_long_lines, width  # noqa: E402


def write_lrc(lines, path: Path) -> None:
    def ts(t: float) -> str:
        m = int(t // 60)
        return f"[{m:02d}:{t - m * 60:05.2f}]"
    out = ["[re:openk]"] + [f"{ts(ln['start'])}{ln['text']}" for ln in lines]
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-width", type=int, default=config.LYRIC_MAX_WIDTH)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    files = sorted(config.JOBS_DIR.glob("*/lyrics.json"))
    if args.limit:
        files = files[: args.limit]
    print(f"检查 {len(files)} 份歌词，上限宽度 {args.max_width}，"
          f"模式：{'写回' if args.apply else '试运行'}")

    touched = worst_before = 0
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        lines = data.get("lines") or []
        if not lines:
            continue
        before_max = max((width(l.get("text", "")) for l in lines), default=0)
        if before_max <= args.max_width:
            continue
        new_lines = split_long_lines(lines, args.max_width)
        after_max = max((width(l.get("text", "")) for l in new_lines), default=0)
        touched += 1
        worst_before = max(worst_before, before_max)
        print(f"  {f.parent.name}: {len(lines)}→{len(new_lines)} 行，"
              f"最宽 {before_max}→{after_max}")
        if args.apply:
            data["lines"] = new_lines
            tmp = f.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(f)
            write_lrc(new_lines, f.parent / "lyrics.lrc")
            st = f.parent / "status.json"
            try:
                job = json.loads(st.read_text(encoding="utf-8"))
                job["line_count"] = len(new_lines)
                t2 = st.with_suffix(".json.tmp")
                t2.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
                t2.replace(st)
            except (OSError, json.JSONDecodeError):
                pass

    print(f"\n需要重切 {touched} 首（原先最宽 {worst_before} 单位 ≈ "
          f"{worst_before // 2} 个汉字）")
    if touched and not args.apply:
        print("这是试运行。确认无误后加 --apply 写回。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
