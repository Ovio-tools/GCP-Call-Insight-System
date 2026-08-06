#!/usr/bin/env python3
"""Claude Code status line: model + live context size, with a /clear nudge.

Context is re-read from cache every turn, so long sessions dominate token cost.
Reads the session JSON on stdin; computes context from the last usage record in
the transcript. Thresholds: <100k green, 100-200k yellow, >200k red (+ nudge).
"""
import json
import os
import sys


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("claude")
        return

    model = (data.get("model") or {}).get("display_name") or "claude"
    tpath = data.get("transcript_path") or ""

    ctx = 0
    if tpath and os.path.exists(tpath):
        try:
            with open(tpath, "rb") as fh:
                lines = fh.readlines()
            for raw in reversed(lines):  # most recent usage record wins
                try:
                    o = json.loads(raw)
                except Exception:
                    continue
                msg = o.get("message")
                u = msg.get("usage") if isinstance(msg, dict) else None
                if u:
                    ctx = (
                        u.get("input_tokens", 0)
                        + u.get("cache_read_input_tokens", 0)
                        + u.get("cache_creation_input_tokens", 0)
                    )
                    break
        except Exception:
            pass

    if ctx == 0 and data.get("exceeds_200k_tokens"):
        ctx = 200_000  # fallback when the transcript is unreadable

    green, yellow, red, dim, reset = (
        "\033[32m",
        "\033[33m",
        "\033[31m",
        "\033[2m",
        "\033[0m",
    )
    if ctx >= 200_000:
        color, hint = red, "  ⚠ /clear — long session"
    elif ctx >= 100_000:
        color, hint = yellow, "  · consider /clear soon"
    else:
        color, hint = green, ""

    ctx_str = f"{ctx / 1000:.0f}k" if ctx else "—"
    print(f"{dim}{model}{reset}  {color}{ctx_str} ctx{reset}{dim}{hint}{reset}")


if __name__ == "__main__":
    main()
