"""Protocol-v2 artifacts: untrusted attempt files become one immutable output group."""
from __future__ import annotations

import hashlib
import errno
import json
import math
import os
import re
import shutil
import stat
import subprocess
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 2
_AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aac", ".opus"}
_DIGEST = re.compile(r"[0-9a-f]{64}")


class InvalidResult(ValueError):
    pass


def safe_name(value: Any) -> str:
    if (not isinstance(value, str) or not value or value in {".", ".."}
            or "/" in value or "\\" in value or "\0" in value):
        raise InvalidResult("Output filenames must be plain basenames")
    return value


def output_files(kind: str, result: dict) -> dict[str, str]:
    if not isinstance(result, dict):
        raise InvalidResult("Result must be an object")
    if kind == "separate":
        files = {}
        for role in ("vocals", "instrumental"):
            name = safe_name(result.get(role))
            if Path(name).suffix.lower() not in _AUDIO_SUFFIXES:
                raise InvalidResult(f"Unsupported {role} audio extension")
            files[role] = name
        if len(set(files.values())) != 2:
            raise InvalidResult("Vocals and instrumental must be different files")
        return files
    if kind in {"transcribe", "align"}:
        name = safe_name(result.get("lyrics_file"))
        if name != "lyrics.json":
            raise InvalidResult("Lyrics output must be lyrics.json")
        return {"lyrics_file": name, "lrc": "lyrics.lrc"}
    raise InvalidResult(f"Unsupported remote task kind: {kind}")


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _number(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def _validate_lyrics(path: Path, result: dict) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise InvalidResult("Corrupt lyrics JSON") from exc
    if not isinstance(data, dict) or not isinstance(data.get("lines"), list):
        raise InvalidResult("Lyrics must contain a lines array")
    lines = data["lines"]
    if (type(result.get("line_count")) is not int
            or result["line_count"] != len(lines)
            or result.get("language") != data.get("language")):
        raise InvalidResult("Lyrics metadata does not match the output")
    if result.get("source") != data.get("source"):
        raise InvalidResult("Lyrics source metadata does not match the output")
    if result.get("language") is not None and not isinstance(result["language"], str):
        raise InvalidResult("Invalid lyrics language")
    if not isinstance(result.get("source"), str):
        raise InvalidResult("Invalid lyrics source")
    previous = -1.0
    for line in lines:
        if not isinstance(line, dict):
            raise InvalidResult("Invalid lyrics line")
        start, end = line.get("start"), line.get("end")
        if (not _number(start) or not _number(end) or start < 0 or end < start
                or start < previous or not isinstance(line.get("text"), str)):
            raise InvalidResult("Invalid lyrics timing/text")
        previous = start
        words = line.get("words", [])
        if not isinstance(words, list):
            raise InvalidResult("Invalid lyric words")
        for word in words:
            if not isinstance(word, dict):
                raise InvalidResult("Invalid lyric word")
            ws, we = word.get("start"), word.get("end")
            if (not _number(ws) or not _number(we) or ws < 0 or we < ws
                    or not isinstance(word.get("text"), str)):
                raise InvalidResult("Invalid lyric word timing/text")
    return data


def _validate_audio(path: Path) -> float:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=True)
        data = json.loads(probe.stdout)
        duration = float(data.get("format", {}).get("duration", 0))
        if not data.get("streams") or not math.isfinite(duration) or duration <= 0:
            raise InvalidResult("Output has no playable audio")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120, check=True)
        return duration
    except FileNotFoundError as exc:
        raise InvalidResult("Controller requires ffprobe and ffmpeg to validate audio") from exc
    except (subprocess.SubprocessError, ValueError, KeyError) as exc:
        raise InvalidResult("Corrupt or incomplete audio output") from exc


@dataclass
class PreparedArtifacts:
    directory: Path
    out_dir: Path
    group_id: str
    result: dict

    def commit(self) -> dict:
        """Caller must hold the current claim and job-generation publication guard."""
        if not self.out_dir.is_dir() or self.out_dir.is_symlink():
            raise InvalidResult("Output directory no longer exists")
        groups = self.out_dir / ".openk-results"
        if groups.is_symlink():
            raise InvalidResult("Output groups must not be a symlink")
        groups.mkdir(exist_ok=True)
        os.replace(self.directory, groups / self.group_id)
        return self.result


