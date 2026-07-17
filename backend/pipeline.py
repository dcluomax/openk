"""流水线编排：下载 → 人声分离 → 歌词识别对齐。

每个阶段占据总进度的一段区间，实时回写任务状态，供前端轮询显示。
"""
from __future__ import annotations

import traceback
from pathlib import Path

from . import config
from .jobs import manager
from .steps import download, lyrics, separate

# 各阶段在总进度中的区间划分
_DOWNLOAD_RANGE = (2, 20)
_SEPARATE_RANGE = (20, 70)
_TRANSCRIBE_RANGE = (70, 99)


def _scaled(rng: tuple[int, int], pct: int) -> int:
    lo, hi = rng
    return lo + int((hi - lo) * max(0, min(100, pct)) / 100)


def run(job_id: str) -> None:
    """执行单个任务的完整流水线（在后台线程中调用）。"""
    job = manager.get(job_id)
    if job is None:
        return
    url = job["url"]
    job_dir = manager.job_dir(job_id)
    src_dir = job_dir / "source"
    stems_dir = job_dir / "stems"
    lyrics_dir = job_dir  # lyrics.json 直接放在任务根目录

    try:
        # 1) 下载
        manager.update(job_id, state="running", step="download", progress=2, message="正在下载音频…")
        info = download.download_audio(
            url, src_dir,
            on_progress=lambda p, m: manager.update(
                job_id, progress=_scaled(_DOWNLOAD_RANGE, p), message=m
            ),
            cookiefile=config.COOKIEFILE,
        )
        manager.update(
            job_id,
            title=info.get("title"),
            thumbnail=info.get("thumbnail"),
            duration=info.get("duration"),
            webpage_url=info.get("webpage_url"),
            video_id=info.get("video_id") or job.get("video_id"),
            progress=_DOWNLOAD_RANGE[1],
        )

        # 时长闸门：过长（默认 >7 分钟）多为混音/合辑/播客，判定不是单曲，提前结束省算力。
        dur = info.get("duration") or 0
        if config.MAX_SONG_SECONDS and dur > config.MAX_SONG_SECONDS:
            raise RuntimeError(
                f"视频时长约 {int(dur // 60)} 分 {int(dur % 60)} 秒，超过 "
                f"{config.MAX_SONG_SECONDS // 60} 分钟，判定不是单曲。"
                "（如需处理长音频，可调高环境变量 OPENK_MAX_SONG_SECONDS）"
            )

        # 2) 人声分离（已有有效分离结果则复用，避免重复分离——8GB 机器上分离最耗时/易超时，
        #    重试只想换语言重识别时尤其不该再分离一遍）
        prev_stems = job.get("stems") or {}

        def _stem_ok(name: str | None) -> bool:
            if not name:
                return False
            p = stems_dir / name
            return p.exists() and p.stat().st_size > 0

        if _stem_ok(prev_stems.get("vocals")) and _stem_ok(prev_stems.get("instrumental")):
            stems = prev_stems
            manager.update(job_id, step="separate",
                           message="复用已分离的音轨，跳过分离",
                           progress=_SEPARATE_RANGE[1])
        else:
            manager.update(job_id, step="separate", message="正在分离人声与伴奏…")
            stems = separate.separate(
                info["audio_path"], stems_dir,
                model=config.SEPARATOR_MODEL,
                on_progress=lambda p, m: manager.update(
                    job_id, progress=_scaled(_SEPARATE_RANGE, p), message=m
                ),
            )
            manager.update(job_id, stems=stems, progress=_SEPARATE_RANGE[1])

        # 分离完成后，默认删除原始下载音频以节省空间（已去重，不会再次分离）。
        if not config.KEEP_SOURCE:
            try:
                Path(info["audio_path"]).unlink(missing_ok=True)
            except OSError:
                pass

        # 3) 歌词：优先 LRCLIB / YouTube 字幕，再对纯人声做逐词对齐
        manager.update(job_id, step="transcribe", message="正在获取并对齐歌词…")
        vocals_path = stems_dir / stems["vocals"]
        result = lyrics.build(
            info, vocals_path, lyrics_dir,
            language=job.get("language") if job.get("language") else config.WHISPER_LANGUAGE,
            model=job.get("whisper_model") or config.WHISPER_MODEL,
            on_progress=lambda p, m: manager.update(
                job_id, progress=_scaled(_TRANSCRIBE_RANGE, p), message=m
            ),
        )

        manager.update(
            job_id,
            state="done",
            step="done",
            progress=100,
            message="处理完成，可以开始唱了！",
            language=result.get("language"),
            lyrics_file=result.get("lyrics_file"),
            line_count=result.get("line_count"),
            lyrics_source=result.get("source"),
        )
    except Exception as exc:  # noqa: BLE001 - 需要把任何异常反馈给前端
        traceback.print_exc()
        manager.update(
            job_id,
            state="error",
            message="处理失败",
            error=str(exc),
        )
