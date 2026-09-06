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
import fcntl
import hashlib
import logging
import multiprocessing
import os
import re
import signal
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.remote.artifacts import PROTOCOL_VERSION, output_files

SERVER = os.environ.get("OPENK_SERVER", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.environ.get("OPENK_WORKER_TOKEN", "").strip()
WORKER_ID = os.environ.get("OPENK_WORKER_ID", "") or socket.gethostname().split(".")[0]
KINDS = [k.strip() for k in os.environ.get(
    "OPENK_WORKER_KINDS", "separate,transcribe,align").split(",") if k.strip()]
POLL_WAIT = float(os.environ.get("OPENK_WORKER_POLL_WAIT", "25"))
HEARTBEAT_EVERY = float(os.environ.get("OPENK_WORKER_HEARTBEAT", "30"))
PROGRESS_INTERVAL = float(os.environ.get("OPENK_WORKER_PROGRESS_INTERVAL", "1"))
SCRATCH_ROOT = Path(os.environ.get(
    "OPENK_WORKER_SCRATCH_DIR", str(Path(__file__).resolve().parent.parent / ".worker-work"))).resolve()
DEFAULT_MODEL_CACHE = Path(__file__).resolve().parent.parent / "data" / "models"
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


class LeaseLost(RuntimeError):
    pass


class ProtocolError(RuntimeError):
    pass


def report(task_id: str, claim_token: str, percent: int, message: str) -> Optional[bool]:
    """True renews, False revokes, None is a transport failure (not a revocation)."""
    try:
        _, data = _request(f"/api/worker/tasks/{task_id}/progress", {
            "worker_id": WORKER_ID, "claim_token": claim_token,
            "percent": int(percent), "message": message,
        }, timeout=15)
        if not isinstance(data, dict) or type(data.get("ok")) is not bool:
            raise ProtocolError("Invalid heartbeat response; update controller and worker together")
        return data["ok"]
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403, 409, 410, 426}:
            log(f"心跳被拒绝（HTTP {exc.code}）；请检查口令和 worker/controller 协议版本")
            return False
        log(f"心跳暂时失败：HTTP {exc.code}")
        return None
    except (OSError, TimeoutError) as exc:
        log(f"心跳网络暂时失败：{exc}")
        return None


def finish(task_id: str, claim_token: str, result: Optional[dict] = None,
           error: Optional[str] = None, heartbeat: Optional["Heartbeat"] = None) -> None:
    """交付结果，失败要重试——这一步丢了，服务端会一直等到租约到期。"""
    for attempt in range(5):
        try:
            if heartbeat:
                heartbeat.check()
            _, data = _request(f"/api/worker/tasks/{task_id}/finish", {
                "worker_id": WORKER_ID, "claim_token": claim_token,
                "result": result, "error": error,
            }, timeout=20)
            if not isinstance(data, dict) or type(data.get("ok")) is not bool:
                raise ProtocolError("Invalid finish response; protocol v2 is required")
            if not data["ok"]:
                raise LeaseLost("任务已过期或被取消；未发布任何输出")
            return
        except urllib.error.HTTPError as exc:
            if exc.code in {401, 403, 409, 410, 422, 426}:
                raise ProtocolError(f"结果被拒绝（HTTP {exc.code}）：{exc.read().decode(errors='replace')}") from exc
            log(f"交付结果失败（第 {attempt + 1} 次）：{exc}")
        except (OSError, TimeoutError) as exc:
            log(f"交付结果网络失败（第 {attempt + 1} 次）：{exc}")
        if attempt < 4:
            if heartbeat:
                heartbeat.lost.wait(2 ** attempt)
            else:
                time.sleep(2 ** attempt)
    raise RuntimeError("交付结果重试失败；租约到期后任务将重新排队")


class Heartbeat:
    """独立心跳：某些步骤（如强制对齐）中途长时间不报进度，靠它续租。"""

    def __init__(self, task_id: str, claim_token: str, lease_seconds: float = 120):
        self.task_id, self.claim_token = task_id, claim_token
        self.lease_seconds = max(0.1, lease_seconds)
        self.percent = 0
        self.message = "处理中…"
        self.lost = threading.Event()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._lock = threading.Lock()
        self._last_ok = time.monotonic()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=16)

    def update(self, percent: int, message: str) -> None:
        self.check()
        value = (max(0, min(100, int(percent))), str(message)[:2000])
        with self._lock:
            if value == (self.percent, self.message):
                return
            self.percent, self.message = value
        self._wake.set()

    def check(self) -> None:
        if self.lost.is_set() or time.monotonic() - self._last_ok >= self.lease_seconds:
            self.lost.set()
            raise LeaseLost("任务租约已丢失，已停止本次计算")

    def _loop(self) -> None:
        renewal = min(max(0.01, HEARTBEAT_EVERY), self.lease_seconds / 3)
        next_send = 0.0
        while not self._stop.is_set():
            delay = max(0, next_send - time.monotonic())
            if self._stop.wait(delay):
                break
            with self._lock:
                percent, message = self.percent, self.message
            self._wake.clear()
            try:
                ok = report(self.task_id, self.claim_token, percent, message)
            except ProtocolError as exc:
                log(str(exc))
                ok = False
            if ok is False:
                self.lost.set()
                break
            if ok is True:
                self._last_ok = time.monotonic()
            elif time.monotonic() - self._last_ok >= self.lease_seconds:
                self.lost.set()
                break
            next_send = time.monotonic() + min(max(0.01, PROGRESS_INTERVAL), renewal)
            self._wake.wait(renewal)


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


