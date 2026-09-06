"""统一媒体库：所有源文件都以同一套命名归到同一个目录。

以前有两条来路，各走各的：

* 本地导入 —— 文件留在原目录，名字是拖进来时的样子；
* YouTube 下载 —— 音频落在 ``data/jobs/<id>/source/source.<ext>``，
  没有歌名，分离完还会被删掉。

结果就是同一批歌散在两处，其中一处还没有名字：想备份得记住两个路径，
想换个 Whisper 模型重跑就得重新下载一遍。这个模块把两条来路合到一起，
统一命名成 ``歌手 - 歌名 [videoID].ext``。

``[videoID]`` 必须保留：曲库里有好几首同名不同版本的歌（三个《沒那麼簡單》），
去掉 ID 就会互相覆盖，那是不可逆的数据丢失。
"""
from __future__ import annotations

import errno
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Literal, Optional

from .. import config

_BAD = re.compile(r'[/\\:*?"<>|\x00-\x1f]')
_VIDEO_ID = re.compile(r"\s*\[([A-Za-z0-9_-]{6,})\]\s*$")


def safe_name(s: str) -> str:
    """清掉文件名里不能出现的字符，并限制长度。"""
    s = _BAD.sub(" ", s or "")
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:120]


def extract_video_id(name: str) -> Optional[str]:
    """从既有文件名尾部取出 ``[videoID]``。"""
    m = _VIDEO_ID.search(Path(name).stem)
    return m.group(1) if m else None


def canonical_name(artist: Optional[str], track: Optional[str],
                   video_id: Optional[str], suffix: str) -> Optional[str]:
    """拼出规范文件名。没有歌名就返回 None——宁可不动，也别造个烂名字。"""
    artist = (artist or "").strip()
    track = (track or "").strip()
    if not track:
        return None
    base = f"{artist} - {track}" if artist else track
    tail = f" [{video_id}]" if video_id else ""
    return safe_name(base) + tail + suffix


def library_dir() -> Optional[Path]:
    """媒体库目录，没配置就返回 None。"""
    if not config.LIBRARY_DIR:
        return None
    p = Path(config.LIBRARY_DIR)
    return p if p.is_dir() else None


@dataclass(frozen=True)
class ArchiveResult:
    status: Literal["disabled", "skipped", "conflict", "failed", "archived"]
    message: str
    path: Optional[Path] = None

    def as_dict(self) -> Dict[str, Any]:
        return {"status": self.status, "message": self.message,
                "path": str(self.path) if self.path else None}


def archive_result(src: str | Path, artist: Optional[str], track: Optional[str],
                   video_id: Optional[str] = None) -> ArchiveResult:
    """Publish without replacing another source; all unsuccessful outcomes retain src."""
    src = Path(src)
    if not config.LIBRARY_DIR:
        return ArchiveResult("disabled", "未配置媒体库，源文件保留在任务目录")
    root = Path(config.LIBRARY_DIR)
    if not root.is_dir():
        return ArchiveResult("failed", "媒体库目录不可用；恢复挂载后重试归档")
    if not src.is_file():
        return ArchiveResult("failed", "源文件不存在；请检查源文件后重试")
    name = canonical_name(artist, track, video_id or extract_video_id(src.name), src.suffix)
    if not name:
        return ArchiveResult("skipped", "缺少歌名；补全歌名后可重试归档")
    dst = root / name
    part = root / f".openk-archive-{uuid.uuid4().hex}.part"
    try:
        if dst.exists():
            if dst.samefile(src):
                return ArchiveResult("archived", "源文件已在媒体库", dst)
            return ArchiveResult("conflict", "媒体库已有同名文件；源文件保留，请核对版本", dst)
        # Hard-link publication is atomic and no-clobber. Cross-device copies
        # remain hidden until complete, then use the same no-clobber operation.
        try:
            os.link(src, dst)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            shutil.copyfile(src, part)
            os.link(part, dst)
        try:
            src.unlink()
        except OSError:
            return ArchiveResult("archived", "归档完成；任务目录旧副本未能清理", dst)
        return ArchiveResult("archived", "源文件已归档到媒体库", dst)
    except FileExistsError:
        return ArchiveResult("conflict", "媒体库已有同名文件；源文件保留，请核对版本", dst)
    except OSError as exc:
        return ArchiveResult("failed", f"归档失败（{exc.strerror or type(exc).__name__}）；源文件保留，可重试")
    finally:
        try:
            part.unlink(missing_ok=True)
        except OSError:
            pass


def archive(src: str | Path, artist: Optional[str], track: Optional[str],
            video_id: Optional[str] = None) -> Optional[Path]:
    """Compatibility helper: unsuccessful moves leave the source untouched."""
    result = archive_result(src, artist, track, video_id)
    return result.path if result.status == "archived" else None


def archive_job_source_result(job: Dict[str, Any], src: str | Path) -> ArchiveResult:
    if not config.LIBRARY_ARCHIVE_DOWNLOADS:
        return ArchiveResult("disabled", "下载源归档已关闭")
    return archive_result(src, job.get("artist"), job.get("track"), job.get("video_id"))


def archive_job_source(job: Dict[str, Any], src: str | Path) -> Optional[Path]:
    """归档某个任务的源文件，用任务上已定好的歌手/歌名命名。"""
    return archive(src, job.get("artist"), job.get("track"),
                   job.get("video_id"))
