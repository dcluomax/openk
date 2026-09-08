"""ML-free regression tests for source acquisition, recovery and subtitle contracts."""
from __future__ import annotations

import errno
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

ROOT = PROJECT_ROOT
_configured_artifacts = Path(os.environ.get("TMPDIR", str(ROOT))).resolve()
ARTIFACTS = (_configured_artifacts if _configured_artifacts.is_relative_to(ROOT)
             and _configured_artifacts != ROOT else ROOT / ".test-artifacts" / "processing")
ARTIFACTS.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("OPENK_DATA_DIR", str(ARTIFACTS / "data"))
os.environ.setdefault("OPENK_JOBS_DIR", str(ARTIFACTS / "data" / "jobs"))

from backend import config, pipeline
from backend.jobs import JobCancelledError
from backend.steps import download, execution, library, local_media, lyrics, lyrics_sources, separate, transcribe


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.storage = tempfile.TemporaryDirectory(dir=ARTIFACTS)
        self.root = Path(self.storage.name)
        self.addCleanup(self.storage.cleanup)


class SeparatorCacheTests(FilesTest):
    def test_effective_model_cache_exists_before_cli_starts(self):
        for override in (False, True):
            with self.subTest(environment_override=override):
                models = self.root / str(override) / "models"
                effective = self.root / "explicit-cache" if override else models / "audio-separator"
                output = self.root / str(override) / "output"

                def run(cmd, **kwargs):
                    self.assertTrue(effective.is_dir())
                    self.assertEqual(cmd[cmd.index("--model_file_dir") + 1], str(effective))
                    (output / "vocals.mp3").write_bytes(b"test stem")
                    (output / "instrumental.mp3").write_bytes(b"test stem")
                    return 0, []

                with patch.object(config, "MODELS_DIR", str(models)), \
                     patch.dict(os.environ, {"AUDIO_SEPARATOR_MODEL_DIR": str(effective) if override else ""}), \
                     patch.object(separate.shutil, "which", return_value="audio-separator"), \
                     patch.object(separate, "run_cli", side_effect=run):
                    result = separate._separate_local_once(self.root / "input.wav", output)
                self.assertEqual(result["vocals"], "vocals.mp3")

    def test_unusable_cache_fails_before_launching_cli(self):
        blocked = self.root / "not-a-directory"
        blocked.write_bytes(b"existing file")
        with patch.dict(os.environ, {"AUDIO_SEPARATOR_MODEL_DIR": str(blocked / "models")}), \
             patch.object(separate.shutil, "which", return_value="audio-separator"), \
             patch.object(separate, "run_cli") as run, self.assertRaises(OSError):
            separate._separate_local_once(self.root / "input.wav", self.root / "output")
        run.assert_not_called()


