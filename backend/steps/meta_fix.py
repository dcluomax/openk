"""用 LRCLIB 校正歌名 / 歌手。

YouTube 标题是给人看的、不是给机器解析的：宣传语、罗马音、英文译名、上传者
水印、表情符号混在一起，还常常把「歌名 - 歌手」写反。纯靠正则永远追不完，
所以这里换个思路——**拿标题去问一个权威曲库，用它的规范名字回填**。

安全底线（很重要）：只有当候选歌名**本来就出现在原标题里**时才采纳。
这样最坏情况是「没改」，绝不会把一首歌错标成另一首完全无关的歌。
歌手可以来自曲库（这正是 131 首无歌手的解药），但要求时长对得上。
"""
from __future__ import annotations

import re
import time
import unicodedata
from typing import Any, Dict, List, Optional

from .lyrics_sources import _clean_title, _to_simp, guess_meta, search_lrclib

# 采纳阈值。低于这个分数宁可不动，留着人工确认。
ACCEPT_SCORE = 70
# 歌手可以从曲库补，但时长必须对得上，否则容易把翻唱版认成原唱。
ARTIST_DURATION_TOLERANCE = 12.0

_PUNCT = re.compile(r"[\s\-–—_·・.,!?！？。、·:：;；'\"“”‘’()（）\[\]【】《》〈〉|丨｜/\\]+")
_EMOJI = re.compile(
    "[" "\U0001F000-\U0001FAFF" "\u2600-\u27BF" "\uFE0F" "\u2190-\u21FF" "\u2B00-\u2BFF" "]+"
)
_FILE_EXT = re.compile(r"\.(mpg|mpeg|mp4|m4v|avi|mkv|wmv|flv|mov|rmvb|ts|webm)\b", re.I)
_CJK = re.compile(r"[\u3400-\u9FFF\uF900-\uFAFF]")

# 曲库里混着一批「把整条 YouTube 标题当歌名」的脏记录，认出来直接否决，
# 否则校正反而会把干净的歌名换成一长串宣传语。
_JUNK_TRACK = re.compile(
    r"(官方|官方版|完整版|高清|字幕|歌词|歌詞|插曲|片尾|主題曲|主题曲|廣告|广告|"
    r"预告|預告|现场|現場|live版|official|music\s*video|\bmv\b|lyric|karaoke|"
    r"audio\b|version|feat\.)", re.I)
# 歌手字段是唱片公司/频道时同样不可信。
_LABEL = re.compile(
    r"(唱片|音樂|音乐|娛樂|娱乐|傳媒|传媒|文化|工作室|频道|頻道|records?|"
    r"music|entertainment|media|official|channel|studio)\b", re.I)
# 歌名超过这个长度基本可以断定不是歌名，而是一整条标题。
MAX_TRACK_LEN = 24


def strip_junk(s: Optional[str]) -> str:
    """去掉表情符号与文件扩展名——这两样在标题里纯属噪声。"""
    if not s:
        return ""
    s = _EMOJI.sub(" ", s)
    s = _FILE_EXT.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def _norm(s: Optional[str]) -> str:
    """归一化到「只剩字母数字与汉字的简体小写串」，用于宽松比对。"""
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = strip_junk(s)
    s = _to_simp(s) or s
    s = _PUNCT.sub("", s)
    return s.casefold()


def has_cjk(s: Optional[str]) -> bool:
    return bool(s and _CJK.search(s))


