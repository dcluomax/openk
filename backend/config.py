"""全局配置。所有值均可通过环境变量覆盖，方便部署时调整。"""
from __future__ import annotations

import os
from pathlib import Path

# --- 目录 ---
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("OPENK_DATA_DIR", BASE_DIR / "data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"
FRONTEND_DIR = BASE_DIR / "frontend"

# --- 人声分离 (audio-separator / UVR 模型) ---
# 默认用 MDX-Net（onnxruntime/CoreML），比 BS-Roformer 更省内存、在低配机器上更稳。
# 内存充足（16GB+）且追求最高质量可设为 "" 使用 audio-separator 默认的 Roformer。
SEPARATOR_MODEL = os.environ.get("OPENK_SEPARATOR_MODEL", "UVR-MDX-NET-Inst_HQ_3.onnx").strip()
SEPARATOR_OUTPUT_FORMAT = os.environ.get("OPENK_SEPARATOR_FORMAT", "MP3").strip()
# 低内存机器可减小段大小以降低峰值内存（对 MDX 模型），留空用模型默认。
SEPARATOR_SEGMENT_SIZE = os.environ.get("OPENK_SEPARATOR_SEGMENT_SIZE", "").strip()
# 分离超时（秒）。超时后中止并报错，避免在内存不足时无限卡住。
SEPARATOR_TIMEOUT = int(os.environ.get("OPENK_SEPARATOR_TIMEOUT", "1200"))

# --- 歌词识别与对齐 (whisperX) ---
# 模型越大越准但越慢：tiny / base / small / medium / large-v2 / large-v3
WHISPER_MODEL = os.environ.get("OPENK_WHISPER_MODEL", "small").strip()
# 在 Apple Silicon / 无 NVIDIA 显卡的机器上使用 cpu + int8。
WHISPER_DEVICE = os.environ.get("OPENK_WHISPER_DEVICE", "cpu").strip()
WHISPER_COMPUTE_TYPE = os.environ.get("OPENK_WHISPER_COMPUTE_TYPE", "int8").strip()
# 留空表示自动检测语言（支持中文 zh、英文 en 等）。
WHISPER_LANGUAGE = os.environ.get("OPENK_WHISPER_LANGUAGE", "").strip()
WHISPER_BATCH_SIZE = os.environ.get("OPENK_WHISPER_BATCH_SIZE", "4").strip()

# --- 下载 ---
# 可选：cookies.txt 路径，用于绕过 YouTube "确认你不是机器人" 校验。
# 生成方式：yt-dlp --cookies cookies.txt --cookies-from-browser chrome
COOKIEFILE = os.environ.get("OPENK_COOKIEFILE", "").strip() or None

# 单曲时长上限（秒）。超过则判定不是单曲（多为混音/合辑/播客），提前结束以省算力。
# 默认 7 分钟；设为 0 可关闭该限制。
MAX_SONG_SECONDS = int(os.environ.get("OPENK_MAX_SONG_SECONDS", str(7 * 60)))

# 分离完成后是否保留原始下载音频。默认删除以节省磁盘（已按视频去重，不会重复分离）。
KEEP_SOURCE = os.environ.get("OPENK_KEEP_SOURCE", "false").strip().lower() in {"1", "true", "yes", "on"}

# --- 服务 ---
HOST = os.environ.get("OPENK_HOST", "127.0.0.1")
PORT = int(os.environ.get("OPENK_PORT", "8000"))

# 同时运行的处理任务数（人声分离与转写很吃 CPU，默认串行执行）。
MAX_WORKERS = int(os.environ.get("OPENK_MAX_WORKERS", "1"))


def ensure_dirs() -> None:
    """确保运行所需目录存在。"""
    JOBS_DIR.mkdir(parents=True, exist_ok=True)


def ca_env() -> dict:
    """返回注入了 certifi CA 证书路径的子进程环境变量。

    修复 macOS 自带 Python 在子进程里用 urllib / torch.hub 下载模型时的
    ``SSL: CERTIFICATE_VERIFY_FAILED``（whisperx 下载 VAD/对齐模型、audio-separator
    下载分离模型都会走到）。
    """
    env = dict(os.environ)
    try:
        import certifi
        ca = certifi.where()
        env["SSL_CERT_FILE"] = ca
        env["REQUESTS_CA_BUNDLE"] = ca
    except Exception:  # noqa: BLE001
        pass
    return env
