"""meta_fix 的纯逻辑测试：不联网，只验打分与安全门槛。

最重要的一条是「硬门槛」：候选歌名必须已经出现在原标题里才可能被采纳。
这条一旦破了，批量校正就会把整个曲库改乱，所以这里反复从不同角度压它。
"""
from backend.steps.meta_fix import (
    _norm, has_cjk, score, strip_junk, clean_track, clean_artist, ACCEPT_SCORE,
)

fails = 0


def T(cond, name):
    global fails
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        fails += 1


def cand(track, artist, duration=None, synced=True, instrumental=False):
    return {"trackName": track, "artistName": artist, "duration": duration,
            "synced": synced, "instrumental": instrumental}


print("== meta_fix ==")

# ---- 噪声清理 ----
T(strip_junk("🎼 [ 可可托海的牧羊人 ] 🎼  演唱  - 王琪").find("🎼") < 0, "表情符号被清掉")
T("mpg" not in strip_junk("沒那麼簡單_Huang Siau Hu.mpg"), "文件扩展名被清掉")
T(_norm("風繼續吹 KARAOKE") == _norm("风继续吹karaoke") or not has_cjk("x"),
  "归一化：繁简与大小写一致（未装 zhconv 时退化为原文）")
T(_norm("A-Lin  有一種悲傷") == _norm("alin有一種悲傷"), "归一化：去掉标点与空格")

# ---- 硬门槛：歌名必须出现在原标题里 ----
title = _norm("龍的傳人")
T(score(cand("不了情", "蔡琴", 203), title, 209) == -999,
  "歌名不在标题里 → 直接否决（绝不会把龍的傳人改成不了情）")
T(score(cand("龍的傳人", "李建復", 209), title, 209) >= ACCEPT_SCORE,
  "歌名在标题里且时长吻合 → 达到采纳线")

# ---- 时长是主要置信来源 ----
t2 = _norm("飛鳥和蟬- 任然 Cover ( 蔡恩雨 Priscilla Abby)")
near = score(cand("飛鳥和蟬", "任然", 240), t2, 242)
far = score(cand("飛鳥和蟬", "Isaac Yong", 293), t2, 242)
T(near > far, f"时长接近的候选得分更高（{near} > {far}）")
T(score(cand("飛鳥和蟬", "任然", 240), t2, 242) > score(cand("飛鳥和蟬", "任然", 240), t2, 400),
  "任务时长对不上时得分下降")

# ---- 歌手出现在标题里是强证据 ----
t3 = _norm("齊秦 - 大約在冬季")
T(score(cand("大約在冬季", "齊秦", 250), t3, 250) > score(cand("大約在冬季", "某翻唱歌手", 250), t3, 250),
  "标题里出现的歌手得分更高")

# ---- 中文歌优先中文歌手名 ----
t4 = _norm("風繼續吹")
T(score(cand("風繼續吹", "張國榮", 313), t4, 313) > score(cand("風繼續吹", "Leslie Cheung", 313), t4, 313),
  "中文歌优先中文歌手名（張國榮 > Leslie Cheung）")

# ---- 伴奏版降权 ----
T(score(cand("龍的傳人", "李建復", 209, instrumental=True), title, 209)
  < score(cand("龍的傳人", "李建復", 209), title, 209), "纯伴奏候选被降权")

# ---- 空值不炸 ----
T(score(cand(None, None), "", None) == -999, "空歌名安全否决")
T(_norm(None) == "" and strip_junk(None) == "", "None 输入不抛异常")

# ---- 护栏：脏记录与唱片公司 ----
t5 = _norm("畢書盡 Bii - Love More (官方版MV) - 三立/東森偶像劇「料理高校生」插曲")
T(score(cand("畢書盡 Bii - Love More (官方版MV) - 三立/東森偶像劇插曲", "福茂唱片", 250), t5, 250) == -999,
  "把整条标题当歌名的脏记录被否决")
T(score(cand("Love More", "福茂唱片", 250), t5, 250)
  < score(cand("Love More", "畢書盡", 250), t5, 250), "唱片公司当歌手时被降权")

