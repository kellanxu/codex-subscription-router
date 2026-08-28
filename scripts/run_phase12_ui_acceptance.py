#!/usr/bin/env python3
"""Run Phase 1 + 2 UI acceptance against an isolated signed app copy."""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_APP = Path(
    "/tmp/csr-phase12-accepted.P1bbMG/"
    "Codex Subscription Router Phase12.app"
)
DEFAULT_STATE_ROOT = Path.home() / ".codex-mux"
BRIDGE_BASE = "http://127.0.0.1:48124"
class AcceptanceError(RuntimeError):
    """A Phase 1 + 2 acceptance assertion failed."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=DEFAULT_APP)
    parser.add_argument("--source-state", type=Path, default=DEFAULT_STATE_ROOT)
    parser.add_argument(
        "--source-profile",
        type=Path,
        help="Optional previously-onboarded isolated Chromium profile to copy.",
    )
    parser.add_argument("--control-port", type=int, required=True)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def request_json(
    base: str,
    path: str,
    token: str,
    *,
    timeout: int = 30,
) -> dict[str, Any]:
    request = urllib.request.Request(
        base + path,
        headers={"X-Codex-Mux-Token": token},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error)
        except (json.JSONDecodeError, UnicodeDecodeError):
            detail = {"error": str(error)}
        raise AcceptanceError(f"HTTP {error.code} for {path}: {detail}") from error
    if not isinstance(value, dict):
        raise AcceptanceError(f"non-object response for {path}")
    return value


def wait_ready(base: str, path: str, token: str, timeout: int = 90) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            request_json(base, path, token, timeout=5)
            return
        except (AcceptanceError, OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(1)
    raise AcceptanceError(f"endpoint did not become ready: {base}{path}: {last_error}")


def capture(
    output: Path,
    token: str,
    name: str,
    action: str | None = None,
    *,
    timeout: int = 360,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    query = {"delayMs": "250", "debug": "1"}
    if action is not None:
        query["action"] = action
    if params:
        query.update(params)
    result = request_json(
        BRIDGE_BASE,
        "/v1/test/app-state?" + urllib.parse.urlencode(query),
        token,
        timeout=timeout,
    )
    encoded = result.pop("imageBase64", None)
    if not isinstance(encoded, str):
        raise AcceptanceError(f"{action or 'capture'} returned no screenshot")
    (output / f"{name}.png").write_bytes(base64.b64decode(encoded))
    return result


def phase_windows(result: dict[str, Any]) -> list[dict[str, Any]]:
    phase = result.get("phase12")
    windows = phase.get("windows") if isinstance(phase, dict) else None
    if not isinstance(windows, list):
        raise AcceptanceError("Desktop bridge returned no Phase 1 window state")
    return windows


def wait_for_phase_windows(
    output: Path,
    token: str,
    name: str,
    predicate: Any,
    *,
    timeout: int = 45,
    recover_errors: bool = False,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last: dict[str, Any] | None = None
    recovery_attempts = 0
    while time.monotonic() < deadline:
        last = capture(output, token, name)
        windows = phase_windows(last)
        if predicate(windows):
            return last
        if recover_errors and recovery_attempts < 2 and any(
            "Oops, an error has occurred" in str(window.get("bodyText", ""))
            for window in windows
        ):
            capture(output, token, name, "phase12-recover-windows")
            recovery_attempts += 1
        time.sleep(1)
    raise AcceptanceError(
        f"Phase 1 window state did not settle for {name}: "
        f"{phase_windows(last) if last else 'no state'}"
    )


def assert_default_picker(window: dict[str, Any]) -> None:
    choices = {
        choice.get("label"): choice.get("pressed")
        for choice in window.get("choices", [])
        if isinstance(choice, dict)
    }
    if set(choices) != {"Primary", "Pro 20x"}:
        raise AcceptanceError(f"new-task choices must be the two accounts: {sorted(choices)}")
    if choices["Pro 20x"] != "true" or window.get("mode") != "preferred":
        raise AcceptanceError("ordinary new-task default is not preferred Pro 20x")
    if len(window.get("badges", [])) < 2:
        raise AcceptanceError("account-scoped plugin badges are missing")


def assert_thread_owner(
    result: dict[str, Any],
    thread_id: str,
    account_id: str,
) -> None:
    matches = [
        window
        for window in phase_windows(result)
        if window.get("threadId") == thread_id
    ]
    if len(matches) != 1:
        raise AcceptanceError(
            f"expected one window for thread {thread_id}, found {len(matches)}"
        )
    window = matches[0]
    if window.get("view") != f"thread:{thread_id}":
        raise AcceptanceError("existing thread rendered the new-task owner picker")
    if window.get("threadOwnerId") != account_id:
        raise AcceptanceError(
            f"thread owner display changed after navigation: {window}"
        )
    if window.get("choices"):
        raise AcceptanceError("existing thread exposed mutable new-task owner choices")


def submitted_thread(
    result: dict[str, Any],
    window_index: int,
    account_id: str,
) -> str:
    windows = phase_windows(result)
    if window_index >= len(windows):
        raise AcceptanceError("routing submission returned no target window")
    window = windows[window_index]
    thread_id = window.get("threadId")
    if not isinstance(thread_id, str):
        raise AcceptanceError(f"routing submission did not expose its real thread: {window}")
    assert_thread_owner(result, thread_id, account_id)
    return thread_id


def persisted_state(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_owner(
    state_path: Path,
    thread: str,
    account_id: str,
    mode: str,
) -> None:
    state = persisted_state(state_path)
    if state.get("threadOwner", {}).get(thread) != account_id:
        raise AcceptanceError(f"thread owner mismatch for {mode}")
    routing = state.get("threadRouting", {}).get(thread, {})
    if routing.get("mode") != mode or not routing.get("reason"):
        raise AcceptanceError(f"thread routing reason or mode is missing for {mode}")


def stop_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            break
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        except PermissionError:
            if process.poll() is not None:
                break
            raise
        time.sleep(0.1)
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        process.wait(timeout=10)


def main() -> int:
    args = parse_args()
    app = args.app.expanduser().resolve()
    source_state = args.source_state.expanduser().resolve()
    source_profile = (
        args.source_profile.expanduser().resolve()
        if args.source_profile is not None
        else None
    )
    launcher = app / "Contents" / "MacOS" / "CodexSubscriptionRouterLauncher"
    if not launcher.is_file():
        raise AcceptanceError(f"signed launcher is missing: {launcher}")
    if args.control_port <= 0 or args.control_port > 65535:
        raise AcceptanceError("control port must be between 1 and 65535")

    token = (source_state / "control-token").read_text(encoding="utf-8").strip()
    work_root = Path(tempfile.mkdtemp(prefix="csr-phase12-ui-acceptance."))
    state_root = work_root / "state"
    profile_root = work_root / "profile"
    output = args.output.expanduser().resolve() if args.output else work_root / "evidence"
    state_root.mkdir(mode=0o700)
    profile_root.mkdir(mode=0o700)
    if source_profile is not None:
        if not source_profile.is_dir():
            raise AcceptanceError(f"source profile is missing: {source_profile}")
        shutil.copytree(
            source_profile,
            profile_root,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(
                "Singleton*",
                "RunningChromeVersion",
                "lockfile",
            ),
        )
    output.mkdir(mode=0o700, parents=True)
    shutil.copy2(source_state / "state.json", state_root / "state.json")
    os.chmod(state_root / "state.json", 0o600)
    original_state = persisted_state(state_root / "state.json")
    original_owners = dict(original_state.get("threadOwner", {}))
    acceptance_run_id = secrets.token_hex(4)

    environment = os.environ.copy()
    environment.update(
        {
            "CODEX_MUX_HOME": str(state_root),
            "CODEX_MUX_CONTROL_PORT": str(args.control_port),
            "CODEX_MUX_CONTROL_TOKEN": token,
            "CODEX_MUX_USER_DATA_DIR": str(profile_root),
            "CODEX_MUX_UI_TESTS": "1",
            "CODEX_MUX_ACCEPTANCE_RUN_ID": acceptance_run_id,
        }
    )
    log_handle = (output / "desktop.log").open("ab")
    process = subprocess.Popen(
        [str(launcher)],
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log_handle.close()
    control_base = f"http://127.0.0.1:{args.control_port}"
    result: dict[str, Any] = {
        "status": "running",
        "artifact": str(app),
        "evidence": str(output),
        "workRoot": str(work_root),
        "checks": [],
    }

    try:
        wait_ready(control_base, "/v1/health", token)
        wait_ready(BRIDGE_BASE, "/v1/test/app-state", token)
        accounts = request_json(control_base, "/v1/accounts", token)["accounts"]
        connected = [
            account
            for account in accounts
            if account.get("connected") and account.get("enabled")
        ]
        primary = next(
            (account for account in connected if account.get("controller")), None
        )
        pro = next(
            (account for account in connected if account.get("planType") == "pro"),
            None,
        )
        if primary is None or pro is None:
            raise AcceptanceError("Primary and connected Pro 20x are both required")
        result["checks"].append("real-two-account-pool")

        onboarding = capture(
            output, token, "01-onboarding-complete", "phase12-onboarding"
        )
        onboarding = wait_for_phase_windows(
            output,
            token,
            "01-onboarding-complete",
            lambda items: len(items) == 1 and len(items[0].get("choices", [])) == 2,
        )
        windows = phase_windows(onboarding)
        if len(windows) != 1:
            raise AcceptanceError("isolated launch did not start with one main window")
        assert_default_picker(windows[0])
        result["checks"].extend(["isolated-onboarding", "default-preferred-pro20"])

        opened = capture(
            output, token, "02-two-default-windows", "phase12-open-second-window"
        )
        opened = wait_for_phase_windows(
            output,
            token,
            "02-two-default-windows",
            lambda items: len(items) == 2
            and all(len(item.get("choices", [])) == 2 for item in items),
            recover_errors=True,
        )
        windows = phase_windows(opened)
        if len(windows) != 2:
            raise AcceptanceError("native New Window did not produce exactly two windows")
        for window in windows:
            assert_default_picker(window)
        result["checks"].append("native-two-window-picker")

        default_submission = capture(
            output, token, "03-default-pro-thread", "phase12-submit-default"
        )
        default_thread = submitted_thread(default_submission, 1, pro["id"])
        assert_owner(state_root / "state.json", default_thread, pro["id"], "preferred")
        result["checks"].append("ordinary-ui-thread-to-pro20")

        capture(
            output,
            token,
            "04-second-window-reset",
            "phase12-reset-second-new-task",
        )
        wait_for_phase_windows(
            output,
            token,
            "04-second-window-reset",
            lambda items: len(items) == 2 and len(items[1].get("choices", [])) == 2,
        )
        selected = capture(
            output, token, "05-dual-manual-selection", "phase12-dual-select"
        )
        windows = phase_windows(selected)
        first_choices = {item["label"]: item["pressed"] for item in windows[0]["choices"]}
        second_choices = {item["label"]: item["pressed"] for item in windows[1]["choices"]}
        if (
            first_choices.get("Primary") != "true"
            or second_choices.get("Pro 20x") != "true"
            or not windows[0].get("locked")
            or not windows[1].get("locked")
        ):
            raise AcceptanceError("manual_locked selection leaked across real windows")
        result["checks"].append("real-two-window-manual-isolation")

        badge_result = capture(
            output, token, "06-plugin-badges", "phase12-refresh-badges", timeout=60
        )
        for window in phase_windows(badge_result):
            badges = window.get("badges", [])
            if len(badges) < 2 or any(not badge.get("text") for badge in badges):
                raise AcceptanceError("plugin badges did not render an account status")
        result["checks"].append("real-plugin-badges-and-scope-disclaimer")

        primary_submission = capture(
            output, token, "07-primary-manual-thread", "phase12-submit-primary"
        )
        primary_thread = submitted_thread(primary_submission, 0, primary["id"])
        assert_owner(
            state_root / "state.json", primary_thread, primary["id"], "manual_locked"
        )
        result["checks"].append("primary-manual-ui-thread")

        pro_submission = capture(
            output, token, "08-pro-manual-thread", "phase12-submit-pro"
        )
        pro_thread = submitted_thread(pro_submission, 0, pro["id"])
        assert_owner(state_root / "state.json", pro_thread, pro["id"], "manual_locked")
        result["checks"].append("pro20-manual-ui-thread")

        primary_return = capture(
            output,
            token,
            "09-return-primary-thread",
            "phase12-open-thread",
            params={
                "threadId": primary_thread,
                "threadTitle": f"Router {acceptance_run_id} E2E step 11",
            },
        )
        assert_thread_owner(primary_return, primary_thread, primary["id"])
        pro_switch = capture(
            output,
            token,
            "10-switch-pro-thread",
            "phase12-open-thread",
            params={
                "threadId": pro_thread,
                "threadTitle": f"Router {acceptance_run_id} E2E step 12",
            },
        )
        assert_thread_owner(pro_switch, pro_thread, pro["id"])
        primary_again = capture(
            output,
            token,
            "11-return-primary-again",
            "phase12-open-thread",
            params={
                "threadId": primary_thread,
                "threadTitle": f"Router {acceptance_run_id} E2E step 11",
            },
        )
        assert_thread_owner(primary_again, primary_thread, primary["id"])
        result["checks"].append("thread-switch-owner-display-sticky")

        final_state = persisted_state(state_root / "state.json")
        if any(
            final_state.get("threadOwner", {}).get(thread) != owner
            for thread, owner in original_owners.items()
        ):
            raise AcceptanceError("an existing thread owner changed during UI acceptance")
        result["checks"].append("existing-thread-owners-preserved")
        result["threadsCreated"] = 3
        result["status"] = "passed"
    except Exception as error:
        result["status"] = "failed"
        result["error"] = str(error)
    finally:
        stop_process(process)
        (output / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(output / "result.json", 0o600)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