def score(cand: Dict[str, Any], title_norm: str, duration: Optional[float],
          avoid: tuple = ()) -> int:
    """给一个 LRCLIB 候选打分。分数只用于排序与阈值，不代表概率。

    ``avoid`` 是「疑似歌手名」的归一化串。曲库里真有以歌手名命名的歌
    （《五月天》），而歌手名必然出现在标题里，硬门槛拦不住，结果
    「五月天 - 乾杯」被改成「五月天 - 五月天」。

    但不能一刀切：标题写反时（`飛鳥和蟬 - 任然`），被当成歌手的那个词
    恰恰就是真歌名。所以只在**候选歌手也不在标题里**时才否决——
    歌名与歌手双双出现在标题里的候选，几乎必然是对的。
    """
    track_n = _norm(cand.get("trackName"))
    artist_n = _norm(cand.get("artistName"))
    if not track_n:
        return -999
    if track_n in avoid and not (artist_n and artist_n in title_norm):
        return -999
    # 歌名与歌手同名的条目（trackName == artistName）几乎都是曲库里的退化数据，
    # 而它恰好能钻过上面那条例外——「五月天 - 乾杯」正是栽在这里。
    if track_n in avoid and track_n == artist_n:
        return -999

    pts = 0
    # 硬门槛：歌名必须已经出现在原标题里。
    if track_n not in title_norm:
        return -999
    # 脏记录：把整条视频标题当歌名的，直接否决。
    raw_track = cand.get("trackName") or ""
    if _JUNK_TRACK.search(raw_track) or len(track_n) > MAX_TRACK_LEN:
        return -999
    # 名字越长、越不容易是巧合命中；但超过一定长度反而说明混进了副标题／译名，
    # 所以先加分再惩罚，让最简洁的规范名胜出。
    pts += 40 + min(len(track_n), 12)
    pts -= max(0, len(track_n) - 12) * 3

    if artist_n and artist_n in title_norm:
        pts += 30
    if _LABEL.search(cand.get("artistName") or ""):
        pts -= 45          # 唱片公司／频道名不是歌手

    cd = cand.get("duration")
    if duration and cd:
        diff = abs(float(cd) - float(duration))
        if diff <= 3:
            pts += 30
        elif diff <= 8:
            pts += 20
        elif diff <= 15:
            pts += 8
        else:
            pts -= 25

    if cand.get("synced"):
        pts += 5
    # 中文歌优先用中文歌手名（張國榮 而不是 Leslie Cheung）。分量给足，
    # 否则同一首歌的罗马音条目会靠其它加分翻盘，而中文用户搜不到罗马音。
    if has_cjk(cand.get("trackName")):
        pts += 25 if has_cjk(cand.get("artistName")) else -20
    if cand.get("instrumental"):
        pts -= 10
    return pts


def _queries(title: str, parsed: Dict[str, Optional[str]]) -> List[str]:
    """生成检索词，按可靠度排序，去重。查询次数要克制——LRCLIB 是免费公共服务。"""
    out: List[str] = []
    for q in (parsed.get("track"), strip_junk(_clean_title(title)), parsed.get("artist")):
        q = strip_junk(q)
        # 太短的词（一两个字）检索噪声极大，跳过
        if q and len(q) >= 2 and q not in out:
            out.append(q)
    return out[:3]


def clean_track(name: Optional[str]) -> str:
    """清掉歌名尾巴上的英文译名、括号注解与宣传语。

    只在**剥完还剩中文**时才剥英文——否则 `Shape of You`、`Love More`
    这类本来就是英文的歌名会被整个抹掉。
    """
    s = strip_junk(name)
    if not s:
        return ""
    # （原唱：黃義達）、(未眠版)、(去人聲) 之类的注解
    s = re.sub(r"[（(][^）)]*[）)]", " ", s)
    # 破折号后的宣传尾巴：`Love More - 三立東森偶像劇插曲`
    parts = re.split(r"\s+[-–—]\s+", s)
    if len(parts) > 1 and _JUNK_TRACK.search(parts[-1]):
        s = " ".join(parts[:-1])
    # 中文歌名后缀的英文译名：`算什麼男人 What Kind of Man`
    if has_cjk(s):
        m = re.match(r"^(.*?[\u3400-\u9FFF\uF900-\uFAFF][^A-Za-z]*)\s*[A-Za-z][A-Za-z'’,.\s!?&-]*$", s)
        if m and has_cjk(m.group(1)):
            s = m.group(1)
    return re.sub(r"\s+", " ", s).strip(" -–—_·,、")


def clean_artist(name: Optional[str]) -> str:
    """清掉歌手名里的罗马音注解与分隔符尾巴：`鄧麗君 (Teresa Teng)` → `鄧麗君`。"""
    s = strip_junk(name)
    if not s:
        return ""
    if has_cjk(s):
        s = re.sub(r"[（(][A-Za-z .'’-]+[）)]", " ", s)
        parts = re.split(r"\s+[-–—]\s+", s)
        cjk = [p for p in parts if has_cjk(p)]
        if cjk:
            s = cjk[0]
    return re.sub(r"\s+", " ", s).strip(" -–—_·,、")


