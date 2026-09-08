"""Read-only path helpers for offline maintenance of legacy and published artifacts."""
from __future__ import annotations

import json
from pathlib import Path
import re


def job_directory(jobs_dir: Path, job_id: str) -> Path:
    if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-f]{12}", job_id):
        raise ValueError("任务 ID 必须是 12 位小写十六进制字符")
    root = Path(jobs_dir).resolve()
    directory = root / job_id
    if directory.is_symlink() or not directory.resolve().is_relative_to(root):
        raise ValueError("任务目录不能越出配置的任务根目录")
    return directory


def load_job(jobs_dir: Path, job_id: str) -> tuple[Path, dict]:
    directory = job_directory(jobs_dir, job_id)
    status = directory / "status.json"
    if status.is_symlink():
        raise ValueError("任务元数据不能是符号链接")
    job = json.loads(status.read_text(encoding="utf-8"))
    if not isinstance(job, dict) or job.get("id") != job_id:
        raise ValueError("任务元数据 ID 与目录不一致")
    return directory, job


def artifact_path(directory: Path, reference: str, *, subdir: str = "") -> Path:
    if not isinstance(reference, str) or not reference or "\\" in reference or "\0" in reference:
        raise ValueError("任务未登记有效的媒体文件")
    relative = Path(reference)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("媒体文件必须是任务内的相对路径")
    root = Path(directory).resolve()
    base = root / subdir
    path = base / relative
    if (not base.resolve().is_relative_to(root) or path.is_symlink()
            or not path.resolve().is_relative_to(base.resolve())):
        raise ValueError("媒体文件不能越出所属任务目录")
    if not path.is_file():
        raise FileNotFoundError(f"媒体文件不存在：{path}")
    return path
