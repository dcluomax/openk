"""歌词切行测试：切出来的句子要短、要落在演唱停顿上、时间戳不能乱。"""
from backend.steps.lyrics_layout import split_long_lines, width, _join

fails = 0


def T(cond, name):
    global fails
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        fails += 1


def words(spec):
    """spec: [(文字, 起, 止), ...]"""
    return [{"text": t, "start": s, "end": e} for t, s, e in spec]


print("== 歌词切行 ==")

T(width("没那么简单") == 10, "汉字按 2 计宽")
T(width("Love More") == 9, "拉丁字符按 1 计宽")
T(_join(["没", "那", "么"]) == "没那么", "中文拼接不加空格")
T(_join(["Love", "More"]) == "Love More", "拉丁词之间加空格")

# ---- 按停顿切 ----
# 「没那么简单」+ 明显停顿 + 「就能去爱」
spec = [(c, i * 0.3, i * 0.3 + 0.28) for i, c in enumerate("没那么简单")]
spec += [(c, 3.0 + i * 0.3, 3.0 + i * 0.3 + 0.28) for i, c in enumerate("就能去爱别的全部")]
line = {"start": 0.0, "end": 5.6, "text": "没那么简单就能去爱别的全部", "words": words(spec)}
out = split_long_lines([line], max_units=16)
T(len(out) == 2, f"超宽行被切开（{len(out)} 行）")
T(out[0]["text"] == "没那么简单" and out[1]["text"] == "就能去爱别的全部",
  f"切在停顿处：{[o['text'] for o in out]}")
T(out[0]["start"] == 0.0 and abs(out[1]["start"] - 3.0) < 1e-6, "子句起始时间取首词")
T(all(o["end"] >= o["start"] for o in out), "时间区间合法")
T(sum(len(o["words"]) for o in out) == len(spec), "词一个都没丢")

# ---- 短行不动 ----
short = {"start": 0, "end": 2, "text": "红红烈烈不如平静", "words": words(
    [(c, i * 0.2, i * 0.2 + 0.18) for i, c in enumerate("红红烈烈不如平静")])}
T(split_long_lines([short], max_units=32) == [short], "短行原样保留（LRCLIB 的分句不该被动）")

# ---- 不切出单字行 ----
spec2 = [(c, i * 0.25, i * 0.25 + 0.2) for i, c in enumerate("相爱没有那么容易每个人有他的脾气")]
out2 = split_long_lines([{"start": 0, "end": 4, "text": "相爱没有那么容易每个人有他的脾气",
                          "words": words(spec2)}], max_units=16)
T(all(width(o["text"]) >= 4 for o in out2), f"没有切出孤字行：{[o['text'] for o in out2]}")
T(all(width(o["text"]) <= 16 for o in out2), f"每行都不超宽：{[width(o['text']) for o in out2]}")

# ---- 无词级时间戳时的退化路径 ----
plain = {"start": 10.0, "end": 20.0, "words": [],
         "text": "一杯红酒配电影，在周末晚上，关上了手机，舒服我在沙发里"}
out3 = split_long_lines([plain], max_units=16)
T(len(out3) > 1, f"纯文本行也能切（{len(out3)} 行）")
T(out3[0]["start"] == 10.0 and abs(out3[-1]["end"] - 20.0) < 0.01, "时间摊开后仍覆盖原区间")
T(all(out3[i]["start"] <= out3[i + 1]["start"] for i in range(len(out3) - 1)), "时间单调递增")
T("".join(o["text"] for o in out3).replace(" ", "") == plain["text"].replace(" ", ""),
  "文字没有增删")

# ---- 边界 ----
T(split_long_lines([], 32) == [], "空输入安全")
T(len(split_long_lines([plain], max_units=0)) == 1, "max_units=0 表示不切")
long_latin = {"start": 0, "end": 3, "words": [],
              "text": "I found a love for me darling just dive right in and follow my lead"}
T(len(split_long_lines([long_latin], max_units=32)) > 1, "英文长行也会被切")

# ---- 整段被吐成单个「词」时的兜底（Whisper 真实会这样）----
blob = "我曾經跨過山和大海也穿過人山人海我曾經擁有著一切轉眼都飄散如煙我曾經失落失望失掉所有方向"
one_word = {"start": 5.0, "end": 25.0, "text": blob,
            "words": [{"text": blob, "start": 5.0, "end": 25.0}]}
o4 = split_long_lines([one_word], max_units=16)
T(len(o4) > 1, f"单词块也能切开（{len(o4)} 行）")
T(all(width(x["text"]) <= 16 for x in o4), f"兜底后无超宽行：{max(width(x['text']) for x in o4)}")
T("".join(x["text"] for x in o4) == blob, "兜底切分不增删文字")
T(o4[0]["start"] == 5.0 and abs(o4[-1]["end"] - 25.0) < 0.01, "兜底切分时间覆盖原区间")

# ---- 不变量：任何输入切完都不超宽 ----
import random
random.seed(7)
pool = "相爱没有那么容易每个人有他的脾气过了爱做梦的年纪"
cases = []
for n in (1, 5, 40, 200):
    txt = "".join(random.choice(pool) for _ in range(n))
    cases.append({"start": 0.0, "end": 10.0, "text": txt, "words": []})
    cases.append({"start": 0.0, "end": 10.0, "text": txt,
                  "words": [{"text": c, "start": i*0.1, "end": i*0.1+0.09}
                            for i, c in enumerate(txt)]})
res = split_long_lines(cases, max_units=32)
T(all(width(x["text"]) <= 32 for x in res),
  f"不变量：所有输出行都不超宽（最宽 {max(width(x['text']) for x in res)}）")

print(("\n✗ %d 项失败" % fails) if fails else "\n✓ 全部通过")
raise SystemExit(1 if fails else 0)
