#!/usr/bin/env python3
"""openk 远程算力 worker —— 跑在有算力的机器上（如 Mac mini M4/16GB）。

只做一件事：向服务端长轮询要活，干完把结果写回共享目录。

为什么是 worker 主动拉、而不是服务端推：
  * 服务端不需要知道 worker 的地址，worker 也不用开任何入站端口；
  * worker 离线时任务只是排队，服务端不报错、不做健康检查、不超时；
  * 家里的 Mac 入站方向本来就脆（休眠、换网段、macOS 本地网络授权），
    出站长连接则稳定得多。

用法：
    export OPENK_SERVER=http://<服务端地址>:8000
    export OPENK_WORKER_TOKEN=<与服务端一致的密钥>
    # 若两端看到的共享存储挂载点不同，用 PATH_MAP 做转换（可留空）
    export OPENK_WORKER_PATH_MAP=<服务端路径>=<本机路径>
    python3 worker/openk_worker.py
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SERVER = os.environ.get("OPENK_SERVER", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.environ.get("OPENK_WORKER_TOKEN", "").strip()
WORKER_ID = os.environ.get("OPENK_WORKER_ID", "") or socket.gethostname().split(".")[0]
KINDS = [k.strip() for k in os.environ.get(
    "OPENK_WORKER_KINDS", "separate,transcribe,align").split(",") if k.strip()]
POLL_WAIT = float(os.environ.get("OPENK_WORKER_POLL_WAIT", "25"))
HEARTBEAT_EVERY = float(os.environ.get("OPENK_WORKER_HEARTBEAT", "30"))
# 是否把输入先复制到本地磁盘再计算。SMB 上做随机读会拖慢 onnxruntime，
# 而且网络抖动会让长任务直接失败；音频只有几 MB，复制的代价可以忽略。
STAGE_LOCAL = os.environ.get("OPENK_WORKER_STAGE_LOCAL", "true").lower() in {"1", "true", "yes", "on"}


def _path_map() -> List[tuple[str, str]]:
    """解析 服务端路径=本机路径 的前缀映射（逗号分隔多组）。"""
    pairs: List[tuple[str, str]] = []
    raw = os.environ.get("OPENK_WORKER_PATH_MAP", "").strip()
    for item in raw.split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        src, dst = item.split("=", 1)
        pairs.append((src.rstrip("/"), dst.rstrip("/")))
    return pairs


PATH_MAP = _path_map()


def localize(p: str) -> str:
    """把服务端视角的路径翻译成本机视角。"""
    for src, dst in PATH_MAP:
        if p == src or p.startswith(src + "/"):
            return dst + p[len(src):]
    return p


def log(msg: str) -> None:
    print(f"[worker {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── HTTP ──

def _request(path: str, payload: Optional[dict] = None,
             method: str = "POST", timeout: float = 40.0) -> tuple[int, Any]:
    url = f"{SERVER}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        if not body:
            return resp.status, None
        try:
            return resp.status, json.loads(body)
        except json.JSONDecodeError:
            return resp.status, None


def report(task_id: str, percent: int, message: str) -> bool:
    """上报进度（同时续租）。网络瞬断不应让任务崩掉，故失败只返回 False。"""
    try:
        _, data = _request(f"/api/worker/tasks/{task_id}/progress", {
            "worker_id": WORKER_ID, "percent": int(percent), "message": message,
        }, timeout=15)
        return bool(data and data.get("ok"))
    except Exception:  # noqa: BLE001
        return False


def finish(task_id: str, result: Optional[dict] = None,
           error: Optional[str] = None) -> None:
    """交付结果，失败要重试——这一步丢了，服务端会一直等到租约到期。"""
    for attempt in range(5):
        try:
            _request(f"/api/worker/tasks/{task_id}/finish", {
                "worker_id": WORKER_ID, "result": result, "error": error,
            }, timeout=20)
            return
        except Exception as exc:  # noqa: BLE001
            log(f"交付结果失败（第 {attempt + 1} 次）：{exc}")
            time.sleep(2 ** attempt)


class Heartbeat:
    """独立心跳：某些步骤（如强制对齐）中途长时间不报进度，靠它续租。"""

    def __init__(self, task_id: str):
        self.task_id = task_id
        self.percent = 0
        self.message = "处理中…"
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()

    def update(self, percent: int, message: str) -> None:
        self.percent, self.message = percent, message
        report(self.task_id, percent, message)

    def _loop(self) -> None:
        while not self._stop.wait(HEARTBEAT_EVERY):
            report(self.task_id, self.percent, self.message)


# ── 任务执行 ──

def _stage_in(src: str, tmp: Path) -> str:
    if not STAGE_LOCAL:
        return src
    dst = tmp / Path(src).name
    # 用 copyfile 而不是 copy2：copy2 会 copystat→chflags，而网络挂载
    # （SMB/NFS）上取到的 st_flags 往往无法在本地重放，直接 EPERM 报错。
    # 暂存只关心内容，元数据一概不需要。
    shutil.copyfile(src, dst)
    return str(dst)


def _stage_out(tmp_out: Path, real_out: str) -> None:
    if not STAGE_LOCAL:
        return
    target = Path(real_out)
    target.mkdir(parents=True, exist_ok=True)
    for item in tmp_out.iterdir():
        if not item.is_file():
            continue
        # 先写临时名再改名：worker 可能在任何时刻掉线，而任务重排后
        # pipeline 会用 _stem_ok() 判断分离结果是否可复用。半截文件
        # 一旦被当成有效结果，损坏会一路带到播放器。改名是原子的。
        final = target / item.name
        part = target / (item.name + ".part")
        shutil.copyfile(item, part)
        os.replace(part, final)


_hinted = False


def _hint_local_network(exc: Exception) -> None:
    """macOS 上的「本地网络」授权被拒时，报错是 EHOSTUNREACH，极具误导性。

    表现是：同一台机器上手动跑能通，交给 launchd 托管就一直 No route to host。
    这里给一次明确提示，免得照着「网络不通」的方向白查半天。
    """
    global _hinted
    if _hinted or sys.platform != "darwin":
        return
    if "No route to host" not in str(exc) and "Errno 65" not in str(exc):
        return
    _hinted = True
    log("提示：macOS 可能拦截了本进程的「本地网络」访问（表现为 No route to host）。")
    log("      到 系统设置 ▸ 隐私与安全性 ▸ 本地网络，打开对应 Python 的开关；")
    log("      若列表中没有，先在终端手动跑一次本脚本触发授权登记。")


def run_task(task: Dict[str, Any]) -> Dict[str, Any]:
    from backend.steps import separate as sep_step, transcribe as tr_step

    kind = task["kind"]
    args = task["args"]
    task_id = task["task_id"]

    with Heartbeat(task_id) as hb, tempfile.TemporaryDirectory(prefix="openk-") as td:
        tmp = Path(td)
        tmp_out = tmp / "out"
        tmp_out.mkdir()
        real_out = localize(args["out_dir"])
        work_out = tmp_out if STAGE_LOCAL else Path(real_out)

        def on_progress(pct: int, msg: str) -> None:
            hb.update(pct, msg)

        if kind == "separate":
            audio = _stage_in(localize(args["audio_path"]), tmp)
            result = sep_step.separate_local(
                audio, work_out, args.get("model") or "", on_progress)
        elif kind == "transcribe":
            audio = _stage_in(localize(args["audio_path"]), tmp)
            result = tr_step.transcribe_local(
                audio, work_out, args.get("model"), args.get("language"), on_progress)
        elif kind == "align":
            vocals = _stage_in(localize(args["vocals_path"]), tmp)
            result = tr_step.align_known_lyrics_local(
                vocals, args["lines"], args["language"],
                work_out, args["source"], on_progress)
        else:
            raise RuntimeError(f"未知任务类型：{kind}")

        _stage_out(tmp_out, real_out)
        return result


# ── 主循环 ──

def _preflight() -> None:
    """启动时把「跑到一半才炸」的问题提前暴露出来。

    ffmpeg 缺失是最典型的一个：audio-separator 要到真正开始分离时才去调用它，
    届时只会回一句 "Separation produced no output files"，完全看不出根因。
    托管运行（launchd/systemd）时 PATH 往往比交互 shell 窄得多，这类问题几乎
    只在后台托管后才出现，更难查。
    """
    missing = [b for b in ("ffmpeg", "ffprobe") if shutil.which(b) is None]
    if missing:
        log(f"警告：PATH 中找不到 {', '.join(missing)}，分离/转码步骤一定会失败。")
        log(f"      当前 PATH={os.environ.get('PATH', '')}")
        log("      托管运行时记得把 ffmpeg 所在目录写进服务配置的 PATH")
        log("      （macOS Homebrew 通常是 /opt/homebrew/bin）。")


def main() -> None:
    # backend 各步骤用的是 logging，worker 自己只有 print。不接上的话，
    # 像「歌词时间轴整体偏移 +5.8s」这种关键判断会被默默丢掉，出了问题无从查起。
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s %(name)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
    log(f"worker={WORKER_ID} server={SERVER} kinds={','.join(KINDS)}")
    if PATH_MAP:
        for src, dst in PATH_MAP:
            log(f"路径映射：{src} → {dst}")
    _preflight()
    backoff = 2.0
    while True:
        try:
            status, task = _request("/api/worker/claim", {
                "worker_id": WORKER_ID, "kinds": KINDS, "wait": POLL_WAIT,
            }, timeout=POLL_WAIT + 15)
            backoff = 2.0
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                log("口令不被接受，检查 OPENK_WORKER_TOKEN；30s 后重试")
                time.sleep(30)
                continue
            log(f"服务端返回 {exc.code}；{backoff:.0f}s 后重试")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue
        except Exception as exc:  # noqa: BLE001 - 服务端离线属于正常状态
            log(f"连不上服务端（{exc}）；{backoff:.0f}s 后重试")
            _hint_local_network(exc)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            continue

        if status == 204 or not task:
            continue

        kind, tid = task.get("kind"), task.get("task_id")
        log(f"领到任务 {tid} kind={kind}")
        started = time.time()
        try:
            result = run_task(task)
        except Exception as exc:  # noqa: BLE001 - 任何失败都要回报，不能让服务端干等
            traceback.print_exc()
            log(f"任务 {tid} 失败：{exc}")
            finish(tid, error=str(exc))
        else:
            log(f"任务 {tid} 完成，用时 {time.time() - started:.1f}s")
            finish(tid, result=result)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("已停止")
