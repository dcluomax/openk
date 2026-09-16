"""目录缓存、流式录音与异步歌词接口回归，不调用外部模型或网络。"""
from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

_temporary = tempfile.TemporaryDirectory(prefix="openk-http-")
os.environ["OPENK_DATA_DIR"] = _temporary.name
os.environ["OPENK_JOBS_DIR"] = str(Path(_temporary.name) / "jobs")
os.environ["OPENK_RESUME_ON_START"] = "false"

from fastapi.testclient import TestClient
from backend import identity, main, search
from backend.jobs import manager
from backend.steps import local_media, lyrics_sources


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        job = manager.create(f"https://example.org/test-{self.id()}")
        self.job_id = job["id"]
        directory = manager.job_dir(self.job_id)
        (directory / "stems").mkdir()
        for name in ("vocals.wav", "instrumental.wav"):
            (directory / "stems" / name).write_bytes(b"RIFF" + b"\0" * 4096)
        (directory / "lyrics.json").write_text('{"lines":[]}', encoding="utf-8")
        manager.update(self.job_id, state="done", artist="測試", track="目录歌曲",
                       title="Title", stems={"vocals": "vocals.wav", "instrumental": "instrumental.wav"},
                       lyrics_file="lyrics.json", duration=10, line_count=1)
        self.addCleanup(self._cleanup_job)

    def _cleanup_job(self):
        if manager.get(self.job_id):
            main.delete_job(self.job_id)

    def test_catalog_etag_and_metadata_changes(self):
        first = self.client.get("/api/jobs")
        self.assertEqual(first.status_code, 200)
        etag = first.headers["etag"]
        again = self.client.get("/api/jobs", headers={"If-None-Match": etag})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(again.content, b"")
        manager.update(self.job_id, track="新的歌曲")
        changed = self.client.get("/api/jobs", headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], etag)
        result = self.client.get("/api/jobs", params={"q": "測試"}).json()
        self.assertTrue(any(job["id"] == self.job_id for job in result))
        self.assertEqual(self.client.get("/api/health").json(), {"status": "ok"})

    def test_party_lobby_and_existing_room_pages_are_available(self):
        for path in ("/rooms", "/rooms/", "/remote", "/remote/", "/tv", "/tv/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-cache", response.headers["cache-control"])
                self.assertIn("room-client.js", response.text)

    def test_account_mode_home_keeps_the_full_room_capable_player(self):
        with patch.object(identity, "KEY", b"test-only-identity-key-" + b"a" * 32):
            for path in ("/", "/index.html"):
                response = self.client.get(path, follow_redirects=False)
                self.assertEqual(response.status_code, 200)
                self.assertIn('id="instAudio"', response.text)
                self.assertIn('id="roomStatus"', response.text)
                self.assertIn('src="/account.js"', response.text)
                self.assertIn("no-cache", response.headers["cache-control"])
            for path in ("/library", "/library/", "/admin"):
                self.assertEqual(self.client.get(path).status_code, 200)
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_user_device_and_history_routes_are_wired_into_the_real_application(self):
        key = b"integration-only-proxy-key-" + b"a" * 32
        account = {
            "id": "00000000-0000-4000-8000-000000000071",
            "username": "integration-singer", "display_name": "Integration singer",
            "is_staff": False,
        }
        headers = {
            "X-OpenK-Identity-Key": key.decode(),
            "X-OpenK-Account": base64.urlsafe_b64encode(json.dumps(account).encode()).decode(),
        }
        with patch.object(identity, "KEY", key):
            for route, script in (("/devices", "/devices.js"), ("/history", "/history.js")):
                for path in (route, route + "/"):
                    response = self.client.get(path)
                    self.assertEqual(response.status_code, 200)
                    self.assertIn('/user-state.js', response.text)
                    self.assertIn(script, response.text)
                    self.assertIn('<html lang="zh-CN">', response.text)
                    self.assertIn("设备" if route == "/devices" else "播放历史", response.text)
            for path in ("/api/user/state", "/api/user/history"):
                self.assertEqual(self.client.get(path).status_code, 401)
                response = self.client.get(path, headers=headers)
                self.assertEqual(response.status_code, 200)
                self.assertIn("no-store", response.headers["cache-control"])
        with patch.object(identity, "KEY", b""):
            for path in ("/devices", "/history", "/api/user/state", "/api/user/history"):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_api_compression_does_not_change_media_ranges(self):
        manager.update(self.job_id, message="large catalog field " * 300)
        response = self.client.get("/api/jobs", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(response.headers["content-encoding"], "gzip")
        media = self.client.get(f"/media/{self.job_id}/stems/instrumental.wav",
                                headers={"Range": "bytes=0-2047", "Accept-Encoding": "gzip"})
        self.assertEqual(media.status_code, 206)
        self.assertEqual(len(media.content), 2048)
        self.assertNotIn("content-encoding", media.headers)
        self.assertEqual(media.headers["cache-control"], "no-cache")

    def test_downloaded_active_documents_cannot_execute_under_app_origin(self):
        source = manager.job_dir(self.job_id) / "source"
        source.mkdir()
        probe = b'<svg xmlns="http://www.w3.org/2000/svg" onload="document.title=\'executed\'"/>'
        for extension in ("svg", "SVG", "svgz", "html", "htm", "xhtml", "xml", "js", "css", "pdf"):
            with self.subTest(extension=extension):
                (source / f"source.{extension}").write_bytes(probe)
                url = f"/media/{self.job_id}/source/source.{extension}"
                for method in ("GET", "HEAD"):
                    response = self.client.request(method, url, headers={"Range": "bytes=0-63"})
                    self.assertEqual(response.status_code, 404)
                    self.assertNotIn(b"document.title", response.content)

        # A misleading extension still receives a fixed non-document MIME type and sandbox.
        (source / "disguised.jpg").write_bytes(probe)
        response = self.client.get(f"/media/{self.job_id}/source/disguised.jpg")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/jpeg")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn("sandbox", response.headers["content-security-policy"])
        self.assertIn("default-src 'none'", response.headers["content-security-policy"])

    def test_media_security_headers_preserve_lyrics_ranges_and_revalidation(self):
        self.assertEqual(local_media.MEDIA_EXTS - main.MediaStaticFiles.TYPES.keys(), set())
        for relative, media_type in (("lyrics.json", "application/json"),
                                     ("stems/instrumental.wav", "audio/wav")):
            with self.subTest(path=relative):
                url = f"/media/{self.job_id}/{relative}"
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], media_type)
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                cached = self.client.get(url, headers={"If-None-Match": response.headers["etag"]})
                self.assertEqual(cached.status_code, 304)
                self.assertEqual(cached.content, b"")
                self.assertIn("sandbox", cached.headers["content-security-policy"])
        ranged = self.client.get(f"/media/{self.job_id}/stems/instrumental.wav",
                                 headers={"Range": "bytes=0-15"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(len(ranged.content), 16)
        self.assertIn("sandbox", ranged.headers["content-security-policy"])

    def test_zh_map_covers_query_only_characters_independently_of_catalog(self):
        manager.update(self.job_id, artist="夢", track="夢", title="夢")
        first = self.client.get("/api/zh-map").json()
        manager.update(self.job_id, artist="闊", track="闊", title="闊")
        second = self.client.get("/api/zh-map").json()
        self.assertEqual(first["夢"], "梦")
        self.assertEqual(second["闊"], "阔")
        self.assertEqual(first, second)
        with patch.object(manager, "list", side_effect=AssertionError("map must not scan jobs")):
            self.assertEqual(self.client.get("/api/zh-map").json(), first)

    def test_search_api_matches_shared_ranking_and_conditional_responses(self):
        from tests.python.test_search import CASES, catalog
        jobs = catalog()
        for job in jobs:
            job["updated_at"] = 1
        with patch.object(manager, "list", return_value=jobs):
            for query, expected in CASES:
                with self.subTest(query=query):
                    response = self.client.get("/api/jobs", params={"q": query})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual([job["id"] for job in response.json()], expected)
            indexed = self.client.get("/api/jobs").json()
            self.assertTrue(all(job["search_index"]["v"] == 1 for job in indexed))
            self.assertEqual([job["id"] for job in indexed], [job["id"] for job in jobs],
                             "omitting q retains the existing recent-first manager order")
            expected = [job["id"] for job in search.search_jobs(indexed, "")]
            for query in ("", "  ", " … 🎤 "):
                result = self.client.get("/api/jobs", params={"q": query}).json()
                self.assertEqual([job["id"] for job in result], expected)
            first = self.client.get("/api/jobs", params={"q": "稻香"},
                                    headers={"Accept-Encoding": "gzip"})
            self.assertEqual(first.headers["content-encoding"], "gzip")
            again = self.client.get("/api/jobs", params={"q": "稻香"}, headers={
                "If-None-Match": first.headers["etag"], "Accept-Encoding": "gzip"})
            self.assertEqual(again.status_code, 304)
            self.assertEqual(again.content, b"")
            different = self.client.get("/api/jobs", params={"q": "周杰倫 稻香"},
                                        headers={"If-None-Match": first.headers["etag"]})
            self.assertEqual(different.status_code, 200)
            jobs[0]["url"] = "https://example.org/AbCd_12"
            jobs[0]["updated_at"] = 2
            result = self.client.get("/api/jobs", params={"q": "EXAMPLE.ORG/abcd_12"}).json()
            self.assertEqual([job["id"] for job in result], ["rice"])

    def test_public_search_index_cache_tracks_metadata_not_progress(self):
        search._index.cache_clear()
        job = {"id": "index-cache", "title": "录制", "track": "稻香", "artist": "周杰伦",
               "updated_at": 1, "state": "done", "generation": "private"}
        with patch.object(manager, "list", return_value=[job]), \
                patch.object(search, "lazy_pinyin", wraps=search.lazy_pinyin) as phonetics:
            first = self.client.get("/api/jobs")
            calls = phonetics.call_count
            self.assertGreater(calls, 0)
            self.assertNotIn("generation", first.json()[0])
            job.update(updated_at=2, progress=80)
            self.client.get("/api/jobs")
            self.assertEqual(phonetics.call_count, calls)
            job.update(track="平凡之路", artist="朴树")
            changed = self.client.get("/api/jobs", params={"q": "pfzl ps"},
                                      headers={"If-None-Match": first.headers["etag"]})
            self.assertEqual(changed.status_code, 200)
            self.assertEqual(changed.json()[0]["search_index"]["f"][0][2], ["pfzl"])
            self.assertEqual(self.client.get("/api/jobs", params={"q": "dx"}).json(), [])
            self.assertGreater(phonetics.call_count, calls)

    def test_recording_mime_upload_and_stream_limit(self):
        url = f"/api/jobs/{self.job_id}/recordings"
        saved = self.client.post(url, content=b"test audio", headers={"Content-Type": "audio/mp4"},
                                 params={"duration": 2.5})
        self.assertEqual(saved.status_code, 200, saved.text)
        rec = saved.json()["recording"]
        self.assertTrue(rec["file"].endswith(".mp4"))
        self.assertEqual(self.client.get(rec["url"]).content, b"test audio")
        self.assertEqual(self.client.post(url, content=b"").status_code, 400)
        self.assertEqual(self.client.post(url, content=b"x",
                                         headers={"Content-Type": "text/html"}).status_code, 415)
        with patch.object(main, "MAX_RECORDING_BYTES", 4):
            self.assertEqual(self.client.post(url, content=iter([b"abc", b"def"])).status_code, 413)
        self.assertEqual(list((Path(_temporary.name) / ".uploads").glob("*.part")), [])
        self.assertEqual(len(manager.get(self.job_id)["recordings"]), 1)

    def test_duplicate_submission_dispatches_once(self):
        with patch.object(main._executor, "submit") as submit:
            request = {"url": "https://www.youtube.com/watch?v=abcdefghijk"}
            a = self.client.post("/api/jobs", json=request).json()
            b = self.client.post("/api/jobs", json=request).json()
            self.assertEqual(a["id"], b["id"])
            self.assertTrue(b["reused"])
            self.assertEqual(submit.call_count, 1)
            main.delete_job(a["id"])

    def test_alignment_is_recoverable_background_operation(self):
        with patch.object(main._executor, "submit") as submit:
            url = f"/api/jobs/{self.job_id}/lyrics/align"
            response = self.client.post(url, json={"lrclib_id": 123})
            self.assertEqual(response.status_code, 202, response.text)
            operation = response.json()["operation"]
            self.assertEqual(operation["state"], "queued")
            second = self.client.post(url, json={"lrclib_id": 123})
            self.assertTrue(second.json()["reused"])
            self.assertEqual(submit.call_count, 1)
            self.assertEqual(self.client.post(f"/api/jobs/{self.job_id}/retry").status_code, 409)
            self.assertEqual(self.client.put(f"/api/jobs/{self.job_id}/lyrics",
                                             json={"lines": [{"text": "手动", "start": 0, "end": 1}]}).status_code, 409)
        lyrics = {"artistName": "Test", "trackName": "Song", "plainLyrics": "一起唱首歌",
                  "syncedLyrics": None}
        with patch.object(lyrics_sources, "get_lrclib_by_id", return_value=lyrics):
            main._operations.run(operation["id"], main._perform_alignment)
        completed = self.client.get(f"/api/operations/{operation['id']}").json()
        self.assertEqual(completed["state"], "done", completed)
        self.assertEqual(manager.get(self.job_id)["state"], "done")
        current = self.client.get(f"/api/jobs/{self.job_id}").json()
        self.assertTrue(current["lyrics_file"].startswith(".openk-results/"))
        self.assertEqual(self.client.get(current["media"]["lyrics"]).status_code, 200)
        # 已经打开旧歌词的播放器可以读完旧版本。
        self.assertEqual(self.client.get(f"/media/{self.job_id}/lyrics.json").status_code, 200)
        self.assertEqual(self.client.get("/api/operations/missing").status_code, 404)

    def test_delete_cancels_queued_alignment(self):
        with patch.object(main._executor, "submit"):
            response = self.client.post(f"/api/jobs/{self.job_id}/lyrics/align", json={"lrclib_id": 1})
        operation = response.json()["operation"]
        self.assertEqual(self.client.delete(f"/api/jobs/{self.job_id}").status_code, 200)
        action = unittest.mock.Mock()
        main._operations.run(operation["id"], action)
        action.assert_not_called()
        self.assertEqual(main.get_operation(operation["id"])["state"], "error")
        self.assertFalse(manager.job_dir(self.job_id).exists())

    def test_failed_only_delete_refreshes_catalog_and_preserves_import_source(self):
        original = Path(_temporary.name) / f"original-{self.job_id}.flac"
        original.write_bytes(b"original imported audio")
        self.addCleanup(original.unlink, missing_ok=True)
        manager.update(self.job_id, state="error", local_path=str(original), source_type="local")
        before = self.client.get("/api/jobs")
        response = self.client.delete(f"/api/jobs/{self.job_id}?failed_only=true")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(original.read_bytes(), b"original imported audio")
        self.assertFalse(manager.job_dir(self.job_id).exists())
        after = self.client.get("/api/jobs", headers={"If-None-Match": before.headers["etag"]})
        self.assertEqual(after.status_code, 200)
        self.assertNotIn(self.job_id, [job["id"] for job in after.json()])
        self.assertEqual(self.client.delete(f"/api/jobs/{self.job_id}?failed_only=true").status_code, 404)

    def test_failed_only_delete_rejects_running_and_completed_jobs(self):
        for state in ("pending", "queued", "running", "done"):
            with self.subTest(state=state):
                manager.update(self.job_id, state=state)
                before = manager.get(self.job_id)
                data = (manager.job_dir(self.job_id) / "status.json").read_bytes()
                with patch.object(main._operations, "cancel_for") as cancel:
                    response = self.client.delete(f"/api/jobs/{self.job_id}?failed_only=true")
                    self.assertEqual(response.status_code, 409, response.text)
                    cancel.assert_not_called()
                self.assertEqual(manager.get(self.job_id), before)
                self.assertEqual((manager.job_dir(self.job_id) / "status.json").read_bytes(), data)

    def test_failed_only_delete_does_not_cancel_a_lyric_operation(self):
        with patch.object(main._executor, "submit"):
            response = self.client.post(f"/api/jobs/{self.job_id}/lyrics/align", json={"lrclib_id": 1})
        operation = response.json()["operation"]
        before = main.get_operation(operation["id"])
        response = self.client.delete(f"/api/jobs/{self.job_id}?failed_only=true")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(main.get_operation(operation["id"]), before)
        self.assertEqual(manager.get(self.job_id)["state"], "done")

    def test_failed_only_delete_rejects_a_successful_retry_from_another_device(self):
        manager.update(self.job_id, state="error")
        with patch.object(main._executor, "submit") as submit:
            retried = self.client.post(f"/api/jobs/{self.job_id}/retry")
            self.assertEqual(retried.status_code, 200, retried.text)
            submit.assert_called_once()
        before = manager.get(self.job_id)
        response = self.client.delete(f"/api/jobs/{self.job_id}?failed_only=true")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(manager.get(self.job_id), before)
        self.assertEqual(before["state"], "queued")

    def test_failed_only_parameter_is_validated_and_general_delete_remains_available(self):
        invalid = self.client.delete(f"/api/jobs/{self.job_id}?failed_only=invalid")
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(manager.get(self.job_id)["state"], "done")
        response = self.client.delete(f"/api/jobs/{self.job_id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(manager.get(self.job_id))

    def test_manual_lyrics_revision_keeps_song_identity(self):
        response = self.client.put(f"/api/jobs/{self.job_id}/lyrics",
                                   json={"lines": [{"text": "一起唱首歌", "start": 0, "end": 3}]})
        self.assertEqual(response.status_code, 200, response.text)
        job = self.client.get(f"/api/jobs/{self.job_id}").json()
        result = self.client.get(job["media"]["lyrics"]).json()
        self.assertEqual(result["lines"][0]["text"], "一起唱首歌")
        self.assertEqual(job["lyrics_status"], "ok")

    def test_manual_timing_keeps_word_gaps_and_rejects_a_stale_editor(self):
        before = self.client.get(f"/api/jobs/{self.job_id}").json()
        old_url = before["media"]["lyrics"]
        words = [{"text": "hello", "start": 2.125, "end": 2.75},
                 {"text": "world", "start": 5.5, "end": 6.25}]
        payload = {"base_lyrics_url": old_url, "lines": [
            {"text": "hello world", "start": 2, "end": 7, "words": words},
        ]}
        saved = self.client.put(f"/api/jobs/{self.job_id}/lyrics", json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        current = self.client.get(f"/api/jobs/{self.job_id}").json()
        latest_url = current["media"]["lyrics"]
        self.assertNotEqual(latest_url, old_url)
        self.assertEqual(self.client.get(latest_url).json()["lines"][0]["words"], words)
        self.assertEqual(self.client.get(old_url).json(), {"lines": []})
        again = self.client.put(f"/api/jobs/{self.job_id}/lyrics", json=payload)
        self.assertEqual(again.status_code, 409, again.text)
        self.assertIn("其他设备更新", again.json()["detail"])
        self.assertEqual(self.client.get(f"/api/jobs/{self.job_id}").json()["media"]["lyrics"], latest_url)
        self.assertEqual(current["stems"], before["stems"])
        self.assertEqual(current["duration"], before["duration"])

    def test_manual_timing_rejects_invalid_intervals_without_publishing(self):
        before = manager.get(self.job_id).copy()
        cases = [
            {"text": "words", "start": -1, "end": 2},
            {"text": "words", "start": 4, "end": 2},
            {"text": "words", "start": True, "end": 2},
            {"text": "words", "start": float("nan"), "end": 2},
            {"text": "words", "start": 0, "end": float("inf")},
            {"text": "words", "start": 0},
            {"text": " ", "start": 0, "end": 2},
            {"text": "words", "start": 0, "end": 2, "words": "invalid"},
            {"text": "words", "start": 0, "end": 2, "words": {}},
            {"text": "words", "start": 0, "end": 2, "words": False},
            {"text": "words", "start": 0, "end": 2,
             "words": [{"text": "words", "start": 0, "end": -1}]},
        ]
        for line in cases:
            with self.subTest(line=line):
                response = self.client.put(f"/api/jobs/{self.job_id}/lyrics",
                    content=json.dumps({"lines": [line]}),
                    headers={"Content-Type": "application/json"})
                self.assertEqual(response.status_code, 400, response.text)
                self.assertIsInstance(response.json()["detail"], str)
                self.assertEqual(manager.get(self.job_id), before)
        self.assertFalse((manager.job_dir(self.job_id) / ".openk-results").exists())

    def test_short_manual_line_never_generates_words_after_its_end(self):
        response = self.client.put(f"/api/jobs/{self.job_id}/lyrics",
            json={"lines": [{"text": "一起唱", "start": 1, "end": 1.1}]})
        self.assertEqual(response.status_code, 200, response.text)
        job = self.client.get(f"/api/jobs/{self.job_id}").json()
        line = self.client.get(job["media"]["lyrics"]).json()["lines"][0]
        self.assertEqual(line["end"], 1.1)
        self.assertTrue(all(1 <= word["start"] <= word["end"] <= 1.1 for word in line["words"]))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        main._executor.shutdown(wait=True)
        _temporary.cleanup()
