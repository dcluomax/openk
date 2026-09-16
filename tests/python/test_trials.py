"""Anonymous trial quotas and media authorization, using synthetic files only."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

os.environ["OPENK_RESUME_ON_START"] = "false"

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from backend import config, identity, main, trials
from backend.jobs import JobManager
from backend.security import BrowserOriginMiddleware


class TrialTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="openk-trial-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.songs = JobManager(self.root / "jobs")
        self.now = [time.time()]
        self.store = trials.TrialStore(self.root / "trials.sqlite3", self.songs, lambda: self.now[0])
        self.guest = trials.Guest(str(uuid.uuid4()), int(self.now[0] + trials.SESSION_SECONDS))
        self.key = b"synthetic-trial-proxy-key-" + b"a" * 32
        self.first = self.song("First song", b"first")
        self.second = self.song("Second song", b"second")
        self.app = FastAPI()
        self.app.add_middleware(main.ApiGZipMiddleware, minimum_size=1024)
        self.app.add_middleware(BrowserOriginMiddleware)
        self.app.add_middleware(trials.TrialBoundaryMiddleware)
        self.app.include_router(trials.create_router(main.MediaStaticFiles(directory=self.songs.jobs_dir)))
        self.app.include_router(identity.router)

        @self.app.api_route("/api/jobs", methods=["GET", "POST", "DELETE"])
        @self.app.get("/media/private")
        @self.app.get("/admin")
        @self.app.get("/api/rooms")
        def ordinary():
            return {"ordinary_route": True}

        for target, name, value in (
            (config, "GUEST_TRIAL_ENABLED", True),
            (identity, "KEY", self.key),
            (trials, "get_store", lambda: self.store),
        ):
            guard = patch.object(target, name, value)
            guard.start()
            self.addCleanup(guard.stop)
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)

    def song(self, title, content):
        job = self.songs.create(f"https://example.org/{uuid.uuid4().hex}")
        directory = self.songs.job_dir(job["id"])
        (directory / "stems").mkdir()
        (directory / "stems" / "instrumental.wav").write_bytes(b"RIFF" + content * 2048)
        (directory / "stems" / "vocals.wav").write_bytes(b"RIFF" + b"guide" * 2048)
        (directory / "lyrics.json").write_text(json.dumps({
            "lines": [{"start": 0, "end": 1, "text": "Synthetic lyrics"}] * 100,
        }))
        self.songs.update(
            job["id"], state="done", track=title, title=title, artist="Synthetic singer",
            duration=18, stems={"instrumental": "instrumental.wav", "vocals": "vocals.wav"},
            lyrics_file="lyrics.json", local_path="/private/source/song.wav",
            recordings=[{"file": "private-recording.wav", "title": "Private recording"}],
        )
        return job["id"]

    def headers(self, guest=None, **changes):
        guest = guest or self.guest
        assertion = base64.urlsafe_b64encode(json.dumps({
            "id": guest.id, "expires_at": guest.expires_at,
        }).encode()).decode()
        return {
            "Origin": "http://testserver",
            "X-OpenK-Identity-Key": self.key.decode(),
            "X-OpenK-Guest": assertion,
            **changes,
        }

    def request(self, method, path, **kwargs):
        kwargs.setdefault("headers", self.headers())
        return self.client.request(method, "/api/trial/" + path, **kwargs)

    def select(self, job_id=None):
        return self.request("POST", "select", json={"job_id": job_id or self.first})

    def test_flag_and_hop_are_required_before_opening_the_trial_store(self):
        with patch.object(trials, "get_store", side_effect=AssertionError("No store for denied requests")):
            for headers in ({}, {"X-OpenK-Guest": self.headers()["X-OpenK-Guest"]},
                            self.headers(**{"X-OpenK-Identity-Key": "wrong-key"})):
                self.assertEqual(self.request("GET", "state", headers=headers).status_code, 401)
            with patch.object(config, "GUEST_TRIAL_ENABLED", False):
                self.assertEqual(self.request("GET", "state").status_code, 404)
            with patch.object(identity, "KEY", b""):
                self.assertEqual(self.request("GET", "state").status_code, 404)

    def test_invalid_assertions_and_account_mixing_are_rejected(self):
        invalid = [
            "not-base64!", base64.urlsafe_b64encode(b"[]").decode(),
            base64.urlsafe_b64encode(json.dumps({
                "id": self.guest.id, "expires_at": True,
            }).encode()).decode(),
            base64.urlsafe_b64encode(json.dumps({
                "id": self.guest.id, "expires_at": self.guest.expires_at, "is_staff": True,
            }).encode()).decode(),
        ]
        for value in invalid:
            with self.subTest(value=value[:20]):
                response = self.request("GET", "state", headers=self.headers(**{"X-OpenK-Guest": value}))
                self.assertEqual(response.status_code, 401)
                self.assertIn("no-store", response.headers["cache-control"])
        for guest in (trials.Guest("not-a-uuid", self.guest.expires_at),
                      trials.Guest(self.guest.id, self.guest.expires_at + 3600)):
            self.assertEqual(self.request("GET", "state", headers=self.headers(guest)).status_code, 401)
        self.assertEqual(self.request(
            "GET", "state", headers=self.headers(**{"X-OpenK-Account": "another-assertion"})).status_code, 401)
        expired = trials.Guest(self.guest.id, int(time.time()) - 1)
        self.assertEqual(self.request("GET", "state", headers=self.headers(expired)).status_code, 410)

    def test_guest_assertion_never_authorizes_ordinary_routes(self):
        for path in ("/api/jobs", "/api/rooms", "/api/account", "/media/private", "/admin"):
            with self.subTest(path=path):
                response = self.client.get(path, headers=self.headers())
                self.assertEqual(response.status_code, 403)
                self.assertNotIn("ordinary_route", response.text)
        self.assertEqual(self.client.post("/api/jobs", headers=self.headers(), json={}).status_code, 403)
        self.assertEqual(self.client.get("/api/jobs").json(), {"ordinary_route": True})

    def test_catalog_exposes_only_bounded_safe_metadata(self):
        response = self.request("GET", "catalog")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["limit"], 50)
        self.assertEqual(len(data["songs"]), 2)
        for song in data["songs"]:
            self.assertEqual(set(song), {"id", "title", "track", "artist", "duration"})
        for secret in ("local_path", "/private/source", "recording", "webpage_url", "/media/"):
            self.assertNotIn(secret, response.text)
        self.assertEqual(self.request("GET", "catalog", params={"q": "second"}).json()["songs"][0]["id"],
                         self.second)
        self.assertEqual(self.request("GET", "catalog", params={"q": "x" * 121}).status_code, 422)
        self.songs.update(self.second, duration=float("nan"))
        self.assertEqual(len(self.request("GET", "catalog").json()["songs"]), 1)
        self.songs.update(self.second, duration=trials.MAX_SONG_SECONDS + 1)
        self.assertEqual(self.select(self.second).status_code, 404)
        self.assertEqual(self.request("GET", "state").json()["status"], "available")

    def test_selection_is_final_idempotent_and_persistent(self):
        before = self.request("GET", "state").json()
        self.assertEqual(before["status"], "available")
        self.assertIsNone(before["song"])
        selected = self.select()
        self.assertEqual(selected.status_code, 200)
        data = selected.json()
        self.assertEqual(data["status"], "active")
        self.assertEqual(data["song"]["id"], self.first)
        self.assertEqual(data["song"]["media"], {
            "instrumental": "/api/trial/media/instrumental",
            "vocals": "/api/trial/media/vocals", "lyrics": "/api/trial/lyrics",
        })
        self.assertEqual(data["remaining_seconds"], 18 + trials.PLAYBACK_GRACE_SECONDS)
        self.now[0] += 30
        self.assertEqual(self.select().json()["expires_at"], data["expires_at"])
        self.assertEqual(self.select(self.second).status_code, 409)
        self.store = trials.TrialStore(self.store.path, self.songs, lambda: self.now[0])
        self.assertEqual(self.request("GET", "state").json()["song"]["id"], self.first)
        self.assertEqual(self.select(self.second).status_code, 409)
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)

    def test_catalog_really_caps_results_at_fifty(self):
        for number in range(51):
            self.song(f"Catalog fixture {number:02d}", b"catalog")
        response = self.request("GET", "catalog", params={"limit": 1000000})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["songs"]), 50)
        self.assertEqual(len(self.songs.list()), 53)

    def test_selection_window_cannot_outlive_its_original_session(self):
        short = trials.Guest(str(uuid.uuid4()), int(self.now[0]) + 10)
        selected = self.store.select(short, self.first)
        self.assertEqual(selected["expires_at"], short.expires_at)
        self.now[0] = short.expires_at
        self.assertEqual(self.store.state(short)["status"], "expired")
        with self.assertRaises(HTTPException) as caught:
            self.store.select(short, self.second)
        self.assertEqual(caught.exception.status_code, 410)

    def test_cleanup_does_not_restore_an_unexpired_completed_trial(self):
        self.store.select(self.guest, self.first)
        self.store.complete(self.guest)
        expired = trials.Guest(str(uuid.uuid4()), int(self.now[0]) + 1)
        self.store.select(expired, self.first)
        self.now[0] += 2
        newcomer = trials.Guest(str(uuid.uuid4()), self.guest.expires_at)
        self.store.select(newcomer, self.second)
        self.assertEqual(self.store.state(self.guest)["status"], "complete")
        with self.assertRaises(HTTPException) as caught:
            self.store.select(self.guest, self.second)
        self.assertEqual(caught.exception.status_code, 410)
        self.assertEqual(self.store.state(expired)["status"], "expired")

    def test_unavailable_selected_song_never_unlocks_another_choice(self):
        self.select()
        self.songs.update(self.first, state="error")
        self.assertEqual(self.select(self.second).status_code, 404)
        self.songs.update(self.first, state="done")
        self.assertEqual(self.request("GET", "state").json()["song"]["id"], self.first)
        self.assertEqual(self.select(self.second).status_code, 409)

    def test_concurrent_tabs_cannot_choose_two_songs(self):
        def choose(job_id):
            try:
                return self.store.select(self.guest, job_id)["song"]["id"]
            except HTTPException as exc:
                return exc.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(choose, [self.first, self.second]))
        self.assertEqual(results.count(409), 1)
        chosen = self.store.state(self.guest)["song"]["id"]
        self.assertIn(chosen, results)

    def test_sessions_are_independent_and_existing_expiry_cannot_be_extended(self):
        self.select()
        second_guest = trials.Guest(str(uuid.uuid4()), self.guest.expires_at)
        self.assertEqual(self.request("POST", "select", headers=self.headers(second_guest),
                                      json={"job_id": self.second}).status_code, 200)
        changed = trials.Guest(self.guest.id, self.guest.expires_at + 1)
        self.assertEqual(self.request("GET", "state", headers=self.headers(changed)).status_code, 401)
        self.assertEqual(self.store.state(second_guest)["song"]["id"], self.second)

    def test_media_requires_selection_and_only_serves_its_declared_assets(self):
        for path in ("media/instrumental", "media/vocals", "lyrics"):
            self.assertEqual(self.request("GET", path).status_code, 409)
        self.select()
        response = self.request("GET", "media/instrumental", params={"job_id": self.second})
        self.assertEqual(response.content, b"RIFF" + b"first" * 2048)
        self.assertIn("sandbox", response.headers["content-security-policy"])
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual(self.request("GET", "media/status.json").status_code, 422)
        self.assertEqual(self.request("GET", f"media/{self.second}/instrumental").status_code, 404)
        self.assertEqual(self.request("GET", "media/recordings").status_code, 422)
        self.assertEqual(self.request("GET", "lyrics").json()["lines"][0]["text"], "Synthetic lyrics")

    def test_media_and_lyrics_ranges_are_not_compressed_or_reused_after_completion(self):
        self.select()
        for path, content_type in (("media/instrumental", "audio/wav"), ("lyrics", "application/json")):
            with self.subTest(path=path):
                response = self.request("GET", path, headers=self.headers(
                    Range="bytes=0-2047", **{"Accept-Encoding": "gzip"}))
                self.assertEqual(response.status_code, 206)
                self.assertEqual(len(response.content), 2048)
                self.assertNotIn("content-encoding", response.headers)
                self.assertEqual(response.headers["content-type"], content_type)
                self.assertEqual(self.request("HEAD", path).content, b"")
        self.request("POST", "complete", json={})
        self.assertEqual(self.request("GET", "media/instrumental", headers=self.headers(
            Range="bytes=0-15", **{"If-None-Match": response.headers["etag"]})).status_code, 410)

    def test_completion_survives_restart_and_cannot_be_reset(self):
        self.select()
        response = self.request("POST", "complete", json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "complete")
        self.assertIsNone(response.json()["song"])
        self.assertEqual(self.request("POST", "complete", json={}).json()["status"], "complete")
        self.store = trials.TrialStore(self.store.path, self.songs, lambda: self.now[0])
        self.assertEqual(self.request("GET", "state").json()["status"], "complete")
        for path in ("catalog", "lyrics", "media/instrumental", "media/vocals"):
            self.assertEqual(self.request("GET", path).status_code, 410)
        self.assertEqual(self.select().status_code, 410)
        self.assertEqual(self.select(self.second).status_code, 410)

    def test_expiry_consumes_the_selection_without_needing_a_browser_end_report(self):
        self.select()
        self.now[0] += 18 + trials.PLAYBACK_GRACE_SECONDS
        self.assertEqual(self.request("GET", "state").json()["status"], "expired")
        self.assertEqual(self.select(self.second).status_code, 410)
        self.assertEqual(self.request("GET", "media/instrumental").status_code, 410)
        self.assertEqual(self.request("POST", "complete", json={}).json()["status"], "expired")

    def test_invalid_or_missing_songs_and_assets_do_not_consume_the_trial(self):
        self.assertEqual(self.select("a" * 12).status_code, 404)
        self.songs.update(self.first, stems={"instrumental": "../status.json"})
        self.assertEqual(self.select().status_code, 404)
        self.assertEqual(self.request("GET", "state").json()["status"], "available")
        self.assertEqual(self.select(self.second).status_code, 200)

    def test_symlinks_cannot_cross_into_another_song(self):
        folder = self.songs.job_dir(self.first) / "stems"
        link = folder / "linked.wav"
        link.symlink_to(self.songs.job_dir(self.second) / "stems" / "instrumental.wav")
        self.songs.update(self.first, stems={"instrumental": "linked.wav"})
        self.assertEqual(self.select().status_code, 404)
        self.assertEqual(self.request("GET", "state").json()["status"], "available")

    def test_nested_published_stems_work_without_exposing_a_freeform_path(self):
        directory = self.songs.job_dir(self.first) / "stems" / ".openk-results" / "published"
        directory.mkdir(parents=True)
        (directory / "instrumental.wav").write_bytes(b"RIFFpublished")
        self.songs.update(self.first, stems={"instrumental": ".openk-results/published/instrumental.wav"})
        response = self.select()
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["song"]["has_vocals"])
        self.assertEqual(self.request("GET", "media/instrumental").content, b"RIFFpublished")

    def test_origin_and_strict_request_shapes_protect_trial_mutations(self):
        for headers in (self.headers(Origin="https://hostile.invalid"), self.headers(Origin="null")):
            self.assertEqual(self.request("POST", "select", headers=headers,
                                          json={"job_id": self.first}).status_code, 403)
        missing = self.headers()
        del missing["Origin"]
        self.assertEqual(self.request("POST", "select", headers=missing,
                                      json={"job_id": self.first}).status_code, 403)
        for body in ({"job_id": "../song"}, {"job_id": self.first, "expires_at": 9999999999}):
            self.assertEqual(self.request("POST", "select", json=body).status_code, 422)
        self.assertEqual(self.request("POST", "complete", json={"reset": True}).status_code, 422)
        self.assertEqual(self.request("POST", "complete", json={}).status_code, 409)

    def test_trial_pages_and_exact_assets_are_feature_gated(self):
        frontend = self.root / "frontend" / "trial"
        frontend.mkdir(parents=True)
        for filename in ("index.html", "trial.js", "trial.css"):
            (frontend / filename).write_text("synthetic trial asset")
        with patch.object(config, "FRONTEND_DIR", frontend.parent), TestClient(main.app) as client:
            for path in ("/try", "/try/", "/trial-assets/trial.js", "/trial-assets/trial.css"):
                self.assertEqual(client.get(path).status_code, 200)
                self.assertEqual(client.head(path).status_code, 200)
                with patch.object(config, "GUEST_TRIAL_ENABLED", False):
                    self.assertEqual(client.get(path).status_code, 404)
            self.assertEqual(client.get("/trial-assets/app.js").status_code, 404)
            for path in ("/trial", "/trial/", "/trial/index.html",
                         "/trial/trial.js", "/trial/trial.css", "/trial%2ftrial.js"):
                for enabled in (True, False):
                    with self.subTest(path=path, enabled=enabled):
                        with patch.object(config, "GUEST_TRIAL_ENABLED", enabled):
                            self.assertEqual(client.get(path).status_code, 404)

    def test_enabled_trial_without_proxy_key_fails_startup(self):
        environment = dict(os.environ, OPENK_GUEST_TRIAL_ENABLED="true", OPENK_IDENTITY_KEY_FILE="",
                           OPENK_DATA_DIR=str(self.root / "startup"),
                           OPENK_JOBS_DIR=str(self.root / "startup" / "jobs"))
        result = subprocess.run([sys.executable, "-c", "from backend import main"],
                                cwd=PROJECT_ROOT, env=environment,
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires a configured authenticated proxy identity key", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
