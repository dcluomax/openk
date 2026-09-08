"""Publication policy and deployment-template regressions without a Docker daemon."""
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

import yaml

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

ROOT = PROJECT_ROOT


class DocumentLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
        self.images = []

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "a" and attrs.get("href"):
            self.links.append(attrs["href"])
        if tag == "img" and attrs.get("src"):
            self.links.append(attrs["src"])
            self.images.append((attrs["src"], attrs.get("alt", "")))


class DocumentationTests(unittest.TestCase):
    def test_local_links_and_public_screenshots_are_complete(self):
        documents = [ROOT / name for name in ("README.md", "CHANGELOG.md", "SECURITY.md")]
        documents.extend(sorted((ROOT / "docs").rglob("*.md")))
        images = set()
        for document in documents:
            text = document.read_text(encoding="utf-8")
            rendered = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
            parser = DocumentLinks()
            parser.feed(rendered)
            links = parser.links + re.findall(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", rendered)
            for target in links:
                url = urlsplit(target)
                if url.scheme or url.netloc or not url.path:
                    continue
                path = (document.parent / unquote(url.path)).resolve()
                with self.subTest(document=str(document.relative_to(ROOT)), target=target):
                    self.assertTrue(path.is_relative_to(ROOT), "Document link escapes repository")
                    self.assertTrue(path.exists(), "Missing local document or image")
            for target, alt in parser.images:
                with self.subTest(image=target):
                    self.assertTrue(alt.strip(), "Screenshots need descriptive alternative text")
                    url = urlsplit(target)
                    self.assertFalse(url.scheme or url.netloc, "Public screenshots must be checked in")
                    path = (document.parent / unquote(url.path)).resolve()
                    data = path.read_bytes()
                    self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
                    width, height = struct.unpack(">II", data[16:24])
                    self.assertGreater(width, 0)
                    self.assertGreater(height, 0)
                    images.add(path)
        self.assertEqual(images, set((ROOT / "docs/screenshots").glob("*.png")),
                         "Only documented public screenshots belong in docs/screenshots")


class ReleasePolicyTests(unittest.TestCase):
    def setUp(self):
        self.release = yaml.load(
            (ROOT / ".github/workflows/docker-publish.yml").read_text(), Loader=yaml.BaseLoader)
        self.tests = yaml.load(
            (ROOT / ".github/workflows/tests.yml").read_text(), Loader=yaml.BaseLoader)

    def test_release_is_gated_and_actions_are_immutable(self):
        self.assertEqual(self.release["jobs"]["build"]["needs"], "test")
        self.assertEqual(self.release["jobs"]["test"]["uses"], "./.github/workflows/tests.yml")
        for workflow in (self.release, self.tests):
            self.assertEqual(workflow["permissions"], {"contents": "read"})
            for job in workflow["jobs"].values():
                for step in job.get("steps", []):
                    if "uses" in step:
                        self.assertRegex(step["uses"], r"^[\w-]+/[\w-]+@[0-9a-f]{40}$")
                    if step.get("uses", "").startswith("actions/checkout@"):
                        self.assertEqual(step["with"]["persist-credentials"], "false")

    def test_stable_aliases_are_not_published_from_main_or_prereleases(self):
        steps = self.release["jobs"]["merge"]["steps"]
        metadata = next(s["with"] for s in steps
                        if s.get("uses", "").startswith("docker/metadata-action@"))
        self.assertEqual(metadata["flavor"], "latest=false")
        condition = "${{ github.ref_type == 'tag' && !contains(github.ref_name, '-') }}"
        tags = metadata["tags"].splitlines()
        self.assertIn("type=ref,event=branch", tags)
        self.assertIn("type=ref,event=tag", tags)
        for alias in ("stable", "latest"):
            self.assertIn(f"type=raw,value={alias},enable={condition}", tags)
        self.assertEqual(self.release["on"]["push"]["branches"], ["main"])

    def test_actual_tag_gate_rejects_invalid_release_names(self):
        gate = next(s for s in self.release["jobs"]["build"]["steps"]
                    if s.get("name") == "校验版本标签")
        self.assertEqual(gate["if"], "github.ref_type == 'tag'")
        for tag, valid in (("v1.0.0", True), ("v1.0.0-rc.1", True),
                           ("v01.0.0", False), ("v1.0", False), ("version", False),
                           ("v1.0.0 extra", False)):
            with self.subTest(tag=tag):
                result = subprocess.run(["bash", "-c", gate["run"]],
                                        env={"PATH": os.environ["PATH"], "RELEASE_TAG": tag},
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, valid)

    def test_sensitive_runtime_paths_are_excluded(self):
        files = [".env", "worker.env", "openk.env", "worker-token.txt", "server.key",
                 "server.pem", "server.crt", ".worker-work/task/audio.wav",
                 ".test-artifacts/private-screenshot.png"]
        result = subprocess.run(
            ["git", "-c", "core.excludesfile=/dev/null", "check-ignore", "--no-index", "--stdin"],
            cwd=ROOT, input="\n".join(files), capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout.splitlines(), files)
        patterns = set((ROOT / ".dockerignore").read_text().splitlines())
        self.assertTrue({"worker.env", "openk.env", "worker-token.txt", ".worker-work/",
                         "**/worker.env", "**/*.key"} <= patterns)


class DeployTemplateTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="openk-deploy-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ("bin", "data", "media", "library"):
            (self.root / name).mkdir()
        stub = self.root / "bin/docker"
        stub.write_text(f"#!{sys.executable}\n" + '''
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ["FAKE_ROOT"])
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps({"args": args,
        "token_received": os.environ.get("OPENK_WORKER_TOKEN") == "publication-test-token",
        "remote_steps": os.environ.get("OPENK_REMOTE_STEPS")}) + "\\n")
if args[:2] == ["image", "inspect"] and os.environ.get("FAKE_MISSING_IMAGE"):
    sys.exit(1)
if args[0] == "inspect":
    if ".State.Health.Status" in " ".join(args):
        print(os.environ.get("FAKE_HEALTH", "healthy"))
    elif os.environ.get("FAKE_EXISTING") != "1":
        sys.exit(1)
    elif "range .Config.Env" in " ".join(args):
        print("OPENK_WORKER_TOKEN=publication-test-token")
        print("OPENK_REMOTE_STEPS=" + os.environ.get("FAKE_REMOTE", "separate,transcribe,align"))
        print("OPENK_ALLOWED_ORIGINS=https://ui.example")
elif args[0] == "ps":
    print("Up 1 minute (healthy)")
elif args[0] == "run":
    print("f" * 64)
''')
        stub.chmod(0o755)
        self.env = {
            "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"],
            "HOME": str(self.root), "FAKE_ROOT": str(self.root), "FAKE_EXISTING": "1",
            "OPENK_HOST_DATA_DIR": str(self.root / "data"),
            "OPENK_HOST_MEDIA_DIR": str(self.root / "media"),
            "OPENK_HOST_LIBRARY_DIR": str(self.root / "library"),
            "OPENK_RUN_UID": "2345", "OPENK_RUN_GID": "3456", "OPENK_MEDIA_GID": "4567",
        }

    def run_template(self, **extra):
        result = subprocess.run(["bash", str(ROOT / "deploy" / "deploy-openk.sh.example")],
                                env={**self.env, **extra}, capture_output=True, text=True)
        log = self.root / "calls.jsonl"
        calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls

    def test_parameters_credentials_and_previous_container_are_preserved(self):
        result, calls = self.run_template()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = next(call for call in calls if call["args"][0] == "run")
        self.assertTrue(run["token_received"])
        self.assertIn("OPENK_WORKER_TOKEN", run["args"])
        self.assertNotIn("publication-test-token", " ".join(run["args"]))
        self.assertNotIn("publication-test-token", result.stdout + result.stderr)
        self.assertIn("2345:3456", run["args"])
        self.assertIn("4567", run["args"])
        self.assertIn("127.0.0.1:8000:8000", run["args"])
        self.assertIn(str(self.root / "media") + ":/media/ktv:ro", run["args"])
        self.assertTrue(any(call["args"][0] == "rename" for call in calls))
        self.assertFalse(any(call["args"][0] == "rm" for call in calls))
        ps = next(call["args"] for call in calls if call["args"][0] == "ps")
        self.assertIn("name=^openk$", ps)

    def test_explicit_empty_remote_steps_are_not_changed(self):
        result, calls = self.run_template(FAKE_REMOTE="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(next(c["remote_steps"] for c in calls if c["args"][0] == "run"), "")

    def test_missing_image_or_initial_token_never_stops_existing_service(self):
        result, calls = self.run_template(FAKE_MISSING_IMAGE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c["args"][0] in {"stop", "run"} for c in calls))
        (self.root / "calls.jsonl").unlink()
        result, calls = self.run_template(FAKE_EXISTING="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c["args"][0] in {"stop", "run"} for c in calls))

    def test_unhealthy_release_fails_without_deleting_rollback(self):
        result, calls = self.run_template(FAKE_HEALTH="unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("未通过健康检查", result.stderr)
        self.assertFalse(any(line.startswith("容器：") for line in result.stdout.splitlines()))
        self.assertFalse(any(c["args"][0] == "rm" for c in calls))


if __name__ == "__main__":
    unittest.main()
