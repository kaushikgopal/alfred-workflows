"""Disposable-fixture test suite for the Image Tools Alfred 6 workflow."""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

WORKFLOW_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "workflow"))
if WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, WORKFLOW_DIR)

from lib.engine import execute_item
from lib.planner import OperationConfig, plan_batch, plan_unique_path
from lib.probe import probe_image
from lib.tools import AvailableTools, detect_tools


def _create_fixtures(tmp_dir: str) -> dict[str, str]:
    """Generate disposable test images (P3 PNG w/ alpha, EXIF-oriented JPEG, animated GIF, special-char filename)."""
    swift_code = r'''
import Foundation
import ImageIO
import CoreGraphics

let dir = CommandLine.arguments[1]
let p3 = CGColorSpace(name: CGColorSpace.displayP3)!

// 1. Display P3 PNG with semi-transparency and high-frequency detail
do {
    let w = 256, h = 256
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: p3, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    for y in stride(from: 0, to: h, by: 2) {
        for x in stride(from: 0, to: w, by: 2) {
            let r = CGFloat((x * 37 + y * 13) % 256) / 255.0
            let g = CGFloat((x * 17 + y * 53) % 256) / 255.0
            let b = CGFloat((x * 71 + y * 29) % 256) / 255.0
            ctx.setFillColor(red: r, green: g, blue: b, alpha: x < 40 ? 0.4 : 1.0)
            ctx.fill(CGRect(x: x, y: y, width: 2, height: 2))
        }
    }
    let img = ctx.makeImage()!
    let url = URL(fileURLWithPath: dir + "/alpha-p3.png")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}

// 2. High-quality JPEG (q=1.0) with EXIF orientation 6 and special characters in filename
do {
    let w = 320, h = 180
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: p3, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    for y in stride(from: 0, to: h, by: 4) {
        for x in stride(from: 0, to: w, by: 4) {
            let r = CGFloat((x * 11 + y * 23) % 256) / 255.0
            let g = CGFloat((x * 41 + y * 7) % 256) / 255.0
            let b = CGFloat((x * 19 + y * 61) % 256) / 255.0
            ctx.setFillColor(red: r, green: g, blue: b, alpha: 1.0)
            ctx.fill(CGRect(x: x, y: y, width: 4, height: 4))
        }
    }
    let img = ctx.makeImage()!
    let url = URL(fileURLWithPath: dir + "/My Photo (2026) 'café' $1.jpg")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, [
        kCGImagePropertyOrientation: 6,
        kCGImageDestinationLossyCompressionQuality: 1.0
    ] as CFDictionary)
    CGImageDestinationFinalize(dest)
}

// 3. 2-frame animated GIF
do {
    let w = 64, h = 64
    let cs = CGColorSpaceCreateDeviceRGB()
    let url = URL(fileURLWithPath: dir + "/anim.gif")
    let dest = CGImageDestinationCreateWithURL(url as CFURL, "com.compuserve.gif" as CFString, 2, [
        kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]
    ] as CFDictionary)!
    for i in 0..<2 {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: i == 0 ? 1.0 : 0.1, green: 0.3, blue: i == 0 ? 0.1 : 1.0, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        CGImageDestinationAddImage(dest, ctx.makeImage()!, [
            kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.2]
        ] as CFDictionary)
    }
    CGImageDestinationFinalize(dest)
}
'''
    proc = subprocess.run(["swift", "-", tmp_dir], input=swift_code, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Fixture generation failed: {proc.stderr}")

    return {
        "png": os.path.join(tmp_dir, "alpha-p3.png"),
        "jpg": os.path.join(tmp_dir, "My Photo (2026) 'café' $1.jpg"),
        "gif": os.path.join(tmp_dir, "anim.gif"),
    }


class TestImageTools(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tools = detect_tools()
        cls.base_tmp = tempfile.mkdtemp(prefix="imgtools-suite-")
        cls.fixtures = _create_fixtures(cls.base_tmp)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.base_tmp, ignore_errors=True)

    def _copy_fixture(self, key: str, dest_dir: str) -> str:
        src = self.fixtures[key]
        dst = os.path.join(dest_dir, os.path.basename(src))
        shutil.copy2(src, dst)
        return dst

    def test_workflow_plist_and_ui_json_valid(self) -> None:
        with open(os.path.join(WORKFLOW_DIR, "info.plist"), "rb") as f:
            plist = plistlib.load(f)
        self.assertEqual(plist["bundleid"], "com.kaushikgopal.alfred.imagetools")
        types = {o["type"] for o in plist["objects"]}
        self.assertIn("alfred.workflow.trigger.action", types)
        self.assertIn("alfred.workflow.userinterface.alfredui", types)

        ui_path = os.path.join(WORKFLOW_DIR, "convert.alfredui", "ui.json")
        with open(ui_path, "r", encoding="utf-8") as f:
            ui = json.load(f)
        self.assertIn("window", ui)
        self.assertIn("variablesconfig", ui)

    def test_collision_safe_path_planning(self) -> None:
        existing = {"/tmp/a.webp", "/tmp/a-2.webp"}
        reserved: set[str] = set()
        p1 = plan_unique_path("/tmp/a.png", "webp", "", reserved, exists_fn=lambda p: p in existing)
        p2 = plan_unique_path("/tmp/a.jpg", "webp", "", reserved, exists_fn=lambda p: p in existing)
        self.assertEqual(p1, "/tmp/a-3.webp")
        self.assertEqual(p2, "/tmp/a-4.webp")

    def test_missing_tool_warning_on_clean_machine(self) -> None:
        no_brew = AvailableTools(
            sips="/usr/bin/sips",
            cwebp=None,
            dwebp=None,
            gif2webp=None,
            webpmux=None,
            magick=None,
            oxipng=None,
            pngquant=None,
        )
        img = probe_image(self.fixtures["png"], self.tools)
        plans = plan_batch([img], OperationConfig(mode="convert", target_format="webp"), no_brew)
        self.assertIsNotNone(plans[0].blocking_error)
        self.assertIn("brew install webp", plans[0].blocking_error or "")

    def test_png_and_jpeg_to_webp_preserves_original_icc_and_collision(self) -> None:
        if not self.tools.cwebp:
            self.skipTest("cwebp not installed")
        with tempfile.TemporaryDirectory() as d:
            png = self._copy_fixture("png", d)
            jpg = self._copy_fixture("jpg", d)
            with open(png, "rb") as f:
                orig_png_bytes = f.read()
            with open(jpg, "rb") as f:
                orig_jpg_bytes = f.read()

            imgs = [probe_image(png, self.tools), probe_image(jpg, self.tools)]
            self.assertTrue(imgs[0].has_alpha)
            self.assertEqual(imgs[0].icc_profile, "Display P3")

            cfg = OperationConfig(mode="convert", target_format="webp", quality=86, lossless=False, keep_exif=True)
            plans = plan_batch(imgs, cfg, self.tools)
            res = [execute_item(p, cfg, self.tools) for p in plans]
            self.assertEqual([r.status for r in res], ["ok", "ok"])

            # Verify originals untouched
            with open(png, "rb") as f:
                self.assertEqual(f.read(), orig_png_bytes)
            with open(jpg, "rb") as f:
                self.assertEqual(f.read(), orig_jpg_bytes)

            # Verify ICC profile preserved on WebP output
            out_png_webp = res[0].output_path
            assert out_png_webp is not None
            probed_webp = probe_image(out_png_webp, self.tools)
            self.assertEqual(probed_webp.icc_profile, "Display P3")
            self.assertTrue(probed_webp.has_alpha)

            # Run again -> collision-safe -2 file, first output untouched
            plans2 = plan_batch([probe_image(png, self.tools)], cfg, self.tools)
            res2 = execute_item(plans2[0], cfg, self.tools)
            self.assertEqual(res2.status, "ok")
            self.assertTrue((res2.output_path or "").endswith("alpha-p3-2.webp"))
            self.assertTrue(os.path.exists(out_png_webp))

    def test_animated_gif_to_webp_preserves_animation(self) -> None:
        if not self.tools.gif2webp:
            self.skipTest("gif2webp not installed")
        with tempfile.TemporaryDirectory() as d:
            gif = self._copy_fixture("gif", d)
            img = probe_image(gif, self.tools)
            self.assertTrue(img.is_animated)
            cfg = OperationConfig(mode="convert", target_format="webp", quality=86)
            plan = plan_batch([img], cfg, self.tools)[0]
            res = execute_item(plan, cfg, self.tools)
            self.assertEqual(res.status, "ok")
            assert res.output_path is not None
            out_info = probe_image(res.output_path, self.tools)
            self.assertTrue(out_info.is_animated)

    def test_alpha_to_jpeg_warns_and_converts(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            png = self._copy_fixture("png", d)
            img = probe_image(png, self.tools)
            cfg = OperationConfig(mode="convert", target_format="jpeg", quality=85)
            plan = plan_batch([img], cfg, self.tools)[0]
            self.assertTrue(any("transparency" in w.lower() for w in plan.warnings))
            res = execute_item(plan, cfg, self.tools)
            self.assertEqual(res.status, "ok")
            self.assertTrue((res.output_path or "").endswith(".jpg"))

    def test_optimize_action_cli_and_skip_if_larger(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            jpg = self._copy_fixture("jpg", d)
            orig_size = os.path.getsize(jpg)
            proc = subprocess.run(
                [sys.executable, os.path.join(WORKFLOW_DIR, "bin", "optimize_action.py"), jpg],
                capture_output=True,
                text=True,
                check=True,
            )
            payload = json.loads(proc.stdout)
            vars_out = payload["alfredworkflow"]["variables"]
            self.assertIn("Optimized", vars_out["notif_title"])
            opt_path = payload["alfredworkflow"]["arg"]
            self.assertTrue(os.path.exists(opt_path))
            self.assertLess(os.path.getsize(opt_path), orig_size)

    def test_ui_bridge_init_measure_and_convert(self) -> None:
        if not self.tools.cwebp:
            self.skipTest("cwebp not installed")
        with tempfile.TemporaryDirectory() as d:
            png = self._copy_fixture("png", d)
            bridge = os.path.join(WORKFLOW_DIR, "convert.alfredui", "scripts", "bridge.sh")

            # init
            r_init = subprocess.run([bridge, "init", "webp", "86", "0", "1", png], capture_output=True, text=True, check=True)
            j_init = json.loads(r_init.stdout)
            rows = j_init["update"]["ids"]["file_list"]["data"]["src"]
            self.assertEqual(len(rows), 1)
            self.assertIn("alpha-p3.webp", rows[0]["row_title.text"])

            # measure (must NOT create output file)
            r_meas = subprocess.run([bridge, "measure", "webp", "86", "0", "1", png], capture_output=True, text=True, check=True)
            j_meas = json.loads(r_meas.stdout)
            self.assertIn("Measured:", j_meas["update"]["ids"]["file_list"]["data"]["src"][0]["row_detail.text"])
            self.assertFalse(os.path.exists(os.path.join(d, "alpha-p3.webp")))

            # convert (creates output file)
            r_conv = subprocess.run([bridge, "convert", "webp", "86", "0", "1", png], capture_output=True, text=True, check=True)
            j_conv = json.loads(r_conv.stdout)
            self.assertIn("✓ Saved", j_conv["update"]["ids"]["file_list"]["data"]["src"][0]["row_detail.text"])
            self.assertTrue(os.path.exists(os.path.join(d, "alpha-p3.webp")))


if __name__ == "__main__":
    unittest.main()