class SubtitleTests(FilesTest):
    def test_each_local_format_avoids_asr(self):
        samples = {
            "lrc": "[00:01.00]hello\n[00:04.00]world\n",
            "vtt": "WEBVTT\n\n00:01.000 --> 00:03.000\nhello\n",
            "srt": "1\n00:00:01,000 --> 00:00:03,000\nhello\n",
            "ass": "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                   "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\k20}hello\n",
        }
        for fmt, contents in samples.items():
            with self.subTest(fmt=fmt):
                directory = self.root / fmt
                directory.mkdir()
                song = directory / "song.flac"
                song.write_bytes(b"audio")
                song.with_suffix(".en." + fmt).write_text(contents)
                out = directory / "out"
                out.mkdir()
                descriptors = local_media._sidecar_subtitles(song, out)
                self.assertEqual(descriptors[0]["origin"], "local")
                self.assertEqual(descriptors[0]["lang"], "en")
                candidate = lyrics_sources.from_subtitles(descriptors)
                self.assertEqual(candidate["lines"][0]["text"], "hello")
                with patch.object(lyrics_sources, "from_lrclib", return_value=None), \
                     patch.object(transcribe, "align_known_lyrics", return_value={"line_count": 1}) as align, \
                     patch.object(transcribe, "transcribe") as asr:
                    lyrics.build({"subtitles": descriptors}, song, out)
                    align.assert_called_once()
                    asr.assert_not_called()

    def test_bad_supplied_subtitles_are_not_silently_transcribed(self):
        path = self.root / "broken.lrc"
        path.write_text("no timestamps")
        with patch.object(lyrics_sources, "from_lrclib", return_value=None), \
             patch.object(transcribe, "transcribe") as asr:
            for subtitles in ([str(path)], [{"path": str(path)}],
                              [{"path": str(path), "format": "unknown"}],
                              [{"path": str(self.root / "missing.srt")}]):
                with self.subTest(subtitles=subtitles), self.assertRaises(lyrics_sources.SubtitleError):
                    lyrics.build({"subtitles": subtitles}, path, self.root)
            asr.assert_not_called()

    def test_unavailable_alignment_falls_back_but_output_errors_propagate(self):
        candidate = {"source": "LRCLIB", "language": "en",
                     "lines": [{"start": 1, "end": 3, "text": "hello"}]}
        with patch.object(lyrics_sources, "from_lrclib", return_value=candidate), \
             patch.object(transcribe, "align_known_lyrics",
                          side_effect=transcribe.AlignmentUnavailable("no model")):
            self.assertEqual(lyrics.build({}, "vocals", self.root)["line_count"], 1)
        with patch.object(lyrics_sources, "from_lrclib", return_value=candidate), \
             patch.object(transcribe, "align_known_lyrics", side_effect=OSError("disk full")), \
             patch.object(transcribe, "save_line_lyrics") as save:
            with self.assertRaisesRegex(OSError, "disk full"):
                lyrics.build({}, "vocals", self.root)
            save.assert_not_called()

    def test_sidecar_prefix_does_not_capture_another_song(self):
        song = self.root / "song.flac"
        song.write_bytes(b"x")
        (self.root / "song-other.lrc").write_text("[00:01]wrong")
        out = self.root / "out"
        out.mkdir()
        self.assertEqual(local_media._sidecar_subtitles(song, out), [])


class ArchiveTests(FilesTest):
    def setUp(self):
        super().setUp()
        self.source = self.root / "source.flac"
        self.source.write_bytes(b"original quality")
        self.library = self.root / "library"
        self.library.mkdir()
        self.patch = patch.object(config, "LIBRARY_DIR", str(self.library))
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_explicit_outcomes_preserve_unsuccessful_sources(self):
        with patch.object(config, "LIBRARY_DIR", ""):
            self.assertEqual(library.archive_result(self.source, "artist", "song").status, "disabled")
        with patch.object(config, "LIBRARY_DIR", str(self.root / "missing")):
            self.assertEqual(library.archive_result(self.source, "artist", "song").status, "failed")
        self.assertEqual(library.archive_result(self.source, "artist", None).status, "skipped")
        target = self.library / "artist - song.flac"
        target.write_bytes(b"another version")
        self.assertEqual(library.archive_result(self.source, "artist", "song").status, "conflict")
        self.assertEqual(self.source.read_bytes(), b"original quality")
        self.assertEqual(target.read_bytes(), b"another version")

    def test_copy_failure_and_publication_race_preserve_source(self):
        with patch.object(library.os, "link", side_effect=OSError(errno.EXDEV, "different device")), \
             patch.object(library.shutil, "copyfile", side_effect=OSError("disk full")):
            self.assertEqual(library.archive_result(self.source, "artist", "song").status, "failed")
        with patch.object(library.os, "link", side_effect=FileExistsError()):
            self.assertEqual(library.archive_result(self.source, "artist", "song").status, "conflict")
        self.assertTrue(self.source.exists())

    def test_success_and_cross_device_copy_publish_original_bytes(self):
        actual_link = os.link
        calls = []

        def cross_device(src, dst):
            calls.append(src)
            if len(calls) == 1:
                raise OSError(errno.EXDEV, "different device")
            return actual_link(src, dst)

        with patch.object(library.os, "link", side_effect=cross_device):
            result = library.archive_result(self.source, "artist", "song")
        self.assertEqual(result.status, "archived")
        self.assertEqual(result.path.read_bytes(), b"original quality")
        self.assertFalse(self.source.exists())
        self.assertEqual(list(self.library.glob("*.part")), [])


