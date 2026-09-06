"""Catalog search contract mirrored by frontend/search.js (no fuzzy aliases).

Public indices contain three [text, pinyin variants, initials variants] fields:
display title, artist, and original title. Only metadata changes need phonetics.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

from pypinyin import Style, lazy_pinyin
from zhconv.zhconv import getdict

_HAN_RANGE = "\u3400-\u9fff\uf900-\ufaff\U00020000-\U000323af"
_SCRIPT_BOUNDARY = re.compile(f"[{_HAN_RANGE}](?=[a-z0-9])|[a-z0-9](?=[{_HAN_RANGE}])")


@lru_cache(maxsize=1)
def zh_map() -> dict[str, str]:
    # Include query-only characters too; catalog-derived tables miss traditional
    # input when every stored song is simplified. Deliberately no phrase folding.
    return {key: value for key, value in getdict("zh-hans").items()
            if len(key) == len(value) == 1 and key != value}


def words(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower()
    text = text.replace("ß", "ss").replace("ς", "σ")
    text = unicodedata.normalize("NFKD", text)
    table = zh_map()
    folded = "".join(table.get(ch, ch) for ch in text
                     if not unicodedata.category(ch).startswith("M"))
    return " ".join("".join(ch if unicodedata.category(ch)[0] in "LN" else " "
                            for ch in folded).split())


def normalize(value: str | None) -> str:
    return words(value).replace(" ", "")


def _han(char: str) -> bool:
    return ("\u3400" <= char <= "\u9fff" or "\uf900" <= char <= "\ufaff"
            or "\U00020000" <= char <= "\U000323af")


def _field(value: str) -> list:
    text = words(value)
    if not any(_han(ch) for ch in text):
        return [text.replace(" ", ""), [], []]
    syllables = lazy_pinyin(text, style=Style.NORMAL, errors=lambda chunk: list(chunk))
    # pypinyin uses keyboard "v" for ü; accept both v and accent-folded u.
    umlaut = [part.replace("v", "ü") if _han(ch) else part for ch, part in zip(text, syllables)]
    full = [normalize("".join(parts)) for parts in (umlaut, syllables)]
    initials = normalize("".join(part[0] for part in syllables if part))
    # Mixed Latin/Han titles also support the Han-only form, as the classic
    # picker historically did (A-Lin 有一種悲傷 -> yyzbs).
    han = [(ch, part) for ch, part in zip(text, syllables) if _han(ch)]
    han_full = normalize("".join(part for _, part in han))
    han_initials = normalize("".join(part[0] for _, part in han if part))
    return [text.replace(" ", ""), list(dict.fromkeys([*full, han_full.replace("v", "u"), han_full])),
            list(dict.fromkeys([initials, han_initials]))]


@lru_cache(maxsize=8192)
def _index(title: str, track: str, artist: str) -> dict:
    return {"v": 1, "f": [_field(track or title), _field(artist), _field(title)]}


def index(job: dict) -> dict:
    return _index(*(str(job.get(key) or "") for key in ("title", "track", "artist")))


def query(value: str | None) -> dict:
    text = words(value)
    # A switch between Han and Latin can separate terms without an extra space.
    terms = _SCRIPT_BOUNDARY.sub(r"\g<0> ", text).split()
    return {"text": text.replace(" ", ""), "terms": list(dict.fromkeys(terms))}


def _term_score(fields: list, term: str) -> int:
    best = -1
    for (text, phonetics, initials), exact in zip(fields, (120, 115, 105)):
        if text and term in text:
            best = max(best, exact if text == term else exact - (40 if text.startswith(term) else 60))
        for phonetic in phonetics:
            if phonetic and term in phonetic:
                best = max(best, 35 if phonetic == term else 30 if phonetic.startswith(term) else 25)
        for initial in initials:
            if initial and initial.startswith(term):
                best = max(best, 20 if initial == term else 15)
    return best


def score(search_index: dict, needle: dict) -> float:
    text, terms = needle["text"], needle["terms"]
    if not text:
        return 0
    fields = search_index["f"]
    best = _term_score(fields, text)
    # No implicit separator is required between the complete song and artist.
    title, artist = fields[0][0], fields[1][0]
    if title and artist and text in (title + artist, artist + title):
        best = max(best, 100)
    scores = [_term_score(fields, term) for term in terms]
    if all(value >= 0 for value in scores):
        best = max(best, sum(scores) / len(scores))
    return best


def sort_key(job: dict) -> tuple:
    fields = (job.get("search_index") or index(job))["f"]
    names = tuple((field[1][0] if field[1] else field[0], field[0]) for field in fields[:2])
    return names + (str(job.get("id") or ""),)


def search_jobs(jobs: list[dict], value: str | None) -> list[dict]:
    needle = query(value)
    ranked = []
    for job in jobs:
        relevance = score(job.get("search_index") or index(job), needle)
        # Keep the existing API's URL lookup without letting URLs outrank names.
        if needle["text"] and value and value.strip().casefold() in str(job.get("url") or "").casefold():
            relevance = max(relevance, 10)
        if relevance >= 0:
            ranked.append((relevance, job))
    ranked.sort(key=lambda item: (-item[0], sort_key(item[1])))
    return [job for _, job in ranked]
