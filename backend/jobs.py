"""任务管理器：线程安全的内存状态 + 磁盘持久化 (status.json)。"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import config

# 从常见 YouTube 链接中提取 11 位视频 ID（用于去重，避免重复下载/分离同一视频）。
_YT_ID = re.compile(r"(?:v=|/shorts/|youtu\.be/|/embed/|/v/|/live/)([0-9A-Za-z_-]{11})")


def extract_video_id(url: str) -> Optional[str]:
    m = _YT_ID.search(url or "")
    return m.group(1) if m else None


class JobManager:
    """管理卡拉OK处理任务的生命周期与状态。

    每个任务对应 ``data/jobs/<id>/`` 目录，状态镜像写入 ``status.json``，
    以便服务重启后仍能列出并回放已完成的任务。
    """

    def __init__(self) -> None:
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._interrupted: List[str] = []
        config.ensure_dirs()
        self._load_from_disk()

    # ---- 目录辅助 ----
    def job_dir(self, job_id: str) -> Path:
        return config.JOBS_DIR / job_id

    def _status_path(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "status.json"

    # ---- 持久化 ----
    def _load_from_disk(self) -> None:
        if not config.JOBS_DIR.exists():
            return
        for status_file in config.JOBS_DIR.glob("*/status.json"):
            try:
                data = json.loads(status_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            job_id = data.get("id")
            if not job_id:
                continue
            if data.get("state") in {"queued", "running"}:
                if config.RESUME_ON_START:
                    # 批量导入几百首时，整批要跑十几个小时。中途一次重启就把
                    # 没轮到的全标成失败，等于让用户手动重试几百次——所以这里
                    # 重新排队。流水线本身会复用已有的分离结果，重跑代价可控。
                    data["state"] = "queued"
                    data["step"] = "queued"
                    data["progress"] = 0
                    data["error"] = None
                    data["message"] = "服务重启，已重新排队"
                    self._interrupted.append(job_id)
                else:
                    data["state"] = "error"
                    data["error"] = data.get("error") or "服务重启，任务被中断"
                    data["message"] = "任务已中断"
            self._jobs[job_id] = data
        # 持久化重排后的状态，避免再次重启时状态与磁盘不一致。
        for job_id in self._interrupted:
            self._persist(job_id)

    def take_interrupted(self) -> List[str]:
        """取出并清空「重启前未完成」的任务 id，交给调用方重新提交执行。

        由 :mod:`backend.main` 在启动时调用——队列执行器在那边，这里只管状态。
        创建时间早的排前面，保持原有的先来后到。
        """
        with self._lock:
            ids = sorted(self._interrupted,
                         key=lambda j: self._jobs.get(j, {}).get("created_at", 0))
            self._interrupted = []
        return ids

    def _persist(self, job_id: str) -> None:
        job = self._jobs.get(job_id)
        if job is None:
            return
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        tmp = self._status_path(job_id).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._status_path(job_id))

    # ---- CRUD ----
    def create(self, url: str, **extra: Any) -> Dict[str, Any]:
        job_id = uuid.uuid4().hex[:12]
        now = time.time()
        job: Dict[str, Any] = {
            "id": job_id,
            "url": url,
            "webpage_url": url,
            "title": None,
            "thumbnail": None,
            "duration": None,
            "state": "queued",  # queued | running | done | error
            "step": "queued",   # queued | download | separate | transcribe | done
            "progress": 0,
            "message": "已加入队列",
            "error": None,
            "language": None,
            "stems": {},
            "lyrics_file": None,
            "video_id": None,
            "recordings": [],
            "created_at": now,
            "updated_at": now,
        }
        job.update(extra)
        with self._lock:
            self._jobs[job_id] = job
            self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
            self._persist(job_id)
        return dict(job)

    def update(self, job_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.update(fields)
            job["updated_at"] = time.time()
            self._persist(job_id)
            return dict(job)

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = list(self._jobs.values())
        jobs.sort(key=lambda j: j.get("created_at", 0), reverse=True)
        return [dict(j) for j in jobs]

    # ---- 去重复用 ----
    def find_reusable(self, video_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """查找相同视频且已完成的任务，用于复用（避免重复下载/分离）。"""
        if not video_id:
            return None
        with self._lock:
            for job in sorted(self._jobs.values(),
                              key=lambda j: j.get("created_at", 0), reverse=True):
                if job.get("video_id") == video_id and job.get("state") == "done":
                    return dict(job)
        return None

    def find_by_video(self, video_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """查找同一视频最近的一个任务，**不限状态**。

        与 :meth:`find_reusable` 的区别：那个只认已完成的任务（用于复用结果），
        这个把排队中 / 处理中 / 失败的也算上。批量导入需要区分这几种状态，
        才能既不重复排队、又允许用户重新加回上次失败的那几首。
        """
        if not video_id:
            return None
        with self._lock:
            for job in sorted(self._jobs.values(),
                              key=lambda j: j.get("created_at", 0), reverse=True):
                if job.get("video_id") == video_id:
                    return dict(job)
        return None

    def find_by_local_path(self, local_path: Optional[str]) -> Optional[Dict[str, Any]]:
        """按本地文件路径查最近的任务。

        文件名里没有 YouTube ID 时，:meth:`find_by_video` 无从判断，
        只能靠路径去重——否则同一个文件会被反复导入。
        """
        if not local_path:
            return None
        with self._lock:
            for job in sorted(self._jobs.values(),
                              key=lambda j: j.get("created_at", 0), reverse=True):
                if job.get("local_path") == local_path:
                    return dict(job)
        return None

    # ---- 录音管理 ----
    def recordings_dir(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "recordings"

    def add_recording(self, job_id: str, filename: str,
                      meta: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            rec = {"file": filename, **meta}
            job.setdefault("recordings", []).append(rec)
            job["updated_at"] = time.time()
            self._persist(job_id)
            return dict(rec)

    def remove_recording(self, job_id: str, filename: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            job["recordings"] = [r for r in job.get("recordings", [])
                                 if r.get("file") != filename]
            job["updated_at"] = time.time()
            self._persist(job_id)
        try:
            (self.recordings_dir(job_id) / filename).unlink(missing_ok=True)
        except OSError:
            pass
        return True


# 全局单例
manager = JobManager()
