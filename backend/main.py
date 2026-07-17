"""openk 卡拉OK Web 服务：FastAPI 后端 + 静态前端。

路由:
    POST /api/jobs              创建任务（提交链接，后台处理）
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

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, pipeline
from .jobs import extract_video_id, manager

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

_executor = ThreadPoolExecutor(max_workers=config.MAX_WORKERS)


class CreateJobRequest(BaseModel):
    url: str
    language: str | None = None      # 留空自动检测
    whisper_model: str | None = None  # 留空用默认


class LyricsUpdateRequest(BaseModel):
    lines: list[dict]                 # [{start, end, text, words?}]
    language: str | None = None
    source: str | None = None


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
def retry_job(job_id: str) -> JSONResponse:
    """重试失败的任务：重置状态并重新跑一遍处理流水线（复用已修的下载重试逻辑）。"""
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.get("state") in ("queued", "running"):
        raise HTTPException(status_code=409, detail="任务正在处理中，无需重试")
    manager.update(
        job_id,
        state="queued", step="queued", progress=0,
        message="已重新加入队列", error=None,
    )
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

    uvicorn.run(app, host=config.HOST, port=config.PORT)


if __name__ == "__main__":
    main()