def _stage_out(tmp_out: Path, task: dict, result: dict, heartbeat: Heartbeat) -> dict:
    files = output_files(task["kind"], result)
    target = Path(localize(task["staging_dir"]))
    if target.name != f"{task['task_id']}-{task['claim_token']}":
        raise ProtocolError("Invalid attempt staging path")
    directory = os.open(target, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    entries = []
    try:
        for role, name in files.items():
            heartbeat.check()
            source = tmp_out / name
            fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            part = name + ".part"
            digest, size = hashlib.sha256(), 0
            with os.fdopen(fd, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ProtocolError("Output must be a regular file")
                output_fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                    0o600, dir_fd=directory)
                with os.fdopen(output_fd, "wb") as output:
                    while chunk := stream.read(1024 * 1024):
                        heartbeat.check()
                        digest.update(chunk)
                        size += len(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            os.replace(part, name, src_dir_fd=directory, dst_dir_fd=directory)
            entries.append({"role": role, "name": name, "size": size,
                            "sha256": digest.hexdigest()})
    finally:
        os.close(directory)
    heartbeat.check()
    return {"protocol_version": PROTOCOL_VERSION, "task_id": task["task_id"],
            "claim_token": task["claim_token"], "generation": task.get("generation"),
            "result": result, "files": entries}


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


def _configure_model_cache() -> None:
    if os.environ.get("OPENK_MODELS_DIR", "").strip():
        return
    # Keep established HF/Torch caches while moving separator models out of task scratch.
    cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))).expanduser()
    os.environ.setdefault("HF_HOME", str(cache / "huggingface"))
    os.environ.setdefault("TORCH_HOME", str(cache / "torch"))
    os.environ["OPENK_MODELS_DIR"] = str(DEFAULT_MODEL_CACHE)


def _execute_task(task: dict, tmp: Path, work_out: Path, connection: Any) -> None:
    if hasattr(os, "setsid"):
        os.setsid()
        connection.send(("process_group", os.getpid()))
    os.environ["TMPDIR"] = str(tmp)
    os.environ["OPENK_TASK_SUPERVISED"] = "1"
    _configure_model_cache()
    scratch_lock = (tmp / ".lock").open("a")
    fcntl.flock(scratch_lock, fcntl.LOCK_SH)
    from backend.steps import separate as sep_step, transcribe as tr_step
    kind, args = task["kind"], task["args"]
    last = [None, 0.0]

    def on_progress(pct: int, msg: str) -> None:
        value = (int(pct), str(msg)[:2000])
        now = time.monotonic()
        if value != last[0] and now - last[1] >= 0.1:
            connection.send(("progress", value))
            last[:] = [value, now]

    try:
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
        connection.send(("result", result))
    except Exception as exc:
        connection.send(("error", f"{type(exc).__name__}: {exc}"))
    finally:
        connection.close()
        scratch_lock.close()


def _signal_group(pgid: int, sig: int) -> None:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin can return EPERM for a group containing only orphaned zombies.
        listing = subprocess.run(["ps", "-axo", "pid=,pgid=,stat="], capture_output=True,
                                 text=True, check=True, timeout=5)
        for line in listing.stdout.splitlines():
            fields = line.split()
            if len(fields) == 3 and int(fields[1]) == pgid and not fields[2].startswith("Z"):
                raise


def _stop_process(process: Any, owns_group: bool = False) -> None:
    """Terminate descendants by PID as well as our group (steps may create sessions)."""
    if process.pid is None:
        return
    try:
        own_group = owns_group or os.getpgid(process.pid) == process.pid
    except ProcessLookupError:
        own_group = owns_group
    descendants = []
    try:
        listing = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True,
                                 text=True, check=True, timeout=5)
        pairs = [tuple(map(int, line.split())) for line in listing.stdout.splitlines()
                 if len(line.split()) == 2]
        parents = {process.pid}
        while True:
            children = {pid for pid, ppid in pairs if ppid in parents and pid not in parents}
            if not children:
                break
            descendants.extend(children)
            parents.update(children)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        log(f"无法枚举子进程，将终止 worker 子进程组：{exc}")
    parents = [process.pid] if process.is_alive() else []
    for pid in list(reversed(descendants)) + parents:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if own_group:
        _signal_group(process.pid, signal.SIGTERM)
    process.join(timeout=3)
    for pid in descendants:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if own_group:
        _signal_group(process.pid, signal.SIGKILL)
    if process.is_alive():
        process.kill()
        process.join(timeout=3)


