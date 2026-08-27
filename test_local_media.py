#!/usr/bin/env python3
"""本地媒体导入的自检脚本：python test_local_media.py

这个功能让 HTTP 接口按路径读本地文件，是整个项目里唯一能碰到文件系统的
入口，所以测试的重点不是「能不能导入」，而是**能不能越界**：

1. 不配置就必须完全关闭（默认安全）；
2. ``..``、白名单外的绝对路径、**指向外部的符号链接**都必须被拒；
3. 非媒体扩展名不碰。

其余覆盖文件名解析（yt-dlp 的 ``标题 [ID]`` 命名能白捡去重信息）、
扫描缓存、以及与播放列表导入一致的幂等性。

不需要 ffprobe：探时长的函数在测试里被替换掉了。
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="openk-local-test-")
os.environ["OPENK_DATA_DIR"] = str(Path(_TMP) / "data")
os.environ["OPENK_JOBS_DIR"] = str(Path(_TMP) / "data" / "jobs")

_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)


def skip(name: str, why: str) -> None:
    print(f"SKIP  {name}  — {why}")


from backend import config  # noqa: E402
from backend.steps import local_media  # noqa: E402

# ---------------- 造一个媒体目录 ----------------
MEDIA = Path(_TMP) / "media"          # 白名单内
OUTSIDE = Path(_TMP) / "outside"      # 白名单外
(MEDIA / "sub").mkdir(parents=True)
OUTSIDE.mkdir()

SONG = MEDIA / "某某乐队 - 某首歌 [abcdefghijk].mp4"
NO_ID = MEDIA / "手动命名的歌.mp4"
NESTED = MEDIA / "sub" / "另一首 [ABCDEFGHIJK].mp4"
NOTES = MEDIA / "readme.txt"
SECRET = OUTSIDE / "secret.mp4"
# 除重挪走的旧版本。扫描必须跳过，否则下次导入又回到曲库，等于白删。
(MEDIA / "_重复").mkdir()
STASHED = MEDIA / "_重复" / "某某乐队 - 某首歌 [zzzzzzzzzzy].mp4"
for p in (SONG, NO_ID, NESTED, NOTES, SECRET, STASHED):
    p.write_bytes(b"fake-media")

ESCAPE_LINK = MEDIA / "看起来很正常 [zzzzzzzzzzz].mp4"
try:
    ESCAPE_LINK.symlink_to(SECRET)
    _HAVE_SYMLINK = True
except (OSError, NotImplementedError):
    _HAVE_SYMLINK = False

# 时长表：ffprobe 在测试里不可用也不该被依赖。
_DURATIONS = {str(SONG): 250.0, str(NO_ID): 300.0,
              str(NESTED): 200.0, str(SECRET): 100.0}
local_media._ffprobe_duration = lambda p: _DURATIONS.get(str(p), 240.0)


def _enable() -> None:
    config.LOCAL_MEDIA_DIRS = [str(MEDIA)]


def _disable() -> None:
    config.LOCAL_MEDIA_DIRS = []


# ---------------- 默认关闭 ----------------
def test_disabled_by_default() -> None:
    _disable()
    check("不配置时功能是关闭的", local_media.enabled() is False)
    check("关闭时白名单为空", local_media.allowed_roots() == [])
    try:
        local_media.resolve_within_roots(str(SONG))
        check("关闭时连白名单内的文件也读不了", False, "本应抛错")
    except local_media.LocalMediaError as exc:
        check("关闭时连白名单内的文件也读不了",
              "OPENK_LOCAL_MEDIA_DIRS" in str(exc), str(exc)[:50])


# ---------------- 越界防护（本文件的重点）----------------
def test_path_confinement() -> None:
    _enable()

    ok = local_media.resolve_within_roots(str(SONG))
    check("白名单内的媒体文件可以读", ok == SONG.resolve())

    check("可以用相对白名单根的路径",
          local_media.resolve_within_roots("sub/另一首 [ABCDEFGHIJK].mp4") == NESTED.resolve())

    for label, bad in [
        ("用 .. 跳出白名单", "../outside/secret.mp4"),
        ("白名单外的绝对路径", str(SECRET)),
        ("多层 .. 跳到系统目录", "../../../../etc/passwd"),
        ("绝对路径读系统文件", "/etc/passwd"),
    ]:
        try:
            local_media.resolve_within_roots(bad)
            check(f"拒绝：{label}", False, "本应抛错")
        except local_media.LocalMediaError:
            check(f"拒绝：{label}", True)

    if _HAVE_SYMLINK:
        # 最阴险的一种：软链本身在白名单里，指向的目标不在。
        # resolve() 会跟随软链，所以这里应该被拦下。
        try:
            local_media.resolve_within_roots(str(ESCAPE_LINK))
            check("拒绝：指向白名单外的符号链接", False, "本应抛错——这是任意文件读取")
        except local_media.LocalMediaError:
            check("拒绝：指向白名单外的符号链接", True)
    else:
        skip("拒绝：指向白名单外的符号链接", "当前系统不支持创建符号链接")

    try:
        local_media.resolve_within_roots(str(NOTES))
        check("拒绝：非媒体扩展名", False, "本应抛错")
    except local_media.LocalMediaError as exc:
        check("拒绝：非媒体扩展名", "不支持" in str(exc), str(exc)[:40])


# ---------------- 文件名解析 ----------------
def test_parse_name() -> None:
    title, vid = local_media.parse_name("某某乐队 - 某首歌 [abcdefghijk]")
    check("从 yt-dlp 命名里取出 ID", vid == "abcdefghijk", str(vid))
    check("标题去掉了 ID 后缀", title == "某某乐队 - 某首歌", title)

    title, vid = local_media.parse_name("手动命名的歌")
    check("没有 ID 时标题原样保留", title == "手动命名的歌" and vid is None)

    # 歌名里带方括号很常见（[Official MV]），不能误当成 ID。
    title, vid = local_media.parse_name("某首歌 [Official MV]")
    check("方括号里不是 11 位 ID 就不当作 ID", vid is None and "Official MV" in title, title)

    check("glob 元字符被转义", "[[]" in local_media.glob_escape("a [b]"))


# ---------------- 扫描 ----------------
def test_scan() -> None:
    _enable()
    data = local_media.scan()
    names = sorted(e["title"] for e in data["entries"])
    check("扫描到全部媒体文件（含子目录）", len(data["entries"]) == 3 + (1 if _HAVE_SYMLINK else 0),
          str(names))
    check("txt 不在结果里", all(not e["path"].endswith(".txt") for e in data["entries"]))
    check("带出了 video_id",
          any(e["video_id"] == "abcdefghijk" for e in data["entries"]))
    check("带出了相对路径",
          any(e["rel_path"] == os.path.join("sub", "另一首 [ABCDEFGHIJK].mp4")
              for e in data["entries"]))

    data2 = local_media.scan(limit=2)
    check("limit 生效并如实告知截断",
          len(data2["entries"]) == 2 and data2["truncated"] is True)

    sub = local_media.scan(subdir="sub")
    check("可以只扫某个子目录", len(sub["entries"]) == 1, str(len(sub["entries"])))

    # 除重把淘汰版本挪进了 `_重复/`，扫描不能再把它们当新歌列出来
    check("`_` 开头的目录不参与扫描",
          all("_重复" not in e["path"] for e in data["entries"]),
          str([e["path"] for e in data["entries"] if "_重复" in e["path"]]))
    stash = local_media.scan(subdir="_重复")
    check("但明确点进去还是看得到（留个后悔药）",
          len(stash["entries"]) == 1, str(len(stash["entries"])))

    try:
        local_media.scan(subdir="../outside")
        check("拒绝扫描白名单外的目录", False, "本应抛错")
    except local_media.LocalMediaError:
        check("拒绝扫描白名单外的目录", True)


# ---------------- 接口层 ----------------
def test_api() -> None:
    try:
        from backend import main
    except ImportError as exc:
        skip("接口层用例（状态判定 / 导入 / 幂等）",
             f"本机没装 fastapi（{exc}），请在容器内运行本脚本")
        return

    from fastapi import HTTPException

    from backend.jobs import manager

    class _NoopExecutor:
        def __init__(self):
            self.submitted: list[str] = []

        def submit(self, fn, *args, **kw):
            self.submitted.append(args[0] if args else None)

    main._executor = _NoopExecutor()

    # 关闭时接口应当 404（不暴露「有这个功能只是没开」）
    _disable()
    try:
        main.scan_local(main.LocalScanRequest())
        check("关闭时接口返回 404", False, "本应抛 404")
    except HTTPException as exc:
        check("关闭时接口返回 404", exc.status_code == 404, str(exc.status_code))

    _enable()
    data = main.scan_local(main.LocalScanRequest())
    status = {Path(e["path"]).name: e["status"] for e in data["entries"]}
    check("全新文件标为 new", status.get(SONG.name) == "new", str(status))
    check("扫描不创建任何任务", len(main._executor.submitted) == 0)

    before = len(manager.list())
    res = main.import_local(main.LocalImportRequest(paths=[str(SONG)]))
    check("只导入指定的那个文件", res["created_count"] == 1, str(res["created_count"]))
    job = res["created"][0]
    check("任务标成 local 来源", job.get("source_type") == "local", str(job.get("source_type")))
    check("记下了本地路径", job.get("local_path") == str(SONG.resolve())
          or job.get("local_path") == str(SONG), str(job.get("local_path")))
    check("从文件名带出了 video_id", job.get("video_id") == "abcdefghijk")
    check("任务数只加了一个", len(manager.list()) == before + 1)

    again = main.import_local(main.LocalImportRequest(paths=[str(SONG)]))
    check("重复导入同一文件不会重复排队", again["created_count"] == 0, str(again["created_count"]))
    check("重复导入说明是已在队列中",
          any("队列" in s["reason"] for s in again["skipped"]),
          str([s["reason"] for s in again["skipped"]]))

    # 没有 video_id 的文件只能按路径去重，单独验一遍。
    res2 = main.import_local(main.LocalImportRequest(paths=[str(NO_ID)]))
    check("没有 ID 的文件也能导入", res2["created_count"] == 1, str(res2["created_count"]))
    res3 = main.import_local(main.LocalImportRequest(paths=[str(NO_ID)]))
    check("没有 ID 的文件靠路径去重", res3["created_count"] == 0, str(res3["created_count"]))

    # 超长的应当在扫描阶段就被挡下。
    # 时长是带缓存的，改了「文件时长」就得同时动 mtime，否则读到的还是旧缓存
    # ——这一步顺带验证了缓存会按 mtime 失效。
    _DURATIONS[str(NESTED)] = 5000.0
    os.utime(NESTED, (time.time() + 10, time.time() + 10))
    data = main.scan_local(main.LocalScanRequest(subdir="sub"))
    check("超长文件被标为 too_long",
          data["entries"][0]["status"] == "too_long", data["entries"][0]["status"])

    # 探测失败（ffprobe 挂了 / 文件正在写入）不能被永久缓存，否则超长预筛
    # 对这个文件就永远失效了。
    _DURATIONS[str(NESTED)] = None
    os.utime(NESTED, (time.time() + 20, time.time() + 20))
    main.scan_local(main.LocalScanRequest(subdir="sub"))
    _DURATIONS[str(NESTED)] = 5000.0          # ffprobe 恢复，但文件没再动过
    data = main.scan_local(main.LocalScanRequest(subdir="sub"))
    check("探测失败不写缓存，下次扫描会重试",
          data["entries"][0]["status"] == "too_long", data["entries"][0]["status"])
    _DURATIONS[str(NESTED)] = 200.0


def test_resume_on_restart() -> None:
    """重启续跑：批量导入几百首时，一次重启不该把整批作废。"""
    from backend import config as cfg
    from backend.jobs import JobManager

    if not cfg.RESUME_ON_START:
        skip("重启续跑", "OPENK_RESUME_ON_START 已关闭")
        return

    # 自己造一个「排队中」和一个「处理中」的任务，不依赖前面的用例。
    seed = JobManager()
    queued = seed.create("https://example.com/a", video_id="q0000000000")
    running = seed.create("https://example.com/b", video_id="r0000000000")
    seed.update(running["id"], state="running", step="separate", progress=40)
    done = seed.create("https://example.com/c", video_id="d0000000000")
    seed.update(done["id"], state="done", progress=100)

    fresh = JobManager()          # 从磁盘重新加载，模拟服务重启
    by_id = {j["id"]: j for j in fresh.list()}
    check("重启后排队中的任务仍是 queued",
          by_id[queued["id"]]["state"] == "queued", by_id[queued["id"]]["state"])
    check("重启后处理到一半的任务回到 queued 而不是 error",
          by_id[running["id"]]["state"] == "queued", by_id[running["id"]]["state"])
    check("已完成的任务不受影响",
          by_id[done["id"]]["state"] == "done", by_id[done["id"]]["state"])

    pending = fresh.take_interrupted()
    # 同一个数据目录里可能还有前面用例建的任务，它们同样是「没跑完」的，
    # 本来就该一起重排——所以这里验的是包含关系，外加已完成的绝不能混进来。
    check("两个未完成任务都被取回重排",
          {queued["id"], running["id"]} <= set(pending), str(len(pending)))
    check("已完成的任务不会被重排", done["id"] not in pending)
    check("取过一次就清空，不会重复提交", fresh.take_interrupted() == [])

    # 重排后的状态要落盘，否则再重启一次又会读到旧的 running。
    third = JobManager()
    again = {j["id"]: j for j in third.list()}
    check("重排后的状态已落盘",
          again[running["id"]]["state"] == "queued", again[running["id"]]["state"])


def main_() -> int:
    print("=== 本地媒体导入自检 ===\n")
    test_disabled_by_default()
    test_path_confinement()
    test_parse_name()
    test_scan()
    test_api()
    test_resume_on_restart()

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
