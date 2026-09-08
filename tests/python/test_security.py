"""Origin checks reject browser side effects without changing CLI/worker access."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

_temporary = tempfile.TemporaryDirectory(prefix="openk-security-")
os.environ["OPENK_DATA_DIR"] = _temporary.name
os.environ["OPENK_JOBS_DIR"] = str(Path(_temporary.name) / "jobs")
os.environ["OPENK_RESUME_ON_START"] = "false"
os.environ["OPENK_ALLOWED_ORIGINS"] = ""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from backend import config, main, rooms
from backend.security import BrowserOriginMiddleware


class OriginTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)

    def test_simple_cross_origin_posts_do_not_create_rooms(self):
        before = len(rooms.store.rooms)
        with patch.object(rooms.store, "create") as create:
            for origin in ("https://untrusted.example", "null", "http://testserver:81", "https://testserver"):
                for content_type in ("text/plain", "application/x-www-form-urlencoded", "application/json"):
                    with self.subTest(origin=origin, content_type=content_type):
                        response = self.client.post("/api/rooms", content=b"", headers={
                            "Origin": origin, "Content-Type": content_type})
                        self.assertEqual(response.status_code, 403)
                        self.assertNotIn("access-control-allow-origin", response.headers)
            create.assert_not_called()
        self.assertEqual(len(rooms.store.rooms), before)

    def test_cli_and_same_origin_posts_still_reach_the_handler(self):
        with patch.object(rooms.store, "create", return_value={"demo": True}) as create:
            for headers in ({}, {"Origin": "http://testserver"}, {"Origin": "http://testserver:80"}):
                self.assertEqual(self.client.post("/api/rooms", headers=headers).status_code, 200)
            self.assertEqual(create.call_count, 3)

    def test_duplicate_or_missing_cross_site_origins_are_rejected(self):
        with patch.object(rooms.store, "create") as create:
            duplicate = self.client.post("/api/rooms", headers=[
                ("Origin", "http://testserver"), ("Origin", "https://untrusted.example")])
            self.assertEqual(duplicate.status_code, 403)
            missing = self.client.post("/api/rooms", headers={"Sec-Fetch-Site": "cross-site"})
            self.assertEqual(missing.status_code, 403)
            create.assert_not_called()

    def test_cross_origin_delete_is_rejected_before_job_mutation(self):
        with patch.object(main.manager, "delete") as delete:
            response = self.client.delete("/api/jobs/000000000001",
                                          headers={"Origin": "https://untrusted.example"})
            self.assertEqual(response.status_code, 403)
            delete.assert_not_called()

    def test_default_cors_does_not_allow_external_reads_or_preflights(self):
        response = self.client.get("/api/jobs", headers={"Origin": "https://untrusted.example"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("access-control-allow-origin", response.headers)
        preflight = self.client.options("/api/rooms", headers={
            "Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization,Content-Type"})
        self.assertEqual(preflight.status_code, 400)
        self.assertNotIn("access-control-allow-origin", preflight.headers)

    def test_explicit_trusted_origin_and_https_proxy_origin(self):
        allowed = config.parse_allowed_origins("https://trusted.example/")
        app = FastAPI()
        app.add_middleware(CORSMiddleware, allow_origins=list(allowed), allow_methods=["*"],
                           allow_headers=["*"])
        app.add_middleware(BrowserOriginMiddleware, allowed_origins=allowed)
        calls = []

        @app.post("/api/rooms")
        def create():
            calls.append(True)
            return {"demo": True}

        with TestClient(app, base_url="https://openk.example:8443") as client:
            for origin in ("https://openk.example:8443", "https://trusted.example"):
                response = client.post("/api/rooms", headers={"Origin": origin})
                self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["access-control-allow-origin"], "https://trusted.example")
            self.assertEqual(client.post("/api/rooms", headers={
                "Origin": "https://openk.example"}).status_code, 403)
        self.assertEqual(len(calls), 2)

    def test_origin_normalization_rejects_unsafe_configuration(self):
        self.assertEqual(config.normalize_origin("HTTPS://Example.ORG:443/"), "https://example.org")
        self.assertEqual(config.normalize_origin("http://[::1]:8000"), "http://[::1]:8000")
        self.assertEqual(config.parse_allowed_origins("https://example.org,https://example.org/"),
                         ("https://example.org",))
        for value in ("*", "null", "file://example.org", "https://user:password@example.org",
                      "https://example.org/private", "https://example.org?key=value",
                      "https://example.org#fragment", "https://example.org:bad",
                      "https://example.org\n", "https://example.org\\evil"):
            with self.subTest(value=value):
                self.assertIsNone(config.normalize_origin(value))
                if not value.endswith("\n"):
                    with self.assertRaises(ValueError):
                        config.parse_allowed_origins(value)


if __name__ == "__main__":
    unittest.main()
