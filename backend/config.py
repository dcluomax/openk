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

# --- 远程算力（把 ML 步骤派发到别的机器）---
# 需要卸载到 worker 的步骤，逗号分隔：separate / transcribe / align。
# 留空＝全部本地执行（默认行为不变）。设成 "separate,transcribe,align" 后，
# 本机就完全不需要 requirements-ml.txt 里的 torch / onnxruntime 了。
REMOTE_STEPS = {
    s.strip() for s in os.environ.get("OPENK_REMOTE_STEPS", "").split(",") if s.strip()
}
# worker 与服务端之间的共享口令（Bearer）。留空则不校验，仅建议在可信内网使用。
WORKER_TOKEN = os.environ.get("OPENK_WORKER_TOKEN", "").strip()
# 租约时长（秒）：worker 领走任务后必须在此时间内上报进度续租，否则任务被回收重排。
WORKER_LEASE_SECONDS = int(os.environ.get("OPENK_WORKER_LEASE_SECONDS", "120"))
# 认定 worker 离线的静默时长（秒），仅用于前端展示与提示文案。
WORKER_OFFLINE_AFTER = int(os.environ.get("OPENK_WORKER_OFFLINE_AFTER", "90"))
# 等待 worker 接手的上限（秒）。0 ＝ 无限等待，即 worker 离线时任务排队而不失败。
REMOTE_WAIT_TIMEOUT = float(os.environ.get("OPENK_REMOTE_WAIT_TIMEOUT", "0"))
# 等待超时后是否退回本机执行（本机若无 ML 依赖会直接报错，故默认关闭）。
REMOTE_FALLBACK_LOCAL = os.environ.get(
    "OPENK_REMOTE_FALLBACK_LOCAL", "false").strip().lower() in {"1", "true", "yes", "on"}

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
