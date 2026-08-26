"""全局配置。所有值均可通过环境变量覆盖，方便部署时调整。"""
from __future__ import annotations

import os
from pathlib import Path

# --- 目录 ---
# 除 BASE_DIR 外都可以单独指向别处：把体积大的任务数据放 NAS、模型放本地 SSD，
# 是分布式部署里很常见的搭配，所以它们不强制挤在同一个 DATA_DIR 下面。
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("OPENK_DATA_DIR", BASE_DIR / "data")).resolve()
# 每首歌的音频、分离结果、歌词和录音都在这里，是占空间的大头。
JOBS_DIR = Path(os.environ.get("OPENK_JOBS_DIR", DATA_DIR / "jobs")).resolve()
# HTTPS 自签证书（scripts/make_cert.py 的输出位置）。
CERTS_DIR = Path(os.environ.get("OPENK_CERTS_DIR", DATA_DIR / "certs")).resolve()
FRONTEND_DIR = Path(os.environ.get("OPENK_FRONTEND_DIR", BASE_DIR / "frontend")).resolve()

# 分离 / 对齐模型的缓存目录。留空＝各库自己的默认位置。
# 值得单独配的原因：audio-separator 默认把模型放 /tmp，有些系统重启就清空，
# 每次都要重新下几百 MB；whisperX 走 HuggingFace 缓存，默认落在 HOME，
# 容器里 HOME 常常不是持久卷。模型总量能到好几 GB，值得放在你选定的位置。
MODELS_DIR = os.environ.get("OPENK_MODELS_DIR", "").strip()
if MODELS_DIR:
    _models = Path(MODELS_DIR).expanduser().resolve()
    MODELS_DIR = str(_models)
    # setdefault：如果用户已经显式设过这些变量，以用户的为准
    os.environ.setdefault("AUDIO_SEPARATOR_MODEL_DIR", str(_models / "audio-separator"))
    os.environ.setdefault("HF_HOME", str(_models / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(_models / "torch"))

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

# --- 歌词时间轴校正 ---
# 歌词库（LRCLIB 等）的时间轴对的是录音室单曲，而我们处理的是 YouTube 视频。
# 官方 MV 常在歌曲前加一段剧情或环境音，两条时间轴就整体错开（有的差好几秒）。
# whisperX 只在给定窗口内部细化词位置，救不回整体偏移，所以对齐前先估一个平移量。
LYRICS_OFFSET_AUTO = os.environ.get(
    "OPENK_LYRICS_OFFSET_AUTO", "true").strip().lower() in {"1", "true", "yes", "on"}
# 搜索范围（秒）。片头再长也很少超过半分钟，范围开太大反而容易被副歌的重复段带偏。
LYRICS_OFFSET_MAX = float(os.environ.get("OPENK_LYRICS_OFFSET_MAX", "30"))
# 死区（秒）：估计值小于它就当作没有偏移，免得给本来就准的歌添乱。
LYRICS_OFFSET_MIN = float(os.environ.get("OPENK_LYRICS_OFFSET_MIN", "0.5"))
# 估偏移时，每行按多长的「正在唱」来画掩码（秒）。歌词库给的 end 常常就是下一行起点，
# 照搬会让整首连成一块、没有句间空档可对齐——而空档恰恰是最有用的信号。1~2.5 秒都稳。
LYRICS_OFFSET_BLOCK = float(os.environ.get("OPENK_LYRICS_OFFSET_BLOCK", "2.0"))
# 送进 whisperX 的窗口左右各留出的余量（秒）。留一点余量，词才不会被窗口边缘夹住。
LYRICS_ALIGN_PAD = float(os.environ.get("OPENK_LYRICS_ALIGN_PAD", "0.35"))
# 单行歌词的最大显示宽度（一个汉字算 2）。Whisper 吐的是「语音段」不是「歌词行」，
# 一段常有四五十个字，点歌台上一行放不下。超过就按演唱停顿切成短句。
# 32 ≈ 16 个汉字，接近商业点歌台的习惯；设成 0 表示不切。
LYRIC_MAX_WIDTH = int(os.environ.get("OPENK_LYRIC_MAX_WIDTH", "32"))

# --- 下载 ---
# 可选：cookies.txt 路径，用于绕过 YouTube "确认你不是机器人" 校验。
# 生成方式：yt-dlp --cookies cookies.txt --cookies-from-browser chrome
COOKIEFILE = os.environ.get("OPENK_COOKIEFILE", "").strip() or None

# 单曲时长上限（秒）。超过则判定不是单曲（多为混音/合辑/播客），提前结束以省算力。
# 默认 7 分钟；设为 0 可关闭该限制。
MAX_SONG_SECONDS = int(os.environ.get("OPENK_MAX_SONG_SECONDS", str(7 * 60)))

# --- 播放列表批量导入 ---
# 一次最多摊平多少首。歌单动辄上百首，而分离+转写是按分钟计的重活，
# 默认给个保守上限，免得误贴一个「全部收藏」把队列堵到明天。
PLAYLIST_MAX_ITEMS = int(os.environ.get("OPENK_PLAYLIST_MAX_ITEMS", "100"))
# 导入前是否按列表里的时长先筛掉超长视频。列表页已经带了时长，
# 在这里筛等于一次下载都不用发；否则要等下载完才在流水线里被 MAX_SONG_SECONDS 拦下。
PLAYLIST_SKIP_LONG = os.environ.get(
    "OPENK_PLAYLIST_SKIP_LONG", "true").strip().lower() in {"1", "true", "yes", "on"}

# --- 本地媒体导入 ---
# 允许从本地磁盘导入媒体文件的白名单目录，用 os.pathsep（Linux/macOS 上是 ":"）分隔。
# **留空＝该功能完全关闭**，相关接口一律 404。
#
# 这是唯一一处让 HTTP 接口接触本地文件系统的地方，所以边界必须由部署者划定：
# 接口收到的路径都会 resolve() 之后检查是不是这些目录的子孙，
# ".." 和指向外部的软链都会被拒。不配置就等于没有这个功能。
LOCAL_MEDIA_DIRS = [
    p.strip() for p in os.environ.get("OPENK_LOCAL_MEDIA_DIRS", "").split(os.pathsep)
    if p.strip()
]
# 一次扫描最多列出多少个文件。
LOCAL_MEDIA_MAX_ITEMS = int(os.environ.get("OPENK_LOCAL_MEDIA_MAX_ITEMS", "1000"))

# --- 重启续跑 ---
# 服务重启时，把还在排队/处理中的任务重新排进队列，而不是标记成失败。
# 批量导入几百首时这条很关键：整批要跑十几个小时，中途任何一次重启
# 都不该把没轮到的任务全部作废。
RESUME_ON_START = os.environ.get(
    "OPENK_RESUME_ON_START", "true").strip().lower() in {"1", "true", "yes", "on"}

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

# HTTPS。浏览器只在「安全上下文」（https 或 localhost）下开放 getUserMedia，
# 所以一旦不是在本机访问——比如手机连到局域网里的这台服务器——录音功能
# 必须走 https，否则 navigator.mediaDevices 直接不存在。
# 用 scripts/make_cert.py 可以生成自签证书。
SSL_CERTFILE = os.environ.get("OPENK_SSL_CERTFILE", "").strip()
SSL_KEYFILE = os.environ.get("OPENK_SSL_KEYFILE", "").strip()

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
