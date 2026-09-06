#!/usr/bin/env python3
"""Offline protocol/lifecycle checks: python test_remote.py (no models or user media)."""
from __future__ import annotations

import copy
import json
import os
import shutil
import threading
import time
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import patch

from backend.remote.artifacts import InvalidResult, digest_file
from backend.remote.queue import TaskCancelled, TaskQueue


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent / (".test-remote-" + uuid.uuid4().hex)
        self.out = self.root / "output"
        self.out.mkdir(parents=True)
        self.queue = TaskQueue(lease_seconds=30, staging_root=self.root / ".remote-staging")
        self.threads = []
        self.results, self.errors = [], []

    def tearDown(self):
        self.queue.cancel_where(lambda task: True)
        for thread in self.threads:
            thread.join(3)
            self.assertFalse(thread.is_alive(), "submitter must not be abandoned")
        shutil.rmtree(self.root)

    def submit(self, kind="transcribe", **kwargs):
        def producer():
            try:
                self.results.append(self.queue.submit(kind, {"out_dir": str(self.out)}, **kwargs))
            except Exception as exc:
                self.errors.append(exc)
        thread = threading.Thread(target=producer)
        thread.start()
        self.threads.append(thread)

    def claim(self, worker="worker", kind="transcribe"):
        task = self.queue.claim(worker, [kind], wait_seconds=2)
        self.assertIsNotNone(task)
        return task

    def manifest(self, task, audio=False):
        stage = Path(task["staging_dir"])
        if audio:
            result = {"vocals": "vocals.wav", "instrumental": "instrumental.wav"}
            for filename in result.values():
                with wave.open(str(stage / filename), "wb") as stream:
                    stream.setnchannels(1)
                    stream.setsampwidth(2)
                    stream.setframerate(8000)
                    stream.writeframes(b"\0\0" * 800)
            roles = result
        else:
            data = {"language": "en", "source": "test", "lines": [
                {"start": 0, "end": 1, "text": "Test", "words": []}]}
            (stage / "lyrics.json").write_text(json.dumps(data))
            (stage / "lyrics.lrc").write_text("[re:openk]\n[00:00.00]Test\n")
            result = {"lyrics_file": "lyrics.json", "language": "en",
                      "line_count": 1, "source": "test"}
            roles = {"lyrics_file": "lyrics.json", "lrc": "lyrics.lrc"}
        return {"protocol_version": 2, "task_id": task["task_id"],
                "claim_token": task["claim_token"], "generation": task["generation"],
                "result": result, "files": [
                    {"role": role, "name": filename, "size": (stage / filename).stat().st_size,
                     "sha256": digest_file(stage / filename)} for role, filename in roles.items()]}

    def finish(self, task, manifest, worker="worker"):
        return self.queue.finish(task["task_id"], worker, result=manifest,
                                 claim_token=task["claim_token"])

    def test_roundtrip_and_coalesced_progress(self):
        seen = []
        self.submit(on_progress=lambda p, m: seen.append((p, m)))
        task = self.claim()
        for _ in range(10):
            self.assertTrue(self.queue.progress(task["task_id"], "worker", 42, "working",
                                                task["claim_token"]))
        self.assertEqual(seen.count((42, "working")), 1)
        self.assertTrue(self.finish(task, self.manifest(task)))
        self.threads[-1].join(3)
        self.assertFalse(self.errors)
        self.assertEqual(self.results[0]["line_count"], 1)
        self.assertTrue((self.out / self.results[0]["lyrics_file"]).is_file())
        self.assertFalse((self.out / "lyrics.json").exists())
        self.assertFalse(Path(task["staging_dir"]).exists())
        self.assertTrue(self.finish(task, self.manifest_copy_for_receipt(task)))

    def manifest_copy_for_receipt(self, task):
        # The receipt acknowledges the claim without rereading already removed staging.
        return {"protocol_version": 2}

    def test_same_worker_stale_attempt_cannot_renew_or_publish(self):
        self.queue.lease_seconds = 0.15
        self.submit()
        first = self.claim()
        old_manifest = self.manifest(first)
        time.sleep(0.2)
        second = self.claim()
        self.assertEqual(first["task_id"], second["task_id"])
        self.assertNotEqual(first["claim_token"], second["claim_token"])
        self.assertEqual(second["attempts"], 2)
        self.assertFalse(Path(first["staging_dir"]).exists())
        self.assertFalse(self.queue.progress(first["task_id"], "worker", 50, "late",
                                             first["claim_token"]))
        self.assertFalse(self.finish(first, old_manifest))
        self.assertTrue(self.finish(second, self.manifest(second)))

    def test_expired_claim_rejected_before_reaper(self):
        self.submit()
        task = self.claim()
        manifest = self.manifest(task)
        with self.queue._lock:
            self.queue._tasks[task["task_id"]].lease_expires = time.monotonic() - 1
        self.assertFalse(self.finish(task, manifest))
        self.assertFalse(self.queue.progress(task["task_id"], "worker", 1, "", task["claim_token"]))

    def test_cancel_pending_claimed_and_timeout(self):
        for claimed in (False, True):
            self.submit()
            if claimed:
                task = self.claim()
                manifest = self.manifest(task)
            else:
                deadline = time.monotonic() + 2
                while not self.queue.status()["waiting"] and time.monotonic() < deadline:
                    time.sleep(0.01)
            self.assertEqual(self.queue.cancel_where(lambda task: True), 1)
            self.threads[-1].join(2)
            self.assertIsInstance(self.errors[-1], TaskCancelled)
            if claimed:
                self.assertFalse(self.finish(task, manifest))
                self.assertFalse(Path(task["staging_dir"]).exists())
        self.submit(timeout=0.1)
        self.threads[-1].join(2)
        self.assertIsInstance(self.errors[-1], TimeoutError)
        self.assertEqual(self.queue.status()["waiting"], 0)

    def test_offline_and_kind_capabilities(self):
        self.assertFalse(self.queue.worker_online())
        self.submit(kind="align")
        self.assertIsNone(self.queue.claim("gpu", ["separate"], 0))
        self.assertEqual(self.claim("gpu", "align")["kind"], "align")
        worker = self.queue.status()["workers"][0]
        self.assertEqual(worker["kinds"], ["align"])
        self.assertGreaterEqual(worker["idle_seconds"], 0)

    def test_interrupted_commit_publishes_nothing_and_can_retry(self):
        self.submit()
        task = self.claim()
        manifest = self.manifest(task)
        with patch("backend.remote.artifacts.os.replace", side_effect=OSError("interrupted rename")):
            with self.assertRaises(OSError):
                self.finish(task, manifest)
        self.assertEqual(list((self.out / ".openk-results").iterdir()), [])
        self.assertFalse(self.results)
        self.assertTrue(Path(task["staging_dir"]).is_dir())
        self.assertTrue(self.finish(task, manifest))

    def test_validation_does_not_block_heartbeat_and_cancellation_wins_commit(self):
        from backend.remote import artifacts
        self.submit()
        task = self.claim()
        manifest = self.manifest(task)
        validating = threading.Event()
        resume = threading.Event()
        finished = []
        original = artifacts._validate_lyrics
        def slow_validate(*args):
            validating.set()
            resume.wait(2)
            return original(*args)
        with patch.object(artifacts, "_validate_lyrics", side_effect=slow_validate):
            thread = threading.Thread(target=lambda: finished.append(self.finish(task, manifest)))
            thread.start()
            self.assertTrue(validating.wait(1))
            started = time.monotonic()
            self.assertTrue(self.queue.progress(task["task_id"], "worker", 99, "publishing",
                                                task["claim_token"]))
            self.assertLess(time.monotonic() - started, 0.2)
            self.queue.cancel_where(lambda item: True)
            resume.set()
            thread.join(3)
            self.assertFalse(thread.is_alive())
        self.assertEqual(finished, [False])
        self.assertFalse((self.out / ".openk-results").exists())
        self.assertFalse(Path(task["staging_dir"]).exists())

    def test_corrupt_incomplete_and_path_injected_results(self):
        for corruption in ("checksum", "missing", "traversal", "json", "count", "legacy",
                           "duplicate", "generation", "role", "symlink"):
            with self.subTest(corruption=corruption):
                self.submit()
                task = self.claim()
                manifest = self.manifest(task)
                stage = Path(task["staging_dir"])
                if corruption == "checksum":
                    (stage / "lyrics.json").write_text("truncated")
                elif corruption == "missing":
                    (stage / "lyrics.lrc").unlink()
                elif corruption == "traversal":
                    manifest["result"]["lyrics_file"] = "../outside.json"
                elif corruption == "json":
                    (stage / "lyrics.json").write_text("not-json")
                    entry = manifest["files"][0]
                    entry.update(size=8, sha256=digest_file(stage / "lyrics.json"))
                elif corruption == "count":
                    manifest["result"]["line_count"] = 99
                elif corruption == "legacy":
                    manifest = {"lyrics_file": "lyrics.json"}
                elif corruption == "duplicate":
                    manifest["files"][1] = copy.deepcopy(manifest["files"][0])
                elif corruption == "generation":
                    manifest["generation"] = "old-generation"
                elif corruption == "role":
                    manifest["files"][0]["role"] = []
                else:
                    (stage / "lyrics.json").unlink()
                    (stage / "lyrics.json").symlink_to(stage / "lyrics.lrc")
                with self.assertRaises((InvalidResult, OSError)):
                    self.finish(task, manifest)
                self.queue.cancel_where(lambda item: True)
                self.threads[-1].join(2)
                self.assertFalse(Path(task["staging_dir"]).exists())
                self.assertFalse((self.out / "lyrics.json").exists())

    def test_audio_group_validates_both_outputs(self):
        self.submit("separate")
        task = self.claim(kind="separate")
        manifest = self.manifest(task, audio=True)
        self.assertTrue(self.finish(task, manifest))
        self.threads[-1].join(3)
        paths = [self.out / self.results[-1][role] for role in ("vocals", "instrumental")]
        self.assertEqual(paths[0].parent, paths[1].parent)
        self.assertTrue(all(path.is_file() for path in paths))
        self.submit("separate")
        task = self.claim(kind="separate")
        manifest = self.manifest(task, audio=True)
        broken = Path(task["staging_dir"]) / "instrumental.wav"
        broken.write_bytes(b"not playable audio")
        manifest["files"][1].update(size=broken.stat().st_size, sha256=digest_file(broken))
        with self.assertRaises(InvalidResult):
            self.finish(task, manifest)

    def test_unknown_restart_claim(self):
        self.submit()
        task = self.claim()
        restarted = TaskQueue(staging_root=self.root / ".remote-staging")
        self.assertFalse(restarted.progress(task["task_id"], "worker", 1, "", task["claim_token"]))
        self.assertFalse(restarted.finish(task["task_id"], "worker",
                                          claim_token=task["claim_token"], error="stale"))

    def test_http_protocol_and_roundtrip(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from backend.remote import api
        app = FastAPI()
        app.include_router(api.router, prefix="/api")
        with patch.object(api, "queue", self.queue), patch.object(api.config, "WORKER_TOKEN", ""):
            client = TestClient(app)
            request = {"worker_id": "worker", "kinds": ["transcribe"], "wait": 0}
            self.assertEqual(client.post("/api/worker/claim", json=request).status_code, 426)
            request["protocol_version"] = 2
            self.assertEqual(client.post("/api/worker/claim", json=request).status_code, 204)
            self.submit()
            request["wait"] = 2
            response = client.post("/api/worker/claim", json=request)
            self.assertEqual(response.status_code, 200)
            task = response.json()
            base = f"/api/worker/tasks/{task['task_id']}"
            self.assertEqual(client.post(base + "/finish", json={"worker_id": "worker"}).status_code, 426)
            payload = {"worker_id": "worker", "claim_token": task["claim_token"]}
            self.assertTrue(client.post(base + "/progress", json=payload).json()["ok"])
            payload["result"] = self.manifest(task)
            self.assertTrue(client.post(base + "/finish", json=payload).json()["ok"])
            payload["claim_token"] = "old"
            self.assertFalse(client.post(base + "/finish", json=payload).json()["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
