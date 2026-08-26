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

import re
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

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


def archive(src: str | Path, artist: Optional[str], track: Optional[str],
            video_id: Optional[str] = None) -> Optional[Path]:
    """把源文件搬进媒体库并规范命名，返回新路径。

    搬不动（没配库、没歌名、同名已存在）就返回 None，由调用方维持原状。
    同名已存在时**不覆盖**：宁可留两份，也不能悄悄吃掉一首歌。
    """
    src = Path(src)
    root = library_dir()
    if root is None or not src.is_file():
        return None
    name = canonical_name(artist, track, video_id or extract_video_id(src.name), src.suffix)
    if not name:
        return None
    dst = root / name
    if dst.exists():
        return dst if dst.samefile(src) else None
    try:
        # 跨设备时 rename 会失败（库和 data 常挂在不同卷上），退回复制后删源。
        try:
            src.rename(dst)
        except OSError:
            shutil.move(str(src), str(dst))
    except OSError:
        return None
    return dst


def archive_job_source(job: Dict[str, Any], src: str | Path) -> Optional[Path]:
    """归档某个任务的源文件，用任务上已定好的歌手/歌名命名。"""
    return archive(src, job.get("artist"), job.get("track"),
                   job.get("video_id"))