def plan_fix(job: Dict[str, Any], sleep: float = 0.35) -> Optional[Dict[str, Any]]:
    """为一个任务算出建议的「歌手 / 歌名」修正，拿不准就返回 None。

    返回 ``{"artist", "track", "score", "matched", "changed"}``；
    ``changed`` 说明相对现状确实有变化，没变化的不必写盘。
    """
    title = job.get("title") or ""
    if not title:
        return None
    parsed = guess_meta({"title": title,
                         "artist": job.get("artist"), "track": job.get("track")})
    title_norm = _norm(title)
    duration = job.get("duration")

    best: Optional[Dict[str, Any]] = None
    best_pts = -10**9
    # 歌手名不可能同时是这首歌的歌名
    avoid = tuple(x for x in {_norm(parsed.get("artist")), _norm(job.get("artist"))} if x)
    for q in _queries(title, parsed):
        try:
            cands = search_lrclib(query=q, limit=12)
        except Exception:
            continue
        for c in cands:
            pts = score(c, title_norm, duration, avoid)
            if pts > best_pts:
                best, best_pts = c, pts
        if best_pts >= ACCEPT_SCORE + 40:
            break          # 已经很确定了，别再打扰人家服务器
        if sleep:
            time.sleep(sleep)

    if not best or best_pts < ACCEPT_SCORE:
        return None

    track = (best.get("trackName") or "").strip() or None
    artist = (best.get("artistName") or "").strip() or None

    cur_a = (job.get("artist") or "").strip() or None
    cur_t = (job.get("track") or "").strip() or None
    if cur_t is None:
        cur_a, cur_t = parsed.get("artist"), parsed.get("track")

    # 中文歌绝不把中文歌手名换成罗马音：王傑→Dave Wang、陳淑樺→Sarah Chen
    # 这种「修正」在点歌台上是纯粹的倒退，中文用户根本搜不到。
    if artist and cur_a and has_cjk(cur_a) and not has_cjk(artist):
        artist = cur_a
    # 本来就没有歌手时同样别用罗马音顶上：中文歌的听众按中文名找人。
    # 宁可留空，也好过写一个搜不到的名字。
    if artist and not cur_a and has_cjk(title) and not has_cjk(artist):
        artist = None
    # 已有的中文歌名不该被英文译名顶掉。
    if track and cur_t and has_cjk(cur_t) and not has_cjk(track):
        track = cur_t
    # 候选歌名只是在原名后面又缀了译名/副标题时（一場遊戲一場夢 - One Game,
    # One Dream），取更短的那个——点歌台要的是能一眼认出的歌名。
    if track and cur_t:
        n_new, n_cur = _norm(track), _norm(cur_t)
        if n_cur and n_cur != n_new and n_new.startswith(n_cur):
            track = cur_t
    # 归一化后完全相同就保留原文，别做无谓的繁简互换：曲库繁简混排会让
    # 同一个歌手在点歌台上分裂成两个人。
    if track and cur_t and _norm(track) == _norm(cur_t):
        track = cur_t
    if artist and cur_a and _norm(artist) == _norm(cur_a):
        artist = cur_a

    # 歌手来自曲库时要更谨慎：时长对不上就可能是翻唱／串烧，宁可只修歌名。
    if artist and _norm(artist) not in title_norm and artist != cur_a:
        cd, d = best.get("duration"), duration
        if not (cd and d and abs(float(cd) - float(d)) <= ARTIST_DURATION_TOLERANCE):
            artist = strip_junk(parsed.get("artist")) or None

    return {
        "artist": artist,
        "track": track,
        "score": best_pts,
        "matched": f"{best.get('artistName')} - {best.get('trackName')}",
        "before": f"{cur_a or '?'} - {cur_t or '?'}",
        "changed": (artist or None) != (cur_a or None) or (track or None) != (cur_t or None),
    }
