#!/usr/bin/env python3
"""播放列表批量导入的自检脚本：python test_playlist.py

这里不联网、也不需要装 yt-dlp：往 ``sys.modules`` 里塞一个假的 yt_dlp，
让它按剧本返回列表内容。要守住的是批量导入最容易出事的几点：

1. **幂等**：同一个歌单点两次「导入」，第二次必须一首都不新建，
   否则一个不小心的双击就会让队列翻倍——而每首歌都是几分钟的重活；
2. **不白干**：曲库里已有的、正在排队的、已失效的、超长的，都要提前挡掉，
   而不是下载完才在流水线里发现；
3. **报错说人话**：歌单链接被聊天软件截断是最常见的情况，
   它跟「歌单不存在」的原始报错长得一模一样，必须translate成能指导下一步的提示。
"""
from __future__ import annotations

import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# 任务数据写到临时目录，绝不碰真实曲库。必须在导入 backend 之前设好，
# 因为 config 是在模块导入时求值的，manager 也是那时建的单例。
_TMP = tempfile.mkdtemp(prefix="openk-playlist-test-")
os.environ["OPENK_DATA_DIR"] = _TMP
os.environ["OPENK_JOBS_DIR"] = str(Path(_TMP) / "jobs")

_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)


def skip(name: str, why: str) -> None:
    print(f"SKIP  {name}  — {why}")


