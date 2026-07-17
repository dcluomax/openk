"""歌词识别与对齐步骤：调用 whisperX 得到词级时间戳。

对已分离出的“纯人声”做识别，准确率显著高于对混音直接识别。
输出统一为 ``lyrics.json``（含逐行、逐词时间戳）与 ``lyrics.lrc``。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .. import config

ProgressCb = Optional[Callable[[int, str], None]]


def _interpolate_words(words: List[Dict[str, Any]], seg_start: float, seg_end: float) -> List[Dict[str, Any]]:
    """为缺失时间戳的词做线性插值，保证每个词都有 start/end。"""
    n = len(words)
    if n == 0:
        return []

    starts: List[Optional[float]] = [w.get("start") for w in words]
    ends: List[Optional[float]] = [w.get("end") for w in words]

    # 找到首尾已知时间，作为缺口边界。
    known_start = next((s for s in starts if s is not None), seg_start)
    known_end = next((e for e in reversed(ends) if e is not None), seg_end)
    if known_start is None:
        known_start = seg_start
    if known_end is None:
        known_end = seg_end
    if known_end <= known_start:
        known_end = known_start + max(0.1 * n, 0.3)

    # 逐词填充：缺失的 start 用上一个 end，缺失的 end 用下一个 start，
    # 若整段都缺失则按词数均匀分布。
    filled: List[Dict[str, Any]] = []
    for i, w in enumerate(words):
        s = starts[i]
        e = ends[i]
        if s is None:
            s = filled[i - 1]["end"] if filled else known_start
        if e is None:
            # 向后找下一个已知 start
            nxt = next((starts[j] for j in range(i + 1, n) if starts[j] is not None), None)
            if nxt is not None and nxt > s:
                e = nxt
            else:
                span = (known_end - s) / max(1, (n - i))
                e = s + max(span, 0.15)
        if e < s:
            e = s + 0.15
        filled.append({"text": str(w.get("word", "")).strip(), "start": round(float(s), 3), "end": round(float(e), 3)})
    return filled


def _convert(data: Dict[str, Any]) -> Dict[str, Any]:
    """把 whisperX 的 JSON 转换为 openk 的歌词格式。"""
    lines: List[Dict[str, Any]] = []
    for seg in data.get("segments", []):
        text = str(seg.get("text", "")).strip()
        if not text:
            continue
        seg_start = float(seg.get("start", 0.0) or 0.0)
        seg_end = float(seg.get("end", seg_start) or seg_start)
        words = _interpolate_words(seg.get("words", []) or [], seg_start, seg_end)
        line_start = words[0]["start"] if words else seg_start
        line_end = words[-1]["end"] if words else seg_end
        lines.append({
            "start": round(line_start, 3),
            "end": round(line_end, 3),
            "text": text,
            "words": words,
        })
    lines.sort(key=lambda ln: ln["start"])
    return {"language": data.get("language"), "lines": lines}


def _write_lrc(lyrics: Dict[str, Any], path: Path) -> None:
    """导出标准 .lrc 歌词文件（行级时间戳）。"""
    def ts(t: float) -> str:
        m = int(t // 60)
        s = t - m * 60
        return f"[{m:02d}:{s:05.2f}]"

    out = ["[re:openk]"]
    for ln in lyrics["lines"]:
        out.append(f"{ts(ln['start'])}{ln['text']}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def _write_lyrics(lyrics: Dict[str, Any], source: str, out_dir: Path,
                  on_progress: ProgressCb = None) -> Dict[str, Any]:
    """写出 lyrics.json 与 lyrics.lrc，返回结果摘要。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    lyrics["source"] = source
    (out_dir / "lyrics.json").write_text(
        json.dumps(lyrics, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_lrc(lyrics, out_dir / "lyrics.lrc")
    if on_progress:
        on_progress(100, f"歌词完成，共 {len(lyrics['lines'])} 行")
    return {
        "lyrics_file": "lyrics.json",
        "language": lyrics.get("language"),
        "line_count": len(lyrics["lines"]),
        "source": source,
    }


def _finalize(segments: List[Dict[str, Any]], language: Optional[str], source: str,
              out_dir: Path, on_progress: ProgressCb = None) -> Dict[str, Any]:
    lyrics = _convert({"segments": segments, "language": language})
    return _write_lyrics(lyrics, source, out_dir, on_progress)


def save_line_lyrics(lines: List[Dict[str, Any]], language: Optional[str], source: str,
                     out_dir: Path, on_progress: ProgressCb = None) -> Dict[str, Any]:
    """把（来自 LRCLIB / 字幕的）逐行歌词直接落盘，不做逐词对齐。"""
    out_lines: List[Dict[str, Any]] = []
    n = len(lines)
    for i, ln in enumerate(lines):
        start = float(ln["start"])
        end = ln.get("end")
        if end is None:
            end = float(lines[i + 1]["start"]) if i + 1 < n else start + 4.0
        out_lines.append({
            "start": round(start, 3),
            "end": round(float(end), 3),
            "text": ln["text"],
            "words": [],
        })
    return _write_lyrics({"language": language, "lines": out_lines}, source, out_dir, on_progress)


def _split_tokens(text: str) -> List[str]:
    """把一行歌词切成逐字高亮用的 token：含空格的拉丁文按空格分词，其余（中文等）按字符。"""
    text = text.strip()
    if not text:
        return []
    core = text.replace(" ", "")
    if " " in text and core.isascii():
        return [t for t in text.split() if t]
    return [c for c in text if not c.isspace()]


def rebuild_line_words(text: str, start: float, end: float,
                       existing: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """为（可能被编辑过的）歌词行重建逐字时间戳。

    文字与原逐字文字一致时沿用原精确时间戳；否则把 ``[start, end]`` 均匀分给各 token。
    """
    def _norm(s: str) -> str:
        return "".join(str(s).split())

    if existing and _norm(text) == _norm("".join(w.get("text", "") for w in existing)):
        return existing
    toks = _split_tokens(text)
    n = len(toks)
    if n == 0:
        return []
    span = max(0.2, float(end) - float(start))
    step = span / n
    return [
        {"text": tok,
         "start": round(start + i * step, 3),
         "end": round(start + (i + 1) * step, 3)}
        for i, tok in enumerate(toks)
    ]


def save_edited_lyrics(lines_in: List[Dict[str, Any]], language: Optional[str],
                       source: str, out_dir: Path) -> Dict[str, Any]:
    """保存用户编辑后的歌词：重建逐字时间戳并写回 lyrics.json / lyrics.lrc。"""
    out_lines: List[Dict[str, Any]] = []
    for ln in lines_in:
        text = str(ln.get("text", "")).strip()
        if not text:
            continue
        start = float(ln.get("start", 0.0) or 0.0)
        end = float(ln.get("end", start) or start)
        if end < start:
            end = start
        words = rebuild_line_words(text, start, end, ln.get("words") or [])
        out_lines.append({"start": round(start, 3), "end": round(end, 3),
                          "text": text, "words": words})
    out_lines.sort(key=lambda x: x["start"])
    return _write_lyrics({"language": language, "lines": out_lines}, source, out_dir)


def _ensure_nltk_punkt() -> None:
    """确保 whisperX 逐词对齐所需的 NLTK ``punkt_tab`` 资源可用。

    whisperX 的 ``align`` 内部用 NLTK 切句，首次运行需联网下载 ``punkt_tab``。
    macOS 自带 Python 常因缺少根证书导致下载报 ``SSL: CERTIFICATE_VERIFY_FAILED``，
    这里改用 certifi 的证书链，并静默跳过已存在的资源。
    """
    try:
        import nltk
    except Exception:
        return
    try:
        import ssl
        import certifi

        ssl._create_default_https_context = lambda: ssl.create_default_context(
            cafile=certifi.where()
        )
    except Exception:
        pass
    for res in ("punkt_tab", "punkt"):
        try:
            nltk.data.find(f"tokenizers/{res}")
        except LookupError:
            try:
                nltk.download(res, quiet=True)
            except Exception:
                pass


def align_known_lyrics(vocals_path: str | Path, lines: List[Dict[str, Any]],
                       language: str, out_dir: Path, source: str,
                       on_progress: ProgressCb = None) -> Dict[str, Any]:
    """用 whisperX 把已知逐行歌词强制对齐到人声，得到逐词时间戳（卡拉OK级精度）。

    对齐失败会抛出异常，交由上层回退到逐行歌词。
    """
    import whisperx  # 延迟导入，避免把 torch 载入 Web 进程

    _ensure_nltk_punkt()  # 预先确保切句资源就绪，避免对齐时 SSL 下载失败

    device = config.WHISPER_DEVICE
    if on_progress:
        on_progress(10, "正在加载对齐模型…")
    audio = whisperx.load_audio(str(vocals_path))
    model_a, metadata = whisperx.load_align_model(language_code=language, device=device)

    segs: List[Dict[str, Any]] = []
    n = len(lines)
    for i, ln in enumerate(lines):
        start = float(ln["start"])
        end = ln.get("end")
        if end is None:
            end = float(lines[i + 1]["start"]) if i + 1 < n else start + 4.0
        end = float(end)
        if end <= start:
            end = start + 0.5
        text = str(ln["text"]).strip()
        if text:
            segs.append({"text": text, "start": start, "end": end})
    if not segs:
        raise RuntimeError("没有可对齐的歌词行")

    if on_progress:
        on_progress(45, "正在逐词对齐人声…")
    result = whisperx.align(segs, model_a, metadata, audio, device, return_char_alignments=False)
    return _finalize(result.get("segments", []), language, source + " · 逐词对齐", out_dir, on_progress)


def transcribe(
    audio_path: str | Path,
    out_dir: Path,
    model: Optional[str] = None,
    language: Optional[str] = None,
    on_progress: ProgressCb = None,
) -> Dict[str, Any]:
    """识别并对齐歌词，写出 lyrics.json 与 lyrics.lrc。

    返回 ``{"lyrics_file": "lyrics.json", "language": <代码>, "line_count": N}``。
    """
    if shutil.which("whisperx") is None:
        raise RuntimeError(
            "未找到 whisperx，请先安装 ML 依赖：\n"
            "  pip install -r requirements-ml.txt"
        )

    audio_path = Path(audio_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    model = model or config.WHISPER_MODEL
    language = language if language is not None else config.WHISPER_LANGUAGE

    if on_progress:
        on_progress(5, "正在加载语音识别模型…")

    cmd = [
        "whisperx",
        str(audio_path),
        "--model", model,
        "--output_format", "json",
        "--output_dir", str(out_dir),
        "--device", config.WHISPER_DEVICE,
        "--compute_type", config.WHISPER_COMPUTE_TYPE,
        "--batch_size", config.WHISPER_BATCH_SIZE,
        "--print_progress", "True",
    ]
    if language:
        cmd += ["--language", language]

    def _run(extra_args: List[str]) -> tuple[int, str]:
        proc = subprocess.Popen(
            cmd + extra_args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, env=config.ca_env(),
        )
        assert proc.stdout is not None
        last = ""
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            last = line
            if on_progress and ("Transcrib" in line or "Align" in line or "%" in line):
                on_progress(50, "正在识别并对齐歌词…")
        return proc.wait(), last

    code, last_line = _run([])
    # whisperX 只对部分语言内置了逐词对齐模型；当语言被（常常是误）判成没有对齐
    # 模型的语言（如拉丁语 la）时，会在对齐阶段抛 “No default align-model for
    # language: xx” 而整段失败。这种情况退回“仅转写、不逐词对齐”，至少产出逐行
    # 歌词而不是直接报错——用户可再手动选对语言重试或直接编辑歌词。
    if code != 0 and "align-model" in last_line.lower():
        if on_progress:
            on_progress(50, "该语言无逐词对齐模型，改为仅转写…")
        code, last_line = _run(["--no_align"])
    if code != 0:
        raise RuntimeError(f"歌词识别失败（退出码 {code}）：{last_line}")

    raw_json = out_dir / f"{audio_path.stem}.json"
    if not raw_json.exists():
        # 兜底：取目录里最新的 json
        jsons = sorted(out_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not jsons:
            raise RuntimeError("识别完成但未找到输出的 JSON 文件")
        raw_json = jsons[0]

    data = json.loads(raw_json.read_text(encoding="utf-8"))
    return _finalize(
        data.get("segments", []),
        data.get("language") or language or None,
        "Whisper 转写",
        out_dir,
        on_progress,
    )
