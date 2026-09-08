#!/usr/bin/env python3
"""兼容入口；推荐 python -m tools demo seed，使用有效的 12 位任务 ID。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import config  # noqa: E402
from tools.demo import main  # noqa: E402

DEMO_DIR = config.JOBS_DIR / "000000000001"
STEMS_DIR = DEMO_DIR / "stems"


if __name__ == "__main__":
    raise SystemExit(main())