class ImportTests(FilesTest):
    def test_download_rejects_known_duration_before_writing_audio(self):
        source = self.root / "source.flac"

        class YoutubeDL:
            def __init__(self, opts):
                self.opts = opts

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def extract_info(self, url, download):
                self.opts["match_filter"]({"duration": 200})
                source.write_bytes(b"must not download")

        fake = types.SimpleNamespace(YoutubeDL=YoutubeDL, utils=types.SimpleNamespace(DownloadError=ValueError))
        with patch.dict(sys.modules, {"yt_dlp": fake}), patch.object(config, "MAX_SONG_SECONDS", 100):
            with self.assertRaisesRegex(RuntimeError, "超过"):
                download.download_audio("https://example.invalid/song", self.root)
        self.assertFalse(source.exists())

    def test_streamed_copy_and_early_duration_gate(self):
        source = self.root / "song.flac"
        source.write_bytes(b"original quality")
        with patch.object(config, "LOCAL_MEDIA_DIRS", [str(self.root)]), \
             patch.object(local_media, "_ffprobe_duration", return_value=20), \
             patch.object(local_media, "_grab_thumbnail", return_value=None), \
             patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
            info = local_media.ingest(str(source), self.root / "out")
            self.assertTrue(Path(info["audio_path"]).exists())
        with patch.object(config, "LOCAL_MEDIA_DIRS", [str(self.root)]), \
             patch.object(config, "MAX_SONG_SECONDS", 100), \
             patch.object(local_media, "_ffprobe_duration", return_value=200), \
             patch.object(local_media.shutil, "copyfile") as copy:
            with self.assertRaisesRegex(RuntimeError, "超过"):
                local_media.ingest(str(source), self.root / "oversized")
            copy.assert_not_called()

    def test_pruning_order_limit_and_duration_cache(self):
        media = self.root / "media"
        media.mkdir()
        for name in ("a.flac", "b.flac", "c.flac", "_hidden/h.flac", "z/d.flac"):
            path = media / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(b"x")
        actual_scandir = os.scandir
        visited = []

        def scandir(path):
            visited.append(str(path))
            return actual_scandir(path)

        with patch.object(config, "LOCAL_MEDIA_DIRS", [str(media)]), \
             patch.object(config, "DATA_DIR", self.root / "index"), \
             patch.object(local_media, "_ffprobe_duration", return_value=20) as probe, \
             patch.object(local_media.os, "scandir", side_effect=scandir):
            first = local_media.scan(limit=2)
            second = local_media.scan(limit=2)
            self.assertEqual([Path(e["path"]).name for e in first["entries"]], ["a.flac", "b.flac"])
            self.assertEqual(first["entries"], second["entries"])
            self.assertTrue(first["truncated"])
            self.assertEqual(probe.call_count, 2)
            self.assertFalse(any("_hidden" in path or path.endswith("/z") for path in visited))

    def test_copy_failure_uses_lossless_container_before_transcoding(self):
        commands = []

        def run(command, **kwargs):
            commands.append(command)
            if str(command[-1]).endswith(".mka"):
                Path(command[-1]).write_bytes(b"original stream")
                return Mock(returncode=0)
            return Mock(returncode=1, stderr="unsupported container")

        with patch.object(local_media.subprocess, "run", side_effect=run):
            out = local_media._extract_audio(self.root / "song.webm", self.root, None)
        self.assertEqual(out.suffix, ".mka")
        self.assertEqual(len(commands), 2)
        self.assertTrue(all(command[command.index("-c:a") + 1] == "copy" for command in commands))


