"""Offline word alignment using registered artifact paths and immutable publication."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import config  # noqa: E402
from tools.job_files import artifact_path, load_job  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="离线逐词对齐；复用人声，不重下载或分离")
    parser.add_argument("job_id")
    parser.add_argument("--apply", action="store_true", help="真正运行本机 ML 并发布歌词")
    parser.add_argument("--offline", action="store_true", help="确认已停止服务端及 worker，且无其他维护任务")
    parser.add_argument("--force", action="store_true", help="即使所有行已有词级时间戳也重新对齐")
    args = parser.parse_args(argv)
    if args.apply and not args.offline:
        parser.error("写入前请停止服务端和 worker，并用 --offline 确认")
    try:
        directory, job = load_job(config.JOBS_DIR, args.job_id)
        if job.get("state") != "done":
            raise ValueError("只允许维护已完成的任务")
        lyrics_path = artifact_path(directory, job.get("lyrics_file", "lyrics.json"))
        data = json.loads(lyrics_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or not isinstance(data.get("lines"), list) or not data["lines"]:
            raise ValueError("没有可对齐的歌词行")
        lines = data["lines"]
        if any(not isinstance(line, dict) or not isinstance(line.get("text"), str) for line in lines):
            raise ValueError("歌词行必须包含文本")
        stems = job.get("stems") or {}
        if not isinstance(stems, dict):
            raise ValueError("任务音轨元数据无效")
        vocals = artifact_path(directory, stems.get("vocals"), subdir="stems")
        if all(line.get("words") for line in lines) and not args.force:
            print("所有歌词行已有词级时间戳；需要重新对齐时使用 --force。")
            return 0
        print(f"{args.job_id}：{len(lines)} 行，复用 {vocals.name}")
        if not args.apply:
            print("仅预览，未运行模型或写文件。执行需在具备 ML 依赖的机器上添加 --apply --offline。")
            return 0
        from backend.jobs import manager
        from backend.remote.artifacts import _validate_lyrics
        from backend.steps import transcribe
        generation = manager.generation(args.job_id)
        with manager.execution(args.job_id, generation, allow_done=True):
            with tempfile.TemporaryDirectory(prefix=".word-align-", dir=directory) as workspace:
                output = Path(workspace)
                result = transcribe.align_known_lyrics_local(
                    vocals, lines, data.get("language") or job.get("language") or "zh",
                    output, data.get("source") or job.get("lyrics_source") or "已有歌词",
                    on_progress=lambda percent, message: print(f"[{percent:3}%] {message}"),
                )
                aligned_path = artifact_path(output, result["lyrics_file"])
                aligned = _validate_lyrics(aligned_path, result)
                if not any(line.get("words") for line in aligned["lines"]):
                    raise RuntimeError("本机未产生词级时间戳，保留原歌词；请检查 ML 依赖和对齐模型")
                manager.commit_artifacts(
                    args.job_id, generation, output,
                    {"lyrics_file": result["lyrics_file"], "lrc_file": "lyrics.lrc"},
                    language=result.get("language"), line_count=result["line_count"],
                    lyrics_source=result.get("source"), lyrics_status="ok" if result["line_count"] else "none",
                )
        print("歌词已发布为新文件组；原歌词与音轨保留。")
        return 0
    except (OSError, ValueError, RuntimeError, KeyError) as exc:
        print(f"逐词对齐失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
