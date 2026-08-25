#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import plistlib
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).with_name("update_guard.py")
SPEC = importlib.util.spec_from_file_location("update_guard", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


def make_app(root: Path, version: str, build: str, contents: bytes) -> Path:
    app = root / f"{version}-{build}.app"
    resources = app / "Contents" / "Resources"
    resources.mkdir(parents=True)
    with (app / "Contents" / "Info.plist").open("wb") as handle:
        plistlib.dump(
            {
                "CFBundleShortVersionString": version,
                "CFBundleVersion": build,
            },
            handle,
        )
    (resources / "app.asar").write_bytes(contents)
    return app


class UpdateGuardTests(unittest.TestCase):
    def test_fingerprint_reads_version_build_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = make_app(Path(temporary), "1.2.3", "456", b"asar")
            result = guard.fingerprint(app)
        self.assertEqual(result["version"], "1.2.3")
        self.assertEqual(result["build"], "456")
        self.assertEqual(
            result["asar_sha256"],
            "20f539dde638d97fcfd24d3b72ac23e8341d108190cbaecdb3e1ce7735514bbd",
        )

    def test_unknown_source_never_becomes_supported_update(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_app(root / "source", "2", "200", b"new")
            installed = make_app(root / "installed", "1", "100", b"old")
            state = root / "state.json"
            with mock.patch.object(guard, "load_approved_builds", return_value={}):
                result = guard.inspect(source, installed, state)
        self.assertEqual(result["decision"], "unsupported_update")
        self.assertFalse(result["approved"])

    def test_approved_new_build_is_supported_update(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_app(root / "source", "2", "200", b"new")
            installed = make_app(root / "installed", "1", "100", b"old")
            source_hash = guard.fingerprint(source)["asar_sha256"]
            with mock.patch.object(
                guard,
                "load_approved_builds",
                return_value={("2", "200"): source_hash},
            ):
                result = guard.inspect(source, installed, root / "state.json")
        self.assertEqual(result["decision"], "supported_update")
        self.assertTrue(result["approved"])

    def test_current_build_requires_explicit_record_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = make_app(root / "source", "2", "200", b"new")
            installed = make_app(root / "installed", "2", "200", b"patched")
            source_hash = guard.fingerprint(source)["asar_sha256"]
            with mock.patch.object(
                guard,
                "load_approved_builds",
                return_value={("2", "200"): source_hash},
            ):
                result = guard.inspect(source, installed, root / "state.json")
        self.assertEqual(result["decision"], "current_unrecorded")

    def test_write_state_uses_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "private" / "state.json"
            guard.write_state(state, {"version": 1})
            mode = state.stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_apply_defers_without_running_commands_while_router_is_active(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "Codex Subscription Router.app"
            args = Namespace(
                source=root / "ChatGPT.app",
                destination=destination,
                helper=root / guard.DEFAULT_HELPER.name,
                state=root / "state.json",
                go_bin=None,
                launch=True,
            )
            inspection = {
                "decision": "supported_update",
                "approved": True,
                "source": {},
            }
            with (
                mock.patch.object(guard, "inspect", return_value=inspection),
                mock.patch.object(guard, "bundle_running", return_value=True),
                mock.patch.object(guard, "run") as run_command,
            ):
                result = guard.guarded_apply(args)
        self.assertEqual(result["decision"], "deferred_router_active")
        run_command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
