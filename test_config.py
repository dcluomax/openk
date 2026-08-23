#!/usr/bin/env python3
"""配置与存储路径的自检脚本：python test_config.py

这是个公开仓库，别人的目录结构跟你的不一样：任务数据可能在 NAS 上、
模型可能在另一块 SSD 上、证书可能由运维统一管理。所以这里守两条底线：

1. 不设任何环境变量时，行为跟以前完全一致（不会把老用户的数据弄丢）；
2. 每个存储路径都能被环境变量单独指走，没有漏网的写死路径。

配置是在模块导入时求值的，所以每个用例都开子进程带着不同的环境跑。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        _failures.append(name)


PROBE = """
import json, os, sys
sys.path.insert(0, %r)
from backend import config
print("@@" + json.dumps({
    "data": str(config.DATA_DIR),
    "jobs": str(config.JOBS_DIR),
    "certs": str(config.CERTS_DIR),
    "frontend": str(config.FRONTEND_DIR),
    "models": config.MODELS_DIR,
    "sep_env": os.environ.get("AUDIO_SEPARATOR_MODEL_DIR", ""),
    "hf": os.environ.get("HF_HOME", ""),
    "torch": os.environ.get("TORCH_HOME", ""),
}))
""" % str(ROOT)


def probe(**env) -> dict:
    """在干净的环境里导入 config，回报它算出来的各个路径。"""
    e = {k: v for k, v in os.environ.items() if not k.startswith("OPENK_")}
    for k in ("AUDIO_SEPARATOR_MODEL_DIR", "HF_HOME", "TORCH_HOME"):
        e.pop(k, None)
    e.update(env)
    out = subprocess.run([sys.executable, "-c", PROBE], capture_output=True,
                         text=True, env=e, cwd=str(ROOT))
    line = next((l for l in out.stdout.splitlines() if l.startswith("@@")), None)
    if line is None:
        raise RuntimeError(f"探针没有输出：{out.stderr.strip()[:400]}")
    return json.loads(line[2:])


def test_defaults_unchanged() -> None:
    """不设环境变量时必须还是老样子，否则升级会让人找不到自己的歌。"""
    c = probe()
    check("默认任务目录仍是 <项目>/data/jobs",
          c["jobs"] == str((ROOT / "data" / "jobs").resolve()), c["jobs"])
    check("默认不接管模型缓存位置", c["models"] == "" and c["sep_env"] == "",
          f"models={c['models']!r} sep={c['sep_env']!r}")


def test_data_dir_moves_everything() -> None:
    c = probe(OPENK_DATA_DIR="/tmp/openk-probe")
    root = str(Path("/tmp/openk-probe").resolve())
    check("改 OPENK_DATA_DIR 后任务目录跟着走", c["jobs"] == root + "/jobs", c["jobs"])
    check("改 OPENK_DATA_DIR 后证书目录跟着走", c["certs"] == root + "/certs", c["certs"])


def test_each_path_overridable() -> None:
    """大数据放 NAS、证书归运维管——这些目录得能各自指到不同地方。"""
    c = probe(OPENK_DATA_DIR="/tmp/openk-probe",
              OPENK_JOBS_DIR="/tmp/openk-jobs",
              OPENK_CERTS_DIR="/tmp/openk-certs",
              OPENK_FRONTEND_DIR="/tmp/openk-ui")
    for label, key, want in (("任务目录", "jobs", "/tmp/openk-jobs"),
                             ("证书目录", "certs", "/tmp/openk-certs"),
                             ("前端目录", "frontend", "/tmp/openk-ui")):
        check(f"{label}可以单独指走", c[key] == str(Path(want).resolve()), c[key])


def test_models_dir_steers_every_library() -> None:
    """模型有好几 GB，而 audio-separator 默认写 /tmp，有的系统重启就清空。

    三个库各有各的环境变量，配一处就该全都跟着走，不然还是会散落一地。
    """
    c = probe(OPENK_MODELS_DIR="/tmp/openk-models")
    root = str(Path("/tmp/openk-models").resolve())
    check("audio-separator 模型跟随", c["sep_env"] == root + "/audio-separator", c["sep_env"])
    check("HuggingFace 缓存跟随", c["hf"] == root + "/huggingface", c["hf"])
    check("torch 缓存跟随", c["torch"] == root + "/torch", c["torch"])


def test_explicit_env_wins() -> None:
    """用户自己设过 HF_HOME 的话要让着人家，别默默改掉别人的全局缓存。"""
    c = probe(OPENK_MODELS_DIR="/tmp/openk-models", HF_HOME="/tmp/my-own-hf")
    check("用户显式设的 HF_HOME 不被覆盖", c["hf"] == "/tmp/my-own-hf", c["hf"])


def main() -> int:
    for fn in (test_defaults_unchanged, test_data_dir_moves_everything,
               test_each_path_overridable, test_models_dir_steers_every_library,
               test_explicit_env_wins):
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