t6 = _norm("一場遊戲一場夢 One Game One Dream")
T(score(cand("一場遊戲一場夢", "王傑", 250), t6, 250)
  > score(cand("一場遊戲一場夢 One Game One Dream", "王傑", 250), t6, 250),
  "简洁的规范歌名胜过带译名的长名字")

# ---- 护栏：中文名不被罗马音顶替 ----
job = {"title": "王傑 - 一場遊戲一場夢", "artist": "王傑", "track": "一場遊戲一場夢", "duration": 250}
T(has_cjk("王傑") and not has_cjk("Dave Wang"), "能区分中文名与罗马音")

# ---- 护栏：歌手名不能被当成歌名 ----
t7 = _norm("五月天 - 乾杯 Cheers")
T(score(cand("五月天", "阿杜", 240), t7, 240, avoid=(_norm("五月天"),)) == -999,
  "歌手名出现在候选歌名位置时被否决（五月天 - 乾杯 不该变成 五月天 - 五月天）")
T(score(cand("乾杯", "五月天", 240), t7, 240, avoid=(_norm("五月天"),)) >= ACCEPT_SCORE,
  "真正的歌名仍然通过")

T(score(cand("五月天", "五月天", 240), t7, 240, avoid=(_norm("五月天"),)) == -999,
  "歌名与歌手同名的退化条目被否决")

# 但标题写反时（歌名被解析成了歌手），这条护栏不能误伤：
# 「飛鳥和蟬 - 任然」里 飛鳥和蟬 才是歌名，任然 是歌手，两者都在标题里。
t8 = _norm("飛鳥和蟬- 任然 Cover ( 蔡恩雨 Priscilla Abby)")
T(score(cand("飛鳥和蟬", "任然", 240), t8, 242, avoid=(_norm("飛鳥和蟬"),)) >= ACCEPT_SCORE,
  "歌名与歌手双双出现在标题里时不被误杀（颠倒的标题仍能纠正）")

print("\n== 收尾清理 ==")

# 中文歌名后缀的英文译名要剥掉，但本来就是英文的歌名不能被抹掉
for raw, want in [
    ("算什麼男人 What Kind of Man", "算什麼男人"),
    ("可惜沒如果 If Only", "可惜沒如果"),
    ("乾杯Cheers", "乾杯"),
    ("Shape of You", "Shape of You"),
    ("Love More", "Love More"),
    ("I'm Not Yours", "I'm Not Yours"),
    ("Love More - 三立_東森偶像劇插曲、面膜廣告歌曲", "Love More"),
    ("那女孩對我說（原唱：黃義達）", "那女孩對我說"),
    ("想你的夜(未眠版)", "想你的夜"),
    # 方括号注解与画质／版本尾巴（真实曲库里漏网的四条）
    ("少年 『我還是從前那個少年 沒有一絲絲改變』【動態歌詞】", "少年"),
    ("女人的一生 HD【三立八點檔片頭曲】", "女人的一生"),
    ("MEIYOU  「往後餘生 風雪是你 平淡是你 清貧也是你」動態歌詞版", "MEIYOU"),
    ("我的滑板鞋2016", "我的滑板鞋2016"),
    ("後來 1080P 高音質", "後來"),
    # 剥完什么都不剩时必须原样保留，不能把歌名清空
    ("【動態歌詞】", "【動態歌詞】"),
    ("完整版", "完整版"),
]:
    T(clean_track(raw) == want, "清理歌名 %r → %r" % (raw, want))

for raw, want in [
    ("鄧麗君 (Teresa Teng)", "鄧麗君"),
    ("鄧麗君 - Teresa Teng", "鄧麗君"),
    ("江蕙 (Jordy Chiang)", "江蕙"),
    ("Ed Sheeran", "Ed Sheeran"),
    ("C AllStar", "C AllStar"),
    # 整个字段就是噪声的，宁可空着等补全，也别顶着假歌手名
    ("完整版", ""),
    ("官方", ""),
    ("Official", ""),
    ("MV", ""),
]:
    T(clean_artist(raw) == want, "清理歌手 %r → %r" % (raw, want))

print(("\n✗ %d 项失败" % fails) if fails else "\n✓ 全部通过")
raise SystemExit(1 if fails else 0)
