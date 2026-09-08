"""测试夹具兼容入口；合成逻辑统一位于 tools.demo。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.demo import create, create_cover, main as _main  # noqa: E402,F401


def main(argv=None):
    return _main(argv, require_directory=True)


if __name__ == "__main__":
    raise SystemExit(main())