@contextmanager
def prepare(task: Any, manifest: dict):
    """Validate a private snapshot without blocking heartbeat renewal or cancellation."""
    if not isinstance(manifest, dict) or manifest.get("protocol_version") != PROTOCOL_VERSION:
        raise InvalidResult("Fenced artifact manifest required; update the worker to protocol v2")
    if (manifest.get("task_id") != task.id or manifest.get("claim_token") != task.claim_token
            or manifest.get("generation") != task.generation):
        raise InvalidResult("Artifact manifest belongs to a different claim/generation")
    result = manifest.get("result")
    expected = output_files(task.kind, result)
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) != len(expected):
        raise InvalidResult("Incomplete output group")
    by_role = {}
    for entry in entries:
        if (not isinstance(entry, dict) or not isinstance(entry.get("role"), str)
                or entry.get("role") in by_role):
            raise InvalidResult("Duplicate or invalid artifact entry")
        role = entry.get("role")
        if role not in expected:
            raise InvalidResult("Unexpected artifact role")
        name = safe_name(entry.get("name"))
        if (name != expected[role] or type(entry.get("size")) is not int
                or entry["size"] <= 0 or not isinstance(entry.get("sha256"), str)
                or not _DIGEST.fullmatch(entry["sha256"])):
            raise InvalidResult("Invalid artifact metadata")
        by_role[role] = entry
    stage = task.staging_dir
    if stage is None or not stage.is_dir() or stage.is_symlink():
        raise InvalidResult("Attempt staging directory no longer exists")
    group_id = uuid.uuid4().hex
    pending = stage / (".commit-" + group_id)
    pending.mkdir()
    try:
        durations = []
        for role, entry in by_role.items():
            src = stage / entry["name"]
            try:
                fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError as exc:
                raise InvalidResult("Incomplete artifact group: output file is missing") from exc
            except OSError as exc:
                if exc.errno == errno.ELOOP:
                    raise InvalidResult("Artifact files must not be symlinks") from exc
                raise
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size != entry["size"]:
                    raise InvalidResult("Artifact size/type mismatch")
                target = pending / entry["name"]
                with target.open("xb") as output:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
            if target.stat().st_size != entry["size"] or digest_file(target) != entry["sha256"]:
                raise InvalidResult("Artifact checksum mismatch")
            if role in {"vocals", "instrumental"}:
                durations.append(_validate_audio(target))
        if durations and max(durations) - min(durations) > max(0.25, max(durations) * 0.01):
            raise InvalidResult("Stem durations do not match; output group is incomplete")
        if task.kind in {"transcribe", "align"}:
            lyrics = _validate_lyrics(pending / expected["lyrics_file"], result)
            try:
                lrc = (pending / "lyrics.lrc").read_text(encoding="utf-8")
            except UnicodeError as exc:
                raise InvalidResult("Corrupt LRC output") from exc
            expected_lrc = ["[re:openk]"]
            for line in lyrics["lines"]:
                minutes = int(line["start"] // 60)
                seconds = line["start"] - minutes * 60
                expected_lrc.append(f"[{minutes:02d}:{seconds:05.2f}]{line['text']}")
            if lrc != "\n".join(expected_lrc) + "\n":
                raise InvalidResult("LRC output does not match the complete lyrics group")
        prefix = f".openk-results/{group_id}/"
        if task.kind == "separate":
            committed = {role: prefix + name for role, name in expected.items()}
        else:
            committed = {key: result.get(key) for key in
                         ("language", "line_count", "source")}
            committed["lyrics_file"] = prefix + expected["lyrics_file"]
        record = {"protocol_version": PROTOCOL_VERSION, "task_id": task.id,
                  "generation": task.generation, "result": committed, "files": entries}
        with (pending / "manifest.json").open("x", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        yield PreparedArtifacts(pending, Path(task.args["out_dir"]), group_id, committed)
    finally:
        if pending.exists():
            shutil.rmtree(pending)
