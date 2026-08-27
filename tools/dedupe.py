#!/usr/bin/env python
"""曲库除重：同一首歌留音质最好的那版，其余移走。

## 怎么判断「同一首」

按「歌手 + 歌名」归一后比对，繁简与标点都折掉——曲库里 `夢然` 和 `梦然`、
`沒那麼簡單` 和 `没那么简单` 是同一首。**歌名相同但歌手不同的不算重复**
（翻唱是另一个版本，KTV 里经常要分开点）。

## 怎么判断「音质最好」

见 :mod:`backend.steps.audio_quality`：从分离出来的伴奏反推源的带宽。
实测本曲库同一首歌的几个版本音质相当接近（源都是同一档 YouTube 音频），
所以音质分接近时（差距小于 ``TIE``）改用歌词行数决胜——对点歌台来说，
字幕全不全比那一点点高频重要得多。

## 怎么删

默认**不删**，只出报告。``--apply`` 时走 HTTP 接口删任务（内存里的曲库
缓存会同步更新，不用重启容器）；源文件不删，而是移进 `_重复/` 子目录，
万一挑错了还能捡回来。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
from collections import defaultdict
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.steps.audio_quality import analyse, quality_score  # noqa: E402

DATA = os.environ.get("OPENK_DATA_DIR", "/data")
API = os.environ.get("OPENK_API", "http://127.0.0.1:8000")
# 音质分差在这个范围内就算「听不出区别」，改看歌词。
# 4 分约等于截止频率差 1kHz，或高频能量差 4dB——都在听感的噪声里。
TIE = 4.0
DUP_DIR = "_重复"
# 频谱分析每首要解码一分钟音频，几百首就是好几分钟。结果只取决于文件本身，
# 缓存下来，导入新歌后再跑一遍就只算增量。
CACHE = os.path.join(DATA, "quality-cache.json")

_PUNCT = re.compile(r"[\s\-_·,，.。'’\"“”!！?？()（）\[\]【】~～/／]")


def _simp(s: str) -> str:
    try:
        import zhconv
        return zhconv.convert(s, "zh-hans")
    except Exception:  # noqa: BLE001 - 没装 zhconv 就退化成原文比对
        return s


def norm(s: Optional[str]) -> str:
    return _PUNCT.sub("", _simp((s or "").strip().lower()))


def load_jobs() -> List[Dict[str, Any]]:
    jobs = []
    for name in sorted(os.listdir(os.path.join(DATA, "jobs"))):
        p = os.path.join(DATA, "jobs", name, "status.json")
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                jobs.append(json.load(f))
        except Exception:  # noqa: BLE001 - 单个坏文件不该中断整轮扫描
            pass
    return jobs


def group_duplicates(jobs: List[Dict[str, Any]]) -> Dict[tuple, List[Dict[str, Any]]]:
    groups: Dict[tuple, List[Dict[str, Any]]] = defaultdict(list)
    for j in jobs:
        if j.get("state") != "done":
            continue          # 还在跑的、失败的都不参与，免得删掉正在处理的
        t, a = norm(j.get("track")), norm(j.get("artist"))
        if t and a:           # 没歌手的判不准是不是同一首，宁可放过
            groups[(a, t)].append(j)
    return {k: v for k, v in groups.items() if len(v) > 1}


def load_cache() -> Dict[str, Any]:
    try:
        with open(CACHE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001 - 缓存坏了重算就是，不该影响主流程
        return {}


def save_cache(cache: Dict[str, Any]) -> None:
    try:
        tmp = CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp, CACHE)
    except Exception:  # noqa: BLE001
        pass


def measure(job: Dict[str, Any], cache: Dict[str, Any]) -> Dict[str, Any]:
    inst = os.path.join(DATA, "jobs", job["id"], "stems", "instrumental.mp3")
    m = None
    if os.path.exists(inst):
        # 用 mtime+大小 当版本号：重新分离过的歌会自动失效重算
        st = os.stat(inst)
        key = "%s:%d:%d" % (job["id"], st.st_mtime_ns, st.st_size)
        if key in cache:
            m = cache[key]
        else:
            m = analyse(inst, job.get("duration"))
            cache[key] = m
    return {"job": job, "m": m, "q": quality_score(m),
            "lines": int(job.get("line_count") or 0)}


def pick_best(cands: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按「音质优先、接近时看歌词」排序，第一个就是要保留的。"""
    top = max(c["q"] for c in cands)
    return sorted(
        cands,
        key=lambda c: (
            0 if c["q"] >= top - TIE else 1,   # 第一梯队（音质相当）优先
            -c["lines"],                        # 梯队内歌词多的赢
            -c["q"],                            # 再不行才比音质分本身
        ),
    )


