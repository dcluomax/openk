"""流水线编排：下载 → 人声分离 → 歌词识别对齐。

每个阶段占据总进度的一段区间，实时回写任务状态，供前端轮询显示。
"""
from __future__ import annotations

import logging
import time
import traceback
from pathlib import Path

from . import config
from .jobs import JobCancelledError, JobConflictError, manager
from .steps import download, execution, library, local_media, lyrics, meta_fix, separate
from .steps.media_utils import check_duration

log = logging.getLogger("openk.pipeline")


class PipelineCancelled(BaseException):
    """Cancellation must pass through optional network/model fallbacks."""


def _checkpoint(job_id: str) -> None:
    try:
        manager.check_active(job_id)
    except JobCancelledError as exc:
        raise PipelineCancelled() from exc


def _update(job_id: str, **values) -> None:
    _checkpoint(job_id)
    manager.update(job_id, **values)


def _fingerprint(path: str | Path | None) -> dict | None:
    if not path:
        return None
    try:
        stat = Path(path).stat()
        if not Path(path).is_file() or stat.st_size <= 0:
            return None
        return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    except OSError:
        return None


def _identity(job: dict) -> dict:
    identity = {"url": job["url"], "source_type": job.get("source_type")}
    if job.get("source_type") == "local":
        fingerprint = _fingerprint(job.get("local_path") or job["url"])
        previous = (job.get("source_info") or {}).get("identity") or {}
        if fingerprint is None and all(previous.get(key) == value for key, value in identity.items()):
            fingerprint = previous.get("local_file")
        identity["local_file"] = fingerprint
    return identity


def _complete_stems(job: dict, stems_dir: Path, identity: dict) -> bool:
    stems = job.get("stems") or {}
    checkpoint = job.get("stems_info")
    if checkpoint and (checkpoint.get("identity") != identity
                       or checkpoint.get("model") != config.SEPARATOR_MODEL):
        return False
    if checkpoint:
        current_source = _fingerprint((job.get("source_info") or {}).get("audio_path"))
        expected_source = checkpoint.get("source_fingerprint")
        if expected_source and current_source and current_source != expected_source:
            return False
    for kind in ("vocals", "instrumental"):
        name = stems.get(kind)
        if (not isinstance(name, str) or not name or "\\" in name
                or Path(name).is_absolute() or ".." in Path(name).parts):
            return False
        try:
            path = (stems_dir / name).resolve()
            if not path.is_relative_to(stems_dir.resolve()):
                return False
            fingerprint = _fingerprint(path)
        except (OSError, ValueError, RuntimeError):
            return False
        if not fingerprint:
            return False
        if checkpoint and checkpoint.get("files", {}).get(kind) != fingerprint:
            return False
    return True


def _source_info(job: dict, identity: dict, src_dir: Path) -> dict:
    cached = job.get("source_info") or {}
    if cached.get("identity") == identity:
        return dict(cached)
    info = {key: job.get(key) for key in (
        "title", "thumbnail", "duration", "webpage_url", "video_id", "artist", "track")}
    if cached:
        info["duration"] = None
    else:
        # Older jobs predate source_info; their downloaded/local sidecars can
        # still avoid ASR on a lyrics-only retry.
        subtitles = []
        for path in sorted(src_dir.glob("*")):
            if path.is_file() and path.suffix.lower() in {".lrc", ".vtt", ".srt", ".ass"}:
                lang = path.stem.removeprefix("source.") if path.stem.startswith("source.") else None
                subtitles.append({"path": str(path), "lang": lang,
                                  "origin": "local" if job.get("source_type") == "local" else "legacy",
                                  "format": path.suffix.lstrip(".").lower()})
        info["subtitles"] = subtitles
    return info


def _save_source_info(job_id: str, info: dict, identity: dict) -> None:
    info["identity"] = identity
    info["fingerprint"] = _fingerprint(info.get("audio_path"))
    _update(job_id, source_info=dict(info))


# 各阶段在总进度中的区间划分
_DOWNLOAD_RANGE = (2, 20)
_SEPARATE_RANGE = (20, 70)
_TRANSCRIBE_RANGE = (70, 99)


