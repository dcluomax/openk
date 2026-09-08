"""Pure search regression + JSON fixtures consumed by the existing Node runner."""
from __future__ import annotations

import json
import sys
import unittest
from unittest.mock import patch

if __package__:
    from ._bootstrap import PROJECT_ROOT
else:
    from _bootstrap import PROJECT_ROOT

from backend import search


def catalog() -> list[dict]:
    entries = [
        ("rice", "稻香", "周杰伦", "周杰伦 Jay Chou - 稻香 (Official MV)"),
        ("rain", "淚的小雨", "高勝美", "淚的小雨"),
        ("sea", "海闊天空", "BEYOND", "海闊天空"),
        ("youth", "少年", "夢然", "少年"),
        ("alone", "没有你陪伴真的好孤单", "梦然", "没有你陪伴真的好孤单"),
        ("plain", "平凡之路", "朴樹", "现场录制"),
        ("love", "Love Story", "Ｔａｙｌｏｒ Ｓｗｉｆｔ", "Official Video"),
        ("accent", "Déjà Vu", "Beyoncé", "Déjà Vu – Beyoncé"),
        ("punct", "Don't Stop (Live)", "AC/DC", "Concert"),
        ("mixed", "A-Lin 有一種悲傷", "A-Lin", "演唱会"),
        ("polyphonic", "重慶森林", "王菲", "電影金曲"),
        ("music", "音樂", "樂隊", "音樂"),
        ("umlaut", "女兒情", "吳靜", "女兒情"),
        ("literal", "daoxiang", "Demo", "daoxiang"),
        ("substring", "稻香现场版", "翻唱", "稻香现场版"),
        ("artist-exact", "另一首歌", "稻香", "另一首歌"),
        ("raw-exact", "现场录音", "匿名", "稻香"),
        ("tie-b", "平凡之路", "朴树", "现场录制"),
        ("tie-a", "平凡之路", "朴树", "现场录制"),
        ("000000000001", "一起唱首歌", "OpenK", "一起唱首歌"),
        ("000000000002", "星光练习曲", "OpenK", "星光练习曲"),
        ("empty", None, None, None),
    ]
    return [{"id": key, "track": track, "artist": artist, "title": title,
             "state": "done", "media": {"instrumental": f"/media/{key}/song.mp3"}}
            for key, track, artist, title in entries]


CASES = [
    ("稻香", ["rice", "artist-exact", "raw-exact", "substring"]),
    ("daoxiang", ["literal", "rice", "artist-exact", "raw-exact", "substring"]),
    ("dx", ["rice", "artist-exact", "raw-exact", "substring"]),
    ("ｄＸ", ["rice", "artist-exact", "raw-exact", "substring"]),
    ("dxy", []),
    ("ldxy", ["rain"]),
    ("gaoshengmei 淚的小雨", ["rain"]),
    ("周杰倫 稻香", ["rice"]),
    ("稻香 周杰伦", ["rice"]),
    ("周杰倫稻香", ["rice"]),
    ("稻香周杰倫", ["rice"]),
    ("  稻香  ／  周杰倫 ", ["rice"]),
    ("zhoujielun 稻香", ["rice"]),
    ("周杰倫daoxiang", ["rice"]),
    ("daoxiang周杰伦", ["rice"]),
    ("稻xiang周杰倫", ["rice"]),
    ("稻香 zjl", ["rice"]),
    ("dx zjl", ["rice"]),
    ("zjl dx", ["rice"]),
    ("zhou jie lun dao xiang", ["rice"]),
    ("dao xiang zhou jie lun", ["rice"]),
    ("zhōujiélún dàoxiāng", ["rice"]),
    ("Jay Chou 稻香", ["rice"]),
    ("稻香 Jay Chou", ["rice"]),
    ("海阔天空", ["sea"]),
    ("海闊天空 beyond", ["sea"]),
    ("海闊天空 周杰倫", []),
    ("夢然 沒有你", ["alone"]),
    ("梦然 少年", ["youth"]),
    ("shaonian mengran", ["youth"]),
    ("Love Story Taylor", ["love"]),
    ("story love ｔａｙｌｏｒ", ["love"]),
    ("taylorswift love story", ["love"]),
    ("  BÉYONCÉ  DEJA—VU  ", ["accent"]),
    ("beyonce de\u0301ja\u0300 vu", ["accent"]),
    ("AC／DC DON'T STOP", ["punct"]),
    ("dontstoplive", ["punct"]),
    ("ALIN 有一种悲伤", ["mixed"]),
    ("yyzbs", ["mixed"]),
    ("youyizhongbeishang", ["mixed"]),
    ("chongqing senlin", ["polyphonic"]),
    ("cqsl", ["polyphonic"]),
    ("yinyue", ["music"]),
    ("yy", ["music", "mixed"]),
    ("nü er qing", ["umlaut"]),
    ("nv er qing", ["umlaut"]),
    ("平凡之路", ["plain", "tie-a", "tie-b"]),
    ("daoxiangg", []),
    ("周結倫", []),
    ("稻香 xyznotfound", []),
    ("<img src=x onerror=alert(1)>", []),
    ("OpenK 一起唱首歌", ["000000000001"]),
    ("yiqichangshouge", ["000000000001"]),
    ("yqcsg", ["000000000001"]),
    ("星光練習曲", ["000000000002"]),
]
NORMALIZATION = [
    "  ＡＣ／ＤＣ — Beyoncé  ", "ＤÉＪÀ　ＶＵ", "Beyonce\u0301",
    "Straße STRASSE Σςσ İ", "朴樹 海闊天空 周杰倫", "神 𠮷 ⑫ K 𝑨",
    "\u200b\u00a0\t　", "🎤 ... — /", "zhōu jié lún", "", None,
]


