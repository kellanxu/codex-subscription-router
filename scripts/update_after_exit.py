#!/usr/bin/env python3
"""Gracefully stop the Router, apply a guarded update, and relaunch it."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DESTINATION = Path.home() / "Applications" / "Codex Subscription Router.app"
DEFAULT_HELPER = (
    Path.home() / "Applications" / "Codex Subscription Router Computer Use.app"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument("--helper", type=Path, default=DEFAULT_HELPER)
    parser.add_argument("--go-bin", type=Path, required=True)
    parser.add_argument("--delay-seconds", type=int, default=90)
    parser.add_argument("--exit-timeout-seconds", type=int, default=120)
    return parser.parse_args()


def bundle_pids(bundle: Path) -> list[int]:
    pattern = f"{bundle.expanduser().resolve()}/Contents/"
    result = subprocess.run(
        ["pgrep", "-f", pattern],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return [int(value) for value in result.stdout.split() if value.isdigit()]


def terminate_bundle(bundle: Path) -> list[int]:
    pids = bundle_pids(bundle)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    return pids


def wait_until_stopped(bundles: tuple[Path, ...], timeout_seconds: int) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if not any(bundle_pids(bundle) for bundle in bundles):
            return True
        time.sleep(1)
    return False


def main() -> int:
    args = parse_args()
    if args.delay_seconds < 0 or args.exit_timeout_seconds < 1:
        print(json.dumps({"decision": "blocked", "error": "invalid timeout"}))
        return 2

    time.sleep(args.delay_seconds)
    bundles = (args.destination, args.helper)
    terminated = {
        str(bundle.expanduser()): terminate_bundle(bundle) for bundle in bundles
    }
    print(json.dumps({"decision": "exit_requested", "pids": terminated}), flush=True)
    if not wait_until_stopped(bundles, args.exit_timeout_seconds):
        print(
            json.dumps(
                {
                    "decision": "blocked",
                    "error": "Router or Computer Use helper did not exit after SIGTERM",
                }
            ),
            flush=True,
        )
        return 2

    environment = os.environ.copy()
    go_bin = str(args.go_bin.expanduser().resolve())
    environment["PATH"] = go_bin + os.pathsep + environment.get("PATH", "")
    command = [
        sys.executable,
        str(ROOT / "scripts" / "update_guard.py"),
        "apply",
        "--sync-repo",
        "--go-bin",
        go_bin,
        "--launch",
    ]
    return subprocess.run(command, cwd=ROOT, env=environment, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
