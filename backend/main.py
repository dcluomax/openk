"""openk 卡拉OK Web 服务：FastAPI 后端 + 静态前端。

路由:
    POST /api/jobs              创建任务（提交链接，后台处理）
    POST /api/playlists/preview 读取播放列表清单（不建任务）
    POST /api/playlists/import  批量导入播放列表
    GET  /api/local/status      本地媒体导入是否可用
    POST /api/local/scan        扫描本地媒体目录（不建任务）
    POST /api/local/import      批量导入本地媒体文件
    GET  /api/jobs              任务列表
    GET  /api/jobs/{id}         任务状态
    DELETE /api/jobs/{id}       删除任务及其文件
    /media/{id}/...            分离后的音频与歌词（StaticFiles，支持 Range 便于拖动进度）
    /                          前端页面
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, pipeline
from .jobs import extract_video_id, manager
from .steps import local_media
from .steps import playlist as playlist_step

config.ensure_dirs()


class _QuietPollFilter(logging.Filter):
    """屏蔽前端每隔数秒轮询 ``GET /api/jobs`` 的成功访问日志，避免刷屏。

    仅过滤成功的 GET 轮询；错误、POST/DELETE 及其它端点日志照常保留。
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003
        msg = record.getMessage()
        return not ('"GET /api/jobs' in msg and '" 200' in msg)


logging.getLogger("uvicorn.access").addFilter(_QuietPollFilter())


app = FastAPI(title="openk 卡拉OK", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

from .remote.api import router as _worker_router  # noqa: E402
app.include_router(_worker_router, prefix="/api")

_executor = ThreadPoolExecutor(max_workers=config.MAX_WORKERS)


def _resume_interrupted() -> None:
    """把重启前没跑完的任务重新排进队列。

    批量导入几百首时整批要跑十几个小时，中途一次重启（升级、断电、
    OOM）不该让没轮到的任务全部作废。JobManager 在加载时已经把它们
    的状态改回 queued，这里只负责重新提交执行。
    """
    if not config.RESUME_ON_START:
        return
    pending = manager.take_interrupted()
    if not pending:
        return
    logging.getLogger("uvicorn.error").info(
        "重启续跑：重新排入 %d 个未完成任务", len(pending))
    for job_id in pending:
        _executor.submit(pipeline.run, job_id)


_resume_interrupted()


class CreateJobRequest(BaseModel):
    url: str
    language: str | None = None      # 留空自动检测
    whisper_model: str | None = None  # 留空用默认


class LyricsUpdateRequest(BaseModel):
    lines: list[dict]                 # [{start, end, text, words?}]
    language: str | None = None
    source: str | None = None


class RetryJobRequest(BaseModel):
    language: str | None = None       # 覆盖语言（自动检测认错时手动指定，如 zh）
    whisper_model: str | None = None  # 覆盖识别模型


class PlaylistPreviewRequest(BaseModel):
    url: str
    limit: int | None = None          # 留空用 OPENK_PLAYLIST_MAX_ITEMS


class PlaylistImportRequest(BaseModel):
    url: str
    video_ids: list[str] | None = None  # 留空＝导入全部可导入项
    language: str | None = None
    whisper_model: str | None = None
    limit: int | None = None


class LocalScanRequest(BaseModel):
    subdir: str | None = None         # 留空＝扫描全部白名单目录
    limit: int | None = None


class LocalImportRequest(BaseModel):
    paths: list[str] | None = None    # 留空＝导入全部可导入项
    subdir: str | None = None
    language: str | None = None
    whisper_model: str | None = None
    limit: int | None = None


class LyricsAlignRequest(BaseModel):
    lrclib_id: int | str | None = None   # 选中的 LRCLIB 歌词 id
    language: str | None = None          # 对齐用语言（留空按歌词字符集自动判断）


def _public_job(job: dict) -> dict:
    """给前端补充媒体访问 URL。"""
    job = dict(job)
    jid = job["id"]
    media = {}
    stems = job.get("stems") or {}
    if stems.get("instrumental"):
        media["instrumental"] = f"/media/{jid}/stems/{stems['instrumental']}"
    if stems.get("vocals"):
        media["vocals"] = f"/media/{jid}/stems/{stems['vocals']}"
    if job.get("lyrics_file"):
        media["lyrics"] = f"/media/{jid}/{job['lyrics_file']}"
    job["media"] = media
    # 录音列表（补充可访问 URL）
    recs = job.get("recordings") or []
    job["recordings"] = [
        {**r, "url": f"/media/{jid}/recordings/{r['file']}"} for r in recs if r.get("file")
    ]
    # 解析歌手 / 歌名（点歌台式分组与显示用）：
    # 优先用 LRCLIB 匹配到的「歌手 - 歌名」（最干净），否则从标题猜。
    artist, track = job.get("artist"), job.get("track")
    src = job.get("lyrics_source") or ""
    if not track and src.startswith("LRCLIB"):
        parts = [p.strip() for p in src.split("·")]
        if len(parts) >= 2 and " - " in parts[1]:
            a, t = parts[1].split(" - ", 1)
            artist, track = (a.strip() or None), (t.strip() or None)
    if not track:
        try:
            from .steps.lyrics_sources import guess_meta
            meta = guess_meta({"title": job.get("title") or ""})
            artist = artist or meta.get("artist")
            track = track or meta.get("track")
        except Exception:
            pass
    job["artist"], job["track"] = artist, track
    return job


@app.post("/api/jobs")
def create_job(req: CreateJobRequest) -> JSONResponse:
    url = (req.url or "").strip()
    if not url or not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="请提供有效的视频链接（http/https）")

    # 去重：同一 YouTube 视频若已处理完成，直接复用，避免重复下载与分离。
    video_id = extract_video_id(url)
    existing = manager.find_reusable(video_id)
    if existing:
        pub = _public_job(existing)
        pub["reused"] = True
        return JSONResponse(pub)

    job = manager.create(
        url,
        video_id=video_id,
        language=(req.language or "").strip() or None,
        whisper_model=(req.whisper_model or "").strip() or None,
    )
    _executor.submit(pipeline.run, job["id"])
    return JSONResponse(_public_job(job))


