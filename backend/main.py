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
import hashlib
import json
import threading
import time
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anyio
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, pipeline, search
from .jobs import JobCancelledError, JobConflictError, extract_video_id, manager
from .operations import OperationStore, public_operation
from .security import BrowserOriginMiddleware
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


class ApiGZipMiddleware(GZipMiddleware):
    async def __call__(self, scope, receive, send):
        # 音轨的 Range 字节范围不能被传输压缩改变。
        if scope["type"] == "http" and scope["path"].startswith("/api/"):
            await super().__call__(scope, receive, send)
        else:
            await self.app(scope, receive, send)


app = FastAPI(title="openk 卡拉OK", version="1.0.0")
app.add_middleware(ApiGZipMiddleware, minimum_size=1024, compresslevel=5)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(config.ALLOWED_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(BrowserOriginMiddleware, allowed_origins=config.ALLOWED_ORIGINS)

from .remote.api import router as _worker_router  # noqa: E402
from .rooms import router as _rooms_router  # noqa: E402
app.include_router(_worker_router, prefix="/api")
app.include_router(_rooms_router)

_executor = ThreadPoolExecutor(max_workers=config.MAX_WORKERS)
_operations = OperationStore(config.DATA_DIR / "operations.json")
_operation_lock = threading.RLock()


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
        job = manager.get(job_id)
        if job is None:
            logging.getLogger("uvicorn.error").warning("续跑任务 %s 已不存在", job_id)
            continue
        _executor.submit(pipeline.run, job_id, job["generation"])


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
    job.pop("generation", None)
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
    # 封面：远程下载的是 http 图床地址，本地导入的是作业目录内的相对路径。
    # 后者要翻译成 /media/{id}/... 才能被浏览器加载；早期版本存的是容器内绝对
    # 路径，这里一并归一，免得旧任务在点歌台上是一片空白封面。
    thumb = job.get("thumbnail")
    if thumb and not str(thumb).startswith(("http://", "https://", "/media/")):
        rel = str(thumb).replace("\\", "/")
        marker = f"/jobs/{jid}/"
        if marker in rel:
            rel = rel.split(marker, 1)[1]
        job["thumbnail"] = f"/media/{jid}/{rel.lstrip('/')}"
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
    job["search_index"] = search.index(job)
    return job


@app.post("/api/jobs")
def create_job(req: CreateJobRequest) -> JSONResponse:
    url = (req.url or "").strip()
    if not url or not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="请提供有效的视频链接（http/https）")

    video_id = extract_video_id(url)
    job, reused = manager.create_or_reuse(
        url,
        video_id=video_id,
        language=(req.language or "").strip() or None,
        whisper_model=(req.whisper_model or "").strip() or None,
    )
    if not reused:
        _executor.submit(pipeline.run, job["id"], job["generation"])
    return JSONResponse({**_public_job(job), "reused": reused})


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
        job, reused = manager.create_or_reuse(
            playlist_step.video_url(entry["video_id"]),
            video_id=entry["video_id"],
            language=language,
            whisper_model=whisper_model,
            # 记下来源，方便日后回看这首歌是从哪个歌单进来的。
            playlist_id=data["playlist_id"],
            playlist_title=data["title"],
        )
        if reused:
            skipped.append({"video_id": entry["video_id"], "title": entry["title"],
                            "reason": "曲库或处理队列里已有", "job_id": job["id"]})
        else:
            _executor.submit(pipeline.run, job["id"], job["generation"])
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
        try:
            # 扫描返回规范路径；macOS 的 /var 与 /private/var 等别名也应匹配。
            wanted.update(str(Path(p).resolve()) for p in tuple(wanted) if Path(p).is_absolute())
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="导入列表含无效文件路径") from exc
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
        job, reused = manager.create_or_reuse(
            entry["path"],
            source_type="local",
            local_path=entry["path"],
            video_id=entry.get("video_id"),
            title=entry.get("title"),
            duration=entry.get("duration"),
            language=language,
            whisper_model=whisper_model,
        )
        if reused:
            skipped.append({"path": entry["rel_path"], "title": entry["title"],
                            "reason": "曲库或处理队列里已有", "job_id": job["id"]})
        else:
            _executor.submit(pipeline.run, job["id"], job["generation"])
            created.append(_public_job(job))

    return {
        "created": created,
        "skipped": skipped,
        "created_count": len(created),
        "skipped_count": len(skipped),
    }


