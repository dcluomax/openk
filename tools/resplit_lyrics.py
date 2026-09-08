#!/usr/bin/env python3
"""把已有曲库里过长的歌词行重新切短。

    python -m tools lyrics resplit             # 试运行，只报告
    python -m tools lyrics resplit --apply     # 离线发布新的 JSON / LRC 文件组

新歌在转写时就已经切好了（见 transcribe._write_lyrics），这个脚本只用来
补救存量。切行只依赖歌词文件本身的词级时间戳，不需要重跑流水线、不碰音频。
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config                                    # noqa: E402
from backend.steps.lyrics_layout import split_long_lines, width  # noqa: E402
from tools.job_files import artifact_path, load_job  # noqa: E402


def write_lrc(lines, path: Path) -> None:
    def ts(t: float) -> str:
        m = int(t // 60)
        return f"[{m:02d}:{t - m * 60:05.2f}]"
    out = ["[re:openk]"] + [f"{ts(ln['start'])}{ln['text']}" for ln in lines]
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="离线重切歌词行；写入前请停止 API 和 worker")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--max-width", type=int, default=config.LYRIC_MAX_WIDTH)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    if args.max_width <= 0 or args.limit < 0:
        ap.error("--max-width 必须为正数，--limit 不能为负数")

    files = sorted(config.JOBS_DIR.glob("*/status.json"))
    if args.limit:
        files = files[: args.limit]
    print(f"检查 {len(files)} 个任务，上限宽度 {args.max_width}，"
          f"模式：{'写回' if args.apply else '试运行'}")

    touched = worst_before = failures = 0
    for status in files:
        try:
            directory, job = load_job(config.JOBS_DIR, status.parent.name)
            if job.get("state") != "done" or not job.get("lyrics_file", "lyrics.json"):
                continue
            f = artifact_path(directory, job.get("lyrics_file", "lyrics.json"))
            data = json.loads(f.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("lines"), list):
                raise ValueError("歌词必须包含 lines 数组")
            if any(not isinstance(line, dict) or not isinstance(line.get("text"), str)
                   for line in data["lines"]):
                raise ValueError("歌词行必须包含文本")
        except (OSError, ValueError) as exc:
            print(f"  ✗ {status.parent.name}：{exc}", file=sys.stderr)
            failures += 1
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
        print(f"  {job['id']}: {len(lines)}→{len(new_lines)} 行，"
              f"最宽 {before_max}→{after_max}")
        if args.apply:
            data["lines"] = new_lines
            from backend.jobs import manager
            generation = manager.generation(job["id"])
            with manager.execution(job["id"], generation, allow_done=True):
                with tempfile.TemporaryDirectory(prefix=".resplit-", dir=directory) as workspace:
                    output = Path(workspace)
                    (output / "lyrics.json").write_text(
                        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                    write_lrc(new_lines, output / "lyrics.lrc")
                    manager.commit_artifacts(
                        job["id"], generation, output,
                        {"lyrics_file": "lyrics.json", "lrc_file": "lyrics.lrc"},
                        line_count=len(new_lines),
                    )

    print(f"\n需要重切 {touched} 首（原先最宽 {worst_before} 单位 ≈ "
          f"{worst_before // 2} 个汉字）")
    if touched and not args.apply:
        print("这是试运行。确认无误后加 --apply 写回。")
    if failures:
        print(f"{failures} 个任务读取失败，未修改这些任务。", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