def _entry_status(entry: dict) -> tuple[str, str | None]:
    """判断列表里某一首在本地的状态，决定它默认要不要被勾上。

    返回 ``(status, job_id)``，status 取值：
    ``new`` 没做过 / ``done`` 曲库里已有 / ``pending`` 正在排队或处理 /
    ``failed`` 上次失败（可重新导入）/ ``too_long`` 超长 / ``unavailable`` 已失效。
    """
    if entry.get("unavailable"):
        return "unavailable", None

    dur = entry.get("duration") or 0
    if config.PLAYLIST_SKIP_LONG and config.MAX_SONG_SECONDS and dur > config.MAX_SONG_SECONDS:
        return "too_long", None

    existing = manager.find_by_video(entry.get("video_id"))
    if existing:
        state = existing.get("state")
        if state == "done":
            return "done", existing.get("id")
        if state in {"queued", "running"}:
            return "pending", existing.get("id")
        return "failed", existing.get("id")
    return "new", None


# 默认勾选：没做过的，以及上次失败可以重来的。
_IMPORTABLE = {"new", "failed"}


def _preview(url: str, limit: int | None) -> dict:
    url = (url or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="请提供播放列表链接")

    cap = config.PLAYLIST_MAX_ITEMS
    n = cap if limit is None else max(1, min(int(limit), cap))
    try:
        data = playlist_step.fetch_entries(url, limit=n, cookiefile=config.COOKIEFILE)
    except playlist_step.PlaylistError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    for entry in data["entries"]:
        status, job_id = _entry_status(entry)
        entry["status"] = status
        entry["job_id"] = job_id
        entry["importable"] = status in _IMPORTABLE
    data["limit"] = n
    data["importable"] = sum(1 for e in data["entries"] if e["importable"])
    return data


@app.post("/api/playlists/preview")
def preview_playlist(req: PlaylistPreviewRequest) -> dict:
    """读取播放列表清单，并标出每一首在本地的状态。**不创建任何任务。**

    单独做成一步是为了让用户先看清楚要导入什么：歌单里混着现场版、
    纯音乐、已经做过的歌很常见，一股脑全导会白白占用几小时算力。
    """
    return _preview(req.url, req.limit)


