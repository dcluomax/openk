#!/usr/bin/env python3
"""兼容入口；推荐 python -m tools setup cert。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.certificates import build_san, config, local_ips, main  # noqa: E402,F401


if __name__ == "__main__":
    raise SystemExit(main())
