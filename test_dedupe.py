#!/usr/bin/env python
"""除重自检：分组规则与「留哪一版」的排序。

音质分析本身要解码真实音频，这里不测它；测的是围绕它的判断逻辑——
哪些算同一首、音质接近时怎么决胜、源文件移不动时会不会误删。
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

_spec = importlib.util.spec_from_file_location("dedupe", os.path.join(_HERE, "tools", "dedupe.py"))
dedupe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dedupe)

from backend.steps.audio_quality import quality_score  # noqa: E402

_fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _fails
    if not ok:
        _fails += 1
    print(("  ✓ " if ok else "  ✗ ") + name + (("  — " + detail) if detail else ""))


def job(jid, artist, track, lines=0, state="done"):
    return {"id": jid, "artist": artist, "track": track,
            "line_count": lines, "state": state}


def cand(jid, q, lines):
    return {"job": job(jid, "甲", "乙", lines), "m": {"cutoff_khz": 15.0, "hf_db": -20.0,
                                                     "clip_pct": 0.0}, "q": q, "lines": lines}


print("=== 归一 ===")
for a, b, same in [
    ("沒那麼簡單", "没那么简单", True),      # 繁简
    ("夢然", "梦然", True),
    ("海阔天空", "海 阔 天 空", True),        # 空格
    ("後來", "后来（Live）", False),          # 括号内容不该被忽略成同一首
    ("Shape of You", "shape of you", True),   # 大小写
    ("曾经的你", "曾经的我", False),
]:
    got = dedupe.norm(a) == dedupe.norm(b)
    check("%r 与 %r %s同一首" % (a, b, "" if same else "不"), got == same,
          "%r vs %r" % (dedupe.norm(a), dedupe.norm(b)))

print("\n=== 分组 ===")
jobs = [
    job("j1", "張學友", "慢慢", 44), job("j2", "张学友", "慢慢", 23),
    job("j3", "陳奕迅", "浮誇", 30),
    job("j4", "王菲", "如願", 30), job("j5", "周深", "如愿", 30),   # 同名不同歌手＝翻唱
    job("j6", "", "無名", 10), job("j7", "", "无名", 10),           # 没歌手，判不准
    job("j8", "張學友", "慢慢", 10, state="running"),               # 还在跑，不参与
]
g = dedupe.group_duplicates(jobs)
check("繁简写法的同一首歌归到一组", g.get(("张学友", "慢慢")) is not None and len(g[("张学友", "慢慢")]) == 2,
      str({k: [x["id"] for x in v] for k, v in g.items()}))
check("同歌名不同歌手不算重复（翻唱要分开点）",
      all("如愿" not in k[1] for k in g))
check("两条都没歌手时退而按歌名分组（报告里会打标提醒）",
      any(k[0] == "" and {x["id"] for x in v} == {"j6", "j7"} for k, v in g.items()),
      str({k: [x["id"] for x in v] for k, v in g.items()}))
check("还在处理的任务不参与除重",
      all(x["id"] != "j8" for v in g.values() for x in v))

print("\n=== 留哪一版 ===")
best = dedupe.pick_best([cand("差音质多歌词", 20.0, 60), cand("好音质少歌词", 50.0, 10)])
check("音质差得多时音质优先", best[0]["job"]["id"] == "好音质少歌词",
      best[0]["job"]["id"])

best = dedupe.pick_best([cand("略低但歌词多", 46.0, 53), cand("略高但歌词少", 47.5, 21)])
check("音质接近时改看歌词行数", best[0]["job"]["id"] == "略低但歌词多",
      best[0]["job"]["id"])

best = dedupe.pick_best([cand("有分", 30.0, 5), {"job": job("量不出", "甲", "乙"),
                                                 "m": None, "q": quality_score(None), "lines": 99}])
check("量不出音质的排最后（哪怕歌词最多）", best[0]["job"]["id"] == "有分",
      best[0]["job"]["id"])

check("没有测量结果时分数是负无穷", quality_score(None) == float("-inf"))
check("削波会拉低分数",
      quality_score({"cutoff_khz": 15.0, "hf_db": -20.0, "clip_pct": 1.0})
      < quality_score({"cutoff_khz": 15.0, "hf_db": -20.0, "clip_pct": 0.0}))
check("高频截止越高分越高",
      quality_score({"cutoff_khz": 19.0, "hf_db": -20.0, "clip_pct": 0.0})
      > quality_score({"cutoff_khz": 15.0, "hf_db": -20.0, "clip_pct": 0.0}))

print("\n=== 源文件挪窝 ===")
tmp = tempfile.mkdtemp()
src = os.path.join(tmp, "某歌 [aaaaaaaaaaa].mp4")
open(src, "wb").write(b"x")
state, dest = dedupe.stash_source({"local_path": src}, apply=True)
check("移进 _重复/ 而不是删掉", state == "ok" and os.path.exists(dest), "%s %s" % (state, dest))
check("原位置已经没有了", not os.path.exists(src))

state, _ = dedupe.stash_source({"local_path": os.path.join(tmp, "不存在.mp4")}, apply=True)
check("没有源文件时如实返回 none", state == "none", state)

# 重名不能当成「没有源文件」——那样任务被删、文件还在，下次扫描又导回来
open(src, "wb").write(b"y")
state, dest2 = dedupe.stash_source({"local_path": src}, apply=True)
check("重名时另存一份而不是放着不动",
      state == "ok" and dest2 != dest and os.path.exists(dest2), "%s %s" % (state, dest2))
check("重名时源文件同样被移走了", not os.path.exists(src))

ro = os.path.join(tmp, "ro")
os.mkdir(ro)
ro_src = os.path.join(ro, "只读里的歌.mp4")
open(ro_src, "wb").write(b"x")
os.chmod(ro, 0o500)
state, info = dedupe.stash_source({"local_path": ro_src}, apply=True)
os.chmod(ro, 0o700)
# root 跑测试时只读位不生效，那种环境下这一项没有意义，跳过而不是误报失败
if os.geteuid() == 0:
    print("  – 只读目录用例跳过（当前是 root，权限位不生效）")
else:
    check("目录只读时返回 fail 而不是抛异常", state == "fail", "%s %s" % (state, info))

print()
print(("✗ %d 项失败" % _fails) if _fails else "✓ 全部通过")
raise SystemExit(1 if _fails else 0)
