"""后台歌词操作的持久化、互斥、错误和取消回归。"""
import tempfile
import threading
import unittest
from pathlib import Path

from backend.operations import OperationStore, public_operation


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="openk-operations-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "operations.json"
        self.store = OperationStore(self.path)

    def test_deduplicates_active_operations(self):
        first, reused = self.store.create("song", 1, {"lrclib_id": 10})
        second, again = self.store.create("song", 1, {"lrclib_id": 20})
        self.assertFalse(reused)
        self.assertTrue(again)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["request"]["lrclib_id"], 10)
        self.assertNotIn("request", public_operation(first))
        self.assertNotIn("generation", public_operation(first))

    def test_restart_recovers_queued_and_running(self):
        op, _ = self.store.create("song", 1, {"lrclib_id": 10})
        with self.store._lock:
            self.store._operations[op["id"]]["state"] = "running"
            self.store._persist()
        restored = OperationStore(self.path)
        self.assertEqual(restored.pending()[0]["id"], op["id"])
        restored.run(op["id"], lambda _: {"lyrics_file": "lyrics.json"})
        self.assertEqual(restored.get(op["id"])["state"], "done")
        self.assertEqual(OperationStore(self.path).get(op["id"])["state"], "done")

    def test_failure_is_visible_and_retry_creates_new_operation(self):
        op, _ = self.store.create("song", 1, {})
        def fail(_):
            raise RuntimeError("worker timeout")
        with self.assertLogs("backend.operations", level="ERROR"):
            self.store.run(op["id"], fail)
        failed = self.store.get(op["id"])
        self.assertEqual(failed["state"], "error")
        self.assertEqual(failed["error"], "worker timeout")
        newer, reused = self.store.create("song", 1, {})
        self.assertFalse(reused)
        self.assertNotEqual(op["id"], newer["id"])

    def test_cancelled_operation_cannot_report_success(self):
        op, _ = self.store.create("song", 1, {})
        entered, finish = threading.Event(), threading.Event()
        def action(_):
            entered.set()
            self.assertTrue(finish.wait(3))
            return {"lyrics_file": "lyrics.json"}
        thread = threading.Thread(target=self.store.run, args=(op["id"], action))
        thread.start()
        self.assertTrue(entered.wait(3))
        self.store.cancel_for("song")
        finish.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.store.get(op["id"])["state"], "error")
        self.assertIsNone(self.store.get(op["id"])["result"])

    def test_concurrent_submit_is_single_operation(self):
        results = []
        barrier = threading.Barrier(5)
        def create():
            barrier.wait()
            results.append(self.store.create("song", 1, {})[0]["id"])
        threads = [threading.Thread(target=create) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(3)
        self.assertEqual(len(results), 5)
        self.assertEqual(len(set(results)), 1)

    def test_corrupt_store_fails_loudly(self):
        self.path.write_text("invalid", encoding="utf-8")
        with self.assertRaises(ValueError):
            OperationStore(self.path)


if __name__ == "__main__":
    unittest.main()