def stash_source(job: Dict[str, Any], apply: bool) -> tuple:
    """把落选版本的源文件移进 `_重复/`，别直接删——挑错了还能捡回来。

    返回 ``(状态, 说明)``。``状态`` 为 ``"none"`` 表示这首本来就没有源文件，
    ``"ok"`` 表示已移走（或试运行时算得出目标路径），``"fail"`` 表示移不动。
    移不动多半是目录挂成了只读——此时**调用方必须放弃删除这一首**，否则
    任务没了、源文件还躺在原地，下次扫描又会被当成新歌导进来。
    """
    src = job.get("local_path")
    if not src or not os.path.exists(src):
        return ("none", None)
    dest_dir = os.path.join(os.path.dirname(src), DUP_DIR)
    dest = os.path.join(dest_dir, os.path.basename(src))
    # 重名时另起一个名字。早先这里是「已存在就当没有源文件」直接返回，
    # 结果任务被删掉、源文件还留在原处，下次扫描又当新歌导回来了。
    if os.path.exists(dest):
        stem, ext = os.path.splitext(dest)
        n = 2
        while os.path.exists("%s.%d%s" % (stem, n, ext)):
            n += 1
        dest = "%s.%d%s" % (stem, n, ext)
    if not apply:
        return ("ok", dest)
    try:
        os.makedirs(dest_dir, exist_ok=True)
        shutil.move(src, dest)
    except OSError as exc:
        return ("fail", "%s（%s）" % (src, exc.strerror or exc))
    return ("ok", dest)


def delete_job(job_id: str) -> None:
    req = urllib.request.Request("%s/api/jobs/%s" % (API, job_id), method="DELETE")
    urllib.request.urlopen(req, timeout=120).read()


def main() -> int:
    ap = argparse.ArgumentParser(description="曲库除重，保留音质最好的版本")
    ap.add_argument("--apply", action="store_true", help="真的删（默认只出报告）")
    ap.add_argument("--keep-sources", action="store_true",
                    help="只删任务，源文件原地不动")
    args = ap.parse_args()

    jobs = load_jobs()
    groups = group_duplicates(jobs)
    cache = load_cache()
    print("已完成 %d 首，重复 %d 组 / %d 首\n"
          % (len([j for j in jobs if j.get("state") == "done"]),
             len(groups), sum(len(v) for v in groups.values())))

    dropped, skipped, freed = 0, 0, 0
    for (_, _), members in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        ranked = pick_best([measure(j, cache) for j in members])
        head = ranked[0]["job"]
        print("· %s - %s  ×%d" % (head.get("artist"), head.get("track"), len(members)))
        for i, c in enumerate(ranked):
            j, m = c["job"], c["m"]
            q = ("截止%.1fk 高频%.1fdB 削波%.2f%%"
                 % (m["cutoff_khz"], m["hf_db"], m["clip_pct"])) if m else "无法评估"
            print("    %s %s  %s  歌词%d行  分%.1f  %ss"
                  % ("保留" if i == 0 else "删除", j["id"], q, c["lines"], c["q"],
                     int(j.get("duration") or 0)))
            if i == 0:
                continue

            state, info = ("none", None)
            if not args.keep_sources:
                state, info = stash_source(j, args.apply)
            if state == "fail":
                # 源文件动不了就整首跳过：任务删了而文件还在，下次扫描又会导回来
                print("         ⚠ 源文件移动失败，跳过不删：%s" % info)
                skipped += 1
                continue
            if state == "ok":
                print("         源文件 → %s" % info)

            dropped += 1
            d = os.path.join(DATA, "jobs", j["id"])
            freed += sum(os.path.getsize(os.path.join(r, f))
                         for r, _, fs in os.walk(d) for f in fs
                         if os.path.exists(os.path.join(r, f)))
            if args.apply:
                delete_job(j["id"])
        print()

    print("%s %d 首，%s %.1f GB"
          % ("已删除" if args.apply else "待删除", dropped,
             "释放" if args.apply else "可释放", freed / 1e9))
    if skipped:
        print("跳过 %d 首（源文件移不动，多半是目录只读）" % skipped)
    save_cache(cache)
    if not args.apply:
        print("这只是报告。确认无误后加 --apply 才会真的动手。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
