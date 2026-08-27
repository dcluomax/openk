#!/usr/bin/env python3
"""批量校正曲库里的歌名 / 歌手。

    python -m tools.fix_meta            # 只看建议，不改动（默认）
    python -m tools.fix_meta --apply    # 写回 status.json
    python -m tools.fix_meta --limit 20 # 先拿一小批试水

默认**只清洗歌名、不替换已有的歌手**：LRCLIB 是模糊搜索，同名歌和翻唱都会
命中，批量替换歌手实测错得比对得多。歌手为空或是噪声时仍会补全。
真要让曲库覆盖歌手名，加 `--replace-artist`，并且请逐条看过再写回。

改动直接写进各任务的 status.json；点歌台的 `_public_job` 会优先用这两个字段，
所以写完刷新页面就能看到，不需要重跑流水线。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend import config                       # noqa: E402
from backend.steps.meta_fix import plan_fix, clean_artist   # noqa: E402


def _keep_existing_artist(job, plan):
    """已经有像样歌手名时，不让曲库的结果顶掉它。

    LRCLIB 的搜索是模糊匹配，同名歌、翻唱、合辑收录都会命中，实测它会把
    `王菲 - 但願人長久` 改成 `詹雯婷`、`Gym Class Heroes - Stereo Hearts`
    改成 `STEREO HEARTS.`——一次批量跑下来错的比对的多。歌名的清洗是纯本地
    规则、可控，歌手的替换却是在赌搜索结果，所以默认只做前者。

    当前歌手为空、或者是 `完整版`/`官方` 这类噪声时仍然照常补，
    因为那种情况怎么改都不会更差。
    """
    cur = (job.get("artist") or "").strip()
    cleaned = clean_artist(cur)
    if not cur or not cleaned:
        return plan
    # 建议值只是当前歌手的清洗结果（`王琪 • 49M plays` → `王琪`）时照单全收，
    # 那不是「换人」，正是我们想要的。
    if (plan.get("artist") or "") in (cur, cleaned):
        return plan
    kept = dict(plan, artist=cleaned)
    kept["changed"] = ((kept["track"] or None) != ((job.get("track") or "").strip() or None)
                       or cleaned != cur)
    return kept


def load_jobs(jobs_dir: Path):
    for f in sorted(jobs_dir.glob("*/status.json")):
        try:
            yield f, json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真正写回，不加则只打印建议")
    ap.add_argument("--limit", type=int, default=0, help="最多处理多少首（调试用）")
    ap.add_argument("--only-missing", action="store_true",
                    help="只处理当前解析不出歌手的")
    ap.add_argument("--sleep", type=float, default=0.35, help="每次查询之间的间隔秒数")
    ap.add_argument("--replace-artist", action="store_true",
                    help="允许用曲库的歌手名顶掉已有的歌手名（默认不允许，见下）")
    args = ap.parse_args()

    jobs_dir = config.JOBS_DIR
    rows = [(f, j) for f, j in load_jobs(jobs_dir) if j.get("state") == "done"]
    if args.only_missing:
        rows = [(f, j) for f, j in rows if not (j.get("artist") or "").strip()]
    if args.limit:
        rows = rows[: args.limit]

    print(f"待检查 {len(rows)} 首，模式：{'写回' if args.apply else '试运行'}")
    changed = skipped = failed = 0
    t0 = time.time()
    for i, (f, job) in enumerate(rows, 1):
        try:
            plan = plan_fix(job, sleep=args.sleep)
        except Exception as e:                     # 单首失败不该中断整批
            failed += 1
            print(f"[{i}/{len(rows)}] ⚠️  {job.get('title','')[:40]} → {e}")
            continue
        if not plan:
            skipped += 1
            continue
        if not args.replace_artist:
            plan = _keep_existing_artist(job, plan)
        if not plan["changed"]:
            skipped += 1
            continue
        changed += 1
        print(f"[{i}/{len(rows)}] {plan['before']}")
        print(f"          → {plan['artist'] or '?'} - {plan['track']}  (分 {plan['score']})")
        if args.apply:
            job["artist"] = plan["artist"]
            job["track"] = plan["track"]
            tmp = f.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(f)

    print(f"\n完成：改动 {changed}，保持 {skipped}，失败 {failed}，"
          f"耗时 {time.time()-t0:.0f}s")
    if changed and not args.apply:
        print("这是试运行。确认无误后加 --apply 写回。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
