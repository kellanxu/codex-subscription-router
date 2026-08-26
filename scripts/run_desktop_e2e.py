#!/usr/bin/env python3
"""Run the signed Router's token-authenticated Desktop E2E bridge."""

from __future__ import annotations

import argparse
import base64
import json
import os
import plistlib
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_APP = Path.home() / "Applications" / "Codex Subscription Router.app"
DEFAULT_HELPER = (
    Path.home() / "Applications" / "Codex Subscription Router Computer Use.app"
)
DEFAULT_STATE_ROOT = Path.home() / ".codex-mux"
CONTROL_BASE = "http://127.0.0.1:48123"
BRIDGE_BASE = "http://127.0.0.1:48124"


class E2EError(RuntimeError):
    """The signed Desktop E2E did not meet its acceptance gate."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=DEFAULT_APP)
    parser.add_argument("--helper", type=Path, default=DEFAULT_HELPER)
    parser.add_argument("--state-root", type=Path, default=DEFAULT_STATE_ROOT)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def bundle_pids(bundle: Path) -> list[int]:
    result = subprocess.run(
        ["pgrep", "-f", f"^{re.escape(str(bundle.resolve()))}/Contents/"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    return [int(value) for value in result.stdout.split() if value.isdigit()]


def stop_bundles(bundles: tuple[Path, ...], timeout: int = 120) -> None:
    for bundle in bundles:
        for pid in bundle_pids(bundle):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not any(bundle_pids(bundle) for bundle in bundles):
            return
        time.sleep(1)
    raise E2EError("Router or Computer Use helper did not exit after SIGTERM")


def request_json(
    base: str,
    path: str,
    token: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: int = 120,
) -> tuple[int, dict[str, Any]]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={
            "Content-Type": "application/json",
            "X-Codex-Mux-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.load(error)
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = {"error": str(error)}
        if not isinstance(payload, dict):
            payload = {"error": payload}
        return error.code, payload


def wait_for_endpoint(base: str, path: str, token: str, timeout: int = 90) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            status, _ = request_json(base, path, token, timeout=5)
            if status == 200:
                return
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(1)
    raise E2EError(f"endpoint did not become ready: {base}{path}: {last_error}")


def launch(app: Path, *, ui_tests: bool, log_path: Path) -> subprocess.Popen[bytes]:
    launcher = app / "Contents" / "MacOS" / "CodexSubscriptionRouterLauncher"
    if not launcher.is_file():
        raise E2EError(f"missing Router launcher: {launcher}")
    environment = os.environ.copy()
    if ui_tests:
        environment["CODEX_MUX_UI_TESTS"] = "1"
    else:
        environment.pop("CODEX_MUX_UI_TESTS", None)
    log_handle = log_path.open("ab")
    try:
        process = subprocess.Popen(
            [str(launcher)],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        log_handle.close()
    return process


def state_thread_owners(state_root: Path) -> dict[str, str]:
    state = json.loads((state_root / "state.json").read_text(encoding="utf-8"))
    owners = state.get("threadOwner", {})
    if not isinstance(owners, dict):
        raise E2EError("state.json threadOwner is invalid")
    return {str(key): str(value) for key, value in owners.items()}


def capture(
    token: str,
    output: Path,
    name: str,
    *,
    action: str | None = None,
    debug: bool = False,
    timeout: int = 120,
) -> dict[str, Any]:
    query: dict[str, str] = {"delayMs": "1800"}
    if action is not None:
        query["action"] = action
    if debug:
        query["debug"] = "1"
    path = "/v1/test/app-state?" + urllib.parse.urlencode(query)
    deadline = time.monotonic() + timeout
    while True:
        status, result = request_json(BRIDGE_BASE, path, token, timeout=timeout)
        if status == 200:
            break
        if action is not None or time.monotonic() >= deadline:
            detail = result.get("error", result)
            raise E2EError(
                f"Desktop action {action!r} returned HTTP {status}: {detail}"
            )
        time.sleep(1)
    encoded = result.pop("imageBase64", None)
    if not isinstance(encoded, str):
        raise E2EError(f"Desktop action {action!r} returned no screenshot")
    (output / f"{name}.png").write_bytes(base64.b64decode(encoded))
    return result


def set_preview(token: str, mode: str, account_id: str | None = None) -> None:
    body: dict[str, Any] = {"mode": mode}
    if account_id is not None:
        body["accountId"] = account_id
    status, result = request_json(
        CONTROL_BASE,
        "/v1/test/rate-limits",
        token,
        method="POST",
        body=body,
        timeout=45,
    )
    if status != 200 or result.get("ok") is not True:
        raise E2EError(f"could not set rate-limit preview: {result}")


def new_routing_thread(
    token: str,
    state_root: Path,
    output: Path,
    name: str,
    expected_owner: str,
) -> str:
    before = state_thread_owners(state_root)
    capture(
        token,
        output,
        name,
        action="routing-first",
        debug=True,
        timeout=120,
    )
    after = state_thread_owners(state_root)
    created = sorted(set(after) - set(before))
    if len(created) != 1:
        raise E2EError(f"expected one new routed thread, found {len(created)}")
    thread_id = created[0]
    if after[thread_id] != expected_owner:
        raise E2EError("new Desktop thread was assigned to the wrong subscription")
    return thread_id


def verify_sticky_turn(
    token: str,
    state_root: Path,
    output: Path,
    name: str,
    thread_id: str,
    expected_owner: str,
) -> None:
    before = state_thread_owners(state_root)
    capture(token, output, name, action="routing-second", timeout=120)
    after = state_thread_owners(state_root)
    if set(after) != set(before) or after.get(thread_id) != expected_owner:
        raise E2EError("second Desktop turn did not keep sticky subscription ownership")


def main() -> int:
    args = parse_args()
    app = args.app.expanduser().resolve()
    helper = args.helper.expanduser().resolve()
    state_root = args.state_root.expanduser().resolve()
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    output = (
        args.output.expanduser().resolve()
        if args.output
        else state_root / "e2e" / timestamp
    )
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    log_path = output / "router.log"
    token = (state_root / "control-token").read_text(encoding="utf-8").strip()
    bundles = (app, helper)
    result: dict[str, Any] = {
        "status": "running",
        "output": str(output),
        "checks": [],
    }
    exit_code = 1

    try:
        with (app / "Contents" / "Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        result["app"] = {
            "version": str(info.get("CFBundleShortVersionString")),
            "build": str(info.get("CFBundleVersion")),
        }
        stop_bundles(bundles)
        launch(app, ui_tests=True, log_path=log_path)
        wait_for_endpoint(CONTROL_BASE, "/v1/health", token)
        wait_for_endpoint(BRIDGE_BASE, "/v1/test/app-state", token)
        result["checks"].append("test-mode-launch")

        _, account_data = request_json(CONTROL_BASE, "/v1/accounts", token)
        connected = [
            account for account in account_data.get("accounts", []) if account.get("connected")
        ]
        primary = next((account for account in connected if account.get("controller")), None)
        secondary = next(
            (account for account in connected if not account.get("controller")), None
        )
        if primary is None or secondary is None or len(connected) != 2:
            raise E2EError(f"expected exactly two connected subscriptions, found {len(connected)}")
        result["checks"].append("two-connected-subscriptions")

        capture(token, output, "01-home", debug=True)
        capture(token, output, "02-account-menu", action="profile")
        capture(token, output, "03-profile-toggle", action="profile-toggle")
        capture(token, output, "04-settings-profile", action="settings-profile")
        capture(token, output, "05-back-from-profile", action="back-to-app")
        capture(token, output, "06-settings-plugins", action="settings-plugins")
        capture(token, output, "07-plugins-secondary", action="plugins-select-second")
        capture(token, output, "08-back-from-plugins", action="back-to-app")
        result["checks"].extend(["account-menu", "profile", "plugins-secondary"])

        set_preview(token, "single_depleted", primary["id"])
        secondary_thread = new_routing_thread(
            token,
            state_root,
            output,
            "09-primary-to-secondary",
            secondary["id"],
        )
        verify_sticky_turn(
            token,
            state_root,
            output,
            "10-secondary-sticky",
            secondary_thread,
            secondary["id"],
        )
        result["checks"].extend(["primary-to-secondary", "secondary-sticky"])

        set_preview(token, "single_depleted", secondary["id"])
        primary_thread = new_routing_thread(
            token,
            state_root,
            output,
            "11-secondary-to-primary",
            primary["id"],
        )
        verify_sticky_turn(
            token,
            state_root,
            output,
            "12-primary-sticky",
            primary_thread,
            primary["id"],
        )
        result["checks"].extend(["secondary-to-primary", "primary-sticky"])

        set_preview(token, "clear")
        capture(token, output, "13-usage", action="usage")
        capture(token, output, "14-usage-secondary", action="usage-select-second")
        result["checks"].append("usage-secondary")
        result["status"] = "passed"
        exit_code = 0
    except Exception as error:
        result["status"] = "failed"
        result["error"] = str(error)
    finally:
        try:
            set_preview(token, "clear")
        except Exception:
            pass
        try:
            stop_bundles(bundles)
            launch(app, ui_tests=False, log_path=log_path)
            wait_for_endpoint(CONTROL_BASE, "/v1/health", token)
            try:
                wait_for_endpoint(BRIDGE_BASE, "/v1/test/app-state", token, timeout=5)
                result["normal_mode_private_bridge_closed"] = False
            except E2EError:
                result["normal_mode_private_bridge_closed"] = True
        except Exception as error:
            result["normal_relaunch_error"] = str(error)
            exit_code = 1
        (output / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(output / "result.json", 0o600)
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