_catalog_lock = threading.Lock()
_catalog_signature: tuple | None = None
_catalog_public: list[dict] = []
_catalog_body = b"[]"
_catalog_etag = ""


@app.get("/api/health")
def health() -> dict:
    # 算力节点可以离线；服务存活不应依赖曲库大小或 worker 是否上线。
    return {"status": "ok"}


@app.get("/api/jobs")
def list_jobs(request: Request, q: str | None = Query(None)) -> Response:
    global _catalog_signature, _catalog_public, _catalog_body, _catalog_etag
    with _catalog_lock:
        jobs = manager.list()
        signature = tuple((j["id"], j.get("updated_at"), j.get("title"), j.get("track"),
                           j.get("artist"), j.get("lyrics_source")) for j in jobs)
        if signature != _catalog_signature:
            public = [_public_job(j) for j in jobs]
            body = json.dumps(public, ensure_ascii=False, separators=(",", ":")).encode()
            _catalog_public = public
            _catalog_body = body
            _catalog_etag = 'W/"' + hashlib.sha256(body).hexdigest() + '"'
            _catalog_signature = signature
        body, etag = _catalog_body, _catalog_etag
        if q is not None:
            matches = search.search_jobs(_catalog_public, q)
            body = json.dumps(matches, ensure_ascii=False, separators=(",", ":")).encode()
            etag = 'W/"' + hashlib.sha256(body).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache", "Vary": "Accept-Encoding"}
    candidates = {value.strip().removeprefix("W/")
                  for value in request.headers.get("if-none-match", "").split(",")}
    if "*" in candidates or etag.removeprefix("W/") in candidates:
        return Response(status_code=304, headers=headers)
    return Response(body, media_type="application/json", headers=headers)


@app.get("/api/zh-map")
def zh_map() -> dict:
    """完整的单字繁→简表（进程内缓存），也覆盖只在搜索输入中出现的字。"""
    return search.zh_map()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return _public_job(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    with _operation_lock:
        _operations.cancel_for(job_id)
        if not manager.delete(job_id):
            raise HTTPException(status_code=404, detail="任务不存在")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str, req: RetryJobRequest | None = Body(None)) -> JSONResponse:
    """重试失败的任务：重置状态并重新跑一遍流水线。

    可选在请求体里传 ``language`` / ``whisper_model`` 覆盖原设置——自动检测把语言
    认错（如中文被判成拉丁语 la）导致歌词乱码 / 无对齐模型时，手动指定语言重试即可修正。
    """
    fields: dict = {}
    if req is not None:
        lang = (req.language or "").strip()
        if lang:
            fields["language"] = lang
        wm = (req.whisper_model or "").strip()
        if wm:
            fields["whisper_model"] = wm
    with _operation_lock:
        if _operations.active_for(job_id):
            raise HTTPException(status_code=409, detail="歌词正在更新，请等待完成")
        try:
            job = manager.retry_if_idle(job_id, **fields)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="任务不存在") from exc
        except JobConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        _executor.submit(pipeline.run, job_id, job["generation"])
    return JSONResponse(_public_job(job))


def _publish_lyrics(job: dict, result: dict, directory: Path) -> dict:
    result = dict(result)
    if not result.get("lyrics_file"):
        raise RuntimeError("对齐结果缺少歌词文件")
    files = {key: result[key] for key in ("lyrics_file", "lrc_file") if result.get(key)}
    updated = manager.commit_artifacts(
        job["id"], job["generation"], directory, files,
        language=result.get("language") or job.get("language"),
        line_count=result.get("line_count"), lyrics_source=result.get("source"), lyrics_status="ok",
    )
    for key in files:
        result[key] = updated[key]
    return result


