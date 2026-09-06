"""运行全部独立回归脚本，隔离任务目录，并保留失败输出。"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    tests = [(sys.executable, path) for path in sorted(ROOT.glob("test_*.py"))]
    js_tests = sorted(ROOT.glob("test_*.js"), key=lambda path: (path.name == "test_browser.js", path.name))
    tests.extend(("node", path) for path in js_tests)
    failures = []
    started = time.monotonic()
    base_env = {key: value for key, value in os.environ.items() if not key.startswith("OPENK_")}
    base_env["PYTHONDONTWRITEBYTECODE"] = "1"
    base_env["OPENK_TEST_PYTHON"] = sys.executable
    if os.environ.get("OPENK_TEST_CHROME"):
        base_env["OPENK_TEST_CHROME"] = os.environ["OPENK_TEST_CHROME"]
    if os.environ.get("OPENK_TEST_ARTIFACTS"):
        base_env["OPENK_TEST_ARTIFACTS"] = os.environ["OPENK_TEST_ARTIFACTS"]
    for executable, path in tests:
        tick = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="openk-suite-") as directory:
            env = dict(base_env, TMPDIR=directory, OPENK_DATA_DIR=directory,
                       OPENK_JOBS_DIR=str(Path(directory) / "jobs"))
            try:
                result = subprocess.run(
                    [executable, str(path)], cwd=ROOT, env=env,
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                failures.append(path.name)
                print(f"FAIL {path.name}: {exc}", flush=True)
                continue
        # 缺依赖时旧脚本会以 0 退出；完整回归不能把这种跳过算成通过。
        skipped = any("SKIP " in line or "跳过：未安装" in line for line in result.stdout.splitlines())
        ok = result.returncode == 0 and not skipped
        print(f"{'PASS' if ok else 'FAIL'} {path.name} ({time.monotonic() - tick:.1f}s)", flush=True)
        if not ok:
            failures.append(path.name)
            print(result.stdout, flush=True)
    print(f"\n{len(tests) - len(failures)}/{len(tests)} suites passed "
          f"in {time.monotonic() - started:.1f}s", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