@app.post("/api/playlists/import")
def import_playlist(req: PlaylistImportRequest) -> dict:
    """批量把播放列表里的歌加入队列。

    ``video_ids`` 留空表示导入全部可导入项（没做过的 + 上次失败的）。
    已完成的会被跳过而不是重做——同一支视频的分离结果本来就可以复用。
    """
    data = _preview(req.url, req.limit)
    entries = data["entries"]

    if req.video_ids is not None:
        wanted = {v.strip() for v in req.video_ids if v and v.strip()}
        entries = [e for e in entries if e["video_id"] in wanted]

    language = (req.language or "").strip() or None
    whisper_model = (req.whisper_model or "").strip() or None

    created: list[dict] = []
    skipped: list[dict] = []
    reason_text = {
        "done": "曲库里已有",
        "pending": "已在队列中",
        "unavailable": "视频已失效",
        "too_long": "时长超过单曲上限",
    }
    for entry in entries:
        status = entry["status"]
        if status not in _IMPORTABLE:
            skipped.append({
                "video_id": entry["video_id"],
                "title": entry["title"],
                "reason": reason_text.get(status, status),
                "job_id": entry.get("job_id"),
            })
            continue
        job = manager.create(
            playlist_step.video_url(entry["video_id"]),
            video_id=entry["video_id"],
            language=language,
            whisper_model=whisper_model,
            # 记下来源，方便日后回看这首歌是从哪个歌单进来的。
            playlist_id=data["playlist_id"],
            playlist_title=data["title"],
        )
        _executor.submit(pipeline.run, job["id"])
        created.append(_public_job(job))

    return {
        "playlist_id": data["playlist_id"],
        "title": data["title"],
        "created": created,
        "skipped": skipped,
        "created_count": len(created),
        "skipped_count": len(skipped),
    }


# ---- 本地媒体导入 ----
def _require_local_enabled() -> None:
    """没配置白名单目录就当这个功能不存在。

    返回 404 而不是 403：不暴露「这里有个功能只是没开」的信息，
    对着公网跑的实例少一点可探测面。
    """
    if not local_media.enabled():
        raise HTTPException(status_code=404, detail="未启用本地媒体导入")


def _local_status(entry: dict) -> tuple[str, str | None]:
    """本地文件的状态判定。

    先按 YouTube ID 去重（yt-dlp 下载的文件名里带着），文件名里没有 ID 时
    退回按路径去重——否则同一个文件每次扫描都会显示成「没做过」。
    """
    dur = entry.get("duration") or 0
    if config.PLAYLIST_SKIP_LONG and config.MAX_SONG_SECONDS and dur > config.MAX_SONG_SECONDS:
        return "too_long", None

    existing = (manager.find_by_video(entry.get("video_id"))
                or manager.find_by_local_path(entry.get("path")))
    if existing:
        state = existing.get("state")
        if state == "done":
            return "done", existing.get("id")
        if state in {"queued", "running"}:
            return "pending", existing.get("id")
        return "failed", existing.get("id")
    return "new", None


def _local_scan(subdir: str | None, limit: int | None) -> dict:
    cap = config.LOCAL_MEDIA_MAX_ITEMS
    n = cap if limit is None else max(1, min(int(limit), cap))
    try:
        data = local_media.scan(subdir=subdir, limit=n)
    except local_media.LocalMediaError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    for entry in data["entries"]:
        status, job_id = _local_status(entry)
        entry["status"] = status
        entry["job_id"] = job_id
        entry["importable"] = status in _IMPORTABLE
    data["importable"] = sum(1 for e in data["entries"] if e["importable"])
    return data


@app.get("/api/local/status")
def local_status() -> dict:
    """本地导入是否可用、允许哪些目录。前端据此决定要不要显示这个入口。"""
    return {"enabled": local_media.enabled(),
            "roots": [str(r) for r in local_media.allowed_roots()]}


@app.post("/api/local/scan")
def scan_local(req: LocalScanRequest) -> dict:
    """列出白名单目录里的媒体文件，并标出每个在曲库里的状态。**不创建任务。**"""
    _require_local_enabled()
    return _local_scan(req.subdir, req.limit)


@app.post("/api/local/import")
def import_local(req: LocalImportRequest) -> dict:
    """批量把本地文件加入队列。``paths`` 留空＝导入全部可导入项。"""
    _require_local_enabled()
    data = _local_scan(req.subdir, req.limit)
    entries = data["entries"]

    if req.paths is not None:
        wanted = {p.strip() for p in req.paths if p and p.strip()}
        entries = [e for e in entries if e["path"] in wanted or e["rel_path"] in wanted]

    language = (req.language or "").strip() or None
    whisper_model = (req.whisper_model or "").strip() or None

    created: list[dict] = []
    skipped: list[dict] = []
    reason_text = {
        "done": "曲库里已有",
        "pending": "已在队列中",
        "too_long": "时长超过单曲上限",
    }
    for entry in entries:
        status = entry["status"]
        if status not in _IMPORTABLE:
            skipped.append({
                "path": entry["rel_path"],
                "title": entry["title"],
                "reason": reason_text.get(status, status),
                "job_id": entry.get("job_id"),
            })
            continue
        job = manager.create(
            entry["path"],
            source_type="local",
            local_path=entry["path"],
            video_id=entry.get("video_id"),
            title=entry.get("title"),
            duration=entry.get("duration"),
            language=language,
            whisper_model=whisper_model,
        )
        _executor.submit(pipeline.run, job["id"])
        created.append(_public_job(job))

    return {
        "created": created,
        "skipped": skipped,
        "created_count": len(created),
        "skipped_count": len(skipped),
    }


