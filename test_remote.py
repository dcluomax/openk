#!/usr/bin/env python3
"""远程算力拆分的自检脚本：python test_remote.py

覆盖的是「worker 可以随时离线」这条要求下最容易出错的几个点：
租约回收、离线排队、进度回调透传、路径映射。
"""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backend.remote.queue import TaskQueue  # noqa: E402

_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)


def test_roundtrip() -> None:
    q = TaskQueue(lease_seconds=30)
    seen: list[tuple[int, str]] = []
    result: dict = {}

    def producer() -> None:
        result["value"] = q.submit(
            "separate", {"audio_path": "/x/a.mp3"},
            on_progress=lambda p, m: seen.append((p, m)))

    t = threading.Thread(target=producer, daemon=True)
    t.start()

    task = q.claim("w1", ["separate"], wait_seconds=3)
    check("worker 能领到任务", task is not None and task["kind"] == "separate")

    q.progress(task["task_id"], "w1", 42, "分离中")
    q.finish(task["task_id"], "w1", result={"vocals": "vocals.mp3"})
    t.join(timeout=5)

    check("进度回调透传到 pipeline", (42, "分离中") in seen)
    check("结果原样返回", result.get("value", {}).get("vocals") == "vocals.mp3")


def test_kind_filter() -> None:
    q = TaskQueue()
    threading.Thread(
        target=lambda: q.submit("align", {}), daemon=True).start()
    time.sleep(0.2)
    check("只领自己声明的类型",
          q.claim("w1", ["separate"], wait_seconds=0.5) is None)
    check("声明了就能领到",
          (q.claim("w1", ["align"], wait_seconds=1) or {}).get("kind") == "align")


def test_offline_queues_instead_of_failing() -> None:
    q = TaskQueue()
    check("没有 worker 时报告离线", q.worker_online() is False)

    msgs: list[str] = []
    err: list[Exception] = []

    def producer() -> None:
        try:
            q.submit("separate", {}, on_progress=lambda p, m: msgs.append(m),
                     timeout=1.0)
        except Exception as exc:  # noqa: BLE001
            err.append(exc)

    t = threading.Thread(target=producer, daemon=True)
    t.start()
    t.join(timeout=5)

    check("离线时给出排队提示", any("等待处理节点" in m for m in msgs),
          "; ".join(msgs) or "无提示")
    check("超时是 TimeoutError 而非静默失败",
          bool(err) and isinstance(err[0], TimeoutError))


def test_lease_requeue() -> None:
    """worker 领走任务后掉线，任务必须回到队列而不是永远卡住。"""
    q = TaskQueue(lease_seconds=1)
    threading.Thread(target=lambda: q.submit("separate", {}), daemon=True).start()
    time.sleep(0.2)

    first = q.claim("dying-worker", ["separate"], wait_seconds=2)
    check("第一个 worker 领到任务", first is not None)

    # 不续租，模拟断电/断网；reaper 每 5s 扫一次
    again = q.claim("fresh-worker", ["separate"], wait_seconds=12)
    check("租约到期后任务被重新排队",
          again is not None and again["task_id"] == first["task_id"])
    check("重排后 attempts 递增", (again or {}).get("attempts") == 2)

    dead = q.progress(first["task_id"], "dying-worker", 50, "late")
    check("掉线的 worker 不能再污染任务状态", dead is False)


def test_path_map() -> None:
    os.environ["OPENK_WORKER_PATH_MAP"] = "/mnt/MainPool/Media=/Volumes/Media"
    sys.modules.pop("worker.openk_worker", None)
    from worker import openk_worker as w
    w.PATH_MAP = w._path_map()

    check("共享目录被翻译成本机视角",
          w.localize("/mnt/MainPool/Media/openk/jobs/a/source/x.mp3")
          == "/Volumes/Media/openk/jobs/a/source/x.mp3")
    check("不匹配的路径原样保留",
          w.localize("/tmp/other.mp3") == "/tmp/other.mp3")
    check("只按目录边界匹配，不做子串替换",
          w.localize("/mnt/MainPool/MediaOther/x") == "/mnt/MainPool/MediaOther/x")


def test_http_layer() -> None:
    try:
        from fastapi.testclient import TestClient
    except (ImportError, RuntimeError) as exc:
        print(f"SKIP  HTTP 层（{exc.__class__.__name__}: 缺 httpx2，pip install httpx2）")
        return

    os.environ["OPENK_WORKER_TOKEN"] = "s3cret"
    for mod in [m for m in sys.modules if m.startswith("backend")]:
        sys.modules.pop(mod, None)
    from backend.main import app
    from backend.remote.queue import queue as live

    c = TestClient(app)
    check("无口令被拒",
          c.post("/api/worker/claim",
                 json={"worker_id": "w", "kinds": ["separate"], "wait": 0}
                 ).status_code == 401)

    h = {"Authorization": "Bearer s3cret"}
    check("空队列返回 204",
          c.post("/api/worker/claim",
                 json={"worker_id": "w", "kinds": ["separate"], "wait": 0},
                 headers=h).status_code == 204)

    out: dict = {}
    threading.Thread(
        target=lambda: out.update(value=live.submit("separate", {"a": 1})),
        daemon=True).start()
    time.sleep(0.3)

    r = c.post("/api/worker/claim",
               json={"worker_id": "w", "kinds": ["separate"], "wait": 2}, headers=h)
    check("HTTP 领取任务", r.status_code == 200 and r.json()["kind"] == "separate")
    tid = r.json()["task_id"]

    c.post(f"/api/worker/tasks/{tid}/progress",
           json={"worker_id": "w", "percent": 10, "message": "go"}, headers=h)
    c.post(f"/api/worker/tasks/{tid}/finish",
           json={"worker_id": "w", "result": {"vocals": "v.mp3"}}, headers=h)
    time.sleep(0.5)
    check("HTTP 全链路把结果送回 pipeline",
          out.get("value", {}).get("vocals") == "v.mp3")

    st = c.get("/api/worker/status").json()
    check("状态接口报告 worker 在线", st.get("online") is True)


def main() -> int:
    for fn in (test_roundtrip, test_kind_filter, test_offline_queues_instead_of_failing,
               test_lease_requeue, test_path_map, test_http_layer):
        print(f"\n── {fn.__name__} ──")
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            check(fn.__name__, False, str(exc))

    print()
    if _failures:
        print(f"❌ {len(_failures)} 项失败：{', '.join(_failures)}")
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
