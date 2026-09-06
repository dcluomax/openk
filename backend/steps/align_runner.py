"""Private alignment subprocess entry point; communicates only over local pipes."""
from __future__ import annotations

import json
from pathlib import Path
import sys

from .transcribe import AlignmentUnavailable, _align_known_lyrics_local_once

PREFIX = "OPENK_ALIGN_EVENT "


def emit(event: dict) -> None:
    print(PREFIX + json.dumps(event, ensure_ascii=False), flush=True)


def main() -> int:
    try:
        args = json.load(sys.stdin)
        result = _align_known_lyrics_local_once(
            args["vocals_path"], args["lines"], args["language"],
            Path(args["out_dir"]), args["source"],
            lambda percent, message: emit({"progress": percent, "message": message}),
        )
        emit({"result": result})
        return 0
    except AlignmentUnavailable as exc:
        emit({"error": str(exc), "kind": "unavailable"})
    except OSError as exc:
        emit({"error": str(exc), "kind": "io"})
    except Exception as exc:
        emit({"error": str(exc), "kind": "failed"})
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