class ExecutionTests(FilesTest):
    def test_alignment_entrypoint_reports_invalid_request_without_loading_model(self):
        with patch.dict(os.environ, {"OPENK_TASK_SUPERVISED": "0"}):
            code, lines = execution.run_cli(
                [sys.executable, "-m", "backend.steps.align_runner"],
                timeout=5, label="test", input_text="{}")
        self.assertEqual(code, 1)
        self.assertTrue(any('OPENK_ALIGN_EVENT ' in line and '"kind": "failed"' in line
                            for line in lines))

    def test_cancellation_is_polled_even_without_progress_output(self):
        calls = []

        def check():
            calls.append(1)
            if len(calls) >= 3:
                raise pipeline.PipelineCancelled()

        with patch.dict(os.environ, {"OPENK_TASK_SUPERVISED": "0"}), \
             execution.cancellation_checks(check), self.assertRaises(pipeline.PipelineCancelled):
            execution.run_cli([sys.executable, "-c", "import time; time.sleep(30)"],
                              timeout=5, label="test")
        self.assertEqual(len(calls), 3)

    def test_timeout_and_cancellation_reap_child_without_models(self):
        with patch.dict(os.environ, {"OPENK_TASK_SUPERVISED": "0"}):
            for mode in ("timeout", "cancel"):
                with self.subTest(mode=mode), \
                     patch.object(execution.subprocess, "Popen", wraps=subprocess.Popen) as popen:
                    children = []
                    def start(*args, **kwargs):
                        child = popen._mock_wraps(*args, **kwargs)
                        children.append(child)
                        return child

                    popen.side_effect = start
                    if mode == "timeout":
                        with self.assertRaises(execution.StepTimeout):
                            execution.run_cli(
                                [sys.executable, "-c", "import time; time.sleep(30)"],
                                timeout=0.1, label="test")
                    else:
                        def cancel(line):
                            raise pipeline.PipelineCancelled()

                        with self.assertRaises(pipeline.PipelineCancelled):
                            execution.run_cli(
                                [sys.executable, "-c", "import time; print('ready', flush=True); time.sleep(30)"],
                                timeout=5, label="test", on_line=cancel)
                    self.assertIsNotNone(children[0].poll())

    def test_alignment_worker_supervision_avoids_nested_model_process(self):
        with patch.dict(os.environ, {"OPENK_TASK_SUPERVISED": "1"}), \
             patch.object(transcribe, "_align_known_lyrics_local_once", return_value={"line_count": 1}) as once, \
             patch.object(transcribe, "run_cli") as run:
            result = transcribe.align_known_lyrics_local("vocals", [], "en", self.root, "test")
        self.assertEqual(result["line_count"], 1)
        once.assert_called_once()
        run.assert_not_called()

    def test_alignment_output_error_is_not_downgraded(self):
        def run(*args, **kwargs):
            kwargs["on_line"]('OPENK_ALIGN_EVENT {"error": "disk full", "kind": "io"}')
            return 1, []

        with patch.dict(os.environ, {"OPENK_TASK_SUPERVISED": "0"}), \
             patch.object(transcribe, "run_cli", side_effect=run):
            with self.assertRaisesRegex(OSError, "disk full"):
                transcribe.align_known_lyrics_local("vocals", [], "en", self.root, "test")

    def test_worker_model_unavailable_saves_valid_line_outputs(self):
        with patch.dict(os.environ, {"OPENK_TASK_SUPERVISED": "1"}), \
             patch.object(transcribe, "_align_known_lyrics_local_once",
                          side_effect=transcribe.AlignmentUnavailable("no model")):
            result = transcribe.align_known_lyrics_local(
                "vocals", [{"start": 0, "end": 2, "text": "hello"}], "en", self.root, "local")
        self.assertEqual(result["line_count"], 1)
        self.assertTrue((self.root / "lyrics.json").is_file())
        self.assertTrue((self.root / "lyrics.lrc").is_file())

    def test_asr_rejects_stale_json_and_propagates_output_failure(self):
        (self.root / "lyrics.json").write_text('{"segments": []}')
        with patch.object(transcribe.shutil, "which", return_value="whisperx"), \
             patch.object(transcribe, "run_cli", return_value=(0, [])):
            with self.assertRaisesRegex(RuntimeError, "本次任务"):
                transcribe.transcribe_local("vocals.mp3", self.root)

        def run(command, **kwargs):
            directory = Path(command[command.index("--output_dir") + 1])
            (directory / "vocals.json").write_text('{"segments": [], "language": "en"}')
            return 0, []

        with patch.object(transcribe.shutil, "which", return_value="whisperx"), \
             patch.object(transcribe, "run_cli", side_effect=run), \
             patch.object(transcribe, "_finalize", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                transcribe.transcribe_local("vocals.mp3", self.root)

    def test_alignment_model_failure_is_distinct_from_output_failure(self):
        fake = types.SimpleNamespace(
            load_audio=lambda path: [0] * 16000,
            load_align_model=Mock(return_value=(None, None)),
            align=Mock(return_value={"segments": []}),
        )
        with patch.dict(sys.modules, {"whisperx": fake}), \
             patch.object(transcribe, "_ensure_nltk_punkt"), \
             patch.object(config, "LYRICS_OFFSET_AUTO", False):
            fake.load_align_model.side_effect = RuntimeError("model missing")
            with self.assertRaises(transcribe.AlignmentUnavailable):
                transcribe._align_known_lyrics_local_once("vocals", [], "en", self.root, "test")
            fake.load_align_model.side_effect = None
            with patch.object(transcribe, "_finalize", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    transcribe._align_known_lyrics_local_once(
                        "vocals", [{"start": 0, "end": 1, "text": "hello"}],
                        "en", self.root, "test")


class FakeManager:
    def __init__(self, directory, job):
        self.directory = directory
        self.job = job
        self.job.setdefault("generation", "generation-1")
        self.cancelled = False
        self.generation = None

    @contextmanager
    def execution(self, job_id, generation=None):
        if self.job is None or (generation is not None and generation != self.job["generation"]):
            raise JobCancelledError("stale generation")
        self.generation = generation or self.job["generation"]
        try:
            yield dict(self.job)
        finally:
            self.generation = None

    def check_active(self, job_id):
        if self.is_cancelled(job_id):
            raise JobCancelledError("cancelled")

    def get(self, job_id):
        return dict(self.job) if self.job is not None else None

    def is_cancelled(self, job_id):
        return (self.cancelled or self.job is None
                or (self.generation is not None and self.generation != self.job["generation"]))

    def update(self, job_id, **values):
        if self.job is None:
            raise AssertionError("updated deleted job")
        self.job.update(values)

    def job_dir(self, job_id):
        return self.directory


class PipelineTests(FilesTest):
    def setUp(self):
        super().setUp()
        self.manager = FakeManager(self.root, {
            "url": "https://example.invalid/song", "id": "job", "title": "song",
            "artist": "artist", "track": "song", "duration": 20,
        })
        self.download_calls = 0
        self.separate_calls = 0

        def download(url, directory, **kwargs):
            self.download_calls += 1
            directory.mkdir(exist_ok=True)
            path = directory / "source.flac"
            path.write_bytes(b"original")
            return {"audio_path": str(path), "duration": 20, "title": "song",
                    "artist": "artist", "track": "song", "subtitles": []}

        def separate(source, directory, **kwargs):
            self.separate_calls += 1
            directory.mkdir(exist_ok=True)
            for name in ("vocals.mp3", "instrumental.mp3"):
                (directory / name).write_bytes(b"complete stem")
            return {"vocals": "vocals.mp3", "instrumental": "instrumental.mp3"}

        self.patches = [
            patch.object(pipeline, "manager", self.manager),
            patch.object(config, "KEEP_SOURCE", True),
            patch.object(config, "LIBRARY_ARCHIVE_DOWNLOADS", False),
            patch.object(pipeline.download, "download_audio", side_effect=download),
            patch.object(pipeline.separate, "separate", side_effect=separate),
            patch.object(pipeline.lyrics, "build", return_value={
                "line_count": 1, "lyrics_file": "lyrics.json", "language": "en", "source": "test"}),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_lyrics_retry_reuses_stems_and_source_metadata_without_download(self):
        pipeline.run("job")
        with patch.object(pipeline.lyrics, "build") as build:
            build.return_value = {"line_count": 1}
            pipeline.run("job")
            self.assertEqual(build.call_args.args[0]["title"], "song")
        self.assertEqual(self.download_calls, 1)
        self.assertEqual(self.separate_calls, 1)

    def test_legacy_complete_stems_retry_does_not_require_source(self):
        stems = self.root / "stems"
        stems.mkdir()
        for name in ("vocals.mp3", "instrumental.mp3"):
            (stems / name).write_bytes(b"complete")
        self.manager.job["stems"] = {"vocals": "vocals.mp3", "instrumental": "instrumental.mp3"}
        source_dir = self.root / "source"
        source_dir.mkdir()
        (source_dir / "source.en.vtt").write_text("WEBVTT\n\n00:01.000 --> 00:03.000\nhello\n")
        pipeline.run("job")
        self.assertEqual(self.manager.job["state"], "done")
        self.assertEqual(self.download_calls, 0)
        self.assertEqual(self.separate_calls, 0)
        self.assertEqual(self.manager.job["source_info"]["subtitles"][0]["lang"], "en")

    def test_incomplete_or_changed_stems_recompute_without_redownloading_source(self):
        pipeline.run("job")
        (self.root / "stems/vocals.mp3").write_bytes(b"changed")
        pipeline.run("job")
        self.assertEqual(self.download_calls, 1)
        self.assertEqual(self.separate_calls, 2)

    def test_nested_published_stems_complete_and_are_reused(self):
        names = {kind: f".openk-results/claim/{kind}.mp3"
                 for kind in ("vocals", "instrumental")}

        def separate(source, directory, **kwargs):
            for name in names.values():
                path = directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"published stem")
            return names

        with patch.object(pipeline.separate, "separate", side_effect=separate) as separate_call, \
             patch.object(pipeline.lyrics, "build", return_value={"line_count": 1}) as build:
            pipeline.run("job")
            self.assertEqual(self.manager.job["state"], "done")
            self.assertEqual(build.call_args.args[1], self.root / "stems" / names["vocals"])
            pipeline.run("job")
            separate_call.assert_called_once()
        self.assertEqual(self.download_calls, 1)

    def test_nested_stem_validation_rejects_escape_paths(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "vocals.mp3").write_bytes(b"not a stem")
        stems = self.root / "stems"
        stems.mkdir()
        (stems / "instrumental.mp3").write_bytes(b"stem")
        for name in ("../outside/vocals.mp3", str(outside / "vocals.mp3")):
            self.assertFalse(pipeline._complete_stems(
                {"stems": {"vocals": name, "instrumental": "instrumental.mp3"}}, stems, {}))
        (stems / "escape").symlink_to(outside, target_is_directory=True)
        self.assertFalse(pipeline._complete_stems(
            {"stems": {"vocals": "escape/vocals.mp3", "instrumental": "instrumental.mp3"}}, stems, {}))

    def test_interrupted_separation_reuses_completed_source(self):
        with patch.object(pipeline.separate, "separate", side_effect=RuntimeError("interrupted")):
            pipeline.run("job")
        self.assertEqual(self.manager.job["state"], "error")
        pipeline.run("job")
        self.assertEqual(self.manager.job["state"], "done")
        self.assertEqual(self.download_calls, 1)

    def test_archive_failure_or_conflict_does_not_delete_source(self):
        for status in ("failed", "conflict", "skipped", "disabled"):
            with self.subTest(status=status), \
                 patch.object(config, "KEEP_SOURCE", False), \
                 patch.object(config, "LIBRARY_ARCHIVE_DOWNLOADS", True), \
                 patch.object(library, "archive_job_source_result",
                              return_value=library.ArchiveResult(status, "retained")):
                pipeline.run("job")
                self.assertTrue((self.root / "source/source.flac").exists())
                self.assertEqual(self.manager.job["source_archive"]["status"], status)
        self.assertEqual(self.download_calls, 1)

    def test_cancelled_callback_never_runs_lyrics_or_updates_deleted_job(self):
        def cancelled(*args, **kwargs):
            self.manager.job = None
            kwargs["on_progress"](10, "progress")

        with patch.object(pipeline.separate, "separate", side_effect=cancelled), \
             patch.object(pipeline.lyrics, "build") as build:
            pipeline.run("job")
            build.assert_not_called()

    def test_known_duration_rejected_before_download(self):
        self.manager.job["duration"] = 500
        with patch.object(config, "MAX_SONG_SECONDS", 100):
            pipeline.run("job")
        self.assertEqual(self.download_calls, 0)
        self.assertEqual(self.manager.job["state"], "error")

    def test_stale_scheduled_generation_cannot_start_new_work(self):
        pipeline.run("job", "old-generation")
        self.assertEqual(self.download_calls, 0)
        self.assertNotIn("state", self.manager.job)


if __name__ == "__main__":
    unittest.main()