# ---------------- 假的 yt_dlp ----------------
class FakeYDL:
    """按剧本作答的 YoutubeDL 替身。"""

    scripted: dict = {}
    last_opts: dict = {}

    def __init__(self, opts):
        FakeYDL.last_opts = dict(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        value = FakeYDL.scripted.get(url)
        if isinstance(value, Exception):
            raise value
        return value


_fake = types.ModuleType("yt_dlp")
_fake.YoutubeDL = FakeYDL
sys.modules["yt_dlp"] = _fake

from backend import config  # noqa: E402
from backend.steps import playlist  # noqa: E402

PL = "PLd72m0Gup7IEwqfnLQm0dLRvOEP0nJHZxx"
PL_URL = f"https://www.youtube.com/playlist?list={PL}"


def _entry(vid, title, duration=200):
    return {"id": vid, "title": title, "duration": duration, "url": playlist.video_url(vid)}


# ---------------- 链接解析 ----------------
def test_extract_id() -> None:
    check("从 watch?v=…&list=… 取出列表 ID",
          playlist.extract_playlist_id(
              f"https://www.youtube.com/watch?v=Wh2kAMtM1WI&list={PL}") == PL)
    check("从 /playlist?list=… 取出列表 ID",
          playlist.extract_playlist_id(PL_URL) == PL)
    check("普通视频链接不算播放列表",
          playlist.extract_playlist_id(
              "https://www.youtube.com/watch?v=Wh2kAMtM1WI") is None)
    check("watch 链接会被换成规范的 playlist 链接",
          playlist.canonical_url(PL) == PL_URL)


def test_dynamic_rejected() -> None:
    """YouTube 自动生成的电台列表因人而异，批量导入没有意义。"""
    try:
        playlist.fetch_entries(f"https://www.youtube.com/watch?v=x&list=RD{PL}")
        check("拒绝自动生成的电台列表", False, "本应抛错")
    except playlist.PlaylistError as exc:
        check("拒绝自动生成的电台列表", "电台" in str(exc), str(exc)[:60])


def test_truncated_link_message() -> None:
    """链接被截断是最常见的失败，提示必须指出「重新完整复制」。"""
    bad = "https://www.youtube.com/playlist?list=PLd72m0Gup7IE"
    FakeYDL.scripted = {
        bad: RuntimeError("ERROR: [youtube:tab] PLd72m0Gup7IE: "
                          "YouTube said: The playlist does not exist."),
    }
    try:
        playlist.fetch_entries(bad)
        check("截断链接给出可操作的提示", False, "本应抛错")
    except playlist.PlaylistError as exc:
        msg = str(exc)
        check("截断链接给出可操作的提示",
              "截断" in msg and "完整复制" in msg, msg[:60])


def test_private_message() -> None:
    FakeYDL.scripted = {PL_URL: RuntimeError("This playlist is private")}
    try:
        playlist.fetch_entries(PL_URL)
        check("私有列表提示配置 cookies", False, "本应抛错")
    except playlist.PlaylistError as exc:
        check("私有列表提示配置 cookies", "COOKIEFILE" in str(exc), str(exc)[:60])


def test_entries_normalised() -> None:
    FakeYDL.scripted = {PL_URL: {
        "title": "我的卡拉OK歌单",
        "entries": [
            _entry("aaaaaaaaaaa", "歌一"),
            None,                                   # yt-dlp 对失败项会塞 None
            _entry("aaaaaaaaaaa", "歌一"),           # 重复项
            {"id": "bbbbbbbbbbb", "title": "[Private video]", "duration": None},
            _entry("ccccccccccc", "歌三", 300),
        ],
    }}
    data = playlist.fetch_entries(PL_URL, limit=50)
    ids = [e["video_id"] for e in data["entries"]]
    check("列表标题读到了", data["title"] == "我的卡拉OK歌单")
    check("None 项被丢掉、重复项只留一份", ids == ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"], str(ids))
    check("私有视频被标记为不可用",
          data["entries"][1]["unavailable"] is True
          and data["entries"][0]["unavailable"] is False)
    check("未超出上限时不标记截断", data["truncated"] is False)


def test_limit_and_truncation() -> None:
    FakeYDL.scripted = {PL_URL: {
        "title": "长歌单",
        "entries": [_entry(f"v{i:010d}", f"歌{i}") for i in range(30)],
    }}
    data = playlist.fetch_entries(PL_URL, limit=10)
    check("超过上限时只取前 N 首", len(data["entries"]) == 10, str(len(data["entries"])))
    check("超过上限时如实告知被截断", data["truncated"] is True)
    check("向 yt-dlp 多要一首用于判断截断",
          FakeYDL.last_opts.get("playlistend") == 11,
          str(FakeYDL.last_opts.get("playlistend")))
    check("只解析列表页、不逐个请求视频",
          FakeYDL.last_opts.get("extract_flat") == "in_playlist")


# ---------------- 接口层：状态判定与导入 ----------------
def _load_api():
    """导入 backend.main（只需要 fastapi/pydantic，没有 ML 依赖）。"""
    from backend import main as _main

    class _NoopExecutor:
        """把 pipeline.run 拦下来，测试里不真的去下载。"""

        def __init__(self):
            self.submitted: list[str] = []

        def submit(self, fn, *args, **kw):
            self.submitted.append(args[0] if args else None)

    _main._executor = _NoopExecutor()
    return _main


def test_import_flow() -> None:
    try:
        main = _load_api()
    except ImportError as exc:
        skip("接口层用例（状态判定 / 导入 / 幂等）",
             f"本机没装 fastapi（{exc}），请在容器内运行本脚本")
        return

    from backend.jobs import manager

    FakeYDL.scripted = {PL_URL: {
        "title": "我的卡拉OK歌单",
        "entries": [
            _entry("n0000000000", "没做过的歌"),
            _entry("d0000000000", "曲库里已有"),
            _entry("f0000000000", "上次失败的"),
            _entry("l0000000000", "一小时纯音乐合辑", 3600),
            {"id": "p0000000000", "title": "[Deleted video]", "duration": None},
        ],
    }}

    # 预置两条历史任务：一条已完成、一条失败。
    manager.create("https://www.youtube.com/watch?v=d0000000000",
                   video_id="d0000000000", state="done")
    manager.create("https://www.youtube.com/watch?v=f0000000000",
                   video_id="f0000000000", state="error")

    preview = main.preview_playlist(main.PlaylistPreviewRequest(url=PL_URL))
    status = {e["video_id"]: e["status"] for e in preview["entries"]}
    check("没做过的标为 new", status.get("n0000000000") == "new", str(status))
    check("曲库已有的标为 done", status.get("d0000000000") == "done")
    check("上次失败的标为 failed（可重来）", status.get("f0000000000") == "failed")
    check("超长的在下载前就被挡下", status.get("l0000000000") == "too_long")
    check("失效视频标为 unavailable", status.get("p0000000000") == "unavailable")
    check("预览不创建任何任务", len(main._executor.submitted) == 0)

    before = len(manager.list())
    result = main.import_playlist(main.PlaylistImportRequest(url=PL_URL))
    check("只导入该导的两首", result["created_count"] == 2, str(result["created_count"]))
    check("其余三首都给出跳过原因",
          result["skipped_count"] == 3
          and all(s.get("reason") for s in result["skipped"]),
          str([s.get("reason") for s in result["skipped"]]))
    check("新任务确实进了队列", len(main._executor.submitted) == 2)
    check("任务数只增加了导入的那几首", len(manager.list()) == before + 2)
    check("记下了来源歌单",
          all(j.get("playlist_id") == PL for j in manager.list()
              if j.get("id") in {c["id"] for c in result["created"]}))

    # 幂等：刚导完再点一次，全部应变成「已在队列中」，一首都不能新建。
    again = main.import_playlist(main.PlaylistImportRequest(url=PL_URL))
    check("重复导入不会重复排队", again["created_count"] == 0, str(again["created_count"]))
    check("重复导入时说明是已在队列中",
          any("队列" in s["reason"] for s in again["skipped"]),
          str([s["reason"] for s in again["skipped"]]))


def test_selective_import() -> None:
    if "fastapi" not in sys.modules:
        return
    from backend import main
    from backend.jobs import manager

    FakeYDL.scripted = {PL_URL: {
        "title": "选一首",
        "entries": [_entry("s0000000000", "选中"), _entry("t0000000000", "没选中")],
    }}
    before = len(manager.list())
    result = main.import_playlist(
        main.PlaylistImportRequest(url=PL_URL, video_ids=["s0000000000"]))
    check("只导入勾选的那几首", result["created_count"] == 1, str(result["created_count"]))
    check("没勾的不进队列", len(manager.list()) == before + 1)


def test_limit_is_capped() -> None:
    """用户传的 limit 不能突破 OPENK_PLAYLIST_MAX_ITEMS，否则等于没有护栏。"""
    if "fastapi" not in sys.modules:
        return
    from backend import main

    FakeYDL.scripted = {PL_URL: {
        "title": "长歌单",
        "entries": [_entry(f"z{i:010d}", f"歌{i}") for i in range(5)],
    }}
    main.preview_playlist(main.PlaylistPreviewRequest(url=PL_URL, limit=99999))
    check("limit 被夹在配置上限内",
          FakeYDL.last_opts.get("playlistend") == config.PLAYLIST_MAX_ITEMS + 1,
          str(FakeYDL.last_opts.get("playlistend")))


def main_() -> int:
    print("=== 播放列表批量导入自检 ===\n")
    test_extract_id()
    test_dynamic_rejected()
    test_truncated_link_message()
    test_private_message()
    test_entries_normalised()
    test_limit_and_truncation()
    test_import_flow()
    test_selective_import()
    test_limit_is_capped()

    print()
    if _failures:
        print(f"✗ {len(_failures)} 项未通过：" + "、".join(_failures))
        return 1
    print("✓ 全部通过")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main_())
    finally:
        import shutil
        shutil.rmtree(_TMP, ignore_errors=True)
