#!/usr/bin/env python3
"""Atomic job lifecycle tests using isolated, project-local data."""
from __future__ import annotations

import json
import os
import shutil
import threading
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

ROOT = PROJECT_ROOT / (".test-jobs-" + uuid.uuid4().hex)
os.environ["OPENK_DATA_DIR"] = str(ROOT / "data")
os.environ["OPENK_JOBS_DIR"] = str(ROOT / "bootstrap-jobs")

from backend.jobs import JobCancelledError, JobConflictError, JobManager
from backend.remote.queue import TaskCancelled, TaskQueue


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root = ROOT / uuid.uuid4().hex
        self.manager = JobManager(self.root / "jobs")
        self.queue = TaskQueue(job_manager=self.manager)

    def tearDown(self):
        self.queue.cancel_where(lambda task: True)
        shutil.rmtree(self.root)

    def test_concurrent_and_sequential_create_one_dispatch(self):
        barrier = threading.Barrier(12)
        def create():
            barrier.wait()
            return self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        with ThreadPoolExecutor(max_workers=12) as executor:
            results = list(executor.map(lambda _: create(), range(12)))
        self.assertEqual(len({job["id"] for job, _ in results}), 1)
        self.assertEqual(sum(not reused for _, reused in results), 1)
        self.assertTrue(self.manager.create_or_reuse("https://youtube.com/watch?v=abcdefghijk")[1])
        self.assertEqual(len(self.manager.list()), 1)

    def test_resolved_local_path_and_video_identity(self):
        source = self.root / "song.wav"
        source.touch()
        alias = self.root / "alias.wav"
        alias.symlink_to(source)
        first, reused = self.manager.create_or_reuse(str(source), source_type="local",
                                                    local_path=str(source))
        second, reused = self.manager.create_or_reuse(str(alias), source_type="local",
                                                     local_path=str(alias))
        self.assertTrue(reused)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["local_path"], str(source.resolve()))
        self.manager.update(first["id"], state="done")
        self.assertTrue(self.manager.create_or_reuse(str(source), local_path=str(source))[1])

    def test_retry_compare_and_swap_and_stale_execution(self):
        job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        self.manager.update(job["id"], state="error")
        barrier = threading.Barrier(8)
        def retry():
            barrier.wait()
            try:
                return self.manager.retry_if_idle(job["id"])
            except JobConflictError:
                return None
        with ThreadPoolExecutor(max_workers=8) as executor:
            retries = list(executor.map(lambda _: retry(), range(8)))
        successful = [result for result in retries if result]
        self.assertEqual(len(successful), 1)
        self.assertNotEqual(successful[0]["generation"], job["generation"])
        with self.assertRaises(JobCancelledError):
            with self.manager.execution(job["id"], job["generation"]):
                self.fail("Old dispatch must never execute")
        with self.manager.execution(job["id"], successful[0]["generation"]):
            with self.assertRaises(JobConflictError):
                with self.manager.execution(job["id"], successful[0]["generation"]):
                    pass

    def test_delete_pending_and_claimed_wakes_submitter(self):
        for claimed in (False, True):
            job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
            errors = []
            def producer():
                try:
                    with self.manager.execution(job["id"], job["generation"]):
                        self.queue.submit("transcribe", {"out_dir": str(self.manager.job_dir(job["id"]))})
                except Exception as exc:
                    errors.append(exc)
            thread = threading.Thread(target=producer)
            thread.start()
            if claimed:
                task = self.queue.claim("same-worker", ["transcribe"], 2)
                self.assertIsNotNone(task)
            else:
                deadline = time.monotonic() + 2
                while not self.queue.status()["waiting"] and time.monotonic() < deadline:
                    time.sleep(0.01)
            self.assertTrue(self.manager.delete(job["id"]))
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertIsInstance(errors[0], TaskCancelled)
            self.assertIsNone(self.manager.get(job["id"]))
            self.assertFalse(self.manager.job_dir(job["id"]).exists())
            self.assertIsNone(self.manager.update(job["id"], state="done"))
            with self.assertRaises(KeyError):
                self.manager.retry_if_idle(job["id"])
            if claimed:
                self.assertFalse(self.queue.finish(task["task_id"], "same-worker",
                                                   claim_token=task["claim_token"], error="late"))
                self.assertFalse(Path(task["staging_dir"]).exists())

    def test_delete_fences_active_local_callbacks_and_submission(self):
        job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        with self.manager.execution(job["id"], job["generation"]):
            self.manager.delete(job["id"])
            self.assertTrue(self.manager.is_cancelled())
            with self.assertRaises(JobCancelledError):
                self.manager.check_active()
            with self.assertRaises((JobCancelledError, ValueError)):
                self.queue.submit("transcribe", {"out_dir": str(self.manager.job_dir(job["id"]))})
        self.assertFalse(self.manager.job_dir(job["id"]).exists())

    def test_restart_durable_requeue_rotates_generation_and_cleans_staging(self):
        job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        self.manager.update(job["id"], state="running", language="zh", local_path="/music/song.wav")
        stage = self.manager.jobs_dir / ".remote-staging" / "interrupted"
        stage.mkdir(parents=True)
        (stage / "partial.part").write_bytes(b"partial")
        pending = self.manager.job_dir(job["id"]) / ".openk-results" / ".commit-interrupted"
        pending.mkdir(parents=True)
        (pending / "lyrics.json").write_text("{}")
        with patch("backend.jobs.config.RESUME_ON_START", True):
            recovered = JobManager(self.manager.jobs_dir)
        restored = recovered.get(job["id"])
        self.assertEqual(restored["state"], "queued")
        self.assertEqual(restored["language"], "zh")
        self.assertNotEqual(restored["generation"], job["generation"])
        self.assertEqual(recovered.take_interrupted(), [job["id"]])
        self.assertEqual(recovered.take_interrupted(), [])
        durable = json.loads((recovered.job_dir(job["id"]) / "status.json").read_text())
        self.assertEqual(durable["generation"], restored["generation"])
        self.assertFalse(stage.exists())
        self.assertFalse(pending.exists())

    def test_cancelled_restart_not_resumed_and_malformed_metadata_ignored(self):
        job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        self.manager.cancel(job["id"])
        invalid = self.manager.jobs_dir / "deadbeef1234"
        invalid.mkdir()
        (invalid / "status.json").write_text(json.dumps({"id": "../../escape", "state": "queued"}))
        recovered = JobManager(self.manager.jobs_dir)
        self.assertEqual(recovered.take_interrupted(), [])
        self.assertEqual(len(recovered.list()), 1)
        self.assertEqual(recovered.get(job["id"])["state"], "cancelled")

    def test_legacy_done_generation_is_persisted_and_stable_across_restarts(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        status = self.manager.job_dir(job["id"]) / "status.json"
        legacy = json.loads(status.read_text())
        legacy.pop("generation")
        status.write_text(json.dumps(legacy))
        migrated = JobManager(self.manager.jobs_dir)
        generation = migrated.generation(job["id"])
        self.assertEqual(json.loads(status.read_text())["generation"], generation)
        restarted = JobManager(self.manager.jobs_dir)
        self.assertEqual(restarted.generation(job["id"]), generation)
        self.assertEqual(restarted.get(job["id"])["state"], "done")
        with restarted.execution(job["id"], generation, allow_done=True):
            self.assertEqual(restarted.current_execution(), (job["id"], generation))
            self.assertEqual(restarted.get(job["id"])["state"], "done")

    def test_get_snapshot_cannot_mutate_nested_metadata(self):
        job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        job["stems"]["vocals"] = "injected.wav"
        self.assertEqual(self.manager.get(job["id"])["stems"], {})

    def test_failed_persistence_rolls_back_create_and_retry(self):
        with patch.object(self.manager, "_persist", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        self.assertEqual(self.manager.list(), [])
        job, _ = self.manager.create_or_reuse("https://youtu.be/abcdefghijk")
        self.manager.update(job["id"], state="error")
        with patch.object(self.manager, "_persist", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.manager.retry_if_idle(job["id"])
        self.assertEqual(self.manager.get(job["id"])["generation"], job["generation"])
        self.assertEqual(self.manager.get(job["id"])["state"], "error")

    def lyrics_workspace(self, job, nested=False):
        directory = self.manager.job_dir(job["id"]) / ".operations" / uuid.uuid4().hex
        source = directory / ".openk-results" / uuid.uuid4().hex if nested else directory
        source.mkdir(parents=True)
        lyrics = {"language": "en", "source": "edited", "lines": [
            {"start": 0, "end": 1, "text": "Test", "words": []}]}
        (source / "lyrics.json").write_text(json.dumps(lyrics))
        (source / "lyrics.lrc").write_text("[re:openk]\n[00:00.00]Test\n")
        files = {"lyrics_file": str((source / "lyrics.json").relative_to(directory)),
                 "lrc_file": str((source / "lyrics.lrc").relative_to(directory))}
        return directory, files

    def test_commit_artifacts_accepts_nested_operation_results_atomically(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        directory, files = self.lyrics_workspace(job, nested=True)
        self.assertEqual(self.manager.generation(job["id"]), job["generation"])
        updated = self.manager.commit_artifacts(
            job["id"], job["generation"], directory, files,
            language="en", line_count=1, lyrics_source="edited")
        paths = [self.manager.job_dir(job["id"]) / updated[key]
                 for key in ("lyrics_file", "lrc_file")]
        self.assertEqual(paths[0].parent, paths[1].parent)
        self.assertTrue(all(path.is_file() for path in paths))
        self.assertTrue((paths[0].parent / "manifest.json").is_file())
        durable = json.loads((self.manager.job_dir(job["id"]) / "status.json").read_text())
        self.assertEqual(durable["lyrics_file"], updated["lyrics_file"])
        self.assertEqual(durable["line_count"], 1)
        self.assertEqual(list((self.manager.jobs_dir / ".artifact-staging").iterdir()), [])

    def test_commit_artifacts_rejects_stale_retry_and_deleted_generation(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        directory, files = self.lyrics_workspace(job)
        self.manager.retry_if_idle(job["id"])
        with self.assertRaises(JobCancelledError):
            self.manager.commit_artifacts(job["id"], job["generation"], directory, files)
        self.manager.delete(job["id"])
        with self.assertRaises(JobCancelledError):
            self.manager.commit_artifacts(job["id"], job["generation"], directory, files)
        self.assertFalse(self.manager.job_dir(job["id"]).exists())

    def test_delete_during_artifact_preparation_does_not_resurrect_directory(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        directory, files = self.lyrics_workspace(job)
        original = self.manager._copy_artifact
        def copy_then_delete(source, target):
            original(source, target)
            self.manager.delete(job["id"])
        with patch.object(self.manager, "_copy_artifact", side_effect=copy_then_delete):
            with self.assertRaises((JobCancelledError, FileNotFoundError)):
                self.manager.commit_artifacts(job["id"], job["generation"], directory, files)
        self.assertFalse(self.manager.job_dir(job["id"]).exists())
        self.assertEqual(list((self.manager.jobs_dir / ".artifact-staging").iterdir()), [])

    def test_commit_artifacts_rejects_corrupt_and_escaping_files(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        directory, files = self.lyrics_workspace(job)
        (directory / "lyrics.json").write_text("not JSON")
        with self.assertRaises(ValueError):
            self.manager.commit_artifacts(job["id"], job["generation"], directory, files)
        with self.assertRaises(ValueError):
            self.manager.commit_artifacts(job["id"], job["generation"], directory,
                                          {"lyrics_file": "../lyrics.json"})
        (directory / "lyrics.json").unlink()
        (directory / "lyrics.json").symlink_to(directory / "lyrics.lrc")
        with self.assertRaises(ValueError):
            self.manager.commit_artifacts(job["id"], job["generation"], directory, files)
        self.assertIsNone(self.manager.get(job["id"])["lyrics_file"])

    def test_commit_recording_moves_upload_and_serializes_metadata(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        uploads = self.root / ".uploads"
        uploads.mkdir()
        def commit(index):
            upload = uploads / f"upload-{index}"
            upload.write_bytes(b"recording bytes")
            return self.manager.commit_recording(
                job["id"], upload, f"rec_{index}.webm", {"title": f"Take {index}"},
                generation=job["generation"])
        with ThreadPoolExecutor(max_workers=2) as executor:
            recordings = list(executor.map(commit, range(2)))
        self.assertEqual(len(self.manager.get(job["id"])["recordings"]), 2)
        self.assertEqual(list(uploads.iterdir()), [])
        for recording in recordings:
            self.assertEqual((self.manager.recordings_dir(job["id"]) /
                              recording["file"]).read_bytes(), b"recording bytes")

    def test_recording_racing_deletion_does_not_resurrect_job(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        upload = self.root / "upload"
        upload.write_bytes(b"recording")
        original = self.manager._copy_artifact
        def copy_then_delete(source, target):
            original(source, target)
            self.manager.delete(job["id"])
        with patch.object(self.manager, "_copy_artifact", side_effect=copy_then_delete):
            with self.assertRaises(JobCancelledError):
                self.manager.commit_recording(job["id"], upload, "rec.webm", {},
                                               generation=job["generation"])
        self.assertTrue(upload.exists(), "caller owns rejected uploads for retry/cleanup")
        self.assertFalse(self.manager.job_dir(job["id"]).exists())
        self.assertEqual(list((self.manager.jobs_dir / ".artifact-staging").iterdir()), [])

    def test_publication_persistence_failure_keeps_old_metadata_and_removes_unreferenced_files(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        directory, files = self.lyrics_workspace(job)
        upload = self.root / "upload"
        upload.write_bytes(b"recording")
        with patch.object(self.manager, "_persist", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.manager.commit_artifacts(job["id"], job["generation"], directory, files)
            with self.assertRaises(OSError):
                self.manager.commit_recording(job["id"], upload, "rec.webm", {},
                                               generation=job["generation"])
        self.assertIsNone(self.manager.get(job["id"])["lyrics_file"])
        self.assertEqual(self.manager.get(job["id"])["recordings"], [])
        self.assertEqual(list((self.manager.job_dir(job["id"]) / ".openk-results").iterdir()), [])
        self.assertEqual(list(self.manager.recordings_dir(job["id"]).iterdir()), [])

    def test_remote_operation_subdirectory_is_supported(self):
        job = self.manager.create("https://youtu.be/abcdefghijk", state="done")
        directory, _ = self.lyrics_workspace(job)
        errors = []
        def producer():
            try:
                with self.manager.execution(job["id"], job["generation"], allow_done=True):
                    self.queue.submit("align", {"out_dir": str(directory)})
            except Exception as exc:
                errors.append(exc)
        thread = threading.Thread(target=producer)
        thread.start()
        task = self.queue.claim("worker", ["align"], 2)
        self.assertEqual(task["args"]["out_dir"], str(directory))
        self.assertEqual(task["generation"], job["generation"])
        self.queue.finish(task["task_id"], "worker", error="test cancellation",
                          claim_token=task["claim_token"])
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], RuntimeError)


def tearDownModule():
    if ROOT.exists():
        shutil.rmtree(ROOT)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        tearDownModule()
