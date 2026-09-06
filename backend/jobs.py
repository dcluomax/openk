"""任务管理器：线程安全的内存状态 + 磁盘持久化 (status.json)。"""
from __future__ import annotations

import json
import contextvars
import copy
import logging
import os
import re
import shutil
import stat
import threading
import time
import uuid
from pathlib import Path
from contextlib import contextmanager
from typing import Any, Dict, List, Optional

from . import config

# 从常见 YouTube 链接中提取 11 位视频 ID（用于去重，避免重复下载/分离同一视频）。
_YT_ID = re.compile(r"(?:v=|/shorts/|youtu\.be/|/embed/|/v/|/live/)([0-9A-Za-z_-]{11})")
_JOB_ID = re.compile(r"[0-9a-f]{12}")
_execution = contextvars.ContextVar("openk_job_execution", default=None)
_ACTIVE = {"pending", "queued", "running"}
log = logging.getLogger("openk.jobs")


class JobConflictError(RuntimeError):
    """An active job already owns this execution."""


class JobCancelledError(RuntimeError):
    """The job was deleted, cancelled, or replaced by another generation."""


def extract_video_id(url: str) -> Optional[str]:
    m = _YT_ID.search(url or "")
    return m.group(1) if m else None


class JobManager:
    """管理卡拉OK处理任务的生命周期与状态。

    每个任务对应 ``data/jobs/<id>/`` 目录，状态镜像写入 ``status.json``，
    以便服务重启后仍能列出并回放已完成的任务。
    """

    def __init__(self, jobs_dir: Optional[Path] = None) -> None:
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._interrupted: List[str] = []
        self._executing: Dict[str, str] = {}
        self._queues: set = set()
        self.jobs_dir = Path(jobs_dir or config.JOBS_DIR).resolve()
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self._load_from_disk()
        self._clean_interrupted_staging()

    def _clean_interrupted_staging(self) -> None:
        for name in (".remote-staging", ".artifact-staging"):
            staging = self.jobs_dir / name
            if staging.is_dir() and not staging.is_symlink():
                for attempt in staging.iterdir():
                    if attempt.is_dir() and not attempt.is_symlink():
                        shutil.rmtree(attempt)
        for job_id in self._jobs:
            for groups in (self.job_dir(job_id) / ".openk-results",
                           self.job_dir(job_id) / "stems" / ".openk-results"):
                if groups.is_dir() and not groups.is_symlink():
                    for pending in groups.glob(".commit-*"):
                        if pending.is_dir() and not pending.is_symlink():
                            shutil.rmtree(pending)

    # ---- 目录辅助 ----
    def job_dir(self, job_id: str) -> Path:
        if not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id):
            raise ValueError("Invalid job id")
        return self.jobs_dir / job_id

    def _status_path(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "status.json"

    # ---- 持久化 ----
    def _load_from_disk(self) -> None:
        if not self.jobs_dir.exists():
            return
        for status_file in self.jobs_dir.glob("*/status.json"):
            if status_file.is_symlink() or status_file.parent.is_symlink():
                continue
            try:
                data = json.loads(status_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(data, dict):
                continue
            job_id = data.get("id")
            if (not isinstance(job_id, str) or not _JOB_ID.fullmatch(job_id)
                    or status_file.parent.name != job_id):
                continue
            data.setdefault("generation", uuid.uuid4().hex)
            if data.get("state") in _ACTIVE:
                data["generation"] = uuid.uuid4().hex
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
        for job_id in self._jobs:
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
        if self.job_dir(job_id).is_symlink():
            raise ValueError("Job directory must not be a symlink")
        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        tmp = self._status_path(job_id).with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as stream:
            json.dump(job, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(self._status_path(job_id))
        directory = os.open(self.job_dir(job_id), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    # ---- CRUD ----
    def _create(self, url: str, **extra: Any) -> Dict[str, Any]:
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
            "generation": uuid.uuid4().hex,
        }
        for key in ("id", "generation", "state"):
            if key in extra:
                raise ValueError(f"{key} is managed by the job lifecycle")
        job.update(extra)
        job["video_id"] = job.get("video_id") or extract_video_id(url)
        if job.get("local_path"):
            job["local_path"] = str(Path(job["local_path"]).expanduser().resolve())
        with self._lock:
            self._jobs[job_id] = job
            try:
                self._persist(job_id)
            except Exception:
                self._jobs.pop(job_id, None)
                raise
        return copy.deepcopy(job)

    def create(self, url: str, **extra: Any) -> Dict[str, Any]:
        """Compatibility entry point; creation now also deduplicates active jobs."""
        state = extra.pop("state", None)
        if state is not None and state not in _ACTIVE | {"done", "error", "cancelled"}:
            raise ValueError("Invalid initial job state")
        with self._lock:
            job, reused = self.create_or_reuse(url, **extra)
            if state is not None and not reused:
                job = self.update(job["id"], state=state)
            return job

    def create_or_reuse(self, url: str, **extra: Any) -> tuple[Dict[str, Any], bool]:
        video_id = extra.get("video_id") or extract_video_id(url)
        local_path = extra.get("local_path")
        if local_path:
            local_path = str(Path(local_path).expanduser().resolve())
            extra["local_path"] = local_path
        with self._lock:
            for job in sorted(self._jobs.values(), key=lambda j: j.get("created_at", 0),
                              reverse=True):
                same_video = video_id and job.get("video_id") == video_id
                same_path = (local_path and job.get("local_path")
                             and str(Path(job["local_path"]).expanduser().resolve()) == local_path)
                if (same_video or same_path) and job.get("state") in _ACTIVE | {"done"}:
                    return copy.deepcopy(job), True
            return self._create(url, **extra), False

    def retry_if_idle(self, job_id: str, **fields: Any) -> Dict[str, Any]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            if job.get("state") in _ACTIVE | {"cancelled"} or job_id in self._executing:
                raise JobConflictError("任务正在处理或已取消，不能重复排队")
            if any(key in fields for key in ("id", "generation")):
                raise ValueError("Cannot replace lifecycle identity")
            updated = {**job, **fields, "generation": uuid.uuid4().hex,
                       "state": "queued", "step": "queued", "progress": 0,
                       "error": None, "message": "已重新加入队列", "updated_at": time.time()}
            self._jobs[job_id] = updated
            try:
                self._persist(job_id)
            except Exception:
                self._jobs[job_id] = job
                raise
            return copy.deepcopy(updated)

    def current_execution(self) -> Optional[tuple[str, str]]:
        context = _execution.get()
        return (context[1], context[2]) if context and context[0] is self else None

    def generation(self, job_id: str) -> str:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return job["generation"]

    def check_active(self, job_id: Optional[str] = None,
                     generation: Optional[str] = None) -> None:
        context = self.current_execution()
        if job_id is None:
            if context is None:
                return
            job_id, generation = context
        elif generation is None and context and context[0] == job_id:
            generation = context[1]
        with self._lock:
            job = self._jobs.get(job_id)
            if (job is None or job.get("state") == "cancelled"
                    or (generation is not None and job.get("generation") != generation)):
                raise JobCancelledError("任务已删除、取消或已被新的重试替代")

    def is_cancelled(self, job_id: Optional[str] = None,
                     generation: Optional[str] = None) -> bool:
        try:
            self.check_active(job_id, generation)
            return False
        except JobCancelledError:
            return True

    @contextmanager
    def guard(self, job_id: str, generation: str):
        """Serialize publication against cancellation and deletion."""
        with self._lock:
            self.check_active(job_id, generation)
            yield

    @contextmanager
    def execution(self, job_id: str, generation: Optional[str] = None, *,
                  allow_done: bool = False):
        with self._lock:
            self.check_active(job_id, generation)
            job = self._jobs[job_id]
            generation = generation or job["generation"]
            allowed = _ACTIVE | ({"done"} if allow_done else set())
            if job_id in self._executing or job.get("state") not in allowed:
                raise JobConflictError("任务已经执行，不能重复调度")
            self._executing[job_id] = generation
        token = _execution.set((self, job_id, generation))
        try:
            yield copy.deepcopy(job)
        finally:
            _execution.reset(token)
            with self._lock:
                if self._executing.get(job_id) == generation:
                    self._executing.pop(job_id, None)

    def register_queue(self, task_queue: Any) -> None:
        with self._lock:
            self._queues.add(task_queue)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            self._jobs[job_id] = {**job, "state": "cancelled", "generation": uuid.uuid4().hex,
                                 "message": "任务已取消", "updated_at": time.time()}
            try:
                self._persist(job_id)
            except Exception:
                self._jobs[job_id] = job
                raise
            queues = tuple(self._queues)
        # Never acquire the queue lock while holding the manager lock:
        # finish() holds them in the opposite order during its fenced commit.
        for task_queue in queues:
            task_queue.cancel_where(lambda task: task.job_id == job_id)
        return True

    def delete(self, job_id: str) -> bool:
        if not self.cancel(job_id):
            return False
        with self._lock:
            path = self.job_dir(job_id)
            if path.exists():
                shutil.rmtree(path)
            self._jobs.pop(job_id, None)
            self._interrupted = [jid for jid in self._interrupted if jid != job_id]
        return True

    def _artifact_stage(self, job_id: str, generation: str) -> Path:
        with self.guard(job_id, generation):
            root = self.jobs_dir / ".artifact-staging"
            if root.is_symlink():
                raise ValueError("Artifact staging must not be a symlink")
            root.mkdir(exist_ok=True)
            directory = root / uuid.uuid4().hex
            directory.mkdir()
            return directory

    @staticmethod
    def _copy_artifact(source: Path, destination: Path) -> None:
        fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size <= 0:
                raise ValueError("Artifacts must be nonempty regular files")
            with destination.open("xb") as output:
                shutil.copyfileobj(stream, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
        if destination.stat().st_size != info.st_size:
            raise ValueError("Artifact changed while being copied")

    def _discard_unreferenced(self, job_id: str, destination: Path, reference: str) -> None:
        # A failure after status.json's rename is an uncertain commit. Never remove
        # complete files if durable metadata might already point to them.
        try:
            persisted = self._status_path(job_id).read_text(encoding="utf-8")
        except OSError:
            log.exception("Cannot establish whether failed publication is referenced: %s",
                          destination)
            return
        if reference not in persisted and destination.exists():
            if destination.is_dir():
                shutil.rmtree(destination)
            else:
                destination.unlink()

    def commit_artifacts(self, job_id: str, generation: str, source_dir: Path,
                         filenames: Dict[str, str], **fields: Any) -> Dict[str, Any]:
        """Publish a lyrics group and metadata only for the original generation.

        ``filenames`` maps metadata fields (``lyrics_file`` / ``lrc_file``) to
        contained relative paths in ``source_dir``, including remote output groups.
        Returns the updated job snapshot with the committed relative paths.
        """
        if (not isinstance(filenames, dict) or not filenames
                or not set(filenames) <= {"lyrics_file", "lrc_file"}):
            raise ValueError("filenames must map lyrics_file/lrc_file to relative output paths")
        if "lyrics_file" not in filenames:
            raise ValueError("A complete lyrics publication requires lyrics_file")
        if any(key in fields for key in ("id", "generation")):
            raise ValueError("Cannot replace lifecycle identity")
        source_dir = Path(source_dir)
        with self.guard(job_id, generation):
            job_root = self.job_dir(job_id).resolve()
            root = source_dir.resolve()
            if (source_dir.is_symlink() or not root.is_dir()
                    or not root.is_relative_to(job_root)):
                raise ValueError("Artifact workspace must be inside the owning job")
        sources = {}
        for field, filename in filenames.items():
            if not isinstance(filename, str) or "\\" in filename or "\0" in filename:
                raise ValueError("Invalid artifact filename")
            relative = Path(filename)
            source = root / relative
            if (relative.is_absolute() or ".." in relative.parts or not relative.name
                    or source.is_symlink() or not source.resolve().is_relative_to(root)):
                raise ValueError("Artifact path escapes its workspace")
            expected_suffix = ".json" if field == "lyrics_file" else ".lrc"
            if source.suffix.lower() != expected_suffix:
                raise ValueError(f"{field} requires a {expected_suffix} file")
            sources[field] = source
        stage = self._artifact_stage(job_id, generation)
        group_id = uuid.uuid4().hex
        prefix = f".openk-results/{group_id}/"
        committed = {}
        try:
            for field, source in sources.items():
                name = "lyrics.json" if field == "lyrics_file" else "lyrics.lrc"
                self._copy_artifact(source, stage / name)
                committed[field] = prefix + name
            lyrics = json.loads((stage / "lyrics.json").read_text(encoding="utf-8"))
            if not isinstance(lyrics, dict) or not isinstance(lyrics.get("lines"), list):
                raise ValueError("Lyrics must contain a lines array")
            from .remote.artifacts import _validate_lyrics, digest_file

            _validate_lyrics(stage / "lyrics.json", {
                "line_count": fields.get("line_count", len(lyrics["lines"])),
                "language": fields.get("language", lyrics.get("language")),
                "source": fields.get("lyrics_source", lyrics.get("source")),
            })
            manifest = {"generation": generation, "files": [
                {"name": path.name, "size": path.stat().st_size, "sha256": digest_file(path)}
                for path in stage.iterdir()]}
            with (stage / "manifest.json").open("x", encoding="utf-8") as stream:
                json.dump(manifest, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            with self.guard(job_id, generation):
                groups = self.job_dir(job_id) / ".openk-results"
                if groups.is_symlink():
                    raise ValueError("Output groups must not be a symlink")
                groups.mkdir(exist_ok=True)
                destination = groups / group_id
                os.replace(stage, destination)
                try:
                    return self.update(job_id, **{**fields, **committed})
                except Exception:
                    self._discard_unreferenced(job_id, destination, prefix)
                    raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)

    def commit_recording(self, job_id: str, temp_path: Path, filename: str,
                         meta: Dict[str, Any], *,
                         generation: Optional[str] = None) -> Dict[str, Any]:
        """Move a staged recording and append metadata under a generation fence.

        Pass the generation captured before streaming the upload to reject an
        upload that races a retry. The caller retains its temporary file on error.
        """
        if (not isinstance(filename, str) or not filename or filename in {".", ".."}
                or "/" in filename or "\\" in filename or "\0" in filename):
            raise ValueError("Recording filename must be a plain basename")
        generation = generation or self.generation(job_id)
        stage = self._artifact_stage(job_id, generation)
        temp_path = Path(temp_path)
        recording = {**copy.deepcopy(meta), "file": filename}
        try:
            prepared = stage / filename
            self._copy_artifact(temp_path, prepared)
            with self.guard(job_id, generation):
                directory = self.recordings_dir(job_id)
                if directory.is_symlink():
                    raise ValueError("Recordings directory must not be a symlink")
                directory.mkdir(exist_ok=True)
                destination = directory / filename
                if destination.exists() or destination.is_symlink():
                    raise FileExistsError("A recording with this filename already exists")
                os.replace(prepared, destination)
                try:
                    current = self._jobs[job_id]
                    self.update(job_id, recordings=[*current.get("recordings", []), recording])
                except Exception:
                    self._discard_unreferenced(job_id, destination, filename)
                    raise
            temp_path.unlink(missing_ok=True)
            return copy.deepcopy(recording)
        finally:
            if stage.exists():
                shutil.rmtree(stage)

    def update(self, job_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            self.check_active()
            if job.get("state") == "cancelled":
                return None
            if any(key in fields for key in ("id", "generation")):
                raise ValueError("Cannot replace lifecycle identity")
            updated = {**job, **fields, "updated_at": time.time()}
            self._jobs[job_id] = updated
            try:
                self._persist(job_id)
            except Exception:
                self._jobs[job_id] = job
                raise
            return copy.deepcopy(updated)

    def get(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return copy.deepcopy(job) if job else None

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            jobs = copy.deepcopy(list(self._jobs.values()))
        jobs.sort(key=lambda j: j.get("created_at", 0), reverse=True)
        return [dict(j) for j in jobs]

    # ---- 去重复用 ----
    def find_reusable(self, video_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """查找相同视频的活动或已完成任务；新建请使用 create_or_reuse。"""
        if not video_id:
            return None
        with self._lock:
            for job in sorted(self._jobs.values(),
                              key=lambda j: j.get("created_at", 0), reverse=True):
                if job.get("video_id") == video_id and job.get("state") in _ACTIVE | {"done"}:
                    return copy.deepcopy(job)
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
                    return copy.deepcopy(job)
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
                if (job.get("local_path")
                        and Path(job["local_path"]).expanduser().resolve()
                        == Path(local_path).expanduser().resolve()):
                    return copy.deepcopy(job)
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
