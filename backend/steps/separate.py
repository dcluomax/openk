"""人声分离步骤：调用 audio-separator（UVR 模型的 CLI 封装）。

以子进程方式运行，避免把 PyTorch / onnxruntime 加载进 Web 进程，
同时让每次分离结束后内存可被系统回收。
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .. import config
from ..remote import client as remote

ProgressCb = Optional[Callable[[int, str], None]]

_PCT_RE = re.compile(r"(\d{1,3})%")


def _resolve_stem(out_dir: Path, wanted: str) -> Optional[Path]:
    """在输出目录中定位某个声部文件（先精确后模糊匹配）。"""
    exact = out_dir / f"{wanted}.mp3"
    if exact.exists():
        return exact
    for p in sorted(out_dir.glob(f"*{wanted}*")):
        if p.is_file() and p.suffix.lower() in {".mp3", ".wav", ".flac", ".m4a"}:
            return p
    return None


def separate(
    audio_path: str | Path,
    out_dir: Path,
    model: str = "",
    on_progress: ProgressCb = None,
) -> Dict[str, str]:
    """把音频分离为 vocals（人声）与 instrumental（伴奏）两个声部。

    返回 ``{"vocals": <文件名>, "instrumental": <文件名>}``（相对 out_dir）。
    开启远程时由 worker 机器执行，输出直接落在共享的 out_dir 中。
    """
    def _local() -> Dict[str, str]:
        return separate_local(audio_path, out_dir, model, on_progress)

    if remote.enabled("separate"):
        return remote.run("separate", {
            "audio_path": str(audio_path),
            "out_dir": str(out_dir),
            "model": model,
        }, on_progress=on_progress, local=_local)
    return _local()


def separate_local(
    audio_path: str | Path,
    out_dir: Path,
    model: str = "",
    on_progress: ProgressCb = None,
) -> Dict[str, str]:
    """在本机执行分离（worker 进程直接调用这个函数）。"""
    # 定位 audio-separator 命令行：优先 PATH；venv 未激活时（如用 .venv/bin/python
    # 直接启动服务）PATH 里没有 venv/bin，退回到与当前 Python 同目录的可执行文件。
    separator_cli = shutil.which("audio-separator")
    if separator_cli is None:
        cand = Path(sys.executable).parent / "audio-separator"
        separator_cli = str(cand) if cand.exists() else None
    if separator_cli is None:
        raise RuntimeError(
            "未找到 audio-separator，请先安装 ML 依赖：\n"
            "  pip install -r requirements-ml.txt\n"
            "（Apple Silicon 使用 `pip install \"audio-separator[cpu]\"`，会自动启用 CoreML 加速）"
        )

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    names = {"Vocals": "vocals", "Instrumental": "instrumental"}
    cmd = [
        separator_cli,
        str(audio_path),
        "--output_dir", str(out_dir),
        "--output_format", config.SEPARATOR_OUTPUT_FORMAT,
        "--custom_output_names", json.dumps(names),
    ]
    if model:
        cmd += ["--model_filename", model]
    # 模型放哪。不指定的话 audio-separator 默认写 /tmp，有些系统重启就清空，
    # 于是每次都要重新下几百 MB 的模型。
    if config.MODELS_DIR:
        cmd += ["--model_file_dir", str(Path(config.MODELS_DIR) / "audio-separator")]
    # 低内存机器可通过减小段大小降低峰值内存（对 MDX 模型生效）。
    if config.SEPARATOR_SEGMENT_SIZE:
        cmd += ["--mdx_segment_size", config.SEPARATOR_SEGMENT_SIZE]

    if on_progress:
        on_progress(0, "正在加载分离模型（首次会自动下载模型文件，可能较慢）…")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=config.ca_env(),
    )
    assert proc.stdout is not None

    # 超时保护：内存不足的机器上分离可能卡死，超时后中止，避免任务永久挂起。
    timed_out = {"flag": False}

    def _kill_on_timeout() -> None:
        timed_out["flag"] = True
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass

    timer = threading.Timer(config.SEPARATOR_TIMEOUT, _kill_on_timeout)
    timer.daemon = True
    timer.start()

    last_line = ""
    try:
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            last_line = line
            if on_progress:
                m = _PCT_RE.search(line)
                if m:
                    pct = max(0, min(100, int(m.group(1))))
                    on_progress(pct, "正在分离人声与伴奏…")
        code = proc.wait()
    finally:
        timer.cancel()

    if timed_out["flag"]:
        raise RuntimeError(
            f"人声分离超时（超过 {config.SEPARATOR_TIMEOUT // 60} 分钟）。"
            "多见于内存较小的机器（如 8GB）：请先关闭浏览器等占内存的程序后重试，"
            "或减小 OPENK_SEPARATOR_SEGMENT_SIZE（如 128），也可换更小的模型。"
        )
    if code != 0:
        raise RuntimeError(f"人声分离失败（退出码 {code}）：{last_line}")

    vocals = _resolve_stem(out_dir, "vocals")
    instrumental = _resolve_stem(out_dir, "instrumental")
    if vocals is None or instrumental is None:
        raise RuntimeError("分离完成但未找到 vocals / instrumental 输出文件")

    if on_progress:
        on_progress(100, "人声分离完成")

    return {"vocals": vocals.name, "instrumental": instrumental.name}
