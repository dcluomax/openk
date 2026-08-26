"""把过长的歌词行切成适合上屏的短句。

Whisper 输出的是「语音段」而不是「歌词行」——一段常常有四五十个字，
在点歌台上一行放不下，只能折行或者被截掉，跟着唱根本看不过来。

好在转写结果带**词级时间戳**，于是可以不靠猜：唱歌的人在乐句之间必然换气，
**词与词之间最大的时间空隙就是最自然的断句点**。按停顿切出来的句子，
既符合乐句，逐字高亮也依然准确。

没有词级时间戳时（比如某些纯文本歌词）退化为按标点与长度切，
再把时间在整行区间内按字数线性摊开。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

_CJK = re.compile(r"[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]")
# 句末标点是比停顿更硬的证据，优先在这里断。
_BREAK_PUNCT = re.compile(r"[，,。.！!？?；;、~—\u2026]$")


def width(text: str) -> int:
    """按显示宽度计：一个汉字算 2，其它算 1。"""
    return sum(2 if _CJK.match(c) else 1 for c in text or "")


def _join(parts: List[str]) -> str:
    """拼词成句：中文之间不加空格，拉丁词之间加。"""
    out = ""
    for p in parts:
        p = (p or "").strip()
        if not p:
            continue
        if out and not _CJK.search(out[-1]) and not _CJK.search(p[0]):
            out += " "
        out += p
    return out


def _best_split(words: List[Dict[str, Any]], max_units: int) -> Optional[int]:
    """在 1..len-1 里挑一个最适合断开的位置，挑不出就返回 None。

    评分 = 停顿时长 + 标点加成 − 偏离中点的惩罚。惩罚这一项很关键，
    否则会在开头切下一个孤零零的字，读起来比不切还难受。
    """
    n = len(words)
    if n < 2:
        return None
    mid = n / 2
    best_i, best_score = None, float("-inf")
    for i in range(1, n):
        gap = float(words[i].get("start", 0)) - float(words[i - 1].get("end", 0))
        score = max(gap, 0.0) * 10.0
        if _BREAK_PUNCT.search(str(words[i - 1].get("text", ""))):
            score += 6.0
        # 越靠近中点越好；两端各留一点余地，避免切出单字行
        score -= abs(i - mid) / mid * 4.0
        left = width(_join([w.get("text", "") for w in words[:i]]))
        right = width(_join([w.get("text", "") for w in words[i:]]))
        if left > max_units or right > max_units:
            score -= 1.5          # 切完还是超宽，只是不得已的中间步骤
        if score > best_score:
            best_i, best_score = i, score
    return best_i


def _split_words(words: List[Dict[str, Any]], max_units: int,
                 depth: int = 0) -> List[List[Dict[str, Any]]]:
    text = _join([w.get("text", "") for w in words])
    if width(text) <= max_units or len(words) < 2 or depth > 6:
        return [words]
    i = _best_split(words, max_units)
    if not i:
        return [words]
    return (_split_words(words[:i], max_units, depth + 1)
            + _split_words(words[i:], max_units, depth + 1))


def _hard_wrap(text: str, max_units: int) -> List[str]:
    """保底切分：只按宽度硬切，保证没有任何一块超宽。

    Whisper 偶尔会把一整段吐成**一个**没有内部时间戳的「词」（见过 478 个字
    连成一行），这时既没有停顿也没有标点可依，只能硬切——难看，但至少能看全。
    """
    out, buf = [], ""
    for ch in text or "":
        if width(buf) + width(ch) > max_units and buf:
            out.append(buf)
            buf = ""
        buf += ch
    if buf:
        out.append(buf)
    return out


def _split_plain(text: str, start: float, end: float,
                 max_units: int) -> List[Dict[str, Any]]:
    """没有词级时间戳时的退化路径：按标点/长度切，时间按字数摊开。"""
    chunks: List[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if _BREAK_PUNCT.search(ch) and width(buf) >= max_units * 0.5:
            chunks.append(buf)
            buf = ""
        elif width(buf) >= max_units:
            chunks.append(buf)
            buf = ""
    if buf.strip():
        chunks.append(buf)
    # 标点切完仍可能有超宽块（长句里一个标点都没有），再硬切一遍兜住。
    wrapped: List[str] = []
    for c in chunks:
        wrapped.extend(_hard_wrap(c, max_units) if width(c) > max_units else [c])
    chunks = [c.strip() for c in wrapped if c.strip()]
    if not chunks:
        return [{"start": start, "end": end, "text": text, "words": []}]
    if len(chunks) == 1:
        return [{"start": start, "end": end, "text": chunks[0], "words": []}]

    total = sum(width(c) for c in chunks) or 1
    span = max(end - start, 0.0)
    out, t = [], start
    for c in chunks:
        dt = span * (width(c) / total)
        out.append({"start": round(t, 3), "end": round(min(t + dt, end), 3),
                    "text": c, "words": []})
        t += dt
    return out


def split_long_lines(lines: List[Dict[str, Any]], max_units: int = 32
                     ) -> List[Dict[str, Any]]:
    """把超宽的行切短。``max_units`` 是显示宽度（一个汉字算 2）。

    短行原样返回——人工/LRCLIB 的歌词本来就分好了句，不该被动。
    """
    if max_units <= 0:
        return lines
    out: List[Dict[str, Any]] = []
    for ln in lines or []:
        text = str(ln.get("text", "") or "")
        if width(text) <= max_units:
            out.append(ln)
            continue
        words = [w for w in (ln.get("words") or []) if str(w.get("text", "")).strip()]
        if not words:
            out.extend(_split_plain(text, float(ln.get("start", 0) or 0),
                                    float(ln.get("end", 0) or 0), max_units))
            continue
        for group in _split_words(words, max_units):
            if not group:
                continue
            text_g = _join([w.get("text", "") for w in group])
            g_start = round(float(group[0].get("start", 0) or 0), 3)
            g_end = round(float(group[-1].get("end", 0) or 0), 3)
            # 整段被吐成单个「词」时按停顿切不动，退回按标点/宽度切。
            if width(text_g) > max_units and len(group) < 2:
                out.extend(_split_plain(text_g, g_start, g_end, max_units))
                continue
            out.append({
                "start": g_start,
                "end": g_end,
                "text": text_g,
                "words": group,
            })
    out.sort(key=lambda x: x.get("start", 0))
    return out
