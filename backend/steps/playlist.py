"""播放列表展开：把一个 YouTube 播放列表链接摊平成一批可提交的单曲。

这里只做「读取清单」，不下载任何音视频。用 yt-dlp 的 ``extract_flat`` 模式，
它只解析播放列表页面本身，不会去挨个请求每支视频的播放地址——一个几十首的
列表通常一两秒就回来了。真正的下载仍然由 :mod:`backend.steps.download`
在各自的任务里完成。

之所以要单独一层而不是把播放列表链接直接丢给下载步骤：下载步骤设了
``noplaylist=True``（拿到 ``watch?v=…&list=…`` 只下当前这一首），而且卡拉OK
的流水线是「一首歌一个任务」的模型——进度、歌词、录音都挂在任务上。所以
正确的做法是在入口处把列表摊平成 N 个任务，而不是让某一个任务去下 N 首歌。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

# 播放列表 ID：出现在 ?list= 或 /playlist?list= 里。
# YouTube 的列表 ID 形态不止一种（PL/UU/OL/RD/FL/LL…，长度也不统一），
# 所以这里不去猜格式，只要是 list= 后面那串合法字符就交给 yt-dlp 判断真伪。
_LIST_ID = re.compile(r"[?&]list=([0-9A-Za-z_-]+)")

# 这几类是 YouTube 动态生成的「推荐/电台」列表，内容因人而异且可能上百首，
# 摊平它们没有意义（也不是用户「收藏的那个歌单」），直接拒掉更不容易误操作。
_DYNAMIC_PREFIXES = ("RD", "UL", "LL", "WL")


class PlaylistError(RuntimeError):
    """播放列表无法读取时抛出，``message`` 已是可直接展示给用户的中文。"""


def extract_playlist_id(url: str) -> Optional[str]:
    """从链接里取出播放列表 ID；不是播放列表则返回 ``None``。"""
    m = _LIST_ID.search(url or "")
    return m.group(1) if m else None


def is_playlist_url(url: str) -> bool:
    return extract_playlist_id(url) is not None


def is_dynamic_playlist(playlist_id: str) -> bool:
    """判断是否是 YouTube 自动生成的电台 / 稍后观看之类的动态列表。"""
    return (playlist_id or "").startswith(_DYNAMIC_PREFIXES)


def canonical_url(playlist_id: str) -> str:
    """播放列表的规范链接。

    用 ``/playlist?list=`` 而不是原始的 ``watch?v=…&list=…``：后者在某些情况下
    会被 yt-dlp 当成「单个视频」处理，只返回当前这一首。
    """
    return f"https://www.youtube.com/playlist?list={playlist_id}"


def video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _friendly(exc: Exception) -> str:
    """把 yt-dlp 那串英文报错翻成一句人能看懂的话。

    最常见的其实是链接被聊天软件截断——YouTube 的列表 ID 有 30 多个字符，
    很容易在换行处被切掉一截，这时它跟「列表不存在」的报错一模一样。
    """
    raw = str(exc)
    low = raw.lower()
    if "does not exist" in low or "not found" in low or "404" in low:
        return ("播放列表不存在。常见原因是链接被截断了——YouTube 的列表 ID "
                "通常有 30 多个字符，请从浏览器地址栏完整复制一次。")
    if "private" in low:
        return "这是私有播放列表，需要登录才能读取（可配置 OPENK_COOKIEFILE 后重试）。"
    if "sign in" in low or "login" in low or "cookies" in low or "bot" in low:
        return "YouTube 要求登录校验，请配置 OPENK_COOKIEFILE 后重试。"
    if "unavailable" in low:
        return "播放列表不可用（可能已被删除或有地区限制）。"
    return f"读取播放列表失败：{raw[:200]}"


def fetch_entries(
    url: str,
    limit: int = 200,
    cookiefile: str | None = None,
) -> Dict[str, Any]:
    """读取播放列表清单。

    参数:
        url: 播放列表链接，或任何带 ``list=`` 参数的观看链接。
        limit: 最多取多少首，防止误贴一个上千首的列表把队列塞满。
        cookiefile: 可选 cookies.txt（私有列表 / 机器人校验时需要）。

    返回 ``{playlist_id, title, uploader, total, truncated, entries}``，
    其中每个 entry 为 ``{video_id, title, duration, url, unavailable}``。

    Raises:
        PlaylistError: 链接不是播放列表，或读取失败（消息已可直接展示）。
    """
    playlist_id = extract_playlist_id(url)
    if not playlist_id:
        raise PlaylistError("这不是播放列表链接（缺少 list= 参数）。")
    if is_dynamic_playlist(playlist_id):
        raise PlaylistError(
            "这是 YouTube 自动生成的电台 / 稍后观看列表，内容因账号而异，"
            "无法批量导入。请打开你自己创建的歌单再复制链接。")

    try:
        import yt_dlp
    except ImportError as exc:  # pragma: no cover - 取决于运行环境
        raise PlaylistError("未安装 yt-dlp，请运行 `pip install -r requirements.txt`") from exc

    opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        # in_playlist：只解析列表页，不对每首歌单独发请求。几十首也就一两秒。
        "extract_flat": "in_playlist",
        "skip_download": True,
        # 多取一首用来判断「是否被截断」，好在界面上如实告诉用户还有更多。
        "playlistend": max(1, int(limit)) + 1,
        "ignoreerrors": True,
        "extractor_retries": 3,
    }
    if cookiefile:
        opts["cookiefile"] = cookiefile

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(canonical_url(playlist_id), download=False)
    except Exception as exc:  # noqa: BLE001 - yt-dlp 的异常类型很杂，统一翻译
        raise PlaylistError(_friendly(exc)) from exc

    if not info:
        raise PlaylistError(_friendly(RuntimeError("does not exist")))

    raw = [e for e in (info.get("entries") or []) if e]
    truncated = len(raw) > limit
    raw = raw[:limit]

    entries: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for e in raw:
        vid = e.get("id")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        title = (e.get("title") or "").strip()
        # 删除/私有的视频在摊平结果里仍占位，标题就是这两个占位串，
        # 时长为空。留着它们只会让用户勾选到必然失败的任务，所以标出来。
        unavailable = (
            title in {"[Private video]", "[Deleted video]", "[Unavailable video]"}
            or not title
        )
        entries.append({
            "video_id": vid,
            "title": title or "(不可用)",
            "duration": e.get("duration"),
            "url": e.get("url") or video_url(vid),
            "uploader": e.get("uploader") or e.get("channel"),
            "unavailable": unavailable,
        })

    return {
        "playlist_id": playlist_id,
        "title": (info.get("title") or "").strip() or playlist_id,
        "uploader": info.get("uploader") or info.get("channel"),
        "total": len(entries),
        "truncated": truncated,
        "entries": entries,
    }
