"""兼容入口；推荐 python -m tools lyrics align JOB_ID --apply --offline。

旧入口现在也先预览，避免检查脚本时意外运行模型或改写曲库。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.align_lyrics import main as _main  # noqa: E402


def main(job_id=None):
    return _main([job_id] if job_id is not None else None)


if __name__ == "__main__":
    raise SystemExit(main())
