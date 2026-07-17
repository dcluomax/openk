"""下载步骤：使用 yt-dlp 从 YouTube（或其它站点）拉取最佳音质音频。"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

ProgressCb = Optional[Callable[[int, str], None]]

# 可读音频扩展名（用于在下载目录中定位实际文件）。
_AUDIO_EXTS = {".m4a", ".webm", ".mp3", ".opus", ".ogg", ".wav", ".aac", ".flac"}


def download_audio(
    url: str,
    out_dir: Path,
    on_progress: ProgressCb = None,
    cookiefile: str | None = None,
) -> Dict[str, Any]:
    """下载音频与字幕，并返回元信息。

    参数:
        url: 视频/音频链接。
        out_dir: 输出目录。
        on_progress: 进度回调 ``(百分比 0-100, 说明文字)``。
        cookiefile: 可选的 cookies.txt 路径（用于绕过 YouTube 的机器人校验）。

    返回字典含 ``title/audio_path/duration/thumbnail/video_id/webpage_url``
    以及用于歌词匹配的 ``artist/track/album/uploader`` 与 ``subtitles`` 列表。
    """
    try:
        import yt_dlp
    except ImportError as exc:  # pragma: no cover - 取决于运行环境
        raise RuntimeError(
            "未安装 yt-dlp，请运行 `pip install -r requirements.txt`"
        ) from exc

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def hook(d: Dict[str, Any]) -> None:
        if not on_progress:
            return
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes", 0)
            if total:
                pct = max(0, min(100, int(done * 100 / total)))
                on_progress(pct, "正在下载音频…")
        elif d.get("status") == "finished":
            on_progress(100, "下载完成，准备处理…")

    # 第一步：只下载音频（不带字幕），确保主流程一定成功。
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "writethumbnail": True,
        "progress_hooks": [hook],
        "ignoreerrors": False,
        # 抗 YouTube 偶发 403 / 限流：多留重试；分块下载可在中途换新链接续传。
        "retries": 10,
        "fragment_retries": 10,
        "extractor_retries": 3,
        "http_chunk_size": 10 * 1024 * 1024,
    }
    if cookiefile:
        ydl_opts["cookiefile"] = cookiefile

    # YouTube 的 403 多为偶发限流，重新提取一次通常即可成功；带退避重试几次。
    info = None
    audio_path = None
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                audio_path = Path(ydl.prepare_filename(info))
            last_exc = None
            break
        except yt_dlp.utils.DownloadError as exc:
            last_exc = exc
            low = str(exc).lower()
            transient = (
                "403" in low or "forbidden" in low
                or "unable to download video data" in low
                or "fragment" in low or "timed out" in low or "temporar" in low
            )
            if transient and attempt < 2:
                if on_progress:
                    on_progress(1, f"下载被限流，正在重试（第 {attempt + 2} 次）…")
                time.sleep(2 * (attempt + 1))  # 退避 2s、4s
                continue
            break

    if last_exc is not None:
        exc = last_exc
        msg = str(exc)
        low = msg.lower()
        if "403" in msg or "forbidden" in low or "not a bot" in low or "sign in" in low \
                or "js runtime" in low or "player response" in low:
            raise RuntimeError(
                "YouTube 下载多次重试仍失败（多为反爬 / 限流 / 需要登录）。请尝试：\n"
                "  1) 稍等几分钟再用同一链接重试——临时限流会自动解除，往往就能成功\n"
                "  2) 配置 cookies：设置环境变量 OPENK_COOKIEFILE 指向从浏览器导出的 cookies.txt\n"
                "  3) 升级 yt-dlp：pip install -U --pre \"yt-dlp[default]\"（已装 Deno 可解 JS 挑战）\n"
                f"（原始错误：{msg.splitlines()[-1] if msg else exc}）"
            ) from exc
        raise RuntimeError(f"下载失败：{msg.splitlines()[-1] if msg else exc}") from exc

    # prepare_filename 可能与实际后缀不一致，做一次兜底查找。
    if not audio_path.exists() or audio_path.suffix.lower() not in _AUDIO_EXTS:
        candidates = [
            p for p in out_dir.glob("source.*")
            if p.suffix.lower() in _AUDIO_EXTS
        ]
        if not candidates:
            raise RuntimeError("下载完成但未找到音频文件")
        audio_path = candidates[0]

    # 第二步：容错地下载字幕（作为歌词来源之一）。失败绝不影响主流程。
    subtitles = _download_subtitles(yt_dlp, url, out_dir, info, cookiefile)

    # "频道 - Topic" 是 YouTube Music 自动生成的艺人频道，可靠地反映艺人名。
    uploader = info.get("uploader") or info.get("channel") or ""
    topic_artist = uploader[:-8].strip() if uploader.endswith(" - Topic") else None

    return {
        "title": info.get("title"),
        "audio_path": str(audio_path),
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "video_id": info.get("id"),
        "webpage_url": info.get("webpage_url") or url,
        "artist": info.get("artist") or info.get("creator") or topic_artist,
        "track": info.get("track"),
        "album": info.get("album"),
        "uploader": uploader or None,
        "subtitles": subtitles,
    }


def _download_subtitles(yt_dlp, url: str, out_dir: Path, info: Dict[str, Any],
                        cookiefile: str | None) -> list:
    """独立、容错地下载字幕。任何失败（包括 429 限流）都只是返回已拿到的部分。"""
    want = [
        "en", "zh", "zh-Hans", "zh-Hant", "zh-CN", "zh-TW",
        "ja", "ko", "es", "fr", "de", "it", "pt", "ru",
    ]
    official = set((info.get("subtitles") or {}).keys())
    auto = set((info.get("automatic_captions") or {}).keys())

    # 优先官方字幕；官方没有时，只取少量自动字幕以降低被限流的概率。
    langs = [l for l in want if l in official]
    if not langs:
        langs = [l for l in want if l in auto][:2]
    if not langs:
        return []

    opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": langs,
        "subtitlesformat": "vtt/srt/best",
        "outtmpl": str(out_dir / "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,          # 单个语言失败不抛异常
        "sleep_interval_subtitles": 1,  # 字幕请求之间稍作停顿，缓解 429
    }
    if cookiefile:
        opts["cookiefile"] = cookiefile
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])
    except Exception:  # noqa: BLE001 - 字幕纯属可选，任何异常都忽略
        pass

    subs = []
    for p in sorted(out_dir.glob("source.*")):
        if p.suffix.lower() not in {".vtt", ".srt"}:
            continue
        lang = p.name[len("source."):-len(p.suffix)]
        subs.append({"lang": lang, "path": str(p), "auto": lang not in official})
    return subs