@app.get("/api/jobs")
def list_jobs(q: str | None = Query(None)) -> list[dict]:
    jobs = manager.list()
    if q:
        kw = q.strip().lower()
        jobs = [
            j for j in jobs
            if kw in (j.get("title") or "").lower()
            or kw in (j.get("url") or "").lower()
        ]
    return [_public_job(j) for j in jobs]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _public_job(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    import shutil

    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    shutil.rmtree(manager.job_dir(job_id), ignore_errors=True)
    # 从内存中移除
    with manager._lock:  # noqa: SLF001 - 内部单例，受控访问
        manager._jobs.pop(job_id, None)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str, req: RetryJobRequest | None = Body(None)) -> JSONResponse:
    """重试失败的任务：重置状态并重新跑一遍流水线。

    可选在请求体里传 ``language`` / ``whisper_model`` 覆盖原设置——自动检测把语言
    认错（如中文被判成拉丁语 la）导致歌词乱码 / 无对齐模型时，手动指定语言重试即可修正。
    """
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.get("state") in ("queued", "running"):
        raise HTTPException(status_code=409, detail="任务正在处理中，无需重试")
    fields: dict = dict(
        state="queued", step="queued", progress=0,
        message="已重新加入队列", error=None,
    )
    if req is not None:
        lang = (req.language or "").strip()
        if lang:
            fields["language"] = lang
        wm = (req.whisper_model or "").strip()
        if wm:
            fields["whisper_model"] = wm
    manager.update(job_id, **fields)
    _executor.submit(pipeline.run, job_id)
    return JSONResponse(_public_job(manager.get(job_id)))


@app.put("/api/jobs/{job_id}/lyrics")
def update_lyrics(job_id: str, req: LyricsUpdateRequest) -> dict:
    """保存用户手动修改的歌词（识别不准时可逐行纠正）。"""
    from .steps import transcribe

    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if not req.lines:
        raise HTTPException(status_code=400, detail="歌词不能为空")
    source = (req.source or job.get("lyrics_source") or "手动编辑").strip()
    if "已编辑" not in source:
        source = f"{source} · 已编辑"
    result = transcribe.save_edited_lyrics(
        req.lines, req.language or job.get("language"), source, manager.job_dir(job_id)
    )
    manager.update(job_id, lyrics_source=result.get("source"), line_count=result.get("line_count"))
    return {"ok": True, **result}


@app.get("/api/lyrics/search")
def lyrics_search(q: str | None = Query(None), track: str | None = Query(None),
                  artist: str | None = Query(None)) -> list[dict]:
    """在 LRCLIB 歌词库里搜索候选歌词（供手动挑选后重新对齐）。"""
    from .steps import lyrics_sources as ls

    if not any((q, track, artist)):
        raise HTTPException(status_code=400, detail="请输入搜索关键词")
    try:
        return ls.search_lrclib(query=q, track=track, artist=artist)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"歌词搜索失败：{exc}")


