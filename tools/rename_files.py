#!/usr/bin/env python3
"""按校正后的「歌手 - 歌名」重命名本地源文件。

    python -m tools.rename_files            # 试运行
    python -m tools.rename_files --apply    # 真的改名

会同步更新 status.json 里的 local_path，所以改完点歌台照常能播。

保留原文件名里的 ``[videoID]`` 后缀：曲库里有好几首同名不同版本的歌
（三个《沒那麼簡單》），去掉 ID 就会互相覆盖——那是不可逆的数据丢失。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config                            # noqa: E402
from backend.steps import library                      # noqa: E402
from backend.steps.lyrics_sources import guess_meta    # noqa: E402
from backend.steps.meta_fix import strip_junk          # noqa: E402


def target_name(job: dict, old: Path) -> str | None:
    """命名规则统一由 backend.steps.library 提供，避免两处各写一套。"""
    artist = (job.get("artist") or "").strip()
    track = (job.get("track") or "").strip()
    if not track:
        meta = guess_meta({"title": job.get("title") or ""})
        artist = artist or (meta.get("artist") or "")
        track = meta.get("track") or ""
    return library.canonical_name(
        strip_junk(artist), strip_junk(track),
        library.extract_video_id(old.name) or job.get("video_id"), old.suffix)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    rows = []
    for st in sorted(config.JOBS_DIR.glob("*/status.json")):
        try:
            job = json.loads(st.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        lp = job.get("local_path")
        if lp:
            rows.append((st, job, Path(lp)))
    if args.limit:
        rows = rows[: args.limit]

    print(f"共 {len(rows)} 个本地源文件，模式：{'改名' if args.apply else '试运行'}")
    renamed = same = missing = clash = 0
    for st, job, old in rows:
        if not old.exists():
            missing += 1
            continue
        new_name = target_name(job, old)
        if not new_name or new_name == old.name:
            same += 1
            continue
        new = old.with_name(new_name)
        if new.exists():
            clash += 1
            print(f"  ⚠️  目标已存在，跳过：{new_name}")
            continue
        print(f"  {old.name}\n    → {new_name}")
        if args.apply:
            try:
                old.rename(new)
            except OSError as e:
                print(f"    ✗ 改名失败：{e}")
                continue
            job["local_path"] = str(new)
            tmp = st.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(st)
        renamed += 1

    print(f"\n需改名 {renamed}，已规范 {same}，文件缺失 {missing}，重名跳过 {clash}")
    if renamed and not args.apply:
        print("这是试运行。确认无误后加 --apply。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