def fixtures() -> dict:
    jobs = [{**job, "search_index": search.index(job)} for job in catalog()]
    queries = [value for value, _ in CASES] + ["", " \t ", " … — 🎤 "]
    return {
        "jobs": jobs, "map": search.zh_map(),
        "cases": [{"q": value, "ids": [job["id"] for job in search.search_jobs(jobs, value)],
                   "scores": [search.score(job["search_index"], search.query(value)) for job in jobs]}
                  for value in queries],
        "normalization": [{"value": value, "text": search.normalize(value),
                           "query": search.query(value)} for value in NORMALIZATION],
    }


class SearchTests(unittest.TestCase):
    def test_matching_and_relevance(self):
        for value, expected in CASES:
            with self.subTest(query=value):
                self.assertEqual([job["id"] for job in search.search_jobs(catalog(), value)], expected)

    def test_complete_character_table_is_cached_without_catalog_access(self):
        table = search.zh_map()
        self.assertIs(table, search.zh_map())
        self.assertEqual(table["夢"], "梦")
        self.assertEqual(table["倫"], "伦")
        self.assertTrue(all(len(key) == len(value) == 1 for key, value in table.items()))
        self.assertLess(len(json.dumps(table, ensure_ascii=False).encode()), 100_000)
        simplified = [{"id": "only", "track": "梦里花", "artist": "张韶涵"}]
        self.assertEqual(search.search_jobs(simplified, "夢裡花 張韶涵"), simplified)

    def test_metadata_keyed_phonetic_cache(self):
        search._index.cache_clear()
        job = {"track": "稻香", "artist": "周杰倫", "title": "演唱會", "updated_at": 1}
        with patch.object(search, "lazy_pinyin", wraps=search.lazy_pinyin) as phonetics:
            first = search.index(job)
            calls = phonetics.call_count
            self.assertGreater(calls, 0)
            self.assertIs(search.index({**job, "updated_at": 2, "state": "running"}), first)
            self.assertEqual(phonetics.call_count, calls)
            for field, value in (("title", "音樂"), ("track", "重慶"), ("artist", "夢然")):
                changed = search.index({**job, field: value})
                self.assertIsNot(changed, first)
                self.assertGreaterEqual(search.score(changed, search.query(value)), 105)
            self.assertEqual(search.index({**job, "track": "重慶"})["f"][0][2], ["cq"])

    def test_empty_queries_have_deterministic_sort_without_mutation(self):
        jobs = catalog()
        before = [job["id"] for job in jobs]
        expected = [job["id"] for job in search.search_jobs(jobs, "")]
        for value in ("", " \n ", " … — 🎤 "):
            self.assertEqual([job["id"] for job in search.search_jobs(jobs[::-1], value)], expected)
        self.assertEqual([job["id"] for job in jobs], before)

    def test_no_names_or_initials_concatenated_across_metadata(self):
        job = {"track": "淚的小雨", "artist": "稻香"}
        self.assertEqual(search.index(job)["f"][0][2], ["ldxy"])
        self.assertLess(search.score(search.index({"track": "淚的小雨"}), search.query("dx")), 0)
        self.assertLess(search.score(search.index(job), search.query("ldxydx")), 0)

    def test_url_lookup_retains_case_insensitive_substrings(self):
        job = {"id": "url", "track": "链接", "url": "https://Example.org/watch?v=AbCd_12"}
        self.assertEqual(search.search_jobs([job], "ABCD_12"), [job])
        self.assertEqual(search.search_jobs([job], "example.org/watch?v="), [job])
        self.assertEqual(search.search_jobs([job], "not-a-url"), [])


if __name__ == "__main__":
    if "--fixtures" in sys.argv:
        print(json.dumps(fixtures(), ensure_ascii=False))
    else:
        unittest.main()
