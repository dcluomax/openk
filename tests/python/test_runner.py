"""Grouped discovery, selectors and independent-suite isolation regressions."""
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

from scripts import run_tests as runner


class RunnerTests(unittest.TestCase):
    def setUp(self):
        artifacts = PROJECT_ROOT / ".test-artifacts"
        artifacts.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="runner-regression-", dir=artifacts)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.tests = [
            (sys.executable, self.root / "tests/python/test_http.py"),
            (sys.executable, self.root / "tests/python/test_search.py"),
            ("node", self.root / "tests/frontend/test_search.js"),
            ("node", self.root / "tests/browser/test_browser.js"),
        ]

    def select(self, groups=(), names=()):
        with patch.object(runner, "ROOT", self.root):
            return runner.select_tests(self.tests, list(groups), list(names))

    def run_main(self, args=(), **mock_options):
        output = io.StringIO()
        with patch.object(runner, "ROOT", self.root), \
             patch.object(runner, "discover_tests", return_value=self.tests), \
             patch.object(runner.subprocess, "run", **mock_options) as run, \
             redirect_stdout(output), redirect_stderr(output):
            status = runner.main(list(args))
        return status, output.getvalue(), run

    def test_all_existing_suites_are_grouped_and_browser_is_last(self):
        expected = {
            "python": {
                "config", "dedupe", "http", "job_lifecycle", "local_media", "lyrics",
                "lyrics_layout", "meta", "meta_fix", "operations", "playlist", "processing",
                "publication", "remote", "retry", "rooms", "search", "security", "worker",
            },
            "frontend": {"frontend", "frontend_runtime", "rooms_frontend", "search"},
            "browser": {"browser"},
        }
        tests = runner.discover_tests()
        paths = [path for _, path in tests]
        existing = {
            PROJECT_ROOT / "tests" / group / f"test_{name}.{'py' if group == 'python' else 'js'}"
            for group, names in expected.items() for name in names
        }
        self.assertEqual(len(existing), 24)
        self.assertTrue(existing <= set(paths), existing - set(paths))
        self.assertIn(Path(__file__).resolve(), paths)
        self.assertEqual(len(paths), len(set(paths)))
        self.assertEqual(paths[-1].parent.name, "browser")
        self.assertEqual(list(PROJECT_ROOT.glob("test_*.py")), [])
        self.assertEqual(list(PROJECT_ROOT.glob("test_*.js")), [])

    def test_discovery_uses_group_paths_extensions_and_stable_order(self):
        files = [
            "test_old.py", "tests/python/helper.py", "tests/python/test_wrong.js",
            "tests/frontend/test_wrong.py", "tests/browser/helper.js",
        ]
        files.extend(str(path.relative_to(self.root)) for _, path in reversed(self.tests))
        for relative in files:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        (self.root / "tests/python/test_directory.py").mkdir()
        with patch.object(runner, "ROOT", self.root):
            self.assertEqual(runner.discover_tests(), self.tests)

    def test_no_selectors_selects_all_suites(self):
        self.assertEqual(self.select(), self.tests)

    def test_repeated_groups_are_a_union_in_discovery_order(self):
        self.assertEqual(self.select(groups=["browser", "python", "python"]),
                         [self.tests[0], self.tests[1], self.tests[3]])

    def test_names_distinguish_python_and_javascript(self):
        self.assertEqual(self.select(names=["test_search.js"]), [self.tests[2]])
        self.assertEqual(self.select(names=["test_search.py"]), [self.tests[1]])

    def test_group_and_names_intersect(self):
        self.assertEqual(self.select(groups=["python"], names=["test_http.py"]),
                         [self.tests[0]])
        with self.assertRaisesRegex(ValueError, "test_search.js"):
            self.select(groups=["python"], names=["test_search.js"])

    def test_relative_paths_duplicates_and_browser_last(self):
        self.assertEqual(self.select(names=[
            "test_browser.js", "./tests/frontend/test_search.js", "test_http.py", "test_http.py",
        ]), [self.tests[0], self.tests[2], self.tests[3]])

    def test_group_relative_and_repository_relative_paths(self):
        for prefix in ("", "tests/"):
            with self.subTest(prefix=prefix):
                self.assertEqual(self.select(names=[
                    f"{prefix}browser/test_browser.js", f"./{prefix}frontend/test_search.js",
                    f"{prefix}python/test_http.py", "test_http.py",
                ]), [self.tests[0], self.tests[2], self.tests[3]])

    def test_prefixed_selectors_respect_group_filtering(self):
        for prefix in ("", "tests/"):
            with self.subTest(prefix=prefix):
                self.assertEqual(self.select(groups=["frontend"], names=[
                    f"{prefix}frontend/test_search.js",
                ]), [self.tests[2]])
                with self.assertRaisesRegex(ValueError, "No matching suite"):
                    self.select(groups=["python"], names=[
                        f"{prefix}python/test_http.py", f"{prefix}frontend/test_search.js",
                    ])

    def test_unknown_names_fail_even_alongside_a_valid_name(self):
        for name in ("test_missing.py", "../test_http.py", "python/test_missing.py",
                     "tests/frontend/test_missing.js", "browser/test_search.js"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "No matching suite"):
                self.select(names=["test_http.py", name])

    def test_empty_discovery_and_empty_groups_fail(self):
        with patch.object(runner, "ROOT", self.root):
            for tests, groups, names in (
                ([], [], []), ([], ["python"], []), ([], [], ["test_http.py"]),
                (self.tests[:2], ["browser"], []),
                (self.tests[:2], ["python", "frontend"], []),
            ):
                with self.subTest(groups=groups, names=names), self.assertRaises(ValueError):
                    runner.select_tests(tests, groups, names)

    def test_cli_rejects_invalid_selections_without_running_subprocesses(self):
        for args in (["--group", "missing"], ["test_missing.py"],
                     ["--group", "python", "test_search.js"],
                     ["--group", "python", "python/test_http.py", "frontend/test_search.js"],
                     ["--group", "python", "tests/python/test_http.py", "tests/frontend/test_search.js"]):
            with self.subTest(args=args), patch.object(runner.subprocess, "run") as run, \
                 redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                runner.main(args)
            self.assertEqual(error.exception.code, 2)
            run.assert_not_called()

    def test_run_all_preserves_environment_isolation_cleanup_and_timeout(self):
        environments = []

        def execute(command, **kwargs):
            env = kwargs["env"]
            environments.append(env)
            directory = Path(env["OPENK_DATA_DIR"])
            self.assertTrue(directory.is_dir())
            self.assertTrue(directory.is_relative_to(self.root))
            self.assertEqual(env["TMPDIR"], str(directory))
            self.assertEqual(env["OPENK_JOBS_DIR"], str(directory / "jobs"))
            self.assertEqual(env["OPENK_TEST_PYTHON"], sys.executable)
            self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
            self.assertEqual(env["OPENK_TEST_CHROME"], "custom-chrome")
            self.assertEqual(env["OPENK_TEST_ARTIFACTS"], str(self.root / "screenshots"))
            self.assertEqual(env["KEEP_ME"], "unchanged")
            self.assertNotIn("OPENK_REMOTE_STEPS", env)
            self.assertNotIn("OPENK_PORT", env)
            self.assertEqual(kwargs["cwd"], self.root)
            self.assertEqual(kwargs["timeout"], 240)
            self.assertTrue(kwargs["text"])
            self.assertEqual(kwargs["stdout"], subprocess.PIPE)
            self.assertEqual(kwargs["stderr"], subprocess.STDOUT)
            return subprocess.CompletedProcess(command, 0, "checks passed\n")

        environment = {
            "KEEP_ME": "unchanged", "OPENK_REMOTE_STEPS": "must-not-leak",
            "OPENK_PORT": "12345", "OPENK_TEST_PYTHON": "must-not-leak",
            "OPENK_DATA_DIR": "must-not-leak", "OPENK_JOBS_DIR": "must-not-leak",
            "OPENK_TEST_CHROME": "custom-chrome",
            "OPENK_TEST_ARTIFACTS": str(self.root / "screenshots"),
        }
        with patch.dict(os.environ, environment, clear=True):
            status, output, run = self.run_main(side_effect=execute)
            self.assertEqual(dict(os.environ), environment)
        self.assertEqual(status, 0, output)
        self.assertIn("4/4 suites passed", output)
        self.assertIn("PASS tests/frontend/test_search.js", output)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [[executable, str(path)] for executable, path in self.tests])
        directories = [env["TMPDIR"] for env in environments]
        self.assertEqual(len(set(directories)), 4)
        self.assertTrue(all(not Path(directory).exists() for directory in directories))

    def test_cli_selects_groups_and_names_without_running_other_suites(self):
        status, output, run = self.run_main(
            ["--group", "frontend", "--group", "python", "test_search.js"],
            return_value=subprocess.CompletedProcess([], 0, "passed\n"))
        self.assertEqual(status, 0, output)
        self.assertIn("1/1 suites passed", output)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ["node", str(self.tests[2][1])])

    def test_cli_accepts_group_options_between_test_names(self):
        status, output, run = self.run_main(
            ["test_browser.js", "--group", "browser", "test_http.py", "--group", "python"],
            return_value=subprocess.CompletedProcess([], 0, "passed\n"))
        self.assertEqual(status, 0, output)
        self.assertIn("2/2 suites passed", output)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [[executable, str(path)] for executable, path in (self.tests[0], self.tests[3])])

    def test_cli_accepts_both_relative_path_prefixes(self):
        status, output, run = self.run_main(
            ["python/test_http.py", "tests/frontend/test_search.js"],
            return_value=subprocess.CompletedProcess([], 0, "passed\n"))
        self.assertEqual(status, 0, output)
        self.assertIn("2/2 suites passed", output)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [[executable, str(path)] for executable, path in self.tests[::2]])

    def test_failure_and_skip_output_never_count_as_success(self):
        for code, text in ((1, "assertion failed"), (0, "SKIP missing dependency"),
                           (0, "跳过：未安装依赖")):
            with self.subTest(code=code, text=text):
                status, output, _ = self.run_main(
                    ["test_http.py"], return_value=subprocess.CompletedProcess([], code, text))
                self.assertEqual(status, 1)
                self.assertIn("0/1 suites passed", output)
                self.assertIn(text, output)

    def test_timeouts_and_missing_executables_fail_but_remaining_suites_run(self):
        status, output, run = self.run_main(side_effect=[
            subprocess.TimeoutExpired(["python"], 240, output=b"partial failure output"),
            OSError("missing executable"),
            subprocess.CompletedProcess([], 0, "passed"),
            subprocess.CompletedProcess([], 0, "passed"),
        ])
        self.assertEqual(status, 1)
        self.assertIn("2/4 suites passed", output)
        self.assertIn("partial failure output", output)
        self.assertIn("missing executable", output)
        self.assertEqual(run.call_count, 4)
        self.assertTrue(all(not Path(call.kwargs["env"]["TMPDIR"]).exists()
                            for call in run.call_args_list))

    def test_real_subprocesses_have_independent_workspaces(self):
        script = '''
import os
from pathlib import Path
data = Path(os.environ["OPENK_DATA_DIR"])
assert data == Path(os.environ["TMPDIR"])
assert data.is_dir()
assert not (data / "sentinel").exists()
(data / "sentinel").write_text("isolated")
assert "OPENK_REMOTE_STEPS" not in os.environ
assert os.environ["OPENK_TEST_PYTHON"] == __import__("sys").executable
'''
        for _, path in self.tests[:2]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(script)
        output = io.StringIO()
        with patch.object(runner, "ROOT", self.root), \
             patch.dict(os.environ, {"OPENK_REMOTE_STEPS": "must-not-leak"}), \
             redirect_stdout(output):
            status = runner.main([])
        self.assertEqual(status, 0, output.getvalue())
        self.assertIn("2/2 suites passed", output.getvalue())
        self.assertEqual(list((self.root / ".test-artifacts/suites").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
