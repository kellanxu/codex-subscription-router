#!/usr/bin/env python3
"""Safely detect and apply compatible official ChatGPT Desktop updates."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import plistlib
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path("/Applications/ChatGPT.app")
DEFAULT_DESTINATION = Path.home() / "Applications" / "Codex Subscription Router.app"
DEFAULT_HELPER = (
    Path.home() / "Applications" / "Codex Subscription Router Computer Use.app"
)
DEFAULT_STATE = Path.home() / ".codex-mux" / "update-guard.json"
STATE_VERSION = 1


class GuardError(RuntimeError):
    """A safe update precondition was not met."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "apply", "record"))
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--destination", type=Path, default=DEFAULT_DESTINATION)
    parser.add_argument("--helper", type=Path, default=DEFAULT_HELPER)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument(
        "--sync-repo",
        action="store_true",
        help="Fetch origin/main and fast-forward a clean local main branch.",
    )
    parser.add_argument(
        "--go-bin",
        type=Path,
        help="Prepend this Go bin directory while running verification and builds.",
    )
    parser.add_argument(
        "--launch",
        action="store_true",
        help="Open the rebuilt Router after a successful guarded update.",
    )
    return parser.parse_args()


def run(
    command: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def output(command: list[str], *, cwd: Path | None = None) -> str:
    return subprocess.check_output(command, cwd=cwd, text=True).strip()


def fingerprint(app: Path) -> dict[str, str]:
    app = app.expanduser().resolve()
    plist_path = app / "Contents" / "Info.plist"
    asar_path = app / "Contents" / "Resources" / "app.asar"
    if not plist_path.is_file() or not asar_path.is_file():
        raise GuardError(f"not a readable ChatGPT app bundle: {app}")
    with plist_path.open("rb") as handle:
        info = plistlib.load(handle)
    return {
        "path": str(app),
        "version": str(info.get("CFBundleShortVersionString", "unknown")),
        "build": str(info.get("CFBundleVersion", "unknown")),
        "asar_sha256": hashlib.sha256(asar_path.read_bytes()).hexdigest(),
    }


def load_approved_builds() -> dict[tuple[str, str], str]:
    patcher_path = ROOT / "scripts" / "patch_app.py"
    spec = importlib.util.spec_from_file_location("router_patch_app", patcher_path)
    if spec is None or spec.loader is None:
        raise GuardError("could not load patch_app.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    builds = getattr(module, "TESTED_SOURCE_BUILDS", None)
    if not isinstance(builds, dict):
        raise GuardError("patch_app.py does not expose TESTED_SOURCE_BUILDS")
    return builds


def load_state(state_path: Path) -> dict[str, Any]:
    try:
        data = json.loads(state_path.expanduser().read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": STATE_VERSION}
    except (OSError, json.JSONDecodeError) as error:
        raise GuardError(f"read update guard state: {error}") from error
    if data.get("version") != STATE_VERSION:
        raise GuardError(f"unsupported update guard state version: {data.get('version')}")
    return data


def write_state(state_path: Path, data: dict[str, Any]) -> None:
    state_path = state_path.expanduser()
    state_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state_path.parent, 0o700)
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(state_path)


def git_sync() -> dict[str, Any]:
    if not (ROOT / ".git").is_dir():
        raise GuardError(f"repository is not a Git checkout: {ROOT}")
    dirty = output(["git", "status", "--porcelain"], cwd=ROOT)
    branch = output(["git", "branch", "--show-current"], cwd=ROOT)
    if dirty:
        raise GuardError("repository has local changes; refusing automatic source update")
    if branch != "main":
        raise GuardError(f"repository branch is {branch!r}; expected 'main'")
    run(["git", "fetch", "origin", "main"], cwd=ROOT, capture=True)
    ahead_text, behind_text = output(
        ["git", "rev-list", "--left-right", "--count", "HEAD...origin/main"],
        cwd=ROOT,
    ).split()
    ahead = int(ahead_text)
    behind = int(behind_text)
    if ahead:
        raise GuardError(
            f"repository is not safe to fast-forward (ahead={ahead}, behind={behind})"
        )
    if behind:
        run(["git", "merge", "--ff-only", "origin/main"], cwd=ROOT, capture=True)
    return {
        "branch": branch,
        "fast_forwarded": bool(behind),
        "head": output(["git", "rev-parse", "HEAD"], cwd=ROOT),
    }


def bundle_running(bundle: Path) -> bool:
    if shutil.which("pgrep") is None:
        raise GuardError("pgrep is required to check whether Router is active")
    result = subprocess.run(
        ["pgrep", "-f", f"{bundle.expanduser().resolve()}/Contents/"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return bool(result.stdout.strip())


def inspect(source: Path, destination: Path, state_path: Path) -> dict[str, Any]:
    source_info = fingerprint(source)
    installed_info = fingerprint(destination) if destination.expanduser().exists() else None
    approved_builds = load_approved_builds()
    expected_hash = approved_builds.get((source_info["version"], source_info["build"]))
    approved = expected_hash == source_info["asar_sha256"]
    state = load_state(state_path)
    last_verified = state.get("last_verified_source")

    if installed_info is None:
        decision = "router_missing" if approved else "unsupported_update"
    elif not approved:
        decision = "unsupported_update"
    elif (
        installed_info["version"] == source_info["version"]
        and installed_info["build"] == source_info["build"]
    ):
        decision = "current" if last_verified == source_info else "current_unrecorded"
    else:
        decision = "supported_update"

    return {
        "decision": decision,
        "approved": approved,
        "expected_asar_sha256": expected_hash,
        "source": source_info,
        "installed": installed_info,
        "last_verified_source": last_verified,
    }


def record_success(
    source: Path,
    destination: Path,
    helper: Path,
    state_path: Path,
) -> dict[str, Any]:
    result = inspect(source, destination, state_path)
    if not result["approved"]:
        raise GuardError("cannot record an unapproved official build")
    source_info = result["source"]
    installed_info = result["installed"]
    if installed_info is None or (
        installed_info["version"], installed_info["build"]
    ) != (source_info["version"], source_info["build"]):
        raise GuardError("installed Router does not match the approved source version/build")
    run(["codesign", "--verify", "--deep", "--strict", str(destination.expanduser())])
    run(["codesign", "--verify", "--deep", "--strict", str(helper.expanduser())])
    state = load_state(state_path)
    state.update(
        {
            "version": STATE_VERSION,
            "last_verified_source": source_info,
            "last_verified_at": int(time.time()),
            "repo_head": output(["git", "rev-parse", "HEAD"], cwd=ROOT),
        }
    )
    write_state(state_path, state)
    result["decision"] = "current"
    result["recorded"] = True
    return result


def guarded_apply(args: argparse.Namespace) -> dict[str, Any]:
    expected_helper = args.destination.expanduser().resolve().parent / DEFAULT_HELPER.name
    if args.helper.expanduser().resolve() != expected_helper:
        raise GuardError(
            f"helper path must match the patcher output path: {expected_helper}"
        )
    result = inspect(args.source, args.destination, args.state)
    if result["decision"] in {"current", "current_unrecorded"}:
        return record_success(args.source, args.destination, args.helper, args.state)
    if result["decision"] == "unsupported_update":
        raise GuardError("official build is not in TESTED_SOURCE_BUILDS")
    if result["decision"] not in {"supported_update", "router_missing"}:
        raise GuardError(f"unsupported guard decision: {result['decision']}")
    if bundle_running(args.destination) or bundle_running(args.helper):
        result["decision"] = "deferred_router_active"
        return result

    environment = os.environ.copy()
    if args.go_bin:
        go_bin = str(args.go_bin.expanduser().resolve())
        environment["PATH"] = go_bin + os.pathsep + environment.get("PATH", "")

    before = result["source"]
    run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=ROOT, env=environment)
    run(["npm", "run", "check"], cwd=ROOT, env=environment)
    run(["npm", "run", "release:check"], cwd=ROOT, env=environment)
    patch_command = [
        sys.executable,
        "scripts/patch_app.py",
        "--source",
        str(args.source.expanduser().resolve()),
        "--destination",
        str(args.destination.expanduser().resolve()),
    ]
    if args.destination.expanduser().exists() or args.helper.expanduser().exists():
        patch_command.append("--force")
    run(patch_command, cwd=ROOT, env=environment)
    after = fingerprint(args.source)
    if after != before:
        raise GuardError("official source changed during the guarded rebuild")
    recorded = record_success(args.source, args.destination, args.helper, args.state)
    recorded["rebuilt"] = True
    if args.launch:
        run(["open", str(args.destination.expanduser())])
        recorded["launched"] = True
    return recorded


def main() -> int:
    args = parse_args()
    try:
        sync_result = git_sync() if args.sync_repo else None
        if args.command == "check":
            result = inspect(args.source, args.destination, args.state)
        elif args.command == "record":
            result = record_success(args.source, args.destination, args.helper, args.state)
        else:
            result = guarded_apply(args)
        if sync_result is not None:
            result["repository"] = sync_result
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (GuardError, OSError, subprocess.CalledProcessError) as error:
        print(json.dumps({"decision": "blocked", "error": str(error)}, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