def _run_supervised(task: dict, tmp: Path, work_out: Path, heartbeat: Heartbeat,
                    target: Any = _execute_task, timeout: Optional[float] = None) -> dict:
    from backend import config

    if timeout is None:
        timeout = {"separate": config.SEPARATOR_TIMEOUT,
                   "transcribe": config.TRANSCRIBE_TIMEOUT,
                   "align": config.ALIGN_TIMEOUT}[task["kind"]]
    if timeout <= 0:
        raise ValueError("Worker whole-task timeout must be positive")
    deadline = time.monotonic() + timeout
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(task, tmp, work_out, sender))
    process.start()
    sender.close()
    result = None
    owns_group = target is _execute_task
    try:
        while True:
            heartbeat.check()
            if time.monotonic() >= deadline:
                raise TimeoutError(f"{task['kind']} 超过整步执行时限（{timeout:g} 秒）")
            if receiver.poll(0.1):
                try:
                    kind, value = receiver.recv()
                except EOFError:
                    break
                if kind == "progress":
                    heartbeat.update(*value)
                elif kind == "process_group":
                    if value != process.pid:
                        raise RuntimeError("Invalid child process-group ownership")
                    owns_group = True
                elif kind == "result":
                    result = value
                    break
                elif kind == "error":
                    raise RuntimeError(value)
            elif not process.is_alive():
                break
        process.join(timeout=3)
        heartbeat.check()
        if result is None or process.exitcode not in {0, None}:
            raise RuntimeError(f"计算子进程未交付结果（退出码 {process.exitcode}）")
        return result
    finally:
        _stop_process(process, owns_group=owns_group)
        receiver.close()
        process.close()


def run_task(task: Dict[str, Any], heartbeat: Optional[Heartbeat] = None) -> Dict[str, Any]:
    if (task.get("protocol_version") != PROTOCOL_VERSION
            or not re.fullmatch(r"[0-9a-f]{32}", str(task.get("claim_token", "")))
            or not re.fullmatch(r"[0-9a-f]{32}", str(task.get("task_id", "")))
            or not task.get("staging_dir")):
        raise ProtocolError("Fenced protocol v2 claim required; update controller and worker")
    if heartbeat is None:
        with Heartbeat(task["task_id"], task["claim_token"], task.get("lease_seconds", 120)) as hb:
            return run_task(task, hb)
    heartbeat.check()
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    tmp = SCRATCH_ROOT / f"{task['task_id']}-{task['claim_token']}"
    tmp.mkdir()
    scratch_lock = (tmp / ".lock").open("a")
    fcntl.flock(scratch_lock, fcntl.LOCK_SH)
    try:
        (tmp / ".owner.json").write_text(json.dumps({"worker_id": WORKER_ID}), encoding="utf-8")
        work_out = tmp / "out"
        work_out.mkdir()
        # Outputs always remain local until staged in this claim's server-created
        # directory. STAGE_LOCAL=False only changes whether the input is copied.
        result = _run_supervised(task, tmp, work_out, heartbeat)
        return _stage_out(work_out, task, result, heartbeat)
    finally:
        try:
            shutil.rmtree(tmp)
        finally:
            scratch_lock.close()


def _cleanup_scratch() -> None:
    """Reclaim this worker's crashed attempts without touching caches or active work."""
    if not SCRATCH_ROOT.is_dir():
        return
    for directory in SCRATCH_ROOT.iterdir():
        if (not re.fullmatch(r"[0-9a-f]{32}-[0-9a-f]{32}", directory.name)
                or not directory.is_dir() or directory.is_symlink()):
            continue
        try:
            owner = json.loads((directory / ".owner.json").read_text(encoding="utf-8"))
            if owner.get("worker_id") != WORKER_ID:
                continue
            lock_fd = os.open(directory / ".lock", os.O_RDWR | os.O_NOFOLLOW)
            with os.fdopen(lock_fd, "a") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                shutil.rmtree(directory)
        except (OSError, ValueError) as exc:
            log(f"未能清理旧暂存目录 {directory.name}：{exc}")


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
    _cleanup_scratch()
    backoff = 2.0
    while True:
        try:
            status, task = _request("/api/worker/claim", {
                "worker_id": WORKER_ID, "kinds": KINDS, "wait": POLL_WAIT,
                "protocol_version": PROTOCOL_VERSION,
            }, timeout=POLL_WAIT + 15)
            backoff = 2.0
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                log("口令不被接受，检查 OPENK_WORKER_TOKEN；30s 后重试")
                time.sleep(30)
                continue
            if exc.code == 426:
                raise ProtocolError("服务端要求升级协议，请同步更新 controller 和 worker") from exc
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
            with Heartbeat(tid, task.get("claim_token", ""), task.get("lease_seconds", 120)) as hb:
                try:
                    result = run_task(task, hb)
                except LeaseLost:
                    raise
                except Exception as exc:
                    traceback.print_exc()
                    log(f"任务 {tid} 失败：{exc}")
                    finish(tid, task["claim_token"], error=str(exc), heartbeat=hb)
                else:
                    finish(tid, task["claim_token"], result=result, heartbeat=hb)
                    log(f"任务 {tid} 完成，用时 {time.time() - started:.1f}s")
        except (LeaseLost, ProtocolError, RuntimeError) as exc:
            log(f"任务 {tid} 未交付：{exc}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("已停止")
