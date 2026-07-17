#!/usr/bin/env bash
# openk 启动脚本
set -euo pipefail
cd "$(dirname "$0")"

# 若存在虚拟环境则自动激活
if [ -d ".venv" ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# 检查 ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "⚠️  未检测到 ffmpeg，人声分离与音频处理需要它。"
  echo "    macOS 安装： brew install ffmpeg"
fi

# 检查 Deno（YouTube 下载所需的 JS runtime）
if ! command -v deno >/dev/null 2>&1; then
  echo "⚠️  未检测到 Deno（YouTube 提取所需的 JS runtime，缺失可能导致 403）。"
  echo "    macOS 安装： brew install deno"
fi

HOST="${OPENK_HOST:-127.0.0.1}"
PORT="${OPENK_PORT:-8000}"
echo "🎤 openk 启动中： http://${HOST}:${PORT}"
exec python -m backend.main
