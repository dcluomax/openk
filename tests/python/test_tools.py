"""Maintenance entrypoints, safe previews, and current artifact layout."""
from __future__ import annotations

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools import __main__ as cli
from tools.demo import create, create_jobs
from tools.job_files import artifact_path, load_job


def snapshot(root: Path) -> dict[str, bytes]:
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


class CommandTests(unittest.TestCase):
    def test_category_help_does_not_import_implementations(self):
        with patch.object(cli.importlib, "import_module") as imported:
            with contextlib.redirect_stdout(io.StringIO()):
                for args in ([], ["library"], ["lyrics"], ["setup"], ["demo"]):
                    self.assertEqual(cli.main(args), 0)
            imported.assert_not_called()

    def test_forwarding_preserves_arguments_exit_code_and_process_argv(self):
        original = sys.argv
        seen = []

        def invoke():
            seen.extend(sys.argv[1:])
            return 7

        with patch.object(cli.importlib, "import_module",
                          return_value=SimpleNamespace(main=invoke)) as imported:
            self.assertEqual(cli.main(["library", "rename", "--limit", "3"]), 7)
            imported.assert_called_once_with("tools.rename_files")
        self.assertEqual(seen, ["--limit", "3"])
        self.assertIs(sys.argv, original)

    def test_all_command_and_legacy_help_leave_data_untouched(self):
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            env = {key: value for key, value in os.environ.items() if not key.startswith("OPENK_")}
            env.update(OPENK_DATA_DIR=str(root / "data"), OPENK_JOBS_DIR=str(root / "jobs"),
                       OPENK_CERTS_DIR=str(root / "certs"), PYTHONPATH=str(ROOT))
            commands = [["-m", "tools", group, command, "--help"]
                        for group, (_, commands) in cli.GROUPS.items() for command in commands]
            commands += [[str(ROOT / "scripts" / name), "--help"] for name in
                         ("make_cert.py", "seed_demo.py", "test_fixtures.py", "upgrade_word_align.py")]
            for command in commands:
                with self.subTest(command=command):
                    result = subprocess.run([sys.executable, *command], cwd=root, env=env,
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("usage:", result.stdout)
                    self.assertEqual(list(root.iterdir()), [])

    def test_unknown_commands_and_arguments_fail(self):
        for args in (["unknown"], ["library", "unknown"], ["--unknown"], ["lyrics", "--unknown"]):
            with self.subTest(args=args), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    cli.main(args)
                self.assertEqual(raised.exception.code, 2)

    def test_certificate_dependency_error_does_not_create_output(self):
        from tools import certificates

        with tempfile.TemporaryDirectory() as workspace:
            directory = Path(workspace) / "certs"
            errors = io.StringIO()
            with patch.object(certificates.config, "CERTS_DIR", directory), \
                    patch.dict(sys.modules, {"cryptography": None}), \
                    contextlib.redirect_stderr(errors):
                self.assertEqual(certificates.main(["localhost"]), 1)
            self.assertFalse(directory.exists())
            self.assertIn("pip install cryptography", errors.getvalue())


class DemoTests(unittest.TestCase):
    def test_shared_fixture_uses_valid_job_ids_and_word_schema(self):
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            create(root)
            self.assertEqual(sorted(path.name for path in (root / "jobs").iterdir()),
                             ["000000000001", "000000000002"])
            for folder in (root / "jobs").iterdir():
                directory, job = load_job(root / "jobs", folder.name)
                data = json.loads(artifact_path(directory, job["lyrics_file"]).read_text())
                self.assertTrue(all(word["text"] for line in data["lines"] for word in line["words"]))
                self.assertTrue(artifact_path(directory, job["stems"]["vocals"], subdir="stems").is_file())

    def test_collision_preflight_does_not_create_first_job_or_overwrite_recordings(self):
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            existing = root / "000000000002"
            existing.mkdir()
            (existing / "recording.webm").write_bytes(b"preserve")
            before = snapshot(root)
            with self.assertRaises(FileExistsError):
                create_jobs(root)
            self.assertEqual(snapshot(root), before)
            self.assertFalse((root / "000000000001").exists())

    def test_seed_respects_separate_jobs_directory(self):
        from tools import demo
        from backend import config

        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            with patch.object(config, "DATA_DIR", root / "data"), \
                    patch.object(config, "JOBS_DIR", root / "separate"), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(demo.main([]), 0)
            self.assertFalse((root / "data").exists())
            self.assertTrue((root / "separate" / "000000000001" / "status.json").is_file())


class LyricsToolsTests(unittest.TestCase):
    def setUp(self):
        from backend import config

        workspace = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(workspace)
        self.jobs = self.root / "jobs"
        self.enterContext(patch.object(config, "DATA_DIR", self.root))
        self.enterContext(patch.object(config, "JOBS_DIR", self.jobs))
        create_jobs(self.jobs)
        from backend import jobs
        from backend.steps import transcribe
        from tools import align_lyrics, resplit_lyrics

        self.manager = jobs.JobManager(self.jobs)
        self.enterContext(patch.object(jobs, "manager", self.manager))
        self.align = align_lyrics
        self.resplit = resplit_lyrics
        self.transcribe = transcribe
        self.job_id = "000000000001"
        self.directory = self.jobs / self.job_id
        self.lyrics = {"language": "zh", "source": "synthetic", "lines": [{
            "start": 1, "end": 5, "text": "abcdefgh",
            "words": [{"start": 1 + index * .5, "end": 1.5 + index * .5, "text": char}
                      for index, char in enumerate("abcdefgh")],
        }]}
        self.lyrics_path = self.directory / ".openk-results" / "old" / "lyrics.json"
        self.lyrics_path.parent.mkdir(parents=True)
        self.lyrics_path.write_text(json.dumps(self.lyrics))
        self.vocals = self.directory / "stems" / ".openk-results" / "old" / "vocals.wav"
        self.vocals.parent.mkdir(parents=True)
        (self.directory / "stems" / "vocals.wav").rename(self.vocals)
        self.manager.update(self.job_id, lyrics_file=".openk-results/old/lyrics.json",
                            stems={"vocals": ".openk-results/old/vocals.wav",
                                   "instrumental": "instrumental.wav"},
                            line_count=1, lyrics_source="synthetic")
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))

    def test_paths_reject_escape_and_symlinks(self):
        for reference in ("../lyrics.json", "/tmp/lyrics.json", "bad\\path", "\0", ""):
            with self.subTest(reference=reference), self.assertRaises(ValueError):
                artifact_path(self.directory, reference)
        link = self.directory / "linked.json"
        link.symlink_to(self.lyrics_path)
        with self.assertRaises(ValueError):
            artifact_path(self.directory, "linked.json")
        with self.assertRaises(ValueError):
            load_job(self.jobs, "../jobs")

    def test_resplit_preview_and_publication_preserve_original_and_words(self):
        before = snapshot(self.root)
        self.assertEqual(self.resplit.main(["--max-width", "6"]), 0)
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual(self.resplit.main(["--max-width", "6", "--apply"]), 0)
        job = self.manager.get(self.job_id)
        self.assertNotEqual(job["lyrics_file"], ".openk-results/old/lyrics.json")
        self.assertEqual(self.lyrics_path.read_bytes(), before[str(self.lyrics_path.relative_to(self.root))])
        updated = json.loads(artifact_path(self.directory, job["lyrics_file"]).read_text())
        self.assertEqual([word for line in updated["lines"] for word in line["words"]],
                         self.lyrics["lines"][0]["words"])
        self.assertEqual(job["line_count"], len(updated["lines"]))
        self.assertTrue(artifact_path(self.directory, job["lrc_file"]).is_file())
        self.assertFalse(list(self.directory.glob(".resplit-*")))

    def test_invalid_lyrics_are_reported_as_failure(self):
        self.lyrics_path.write_text("[]")
        self.assertEqual(self.resplit.main([]), 1)

    def test_alignment_preview_never_runs_ml_or_changes_files(self):
        before = snapshot(self.root)
        with patch.object(self.transcribe, "align_known_lyrics_local") as local:
            self.assertEqual(self.align.main([self.job_id, "--force"]), 0)
            local.assert_not_called()
        self.assertEqual(snapshot(self.root), before)

    def test_alignment_requires_explicit_offline_confirmation(self):
        before = snapshot(self.root)
        with self.assertRaises(SystemExit) as raised:
            self.align.main([self.job_id, "--apply"])
        self.assertEqual(raised.exception.code, 2)
        self.assertEqual(snapshot(self.root), before)

    def test_alignment_uses_local_ml_and_publishes_nested_artifacts(self):
        def aligned(vocals, lines, language, output, source, on_progress):
            self.assertEqual(vocals, self.vocals)
            self.assertEqual(lines, self.lyrics["lines"])
            return self.transcribe._write_lyrics(copy.deepcopy(self.lyrics), source, output)

        old = self.lyrics_path.read_bytes()
        with patch.object(self.transcribe, "align_known_lyrics_local", side_effect=aligned) as local, \
                patch.object(self.transcribe, "align_known_lyrics") as remote:
            self.assertEqual(self.align.main([self.job_id, "--force", "--apply", "--offline"]), 0)
            local.assert_called_once()
            remote.assert_not_called()
        job = self.manager.get(self.job_id)
        self.assertNotEqual(job["lyrics_file"], ".openk-results/old/lyrics.json")
        self.assertTrue(artifact_path(self.directory, job["lrc_file"]).is_file())
        self.assertEqual(self.lyrics_path.read_bytes(), old)
        self.assertFalse(list(self.directory.glob(".word-align-*")))

    def test_unavailable_alignment_does_not_publish_line_only_fallback(self):
        def unavailable(vocals, lines, language, output, source, on_progress):
            return self.transcribe.save_line_lyrics(lines, language, source, output)

        before = snapshot(self.root)
        with patch.object(self.transcribe, "align_known_lyrics_local", side_effect=unavailable):
            self.assertEqual(self.align.main([self.job_id, "--force", "--apply", "--offline"]), 1)
        self.assertEqual(snapshot(self.root), before)

    def test_dedupe_measures_registered_nested_wav_in_separate_jobs_directory(self):
        from tools import dedupe

        instrumental = self.directory / "stems" / ".openk-results" / "old" / "instrumental.wav"
        (self.directory / "stems" / "instrumental.wav").rename(instrumental)
        job = self.manager.get(self.job_id)
        job["stems"]["instrumental"] = ".openk-results/old/instrumental.wav"
        metrics = {"cutoff_khz": 16, "hf_db": -20, "clip_pct": 0}
        cache = {}
        with patch.object(dedupe, "JOBS", self.jobs), \
                patch.object(dedupe, "analyse", return_value=metrics) as analyse:
            measured = dedupe.measure(job, cache)
            self.assertEqual(measured["m"], metrics)
            self.assertIsNone(measured["error"])
            analyse.assert_called_once_with(str(instrumental), job["duration"])
            dedupe.measure(job, cache)
            analyse.assert_called_once()

    def test_dedupe_keeps_entire_group_when_quality_cannot_be_compared(self):
        from tools import dedupe

        first = self.manager.get(self.job_id)
        second = self.manager.get("000000000002")
        first["stems"]["instrumental"] = ".openk-results/missing/instrumental.wav"
        for job in (first, second):
            job.update(artist="Synthetic", track="Duplicate")
        before = snapshot(self.root)
        with patch.object(dedupe, "JOBS", self.jobs), \
                patch.object(dedupe, "load_jobs", return_value=[first, second]), \
                patch.object(dedupe, "load_cache", return_value={}), \
                patch.object(dedupe, "save_cache"), \
                patch.object(dedupe, "analyse", return_value={"cutoff_khz": 16, "hf_db": -20, "clip_pct": 0}), \
                patch.object(dedupe, "stash_source") as stash, \
                patch.object(dedupe, "delete_job") as delete, \
                patch.object(sys, "argv", ["dedupe", "--apply"]):
            self.assertEqual(dedupe.main(), 1)
            stash.assert_not_called()
            delete.assert_not_called()
        self.assertEqual(snapshot(self.root), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