def _lyrics_workspace(job: dict):
    with manager.guard(job["id"], job["generation"]):
        directory = manager.job_dir(job["id"]) / ".operations"
        directory.mkdir(exist_ok=True)
        return tempfile.TemporaryDirectory(prefix="lyrics-", dir=directory)


@app.put("/api/jobs/{job_id}/lyrics")
def update_lyrics(job_id: str, req: LyricsUpdateRequest) -> dict:
    """保存用户手动修改的歌词（识别不准时可逐行纠正）。"""
    from .steps import transcribe

    if not req.lines:
        raise HTTPException(status_code=400, detail="歌词不能为空")
    with _operation_lock:
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if job["state"] != "done" or _operations.active_for(job_id):
            raise HTTPException(status_code=409, detail="歌曲正在处理，请等待完成后编辑")
        source = (req.source or job.get("lyrics_source") or "手动编辑").strip()
        if "已编辑" not in source:
            source = f"{source} · 已编辑"
        with _lyrics_workspace(job) as directory:
            result = transcribe.save_edited_lyrics(
                req.lines, req.language or job.get("language"), source, Path(directory)
            )
            result = _publish_lyrics(job, result, Path(directory))
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
def align_lyrics(job_id: str, req: LyricsAlignRequest) -> JSONResponse:
    """立即返回可恢复的操作 ID，不占用浏览器请求等待模型完成。"""
    if not req.lrclib_id:
        raise HTTPException(status_code=400, detail="缺少歌词 id")
    with _operation_lock:
        job = manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="任务不存在")
        if job["state"] != "done":
            raise HTTPException(status_code=409, detail="歌曲正在处理，请等待完成")
        vocals = (job.get("stems") or {}).get("vocals")
        if not vocals or not (manager.job_dir(job_id) / "stems" / vocals).is_file():
            raise HTTPException(status_code=400, detail="人声文件不存在，请先重新处理")
        operation, reused = _operations.create(job_id, job["generation"], req.model_dump())
        if not reused:
            _executor.submit(_operations.run, operation["id"], _perform_alignment)
    return JSONResponse({"operation": public_operation(operation), "reused": reused}, status_code=202)


@app.get("/api/operations/{operation_id}")
def get_operation(operation_id: str) -> dict:
    operation = _operations.get(operation_id)
    if operation is None:
        raise HTTPException(status_code=404, detail="操作不存在或历史已过期")
    return public_operation(operation)


def _perform_alignment(operation: dict) -> dict:
    job_id = operation["job_id"]
    with manager.execution(job_id, operation["generation"], allow_done=True) as job:
        with _lyrics_workspace(job) as directory:
            result = _align_into(job, LyricsAlignRequest(**operation["request"]), Path(directory))
            return _publish_lyrics(job, result, Path(directory))


def _align_into(job: dict, req: LyricsAlignRequest, directory: Path) -> dict:
    from .steps import lyrics_sources as ls, transcribe

    vocals_path = manager.job_dir(job["id"]) / "stems" / job["stems"]["vocals"]
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
                vocals_path, lines, language, directory, base_src
            )
        elif plain:
            lines = ls.spread_plain(plain, job.get("duration"))
            if not lines:
                raise HTTPException(status_code=400, detail="歌词为空")
            language = lang_override or ls.detect_language(lines)
            result = transcribe.save_line_lyrics(
                lines, language, base_src + " · 近似时间轴",
                directory,
            )
        else:
            raise HTTPException(status_code=400, detail="该结果没有歌词内容")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"对齐失败：{exc}")
    return result


# ---- 录音：录制演唱的保存 / 列表 / 删除 ----
MAX_RECORDING_BYTES = 100 * 1024 * 1024


def _save_recording(job: dict, temporary: Path, filename: str, meta: dict) -> dict:
    return manager.commit_recording(job["id"], temporary, filename, meta,
                                    generation=job["generation"])


