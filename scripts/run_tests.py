"""按 Python、前端和真实浏览器分组运行独立回归脚本，默认运行全部。"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GROUPS = {
    "python": ("test_*.py", sys.executable),
    "frontend": ("test_*.js", "node"),
    "browser": ("test_*.js", "node"),
}


def discover_tests() -> list[tuple[str, Path]]:
    return [
        (executable, path)
        for group, (pattern, executable) in GROUPS.items()
        for path in sorted((ROOT / "tests" / group).glob(pattern))
        if path.is_file()
    ]


def select_tests(tests: list[tuple[str, Path]], groups: list[str],
                 names: list[str]) -> list[tuple[str, Path]]:
    for group in groups:
        if not any(path.parent.name == group for _, path in tests):
            raise ValueError(f"No suites found in group: {group}")
    candidates = [(executable, path) for executable, path in tests
                  if not groups or path.parent.name in groups]
    selected = set()
    for name in names:
        selector = Path(name).as_posix()
        matches = {path for _, path in candidates
                   if selector in (path.name, path.relative_to(ROOT / "tests").as_posix(),
                                   path.relative_to(ROOT).as_posix())}
        if not matches:
            raise ValueError(f"No matching suite in selected groups: {name}")
        selected.update(matches)
    result = [(executable, path) for executable, path in candidates
              if not names or path in selected]
    if not result:
        raise ValueError("No test suites found")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group", action="append", choices=GROUPS, default=[],
                        help="只运行指定分组；可重复，与测试名一起使用时取交集")
    parser.add_argument("tests", nargs="*", metavar="TEST",
                        help="测试文件名、分组相对路径或项目相对路径，例如 "
                             "test_http.py、frontend/test_search.js、tests/python/test_search.py")
    args = parser.parse_intermixed_args(argv)
    try:
        tests = select_tests(discover_tests(), args.group, args.tests)
    except ValueError as exc:
        parser.error(str(exc))
    failures = []
    started = time.monotonic()
    base_env = {key: value for key, value in os.environ.items() if not key.startswith("OPENK_")}
    base_env["PYTHONDONTWRITEBYTECODE"] = "1"
    base_env["OPENK_TEST_PYTHON"] = sys.executable
    if os.environ.get("OPENK_TEST_CHROME"):
        base_env["OPENK_TEST_CHROME"] = os.environ["OPENK_TEST_CHROME"]
    if os.environ.get("OPENK_TEST_ARTIFACTS"):
        base_env["OPENK_TEST_ARTIFACTS"] = os.environ["OPENK_TEST_ARTIFACTS"]
    scratch = ROOT / ".test-artifacts" / "suites"
    scratch.mkdir(parents=True, exist_ok=True)
    for executable, path in tests:
        label = path.relative_to(ROOT).as_posix()
        tick = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="openk-suite-", dir=scratch) as directory:
            env = dict(base_env, TMPDIR=directory, OPENK_DATA_DIR=directory,
                       OPENK_JOBS_DIR=str(Path(directory) / "jobs"))
            try:
                result = subprocess.run(
                    [executable, str(path)], cwd=ROOT, env=env,
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                failures.append(label)
                print(f"FAIL {label}: {exc}", flush=True)
                if isinstance(exc, subprocess.TimeoutExpired) and exc.output:
                    output = (exc.output.decode(errors="replace")
                              if isinstance(exc.output, bytes) else exc.output)
                    print(output, flush=True)
                continue
        # 缺依赖时旧脚本会以 0 退出；完整回归不能把这种跳过算成通过。
        skipped = any("SKIP " in line or "跳过：未安装" in line for line in result.stdout.splitlines())
        ok = result.returncode == 0 and not skipped
        print(f"{'PASS' if ok else 'FAIL'} {label} ({time.monotonic() - tick:.1f}s)", flush=True)
        if not ok:
            failures.append(label)
            print(result.stdout, flush=True)
    print(f"\n{len(tests) - len(failures)}/{len(tests)} suites passed "
          f"in {time.monotonic() - started:.1f}s", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