def _settle_meta(job_id: str, job: dict, info: dict) -> dict:
    """在查歌词之前先把「歌手 / 歌名」定下来。

    歌词库是按歌手歌名查的，而 YouTube 标题常常是
    「似是故人來 梅艷芳 Karaoke MP4_AAC Stereo」这种。名字没定准就去查，
    必然查不到，于是退回语音识别；偏偏这类源本身就是伴奏带，没有人声可认，
    最后落得一行歌词都没有。所以定名必须排在取歌词前面。
    """
    merged = dict(info)
    artist = (job.get("artist") or "").strip()
    track = (job.get("track") or "").strip()
    if not track:
        try:
            plan = meta_fix.plan_fix({**job, "title": info.get("title") or job.get("title"),
                                      "duration": info.get("duration")})
        except Exception:  # noqa: BLE001 - 定名失败不该拖垮整条流水线
            traceback.print_exc()
            plan = None
        if plan:
            artist = plan.get("artist") or artist
            track = plan.get("track") or track
            _update(job_id, artist=artist or None, track=track or None)
    if artist:
        merged["artist"] = artist
    if track:
        merged["track"] = track
    return merged


def _scaled(rng: tuple[int, int], pct: int) -> int:
    lo, hi = rng
    return lo + int((hi - lo) * max(0, min(100, pct)) / 100)


def run(job_id: str, generation: str | None = None) -> None:
    """执行单个任务的完整流水线（在后台线程中调用）。"""
    try:
        with manager.execution(job_id, generation):
            with execution.cancellation_checks(lambda: _checkpoint(job_id)):
                _run(job_id)
    except JobCancelledError:
        log.info("processing_not_started reason=cancelled")
    except JobConflictError:
        log.info("processing_not_started reason=already_executing")


