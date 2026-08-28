#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("patch_app.py")
SPEC = importlib.util.spec_from_file_location("patch_app", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
patch_app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch_app)


class ExactAnchorTests(unittest.TestCase):
    def test_selects_the_only_exact_supported_anchor(self) -> None:
        selected = patch_app.select_unique_anchor(
            "prefix current-anchor suffix",
            ("legacy-anchor", "current-anchor"),
            "missing",
        )
        self.assertEqual(selected, "current-anchor")

    def test_rejects_a_duplicate_anchor(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            patch_app.select_unique_anchor(
                "anchor anchor",
                ("anchor",),
                "ambiguous",
            )

    def test_rejects_multiple_supported_anchors(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            patch_app.select_unique_anchor(
                "legacy-anchor current-anchor",
                ("legacy-anchor", "current-anchor"),
                "ambiguous",
            )


class RendererCompatibilityTests(unittest.TestCase):
    def test_native_route_bridge_supports_every_recorded_minified_shape(self) -> None:
        samples = (
            "i=xXt({pathname:t,routeTemplate:s4s(ZZl,t),search:n}),"
            "a=i.routeKind===`client-local-thread`||i.routeKind===`local-thread`||"
            "i.routeKind===`remote-thread`?By(i):null",
            "i=TXt({pathname:t,routeTemplate:l4s($Zl,t),search:n}),"
            "a=i.routeKind===`client-local-thread`||i.routeKind===`local-thread`||"
            "i.routeKind===`remote-thread`?Ry(i):null",
            "a=v_n({pathname:n,routeTemplate:jWs(MYl,n),search:r}),"
            "o=a.routeKind===`client-local-thread`||a.routeKind===`local-thread`||"
            "a.routeKind===`remote-thread`?$x(a):null",
        )

        for sample in samples:
            with self.subTest(sample=sample[:12]):
                patched = patch_app.patch_native_route_bridge(sample)
                self.assertEqual(patched.count("codexMuxTrackNativeRoute("), 1)
                self.assertIn("routeKind===`local-thread`", patched)

    def test_native_route_bridge_fails_closed_when_ambiguous(self) -> None:
        sample = (
            "i=xXt({pathname:t,routeTemplate:s4s(ZZl,t),search:n}),"
            "a=i.routeKind===`client-local-thread`||i.routeKind===`local-thread`||"
            "i.routeKind===`remote-thread`?By(i):null"
        )
        with self.assertRaisesRegex(RuntimeError, "found 2"):
            patch_app.patch_native_route_bridge(sample + sample)

    def test_build_7119_maps_every_account_menu_component(self) -> None:
        component = (patch_app.PROJECT_ROOT / "ui" / "account-menu.js").read_text(
            encoding="utf-8"
        )

        adapted, jsx_runtime = patch_app.adapt_account_menu_component(
            component,
            "function zbl(e){let t=(0,Wbl.c)(252)",
        )

        self.assertEqual(jsx_runtime, "m8")
        self.assertIn("Gbl.useState", adapted)
        self.assertIn("us(Q)", adapted)
        self.assertIn("Cz(modalScope", adapted)
        self.assertIn("hza(imageUrl || null).src", adapted)
        self.assertIn("(H6s,", adapted)
        self.assertIn("m8.jsx", adapted)
        self.assertIn("m8.Fragment", adapted)
        self.assertIn("VI,", adapted)
        self.assertIn("qI.Separator", adapted)
        for stale in ("Pql.", "ys(Q)", "d7.", "mI,", "bI."):
            self.assertNotIn(stale, adapted)


if __name__ == "__main__":
    unittest.main()
