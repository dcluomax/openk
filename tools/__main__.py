"""Categorized, lazy-loading entrypoint for OpenK maintenance utilities."""
from __future__ import annotations

import argparse
import importlib
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Command:
    module: str
    description: str


GROUPS = {
    "library": ("曲库维护", {
        "dedupe": Command("tools.dedupe", "在线 API 除重；默认预览，--apply 才修改"),
        "fix-meta": Command("tools.fix_meta", "离线校正歌名／歌手；默认预览"),
        "rename": Command("tools.rename_files", "离线规范源文件名；默认预览"),
    }),
    "lyrics": ("歌词维护", {
        "refetch": Command("tools.refetch_lyrics", "离线从 LRCLIB 补取歌词；默认预览，会联网"),
        "resplit": Command("tools.resplit_lyrics", "离线重排长歌词行；默认预览，不运行模型"),
        "align": Command("tools.align_lyrics", "离线本地逐词对齐；默认预览，执行需要 ML 依赖"),
    }),
    "setup": ("环境准备", {
        "cert": Command("tools.certificates", "生成自签 HTTPS 证书；执行会写入证书目录"),
    }),
    "demo": ("合成演示", {
        "seed": Command("tools.demo", "生成虚构曲目与合成音轨；拒绝覆盖已有任务"),
    }),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tools",
        description="OpenK 程序与维护工具",
        epilog="服务端：./run.sh；worker：python worker/openk_worker.py；测试：python scripts/run_tests.py",
    )
    groups = parser.add_subparsers(dest="group", metavar="分类")
    group_parsers = {}
    for name, (description, commands) in GROUPS.items():
        group = groups.add_parser(name, help=description, description=description)
        group_parsers[name] = group
        children = group.add_subparsers(dest="command", metavar="命令")
        for command, entry in commands.items():
            children.add_parser(command, add_help=False, help=entry.description)
    args, remaining = parser.parse_known_args(argv)
    if args.group is None:
        if remaining:
            parser.error("无法识别的参数：" + " ".join(remaining))
        parser.print_help()
        return 0
    if args.command is None:
        if remaining:
            group_parsers[args.group].error("无法识别的参数：" + " ".join(remaining))
        group_parsers[args.group].print_help()
        return 0
    entry = GROUPS[args.group][1][args.command]
    original = sys.argv
    try:
        sys.argv = [f"{parser.prog} {args.group} {args.command}", *remaining]
        module = importlib.import_module(entry.module)
        return module.main() or 0
    finally:
        sys.argv = original


if __name__ == "__main__":
    raise SystemExit(main())
