"""把某个已完成任务的行级歌词就地升级为逐词对齐（复用已分离的人声）。

用法：
    python -m scripts.upgrade_word_align <job_id>

适用场景：早期因缺少 NLTK ``punkt_tab`` 资源导致逐词对齐失败、
回退成行级歌词的任务。资源修好后无需重新下载/分离，直接重对齐即可。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from backend import config
from backend.steps import transcribe


def main(job_id: str) -> int:
    job_dir = config.JOBS_DIR / job_id
    lyrics_path = job_dir / "lyrics.json"
    vocals = job_dir / "stems" / "vocals.mp3"

    if not lyrics_path.exists():
        print(f"找不到 {lyrics_path}")
        return 1
    if not vocals.exists():
        print(f"找不到人声文件 {vocals}")
        return 1

    data = json.loads(lyrics_path.read_text(encoding="utf-8"))
    lines = data.get("lines") or []
    language = data.get("language") or "zh"
    if not lines:
        print("lyrics.json 无歌词行，无法对齐")
        return 1

    already = sum(len(ln.get("words") or []) for ln in lines)
    if already:
        print(f"该任务已是逐词对齐（{already} 个词），无需升级")
        return 0

    print(f"开始逐词对齐：{job_id}（{len(lines)} 行，语言 {language}）")

    def prog(p: int, m: str) -> None:
        print(f"  [{p:>3}%] {m}")

    result = transcribe.align_known_lyrics(
        vocals_path=vocals,
        lines=lines,
        language=language,
        out_dir=job_dir,
        source="LRCLIB",
        on_progress=prog,
    )
    print("完成：", result)

    check = json.loads(lyrics_path.read_text(encoding="utf-8"))
    total_words = sum(len(ln.get("words") or []) for ln in check["lines"])
    first = next((ln for ln in check["lines"] if ln.get("words")), None)
    print(f"逐词时间戳总数：{total_words}")
    if first:
        preview = [(w["text"], w["start"], w["end"]) for w in first["words"][:4]]
        print("首行前几个词：", preview)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法：python -m scripts.upgrade_word_align <job_id>")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