def _run(job_id: str) -> None:
    job = manager.get(job_id)
    if job is None:
        return
    url = job["url"]
    job_dir = manager.job_dir(job_id)
    src_dir = job_dir / "source"
    stems_dir = job_dir / "stems"
    lyrics_dir = job_dir  # lyrics.json 直接放在任务根目录

    try:
        _checkpoint(job_id)
        identity = _identity(job)
        reuse_stems = _complete_stems(job, stems_dir, identity)
        info = _source_info(job, identity, src_dir)
        check_duration(info.get("duration"))
        source = info.get("audio_path")
        reuse_source = bool(source and _fingerprint(source) == info.get("fingerprint")
                            and info.get("fingerprint"))
        started = time.monotonic()
        _update(job_id, state="running", step="download", progress=2,
                error=None, message="正在检查已完成的处理阶段…")
        if not reuse_stems and not reuse_source:
            # A previously archived download is already a usable audio source.
            archived = job.get("local_path") if job.get("source_type") != "local" else None
            if archived and _fingerprint(archived):
                info["audio_path"] = archived
                reuse_source = True
            elif job.get("source_type") == "local":
                info = local_media.ingest(
                    job.get("local_path") or url, src_dir,
                    on_progress=lambda p, m: _update(
                        job_id, progress=_scaled(_DOWNLOAD_RANGE, p), message=m),
                )
            else:
                info = download.download_audio(
                    url, src_dir,
                    on_progress=lambda p, m: _update(
                        job_id, progress=_scaled(_DOWNLOAD_RANGE, p), message=m),
                    cookiefile=config.COOKIEFILE,
                )
        _checkpoint(job_id)
        check_duration(info.get("duration"))
        _save_source_info(job_id, info, identity)
        log.info("processing_stage stage=source duration_seconds=%.3f reused=%s",
                 time.monotonic() - started, reuse_stems or reuse_source)
        _update(
            job_id,
            title=info.get("title"),
            thumbnail=info.get("thumbnail"),
            duration=info.get("duration"),
            webpage_url=info.get("webpage_url"),
            video_id=info.get("video_id") or job.get("video_id"),
            progress=_DOWNLOAD_RANGE[1],
        )

        # 定名要排在分离和取歌词前面：归档需要名字来命名文件，歌词库也是按名字查的。
        info = _settle_meta(job_id, manager.get(job_id) or job, info)
        _save_source_info(job_id, info, identity)

        started = time.monotonic()
        if reuse_stems:
            stems = job["stems"]
            _update(job_id, step="separate", message="复用已分离的音轨，跳过分离",
                    progress=_SEPARATE_RANGE[1])
        else:
            _update(job_id, step="separate", message="正在分离人声与伴奏…")
            stems = separate.separate(
                info["audio_path"], stems_dir,
                model=config.SEPARATOR_MODEL,
                on_progress=lambda p, m: _update(
                    job_id, progress=_scaled(_SEPARATE_RANGE, p), message=m
                ),
            )
            if not _complete_stems({"stems": stems}, stems_dir, identity):
                raise RuntimeError("分离结果不完整；不会缓存或删除源文件")
        _update(job_id, stems=stems, progress=_SEPARATE_RANGE[1],
                stems_info={"identity": identity, "model": config.SEPARATOR_MODEL,
                            "source_fingerprint": info.get("fingerprint"),
                            "files": {kind: _fingerprint(stems_dir / name)
                                      for kind, name in stems.items()}})
        log.info("processing_stage stage=separate duration_seconds=%.3f reused=%s",
                 time.monotonic() - started, reuse_stems)

        source = info.get("audio_path")
        if source and _fingerprint(source):
            _checkpoint(job_id)
            src_audio = Path(source)
            owned = src_audio.parent.resolve() == src_dir.resolve()
            if job.get("source_type") != "local":
                if owned:
                    archived = library.archive_job_source_result(manager.get(job_id) or job, src_audio)
                    _update(job_id, source_archive=archived.as_dict())
                    if archived.status == "archived":
                        info["audio_path"] = str(archived.path)
                        _update(job_id, local_path=str(archived.path))
                    elif (archived.status == "disabled" and not config.LIBRARY_ARCHIVE_DOWNLOADS
                          and not config.KEEP_SOURCE):
                        src_audio.unlink(missing_ok=True)
            elif owned and not config.KEEP_SOURCE:
                src_audio.unlink(missing_ok=True)
            _save_source_info(job_id, info, identity)
            if info.get("fingerprint"):
                stem_info = dict((manager.get(job_id) or {}).get("stems_info") or {})
                stem_info["source_fingerprint"] = info["fingerprint"]
                _update(job_id, stems_info=stem_info)

        # 3) 歌词：优先 LRCLIB / YouTube 字幕，再对纯人声做逐词对齐
        _update(job_id, step="transcribe", message="正在获取并对齐歌词…")
        started = time.monotonic()
        vocals_path = stems_dir / stems["vocals"]
        result = lyrics.build(
            info, vocals_path, lyrics_dir,
            language=job.get("language") if job.get("language") else config.WHISPER_LANGUAGE,
            model=job.get("whisper_model") or config.WHISPER_MODEL,
            on_progress=lambda p, m: _update(
                job_id, progress=_scaled(_TRANSCRIBE_RANGE, p), message=m
            ),
        )
        _checkpoint(job_id)
        log.info("processing_stage stage=lyrics duration_seconds=%.3f",
                 time.monotonic() - started)

        # 歌词库没有、人声里也认不出字，多半这个源本身就是伴奏带（KTV 版没有原唱）。
        # 这不是失败——伴奏照样能唱，只是没字幕。标记出来，避免反复重试。
        got_lyrics = (result.get("line_count") or 0) > 0
        message = ("处理完成，可以开始唱了！" if got_lyrics
                   else "处理完成（此源没有可用歌词，只有伴奏）")
        archive_status = (manager.get(job_id) or {}).get("source_archive") or {}
        if (archive_status.get("status") in {"failed", "conflict", "skipped"}
                or (archive_status.get("status") == "disabled" and config.LIBRARY_ARCHIVE_DOWNLOADS)):
            message += "；" + archive_status["message"]
        _update(
            job_id,
            state="done",
            step="done",
            progress=100,
            message=message,
            language=result.get("language"),
            lyrics_file=result.get("lyrics_file"),
            line_count=result.get("line_count"),
            lyrics_source=result.get("source"),
            lyrics_status="ok" if got_lyrics else "none",
        )
    except PipelineCancelled:
        log.info("processing_cancelled")
    except Exception as exc:  # noqa: BLE001 - 需要把任何异常反馈给前端
        traceback.print_exc()
        if manager.get(job_id) is not None and not manager.is_cancelled(job_id):
            manager.update(job_id, state="error", message="处理失败", error=str(exc))