@app.post("/api/jobs/{job_id}/lyrics/align")
def align_lyrics(job_id: str, req: LyricsAlignRequest) -> dict:
    """把选中的歌词库歌词强制对齐到该任务的人声，得到逐字时间戳并覆盖歌词。

    用于 ASR 识别不准（语言误判成拼音/英文等）时，手动搜到正确歌词后重新对齐。
    复用已分离的人声，不重新下载/分离。
    """
    from .steps import lyrics_sources as ls, transcribe

    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if not req.lrclib_id:
        raise HTTPException(status_code=400, detail="缺少歌词 id")

    stems = job.get("stems") or {}
    vocals = stems.get("vocals")
    if not vocals:
        raise HTTPException(status_code=400, detail="该任务还没有分离出人声，无法对齐")
    vocals_path = manager.job_dir(job_id) / "stems" / vocals
    if not vocals_path.exists():
        raise HTTPException(status_code=400, detail="人声文件不存在，请先重新处理")

    rec = ls.get_lrclib_by_id(req.lrclib_id)
    if not rec:
        raise HTTPException(status_code=404, detail="未找到该歌词")

    who = " - ".join(x for x in (rec.get("artistName"), rec.get("trackName")) if x)
    base_src = f"LRCLIB · {who}" if who else "LRCLIB"
    lang_override = (req.language or "").strip()
    synced = rec.get("syncedLyrics")
    plain = rec.get("plainLyrics")
    try:
        if synced:
            lines = ls.parse_lrc(synced)
            if not lines:
                raise HTTPException(status_code=400, detail="歌词解析为空")
            language = lang_override or ls.detect_language(lines)
            result = transcribe.align_known_lyrics(
                vocals_path, lines, language, manager.job_dir(job_id), base_src
            )
        elif plain:
            lines = ls.spread_plain(plain, job.get("duration"))
            if not lines:
                raise HTTPException(status_code=400, detail="歌词为空")
            language = lang_override or ls.detect_language(lines)
            result = transcribe.save_line_lyrics(
                lines, language, base_src + " · 近似时间轴",
                manager.job_dir(job_id),
            )
        else:
            raise HTTPException(status_code=400, detail="该结果没有歌词内容")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"对齐失败：{exc}")
    manager.update(
        job_id,
        language=result.get("language"),
        lyrics_file=result.get("lyrics_file"),
        line_count=result.get("line_count"),
        lyrics_source=result.get("source"),
    )
    return {"ok": True, **result}


# ---- 录音：录制演唱的保存 / 列表 / 删除 ----
@app.post("/api/jobs/{job_id}/recordings")
async def upload_recording(
    job_id: str,
    request: Request,
    title: str | None = Query(None),
    duration: float | None = Query(None),
) -> dict:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="录音内容为空")
    if len(body) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="录音文件过大（上限 100MB）")

    rec_dir = manager.recordings_dir(job_id)
    rec_dir.mkdir(parents=True, exist_ok=True)
    filename = f"rec_{int(time.time() * 1000)}.webm"
    (rec_dir / filename).write_bytes(body)

    rec = manager.add_recording(job_id, filename, {
        "title": (title or "").strip() or None,
        "duration": duration,
        "created_at": time.time(),
        "size": len(body),
    })
    return {"ok": True, "recording": {**rec, "url": f"/media/{job_id}/recordings/{filename}"}}


@app.get("/api/jobs/{job_id}/recordings")
def list_recordings(job_id: str) -> list[dict]:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _public_job(job)["recordings"]


@app.delete("/api/jobs/{job_id}/recordings/{filename}")
def delete_recording(job_id: str, filename: str) -> dict:
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="非法文件名")
    if manager.get(job_id) is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    manager.remove_recording(job_id, filename)
    return {"ok": True}


class NoCacheStaticFiles(StaticFiles):
    """前端页面资源：强制浏览器每次重新校验，避免加载到旧版 HTML/JS/CSS。

    默认的 StaticFiles 只设 ETag/Last-Modified、不设 Cache-Control，浏览器会按
    启发式缓存直接复用旧文件而不回源校验，导致改了前端却看到老界面。加上
    ``no-cache`` 后浏览器每次都带条件请求回源，未变更仍返回 304，既不陈旧也不浪费带宽。
    """

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


# 媒体文件（分离音频 + 歌词）。StaticFiles 支持 HTTP Range，便于音频拖动进度；
# 媒体按任务不可变，可放心长期缓存，故不加 no-cache。
app.mount("/media", StaticFiles(directory=str(config.JOBS_DIR)), name="media")

# 前端页面（放在最后挂载到根路径，避免遮蔽上面的 API 路由）。
if config.FRONTEND_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="frontend")


def main() -> None:
    import uvicorn

    kwargs = {"host": config.HOST, "port": config.PORT}
    if config.SSL_CERTFILE and config.SSL_KEYFILE:
        kwargs["ssl_certfile"] = config.SSL_CERTFILE
        kwargs["ssl_keyfile"] = config.SSL_KEYFILE
        print(f"[openk] HTTPS 已启用 → https://{config.HOST}:{config.PORT}")
    elif config.HOST not in ("127.0.0.1", "localhost", "::1"):
        # 别等用户点了「开始录唱」才发现录不了。
        print("[openk] 提示：当前是 HTTP，浏览器只在 https 或 localhost 下允许使用麦克风。")
        print("[openk]       从其他设备访问时录音会被浏览器拦截；生成证书见 scripts/make_cert.py。")
    uvicorn.run(app, **kwargs)


if __name__ == "__main__":
    main()
