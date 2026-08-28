#!/usr/bin/env python3
"""Exercise Phase 1/2 routing against the mux embedded in a signed app."""

from __future__ import annotations

import argparse
import json
import os
import queue
import secrets
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class AcceptanceError(RuntimeError):
    """The signed mux did not meet a Phase 1/2 acceptance assertion."""


class RpcClient:
    def __init__(self, executable: Path, environment: dict[str, str]) -> None:
        self.process = subprocess.Popen(
            [str(executable), "app-server"],
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        self.messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self.next_id = 1
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                self.messages.put(value)

    def _write(self, value: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise AcceptanceError("signed mux stdin is unavailable")
        self.process.stdin.write(json.dumps(value, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"method": method}
        if params is not None:
            message["params"] = params
        self._write(message)

    def request(
        self, method: str, params: dict[str, Any], *, timeout: float = 90
    ) -> tuple[dict[str, Any], float]:
        request_id = self.next_id
        self.next_id += 1
        started = time.monotonic()
        self._write({"id": request_id, "method": method, "params": params})
        deadline = started + timeout
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=min(0.5, deadline - time.monotonic()))
            except queue.Empty:
                if self.process.poll() is not None:
                    raise AcceptanceError("signed mux exited before responding")
                continue
            if message.get("id") == request_id and "method" not in message:
                return message, (time.monotonic() - started) * 1000
            if message.get("id") is not None and message.get("method"):
                self._write(
                    {
                        "id": message["id"],
                        "error": {"code": -32601, "message": "not used by acceptance"},
                    }
                )
        raise AcceptanceError(f"RPC {method} timed out")

    def close(self) -> None:
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                os.killpg(self.process.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if self.process.poll() is None:
            self.process.wait(timeout=5)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--control-port", type=int, required=True)
    parser.add_argument("--source-state", type=Path, default=Path.home() / ".codex-mux")
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def request_json(
    base: str,
    path: str,
    token: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 30,
) -> tuple[int, dict[str, Any], float]:
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
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
            return response.status, payload, (time.monotonic() - started) * 1000
    except urllib.error.HTTPError as error:
        payload = json.load(error)
        return error.code, payload, (time.monotonic() - started) * 1000


def wait_health(base: str, token: str) -> None:
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        try:
            status, _, _ = request_json(base, "/v1/health", token, timeout=2)
            if status == 200:
                return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.5)
    raise AcceptanceError("signed mux control plane did not become ready")


def state(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def expect_success(response: dict[str, Any], method: str) -> dict[str, Any]:
    if "error" in response:
        raise AcceptanceError(f"{method} failed with code {response['error'].get('code')}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise AcceptanceError(f"{method} returned no result object")
    return result


def thread_id(result: dict[str, Any]) -> str:
    thread = result.get("thread")
    value = thread.get("id") if isinstance(thread, dict) else None
    if not isinstance(value, str) or not value:
        raise AcceptanceError("thread/start returned no thread id")
    return value


def main() -> int:
    args = parse_args()
    app = args.app.expanduser().resolve()
    executable = app / "Contents" / "Resources" / "codex"
    if not executable.is_file():
        raise AcceptanceError("signed mux executable is missing")
    source_state = args.source_state.expanduser().resolve()
    token = (source_state / "control-token").read_text(encoding="utf-8").strip()
    work_root = Path(tempfile.mkdtemp(prefix="csr-phase12-mux-acceptance."))
    state_root = work_root / "state"
    state_root.mkdir(mode=0o700)
    shutil.copy2(source_state / "state.json", state_root / "state.json")
    os.chmod(state_root / "state.json", 0o600)
    original_owners = dict(state(state_root / "state.json").get("threadOwner", {}))
    output = args.output.expanduser().resolve() if args.output else work_root / "result.json"
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment.update(
        {
            "CODEX_MUX_HOME": str(state_root),
            "CODEX_MUX_CONTROL_PORT": str(args.control_port),
            "CODEX_MUX_CONTROL_TOKEN": token,
            "CODEX_MUX_UI_TESTS": "1",
        }
    )
    base = f"http://127.0.0.1:{args.control_port}"
    rpc = RpcClient(executable, environment)
    report: dict[str, Any] = {
        "status": "running",
        "artifact": str(app),
        "checks": [],
        "timingsMs": {},
    }
    try:
        wait_health(base, token)
        init, _ = rpc.request(
            "initialize",
            {"clientInfo": {"name": "phase12-acceptance", "version": "1.0"}},
        )
        expect_success(init, "initialize")
        rpc.notify("initialized")

        status, account_payload, _ = request_json(base, "/v1/accounts", token)
        if status != 200:
            raise AcceptanceError("account control query failed")
        connected = [
            item
            for item in account_payload.get("accounts", [])
            if item.get("connected") and item.get("enabled")
        ]
        primary = next((item for item in connected if item.get("controller")), None)
        pro = next((item for item in connected if item.get("planType") == "pro"), None)
        if primary is None or pro is None:
            raise AcceptanceError("connected Primary and Pro 20x are required")
        report["checks"].append("real-two-account-pool")

        ordinary, ordinary_ms = rpc.request(
            "thread/start", {"cwd": str(Path.cwd()), "ephemeral": True}, timeout=120
        )
        ordinary_thread = thread_id(expect_success(ordinary, "ordinary thread/start"))
        persisted = state(state_root / "state.json")
        if persisted.get("threadOwner", {}).get(ordinary_thread) != pro["id"]:
            raise AcceptanceError("ordinary signed-mux task did not route to Pro 20x")
        route = persisted.get("threadRouting", {}).get(ordinary_thread, {})
        if route.get("mode") != "preferred" or not route.get("reason"):
            raise AcceptanceError("ordinary signed-mux task has no routing reason")
        report["timingsMs"]["ordinaryThreadStart"] = round(ordinary_ms, 1)
        report["checks"].append("ordinary-preferred-pro20")

        primary_response, _ = rpc.request(
            "thread/start",
            {
                "cwd": str(Path.cwd()),
                "ephemeral": True,
                "codexMuxRouting": {
                    "mode": "manual_locked",
                    "accountId": primary["id"],
                },
            },
            timeout=120,
        )
        primary_thread = thread_id(
            expect_success(primary_response, "Primary manual thread/start")
        )

        status, cold, cold_ms = request_json(
            base,
            "/v1/plugin-status?"
            + urllib.parse.urlencode(
                {"accountId": primary["id"], "refresh": "false"}
            ),
            token,
        )
        if status != 200 or cold.get("cached") or cold.get("state") != "unknown":
            raise AcceptanceError("plugin cold-cache path was not safe unknown")
        report["timingsMs"]["pluginColdCache"] = round(cold_ms, 1)

        status, timed_out, timeout_ms = request_json(
            base,
            "/v1/plugin-status?"
            + urllib.parse.urlencode(
                {"accountId": primary["id"], "refresh": "true"}
            ),
            token,
            timeout=5,
        )
        if (
            status != 200
            or timed_out.get("state") != "unknown"
            or not 1500 <= timeout_ms <= 2300
        ):
            raise AcceptanceError("plugin hard-timeout path did not fail closed near 1.8s")
        report["timingsMs"]["pluginHardTimeout"] = round(timeout_ms, 1)

        cached: dict[str, Any] | None = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            _, candidate, _ = request_json(
                base,
                "/v1/plugin-status?"
                + urllib.parse.urlencode(
                    {"accountId": primary["id"], "refresh": "false"}
                ),
                token,
            )
            if candidate.get("cached"):
                cached = candidate
                break
            time.sleep(1)
        if cached is None:
            raise AcceptanceError("plugin background refresh did not populate the cache")
        status, hit, hit_ms = request_json(
            base,
            "/v1/plugin-status?"
            + urllib.parse.urlencode(
                {"accountId": primary["id"], "refresh": "true"}
            ),
            token,
        )
        if status != 200 or not hit.get("cached"):
            raise AcceptanceError("plugin cache-hit path missed")
        report["timingsMs"]["pluginCacheHit"] = round(hit_ms, 1)
        report["checks"].append("plugin-cache-cold-timeout-hit")

        conflict = next(
            (
                plugin
                for plugin in hit.get("plugins", [])
                if plugin.get("state") == "conflict" and plugin.get("id")
            ),
            None,
        )
        if conflict is None:
            raise AcceptanceError("real Primary plugin snapshot exposed no conflict")
        blocked, blocked_ms = rpc.request(
            "turn/start",
            {
                "threadId": primary_thread,
                "input": [
                    {
                        "type": "text",
                        "text": f"[@Connector](plugin://{conflict['id']})",
                    }
                ],
            },
            timeout=10,
        )
        if blocked.get("error", {}).get("code") != -32031:
            raise AcceptanceError("real plugin conflict was not blocked before the model")
        report["timingsMs"]["pluginConflictBlock"] = round(blocked_ms, 1)
        report["checks"].append("real-plugin-conflict-preflight")

        read_only, read_only_ms = rpc.request(
            "mcpServer/tool/call",
            {
                "server": "codex_apps",
                "tool": "google_drive.get_profile",
                "threadId": primary_thread,
                "arguments": {},
            },
            timeout=90,
        )
        if "error" in read_only:
            raise AcceptanceError(
                "Primary read-only connector call failed with code "
                f"{read_only['error'].get('code')}"
            )
        report["timingsMs"]["primaryReadOnlyConnector"] = round(read_only_ms, 1)
        report["checks"].append("primary-read-only-connector")

        status, preview, _ = request_json(
            base,
            "/v1/test/rate-limits",
            token,
            method="POST",
            body={"mode": "single_depleted", "accountId": primary["id"]},
            timeout=45,
        )
        if status != 200 or preview.get("ok") is not True:
            raise AcceptanceError("could not enable deterministic depleted preview")
        quota_blocked, _ = rpc.request(
            "turn/start",
            {
                "threadId": primary_thread,
                "input": [{"type": "text", "text": "Manual lock quota check"}],
            },
            timeout=45,
        )
        if quota_blocked.get("error", {}).get("code") != -32030:
            raise AcceptanceError("depleted manual_locked thread did not stop in place")
        if (
            state(state_root / "state.json").get("threadOwner", {}).get(primary_thread)
            != primary["id"]
        ):
            raise AcceptanceError("depleted manual_locked thread silently migrated")
        report["checks"].append("manual-locked-depleted-no-migration")

        final_owners = state(state_root / "state.json").get("threadOwner", {})
        if any(final_owners.get(key) != value for key, value in original_owners.items()):
            raise AcceptanceError("an existing thread owner changed in signed mux E2E")
        report["checks"].append("existing-thread-owners-preserved")
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
    finally:
        try:
            request_json(
                base,
                "/v1/test/rate-limits",
                token,
                method="POST",
                body={"mode": "clear"},
                timeout=10,
            )
        except Exception:
            pass
        rpc.close()
        output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(output, 0o600)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