@app.post("/api/jobs/{job_id}/recordings")
async def upload_recording(
    job_id: str,
    request: Request,
    title: str | None = Query(None),
    duration: float | None = Query(None, ge=0, allow_inf_nan=False),
) -> dict:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    mime = request.headers.get("content-type", "application/octet-stream").split(";")[0].strip().lower()
    extensions = {
        "audio/webm": ".webm", "video/webm": ".webm", "audio/mp4": ".mp4",
        "video/mp4": ".mp4", "audio/ogg": ".ogg", "application/octet-stream": ".webm",
    }
    if mime not in extensions:
        raise HTTPException(status_code=415, detail="不支持的录音格式")
    length = request.headers.get("content-length")
    if length:
        try:
            declared = int(length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="录音长度无效") from exc
        if declared < 0:
            raise HTTPException(status_code=400, detail="录音长度无效")
        if declared > MAX_RECORDING_BYTES:
            raise HTTPException(status_code=413, detail="录音文件过大（上限 100MB）")
    staging = config.DATA_DIR / ".uploads"
    await anyio.to_thread.run_sync(lambda: staging.mkdir(parents=True, exist_ok=True))
    identifier = uuid.uuid4().hex
    temporary = staging / f"{identifier}.part"
    filename = f"rec_{identifier}{extensions[mime]}"
    size = 0
    try:
        async with await anyio.open_file(temporary, "xb") as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_RECORDING_BYTES:
                    raise HTTPException(status_code=413, detail="录音文件过大（上限 100MB）")
                await output.write(chunk)
        if not size:
            raise HTTPException(status_code=400, detail="录音内容为空")
        rec = await anyio.to_thread.run_sync(
            _save_recording, job, temporary, filename, {
                "title": (title or "").strip() or None,
                "duration": duration, "created_at": time.time(), "size": size, "mime_type": mime,
            },
        )
    except JobCancelledError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    finally:
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(lambda: temporary.unlink(missing_ok=True))
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


class MediaStaticFiles(StaticFiles):
    TYPES = {
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
        ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
        ".opus": "audio/ogg", ".wma": "audio/x-ms-wma", ".aif": "audio/aiff",
        ".aiff": "audio/aiff", ".mp4": "video/mp4", ".m4v": "video/mp4",
        ".webm": "video/webm", ".mkv": "video/x-matroska", ".mka": "audio/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo", ".flv": "video/x-flv", ".ts": "video/mp2t",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
        ".bmp": "image/bmp", ".json": "application/json",
        ".lrc": "text/plain; charset=utf-8", ".srt": "text/plain; charset=utf-8",
        ".vtt": "text/plain; charset=utf-8", ".ass": "text/plain; charset=utf-8",
    }

    async def get_response(self, path: str, scope):
        media_type = self.TYPES.get(Path(path).suffix.lower())
        if media_type is None:
            raise HTTPException(status_code=404, detail="媒体格式不可公开访问")
        response = await super().get_response(path, scope)
        # 下载的封面可能是 SVG/HTML；即使内容伪装成图片，也不能获得应用同源权限。
        response.media_type = media_type
        response.headers["Content-Type"] = media_type
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = (
            "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        )
        # 歌词和音轨都可能原地重做；复用缓存前按 ETag/修改时间校验。
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/media", MediaStaticFiles(directory=str(config.JOBS_DIR)), name="media")


def _page(filename: str) -> FileResponse:
    path = config.FRONTEND_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="页面未安装")
    return FileResponse(path, headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/tv", include_in_schema=False)
@app.get("/tv/", include_in_schema=False)
def tv_page() -> FileResponse:
    return _page("tv.html")


@app.get("/remote", include_in_schema=False)
@app.get("/remote/", include_in_schema=False)
def remote_page() -> FileResponse:
    return _page("remote.html")


@app.get("/admin", include_in_schema=False)
@app.get("/admin/", include_in_schema=False)
def admin_page() -> FileResponse:
    return _page("index.html")


if config.RESUME_ON_START:
    for _operation in _operations.pending():
        _executor.submit(_operations.run, _operation["id"], _perform_alignment)


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
