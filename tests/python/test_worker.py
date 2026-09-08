#!/usr/bin/env python3
"""Worker supervision, coalescing and staging checks without loading ML models."""
from __future__ import annotations

import json
import fcntl
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

from worker import openk_worker as worker


def slow_child(task, tmp, out, connection):
    (tmp / "child-pid").write_text(str(os.getpid()))
    time.sleep(30)


def result_child(task, tmp, out, connection):
    (out / "lyrics.json").write_text(json.dumps(
        {"language": "en", "source": "test", "lines": []}))
    (out / "lyrics.lrc").write_text("[re:openk]\n")
    connection.send(("result", {"lyrics_file": "lyrics.json", "language": "en",
                                "source": "test", "line_count": 0}))
    connection.close()


def orphan_child(task, tmp, out, connection):
    os.setsid()
    connection.send(("process_group", os.getpid()))
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    (tmp / "orphan-pid").write_text(str(child.pid))
    connection.send(("error", "failed after starting a descendant"))
    connection.close()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.root = PROJECT_ROOT / (".test-worker-" + uuid.uuid4().hex)
        self.root.mkdir()
        self.task = {"task_id": uuid.uuid4().hex, "claim_token": uuid.uuid4().hex,
                     "kind": "transcribe", "args": {}, "generation": uuid.uuid4().hex,
                     "protocol_version": 2, "lease_seconds": 30}
        stage = self.root / ".remote-staging" / (
            self.task["task_id"] + "-" + self.task["claim_token"])
        stage.mkdir(parents=True)
        self.task["staging_dir"] = str(stage)
        self.out = self.root / "out"
        self.out.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root)

    def hb(self, lease=30):
        return worker.Heartbeat(self.task["task_id"], self.task["claim_token"], lease)

    def test_latest_state_slot_is_nonblocking_and_identical_updates_coalesce(self):
        calls = []
        blocked = threading.Event()
        release = threading.Event()
        def report(*args):
            calls.append(args)
            if len(calls) == 1:
                blocked.set()
                release.wait(2)
            return True
        with patch.object(worker, "report", side_effect=report), \
                patch.object(worker, "HEARTBEAT_EVERY", 0.2), \
                patch.object(worker, "PROGRESS_INTERVAL", 0.05):
            with self.hb() as hb:
                self.assertTrue(blocked.wait(1))
                started = time.monotonic()
                for index in range(10000):
                    hb.update(index % 100, f"line {index}")
                for _ in range(10000):
                    hb.update(42, "latest")
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertEqual(len(calls), 1)
                release.set()
                deadline = time.monotonic() + 1
                while len(calls) < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(calls[1][2:], (42, "latest"))
                self.assertLessEqual(len(calls), 3)

    def test_one_transport_failure_does_not_revoke_lease(self):
        with patch.object(worker, "report", side_effect=[None, True, True, True]), \
                patch.object(worker, "HEARTBEAT_EVERY", 0.05):
            with self.hb(lease=2) as hb:
                time.sleep(0.12)
                hb.check()
                self.assertFalse(hb.lost.is_set())

    def test_explicit_lost_lease_cancels_supervised_process(self):
        hb = self.hb()
        def revoke():
            deadline = time.monotonic() + 3
            while not (self.root / "child-pid").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            hb.lost.set()
        thread = threading.Thread(target=revoke)
        thread.start()
        started = time.monotonic()
        with self.assertRaises(worker.LeaseLost):
            worker._run_supervised(self.task, self.root, self.out, hb, target=slow_child)
        thread.join()
        self.assertLess(time.monotonic() - started, 6)
        pid = int((self.root / "child-pid").read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_remote_revocation_and_local_lease_deadline(self):
        with patch.object(worker, "report", return_value=False):
            with self.hb() as hb:
                self.assertTrue(hb.lost.wait(1))
                with self.assertRaises(worker.LeaseLost):
                    hb.check()
        hb = self.hb(lease=0.1)
        time.sleep(0.12)
        with self.assertRaises(worker.LeaseLost):
            hb.check()

    def test_silent_child_has_whole_task_deadline(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            worker._run_supervised(self.task, self.root, self.out, self.hb(),
                                   target=slow_child, timeout=0.15)
        self.assertLess(time.monotonic() - started, 4)

    def test_failed_child_group_is_cleaned_even_after_parent_exits(self):
        with self.assertRaises(RuntimeError):
            worker._run_supervised(self.task, self.root, self.out, self.hb(),
                                   target=orphan_child)
        pid = int((self.root / "orphan-pid").read_text())
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="],
                                   text=True, capture_output=True).stdout.strip()
            if not state or state.startswith("Z"):
                break
            time.sleep(0.02)
        self.assertTrue(not state or state.startswith("Z"), f"descendant is still running: {state}")

    def test_stage_manifest_never_writes_canonical_outputs(self):
        hb = self.hb()
        result = worker._run_supervised(self.task, self.root, self.out, hb, target=result_child)
        manifest = worker._stage_out(self.out, self.task, result, hb)
        self.assertEqual(manifest["claim_token"], self.task["claim_token"])
        self.assertEqual({item["role"] for item in manifest["files"]}, {"lyrics_file", "lrc"})
        self.assertTrue((Path(self.task["staging_dir"]) / "lyrics.json").is_file())
        self.assertFalse((self.root / "lyrics.json").exists())
        self.assertFalse(list(Path(self.task["staging_dir"]).glob("*.part")))

    def test_removed_staging_not_recreated(self):
        result = {"lyrics_file": "lyrics.json"}
        (self.out / "lyrics.json").write_text("{}")
        (self.out / "lyrics.lrc").write_text("[re:openk]\n")
        shutil.rmtree(self.task["staging_dir"])
        with self.assertRaises(FileNotFoundError):
            worker._stage_out(self.out, self.task, result, self.hb())
        self.assertFalse(Path(self.task["staging_dir"]).exists())

    def test_scratch_cleanup_success_failure_and_stage_local_false(self):
        original = worker._run_supervised
        def execute(task, tmp, out, heartbeat):
            return original(task, tmp, out, heartbeat, target=result_child)
        scratch = self.root / "scratch"
        with patch.object(worker, "SCRATCH_ROOT", scratch), \
                patch.object(worker, "_run_supervised", side_effect=execute), \
                patch.object(worker, "STAGE_LOCAL", False):
            result = worker.run_task(self.task, self.hb())
            self.assertEqual(result["protocol_version"], 2)
            self.assertEqual(list(scratch.iterdir()), [])
        with patch.object(worker, "SCRATCH_ROOT", scratch), \
                patch.object(worker, "_run_supervised", side_effect=RuntimeError("ML failed")):
            with self.assertRaises(RuntimeError):
                worker.run_task(self.task, self.hb())
            self.assertEqual(list(scratch.iterdir()), [])

    def test_untrusted_filename_and_legacy_claim_rejected(self):
        with self.assertRaises(ValueError):
            worker._stage_out(self.out, self.task, {"lyrics_file": "../lyrics.json"}, self.hb())
        with self.assertRaises(worker.ProtocolError):
            worker.run_task({"task_id": "old-protocol"}, self.hb())

    def test_finish_requires_positive_ack_and_does_not_retry_rejection(self):
        with patch.object(worker, "_request", return_value=(200, {"ok": False})) as request:
            with self.assertRaises(worker.LeaseLost):
                worker.finish(self.task["task_id"], self.task["claim_token"], result={})
            self.assertEqual(request.call_count, 1)

    def test_restart_scratch_cleanup_preserves_models_and_active_attempts(self):
        cache = self.root / "models"
        cache.mkdir()
        (cache / "cached-model").write_bytes(b"keep model cache")
        crashed = self.root / (uuid.uuid4().hex + "-" + uuid.uuid4().hex)
        active = self.root / (uuid.uuid4().hex + "-" + uuid.uuid4().hex)
        for directory in (crashed, active):
            directory.mkdir()
            (directory / ".owner.json").write_text(json.dumps({"worker_id": worker.WORKER_ID}))
            (directory / ".lock").touch()
            (directory / "music.wav").write_bytes(b"temporary music")
        with (active / ".lock").open("a") as lock, patch.object(worker, "SCRATCH_ROOT", self.root):
            fcntl.flock(lock, fcntl.LOCK_SH)
            worker._cleanup_scratch()
            self.assertFalse(crashed.exists())
            self.assertTrue(active.exists())
            self.assertTrue((cache / "cached-model").exists())
        with patch.object(worker, "SCRATCH_ROOT", self.root):
            worker._cleanup_scratch()
        self.assertFalse(active.exists())

    def test_default_model_root_preserves_existing_hf_and_torch_caches(self):
        with patch.dict(os.environ, {}, clear=True):
            worker._configure_model_cache()
            self.assertEqual(os.environ["HF_HOME"], str(Path.home() / ".cache/huggingface"))
            self.assertEqual(os.environ["TORCH_HOME"], str(Path.home() / ".cache/torch"))
            self.assertEqual(os.environ["OPENK_MODELS_DIR"], str(worker.DEFAULT_MODEL_CACHE))
        with patch.dict(os.environ, {"XDG_CACHE_HOME": str(self.root / "cache"),
                                     "HF_HOME": str(self.root / "existing-hf")}, clear=True):
            worker._configure_model_cache()
            self.assertEqual(os.environ["HF_HOME"], str(self.root / "existing-hf"))
            self.assertEqual(os.environ["TORCH_HOME"], str(self.root / "cache/torch"))
        with patch.dict(os.environ, {"OPENK_MODELS_DIR": str(self.root / "custom")}, clear=True):
            worker._configure_model_cache()
            self.assertNotIn("HF_HOME", os.environ)
            self.assertNotIn("TORCH_HOME", os.environ)
            self.assertEqual(os.environ["OPENK_MODELS_DIR"], str(self.root / "custom"))

    def test_path_map_directory_boundaries(self):
        with patch.object(worker, "PATH_MAP", [("/srv/shared", "/mnt/nas")]):
            self.assertEqual(worker.localize("/srv/shared/jobs/a"), "/mnt/nas/jobs/a")
            self.assertEqual(worker.localize("/srv/shared-other/a"), "/srv/shared-other/a")
            self.assertEqual(worker.localize("/outside/a"), "/outside/a")


if __name__ == "__main__":
    unittest.main(verbosity=2)
