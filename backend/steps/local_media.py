"""本地媒体导入：把已经存在磁盘上的视频/音频文件做成卡拉OK任务。

用途是「我早就下好了一柜子 MV，不想再从 YouTube 下一遍」。相比走链接：
省掉整个下载环节，也不受限流和反爬影响。

**安全边界（这是个公开仓库，务必先读这一段）**

允许 HTTP 接口按路径读本地文件，等于开了一个任意文件读取的口子。所以：

1. 默认**完全关闭**。不设 ``OPENK_LOCAL_MEDIA_DIRS`` 时所有相关接口直接 404，
   行为与没有这个功能时一致；
2. 开启后也只认白名单目录。所有路径都会 ``resolve()``（跟随符号链接）之后
   再检查是不是某个白名单根目录的子孙，``..`` 和指向外部的软链都会被拒；
3. 只认媒体扩展名，不做任何形式的「猜类型」。

换句话说：能读到什么，完全由部署者用环境变量圈定，接口本身不能越界。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .. import config

ProgressCb = Optional[Callable[[int, str], None]]

# 认得的媒体扩展名。视频会被抽出音轨，音频直接用。
VIDEO_EXTS = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".flv", ".m4v", ".ts"}
AUDIO_EXTS = {".m4a", ".mp3", ".flac", ".wav", ".opus", ".ogg", ".aac", ".wma"}
MEDIA_EXTS = VIDEO_EXTS | AUDIO_EXTS
# 以 `_` 或 `.` 开头的子目录一律不参与扫描。除重时被淘汰的版本会挪进
# `_重复/`，如果扫描还把它们列出来，下次导入又原样回到曲库，等于白删。
HIDDEN_PREFIXES = ("_", ".")


def _in_hidden_dir(path: Path, roots: List[Path]) -> bool:
    """判断文件是否落在某个 `_`／`.` 开头的子目录里。"""
    for root in roots:
        try:
            parts = path.relative_to(root).parts[:-1]
        except ValueError:
            continue
        return any(p.startswith(HIDDEN_PREFIXES) for p in parts)
    return False

# yt-dlp 默认的命名模板是 ``%(title)s [%(id)s].%(ext)s``，所以下载来的文件名
# 结尾大多带着 11 位视频 ID。能认出来就白捡两样东西：跟已有任务去重，
# 以及把原始链接补回去（点回去还能看原视频）。
_YT_ID_SUFFIX = re.compile(r"^(?P<title>.*?)[\s_]*\[(?P<id>[0-9A-Za-z_-]{11})\]$")

# 一起放在旁边的外挂字幕，可作为歌词来源，省掉一次语音识别。
_SUB_EXTS = (".lrc", ".srt", ".vtt", ".ass")


class LocalMediaError(RuntimeError):
    """路径不合法或不在白名单内；``message`` 可直接展示给用户。"""


# ---------------- 白名单 ----------------
def allowed_roots() -> List[Path]:
    """已配置的白名单根目录（不存在的会被忽略）。空列表＝功能关闭。"""
    roots: List[Path] = []
    for raw in config.LOCAL_MEDIA_DIRS:
        try:
            p = Path(raw).expanduser().resolve()
        except OSError:
            continue
        if p.is_dir():
            roots.append(p)
    return roots


def enabled() -> bool:
    return bool(allowed_roots())


def resolve_within_roots(raw: str) -> Path:
    """把用户给的路径解析成绝对路径，并确认它落在白名单内。

    接受绝对路径，也接受相对于某个白名单根的相对路径。
    ``resolve()`` 会展开 ``..`` 和符号链接，因此软链指到外面也会被这里拦下。
    """
    roots = allowed_roots()
    if not roots:
        raise LocalMediaError("未启用本地媒体导入（请配置 OPENK_LOCAL_MEDIA_DIRS）。")

    raw = (raw or "").strip()
    if not raw:
        raise LocalMediaError("请提供文件路径。")

    candidates = [Path(raw)] if os.path.isabs(raw) else [root / raw for root in roots]
    for cand in candidates:
        try:
            resolved = cand.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        for root in roots:
            try:
                resolved.relative_to(root)
            except ValueError:
                continue
            if resolved.is_file() and resolved.suffix.lower() in MEDIA_EXTS:
                return resolved
            if not resolved.is_file():
                raise LocalMediaError("路径不是文件。")
            raise LocalMediaError(f"不支持的文件类型：{resolved.suffix}")
    raise LocalMediaError("路径不存在，或不在允许的媒体目录内。")


# ---------------- 元数据 ----------------
def parse_name(stem: str) -> tuple[str, Optional[str]]:
    """从文件名（不含扩展名）里拆出标题和 YouTube ID。"""
    m = _YT_ID_SUFFIX.match(stem)
    if m:
        return (m.group("title").strip() or stem), m.group("id")
    return stem, None


def _ffprobe_duration(path: Path) -> Optional[float]:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, errors="replace", timeout=30, check=False,
        )
        value = (out.stdout or "").strip()
        return float(value) if value and value != "N/A" else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _index_path() -> Path:
    return config.DATA_DIR / "local_index.json"


def _load_index() -> Dict[str, Any]:
    try:
        return json.loads(_index_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_index(index: Dict[str, Any]) -> None:
    try:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _index_path().with_suffix(".json.tmp")
        tmp.write_text(json.dumps(index), encoding="utf-8")
        tmp.replace(_index_path())
    except OSError:
        pass  # 索引只是缓存，写不进去也不该影响功能


def scan(subdir: str | None = None, limit: int = 1000) -> Dict[str, Any]:
    """列出白名单目录下的媒体文件。

    时长要靠 ffprobe 一个个探，几百个文件就是几百次进程调用。所以结果按
    ``(大小, mtime)`` 缓存到 ``local_index.json``：文件没动过就直接用缓存，
    第二次扫描几乎是瞬间完成的。
    """
    roots = allowed_roots()
    if not roots:
        raise LocalMediaError("未启用本地媒体导入（请配置 OPENK_LOCAL_MEDIA_DIRS）。")

    search_roots = roots
    if subdir:
        target = resolve_within_roots_dir(subdir)
        search_roots = [target]

    index = _load_index()
    entries: List[Dict[str, Any]] = []
    truncated = False
    dirty = False

    for root in search_roots:
        for path in sorted(root.rglob("*")):
            if len(entries) >= limit:
                truncated = True
                break
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTS:
                continue
            if _in_hidden_dir(path, search_roots):
                continue
            try:
                st = path.stat()
            except OSError:
                continue

            key = str(path)
            cached = index.get(key)
            # 缓存只在「文件没动过 且 上次真的探出了时长」时才算数。
            fresh = (cached is not None
                     and cached.get("size") == st.st_size
                     and int(cached.get("mtime", 0)) == int(st.st_mtime)
                     and cached.get("duration") is not None)
            if not fresh:
                duration = _ffprobe_duration(path)
                cached = {"size": st.st_size, "mtime": int(st.st_mtime),
                          "duration": duration}
                # 探测失败不写进缓存。否则一次偶发失败（ffprobe 超时、文件正在写入）
                # 会让这个文件永远「时长未知」，超长预筛对它就永久失效了；
                # 不写缓存的话下次扫描自然会重试。
                if duration is not None:
                    index[key] = cached
                    dirty = True

            title, video_id = parse_name(path.stem)
            entries.append({
                "path": str(path),
                "rel_path": _relative_display(path, roots),
                "title": title,
                "video_id": video_id,
                "duration": cached.get("duration"),
                "size": st.st_size,
            })
        if truncated:
            break

    if dirty:
        _save_index(index)

    return {"roots": [str(r) for r in roots], "total": len(entries),
            "truncated": truncated, "limit": limit, "entries": entries}


def resolve_within_roots_dir(raw: str) -> Path:
    """同 :func:`resolve_within_roots`，但要求目标是目录。"""
    roots = allowed_roots()
    if not roots:
        raise LocalMediaError("未启用本地媒体导入（请配置 OPENK_LOCAL_MEDIA_DIRS）。")
    candidates = [Path(raw)] if os.path.isabs(raw) else [root / raw for root in roots]
    for cand in candidates:
        try:
            resolved = cand.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        for root in roots:
            try:
                resolved.relative_to(root)
            except ValueError:
                continue
            if resolved.is_dir():
                return resolved
    raise LocalMediaError("目录不存在，或不在允许的媒体目录内。")


def _relative_display(path: Path, roots: List[Path]) -> str:
    for root in roots:
        try:
            return str(path.relative_to(root))
        except ValueError:
            continue
    return path.name


# ---------------- 导入 ----------------
def _extract_audio(src: Path, out_dir: Path, on_progress: ProgressCb) -> Path:
    """抽出音轨。优先直接复制音频流，失败再转码。

    直接 copy 不重新编码：一首歌零点几秒就完事，也不会有二次压缩的损失。
    只有当源音频编码装不进 m4a（比如 vorbis/opus）时才退回转码。
    """
    dst = out_dir / "source.m4a"
    if on_progress:
        on_progress(10, "正在抽取音轨…")

    copy_cmd = ["ffmpeg", "-nostdin", "-y", "-i", str(src),
                "-vn", "-c:a", "copy", "-movflags", "+faststart", str(dst)]
    # errors="replace"：ffmpeg 会把源文件的元数据原样打进 stderr，而外面下载来的
    # mp4 里常带非 UTF-8 的标题/注释。严格解码会让抽音轨这一步直接抛异常，
    # 明明音频本身完全正常。日志里出现几个乱码字符，远好过整首歌失败。
    res = subprocess.run(copy_cmd, capture_output=True, text=True, errors="replace",
                         timeout=config.SEPARATOR_TIMEOUT, check=False)
    if res.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
        if on_progress:
            on_progress(100, "音轨就绪")
        return dst

    if on_progress:
        on_progress(40, "音频编码需要转换，正在转码…")
    dst.unlink(missing_ok=True)
    res = subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", str(src), "-vn",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(dst)],
        capture_output=True, text=True, errors="replace",
        timeout=config.SEPARATOR_TIMEOUT, check=False)
    if res.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
        tail = (res.stderr or "").strip().splitlines()[-3:]
        raise RuntimeError("抽取音轨失败：" + " / ".join(tail))
    if on_progress:
        on_progress(100, "音轨就绪")
    return dst


def _grab_thumbnail(src: Path, out_dir: Path, duration: Optional[float]) -> Optional[str]:
    """截一帧当封面。纯装饰，失败就算了。

    返回相对作业目录的路径（而不是绝对路径）：封面要经 ``/media/{id}/...``
    暴露给浏览器，存绝对路径的话前端拿到的是容器内路径，根本加载不了。
    """
    dst = out_dir / "thumb.jpg"
    seek = max(1.0, min(10.0, (duration or 20) * 0.1))
    try:
        res = subprocess.run(
            ["ffmpeg", "-nostdin", "-y", "-ss", f"{seek:.2f}", "-i", str(src),
             "-frames:v", "1", "-vf", "scale=480:-1", str(dst)],
            capture_output=True, text=True, errors="replace", timeout=60, check=False)
        if res.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return f"{out_dir.name}/{dst.name}"
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def _sidecar_subtitles(src: Path, out_dir: Path) -> List[str]:
    """收集与媒体同名的外挂字幕，作为歌词来源之一（有就省掉一次识别）。"""
    found: List[str] = []
    for sub in sorted(src.parent.glob(glob_escape(src.stem) + "*")):
        if sub.suffix.lower() not in _SUB_EXTS:
            continue
        try:
            dst = out_dir / sub.name
            dst.write_bytes(sub.read_bytes())
            found.append(str(dst))
        except OSError:
            continue
    return found


def glob_escape(text: str) -> str:
    """转义 glob 元字符——歌名里出现 ``[`` ``]`` 太常见了（``[Official MV]``）。"""
    return re.sub(r"([\[\]*?])", r"[\1]", text)


def ingest(
    path: str,
    out_dir: Path,
    on_progress: ProgressCb = None,
) -> Dict[str, Any]:
    """把本地文件做成任务源，返回与 ``download_audio`` 同构的元信息字典。"""
    src = resolve_within_roots(path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    title, video_id = parse_name(src.stem)
    duration = _ffprobe_duration(src)

    if src.suffix.lower() in AUDIO_EXTS:
        # 已经是音频：直接复制进任务目录，不动编码。
        audio = out_dir / ("source" + src.suffix.lower())
        if on_progress:
            on_progress(10, "正在准备音频…")
        audio.write_bytes(src.read_bytes())
        if on_progress:
            on_progress(100, "音频就绪")
    else:
        audio = _extract_audio(src, out_dir, on_progress)

    return {
        "title": title,
        "audio_path": str(audio),
        "duration": duration,
        "thumbnail": _grab_thumbnail(src, out_dir, duration),
        "video_id": video_id,
        # 文件名里带 ID 的话，把原始链接补回去，界面上还能点回去看原视频。
        "webpage_url": f"https://www.youtube.com/watch?v={video_id}" if video_id else str(src),
        "artist": None,
        "track": None,
        "album": None,
        "uploader": None,
        "subtitles": _sidecar_subtitles(src, out_dir),
        "local_path": str(src),
        "imported_at": time.time(),
    }
