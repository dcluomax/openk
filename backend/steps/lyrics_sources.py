"""歌词来源：LRCLIB 歌词库、YouTube 字幕（VTT/SRT）解析与元数据清洗。

产出统一的“逐行歌词”结构：``[{"start": float, "end": float|None, "text": str}, ...]``。
这些逐行歌词随后可交给 whisperX 强制对齐，细化为逐词时间戳。
"""
from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

_UA = "openk/1.0 (https://github.com/openk; karaoke maker)"
_LRCLIB = "https://lrclib.net"

# 标题里常见的噪声标签（用于清洗，提高歌词库匹配率）
_NOISE = re.compile(
    r"\(([^)]*?(official|lyric|audio|video|mv|m/v|hd|4k|live|remaster|visualizer|"
    r"performance|explicit|clean|full|version|ver\.?|feat\.?|ft\.?)[^)]*?)\)"
    r"|\[[^\]]*?(official|lyric|audio|video|mv|hd|4k|live|remaster)[^\]]*?\]"
    r"|【[^】]*?(official|lyric|audio|video|mv|hd|4k|live|字幕|歌词|完整版)[^】]*?】"
    r"|「[^」]*?(official|lyric|mv|字幕|歌词)[^」]*?」",
    re.IGNORECASE,
)
_TRAILING = re.compile(r"[\-–—|·]\s*(official.*|lyric.*|audio.*|mv.*|hd.*|4k.*)$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# LRC / VTT / SRT 解析
# ---------------------------------------------------------------------------
def parse_lrc(text: str) -> List[Dict[str, Any]]:
    """解析 LRC 字符串为逐行歌词（支持一行多个时间标签）。"""
    tag = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")
    rows: List[Dict[str, Any]] = []
    for raw in text.splitlines():
        stamps = list(tag.finditer(raw))
        if not stamps:
            continue
        content = raw[stamps[-1].end():].strip()
        if not content:
            continue
        for m in stamps:
            mm, ss, frac = m.group(1), m.group(2), m.group(3) or "0"
            t = int(mm) * 60 + int(ss) + float("0." + frac)
            rows.append({"start": round(t, 3), "end": None, "text": content})
    rows.sort(key=lambda r: r["start"])
    return _fill_ends(rows)


def parse_vtt_srt(path: str | Path) -> List[Dict[str, Any]]:
    """解析 WebVTT 或 SRT 字幕为逐行歌词（去标签、去相邻重复）。"""
    data = Path(path).read_text(encoding="utf-8", errors="ignore")
    ts = re.compile(
        r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*"
        r"(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})"
    )
    lines = data.splitlines()
    rows: List[Dict[str, Any]] = []
    i = 0
    while i < len(lines):
        m = ts.search(lines[i])
        if not m:
            i += 1
            continue
        g = list(map(int, m.groups()))
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        i += 1
        buf: List[str] = []
        while i < len(lines) and lines[i].strip() and not ts.search(lines[i]):
            buf.append(lines[i])
            i += 1
        text = _clean_cue(" ".join(buf))
        if text:
            rows.append({"start": round(start, 3), "end": round(end, 3), "text": text})

    # 合并相邻的完全重复（YouTube 自动字幕常见的滚动重复）
    merged: List[Dict[str, Any]] = []
    for r in rows:
        if merged and r["text"] == merged[-1]["text"]:
            merged[-1]["end"] = r["end"]
            continue
        merged.append(r)
    return merged


def _clean_cue(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)          # 去掉 <c>、<00:00:00.000> 等标签
    text = re.sub(r"&[a-z]+;", " ", text)         # HTML 实体
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _fill_ends(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for i, r in enumerate(rows):
        if r["end"] is None:
            r["end"] = rows[i + 1]["start"] if i + 1 < len(rows) else r["start"] + 4.0
    return rows


# ---------------------------------------------------------------------------
# 元数据清洗
# ---------------------------------------------------------------------------
def _clean_title(title: str) -> str:
    t = _NOISE.sub("", title or "")
    t = _TRAILING.sub("", t)
    t = re.sub(r"\s+", " ", t).strip(" -–—|·")
    return t.strip()


def guess_meta(info: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """从 yt-dlp 元信息推断 artist / track / album，用于歌词库匹配。"""
    artist = (info.get("artist") or "").strip() or None
    track = (info.get("track") or "").strip() or None
    album = (info.get("album") or "").strip() or None

    if not track:
        raw = info.get("title") or ""
        # 中文歌常把歌名放在《》书名号里（最可靠）；artist 取书名号前的短前缀，
        # 并去掉“这首/演唱/翻唱”等填充词。否则再按 "Artist - Title" 拆分。
        m = re.search(r"《\s*([^《》]+?)\s*》", raw)
        if m:
            track = m.group(1).strip()
            before = re.sub(r"[（(【\[][^)）】\]]*[)）】\]]", "", raw[:m.start()])
            before = re.sub(r"(这首|那首|演唱|翻唱|带来|新歌|单曲|歌曲|作品|经典|的)\s*$", "", before)
            before = before.strip(" -–—|·:：、")
            if before and not artist and len(before) <= 12:
                artist = before
        else:
            cleaned = _clean_title(raw)
            # "Artist - Title" 是最常见的音乐视频命名
            parts = re.split(r"\s[-–—]\s", cleaned, maxsplit=1)
            if len(parts) == 2 and not artist:
                artist, track = parts[0].strip(), parts[1].strip()
            else:
                track = cleaned or None

    # 去掉 feat. 部分，以及中文书名号/方括号内的副标题与宣传语（几乎不是歌名主体）
    if track:
        track = re.sub(r"\s*[\(（]?\s*(feat\.?|ft\.?)\s+[^\)）]*[\)）]?", "", track, flags=re.IGNORECASE)
        track = re.sub(r"[『「【〖\[][^』」】〗\]]*[』」】〗\]]", "", track)
        track = re.sub(r"\s+", " ", track).strip(" -–—|·")
    if artist:
        artist = re.sub(r"[『「【〖\[][^』」】〗\]]*[』」】〗\]]", "", artist).strip()
    return {"artist": artist or None, "track": track or None, "album": album}


# ---------------------------------------------------------------------------
# LRCLIB 查询
# ---------------------------------------------------------------------------
def _http_get_json(url: str, params: Dict[str, Any], timeout: float = 12.0) -> Optional[Any]:
    """GET 一个 JSON 接口。优先用 requests（证书可靠），回退 urllib + certifi。"""
    clean = {k: v for k, v in params.items() if v not in (None, "")}
    qs = urllib.parse.urlencode(clean)
    full = f"{url}?{qs}"

    # 优先 requests（随 ML 依赖安装，使用 certifi，避免 macOS 证书问题）
    try:
        import requests
        r = requests.get(full, headers={"User-Agent": _UA}, timeout=timeout)
        return r.json() if r.status_code == 200 else None
    except ImportError:
        pass
    except Exception:
        return None

    # 回退 urllib，尽量用 certifi 提供的 CA
    ctx = None
    try:
        import ssl
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = None
    try:
        req = urllib.request.Request(full, headers={"User-Agent": _UA})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def fetch_lrclib(meta: Dict[str, Optional[str]], duration: Optional[float]) -> Optional[Dict[str, Any]]:
    """向 LRCLIB 查询同步歌词。优先精确签名，失败则模糊搜索。"""
    track, artist, album = meta.get("track"), meta.get("artist"), meta.get("album")
    if not track:
        return None

    # 1) 精确签名匹配
    if artist:
        rec = _http_get_json(f"{_LRCLIB}/api/get", {
            "track_name": track, "artist_name": artist,
            "album_name": album, "duration": int(duration) if duration else None,
        })
        if rec and rec.get("syncedLyrics"):
            return rec

    # 2) 模糊搜索，挑时长最接近且带同步歌词的
    results = _http_get_json(f"{_LRCLIB}/api/search", {
        "track_name": track, "artist_name": artist,
    }) or _http_get_json(f"{_LRCLIB}/api/search", {"q": track})
    if not isinstance(results, list):
        return None

    best, best_diff = None, 1e9
    for r in results:
        if not r.get("syncedLyrics"):
            continue
        diff = abs((r.get("duration") or 0) - (duration or 0)) if duration else 0
        if diff < best_diff:
            best, best_diff = r, diff
    # 若提供了时长，则要求相差不超过 8 秒，避免错配
    if best and (duration is None or best_diff <= 8):
        return best
    return None


def _to_simp(s: Optional[str]) -> Optional[str]:
    """转简体（装了 zhconv 才生效，否则原样返回）。

    LRCLIB 里中文歌名多为简体，而 YouTube 标题常是繁体，只用原文检索会漏。
    """
    if not s:
        return s
    try:
        import zhconv
        return zhconv.convert(s, "zh-hans")
    except Exception:
        return s


def search_lrclib(query: Optional[str] = None, track: Optional[str] = None,
                  artist: Optional[str] = None, limit: int = 15) -> List[Dict[str, Any]]:
    """搜索 LRCLIB，返回候选列表（精简元信息，不含完整歌词正文，供前端选择）。

    同时用原文与简体形式检索并合并去重，尽量提高繁体标题的命中率。
    """
    seen: Dict[Any, Dict[str, Any]] = {}

    def _collect(results: Any) -> None:
        if isinstance(results, list):
            for r in results:
                if isinstance(r, dict) and r.get("id") is not None:
                    seen.setdefault(r["id"], r)

    attempts: List[Dict[str, Any]] = []
    if track or artist:
        attempts.append({"track_name": track, "artist_name": artist})
        st, sa = _to_simp(track), _to_simp(artist)
        if (st, sa) != (track, artist):
            attempts.append({"track_name": st, "artist_name": sa})
    seen_q: List[str] = []
    for q in (query, _to_simp(query)):
        if q and q not in seen_q:
            seen_q.append(q)
            attempts.append({"q": q})

    for params in attempts:
        if len(seen) >= limit:
            break
        _collect(_http_get_json(f"{_LRCLIB}/api/search", params))

    out: List[Dict[str, Any]] = []
    for r in list(seen.values())[:limit]:
        out.append({
            "id": r.get("id"),
            "trackName": r.get("trackName") or r.get("name"),
            "artistName": r.get("artistName"),
            "albumName": r.get("albumName"),
            "duration": r.get("duration"),
            "synced": bool(r.get("syncedLyrics")),
            "instrumental": bool(r.get("instrumental")),
        })
    return out


def get_lrclib_by_id(rid: Any) -> Optional[Dict[str, Any]]:
    """按 LRCLIB id 取完整记录（含 syncedLyrics / plainLyrics）。"""
    rec = _http_get_json(f"{_LRCLIB}/api/get/{urllib.parse.quote(str(rid))}", {})
    return rec if isinstance(rec, dict) else None


def spread_plain(plain: str, duration: Optional[float]) -> List[Dict[str, Any]]:
    """把无时间轴的纯文本歌词按时长均匀铺开，得到近似逐行时间（无逐字）。"""
    text_lines = [ln.strip() for ln in (plain or "").splitlines() if ln.strip()]
    n = len(text_lines)
    if n == 0:
        return []
    span = duration if duration and duration > 0 else n * 4.0
    step = span / n
    return [{"start": round(i * step, 3), "end": round((i + 1) * step, 3), "text": t}
            for i, t in enumerate(text_lines)]


# ---------------------------------------------------------------------------
# 对外：从各来源获取逐行歌词候选
# ---------------------------------------------------------------------------
def from_lrclib(info: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    meta = guess_meta(info)
    rec = fetch_lrclib(meta, info.get("duration"))
    if not rec:
        return None
    lines = parse_lrc(rec["syncedLyrics"])
    if not lines:
        return None
    return {
        "lines": lines,
        "source": "LRCLIB",
        "language": None,
        "meta": {"trackName": rec.get("trackName"), "artistName": rec.get("artistName")},
    }


def from_subtitles(subtitles: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """从下载到的字幕里挑最合适的一条并解析。官方字幕优先于自动字幕。"""
    if not subtitles:
        return None

    def score(sub: Dict[str, Any]) -> tuple:
        # 官方 > 自动；中/英/日/韩优先
        lang = (sub.get("lang") or "").lower()
        base = lang.split("-")[0]
        pref = {"zh": 3, "en": 2, "ja": 2, "ko": 2}.get(base, 1)
        return (0 if sub.get("auto") else 1, pref)

    chosen = sorted(subtitles, key=score, reverse=True)[0]
    lines = parse_vtt_srt(chosen["path"])
    if not lines:
        return None
    base_lang = (chosen.get("lang") or "").split("-")[0] or None
    kind = "YouTube 自动字幕" if chosen.get("auto") else "YouTube 字幕"
    return {"lines": lines, "source": kind, "language": base_lang}


def detect_language(lines: List[Dict[str, Any]]) -> str:
    """按字符集简单判断语言（供 whisperX 对齐模型选择）。"""
    text = " ".join(l["text"] for l in lines[:20])
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    if re.search(r"[\uac00-\ud7a3]", text):
        return "ko"
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    return "en"
