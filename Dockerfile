# syntax=docker/dockerfile:1

# openk —— 把 YouTube 变成卡拉OK。镜像自带 ffmpeg / Deno / Python 与全部 ML 依赖，开箱即用。
FROM python:3.12-slim

# 系统依赖：ffmpeg（音视频处理）、libsndfile/libgomp（音频与 onnxruntime/torch 运行库）、curl（健康检查）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates libsndfile1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Deno：yt-dlp 提取 YouTube 所需的 JS runtime（从官方多架构镜像拷贝二进制）
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app

# Python 依赖分层安装（利于缓存）。
# 少数依赖（如 demucs 的 diffq）无预编译轮子、需现场编译，故临时装 build-essential，装完即卸以缩小镜像。
# torch 在 x86_64 上走 CPU 专用源，避免拉入巨大的 CUDA 版本；arm64 的 PyPI 轮子本就是 CPU 版。
ARG TARGETARCH
COPY requirements.txt requirements-ml.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
 && python -m pip install --no-cache-dir -U pip \
 && if [ "$TARGETARCH" = "amd64" ]; then \
      pip install --no-cache-dir torch torchaudio --index-url https://download.pytorch.org/whl/cpu ; \
    else \
      pip install --no-cache-dir torch torchaudio ; \
    fi \
 && pip install --no-cache-dir -r requirements.txt \
 && pip install --no-cache-dir -U --pre "yt-dlp[default]" \
 && pip install --no-cache-dir -r requirements-ml.txt \
 && apt-get purge -y --auto-remove build-essential \
 && rm -rf /var/lib/apt/lists/*

# 应用代码
COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY scripts/ ./scripts/
COPY run.sh README.md ./

# 容器内监听 0.0.0.0；数据与模型缓存统一放到 /data（挂载卷即可持久化，避免每次重下模型）
ENV OPENK_HOST=0.0.0.0 \
    OPENK_PORT=8000 \
    OPENK_DATA_DIR=/data \
    XDG_CACHE_HOME=/data/cache \
    HF_HOME=/data/cache/huggingface \
    TORCH_HOME=/data/cache/torch \
    NLTK_DATA=/data/cache/nltk_data \
    PYTHONUNBUFFERED=1

RUN mkdir -p /data/cache
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/jobs >/dev/null || exit 1

CMD ["python", "-m", "backend.main"]
