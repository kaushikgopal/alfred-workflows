/** Disposable-fixture test suite for the Image Tools Alfred 6 workflow. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { executeItem } from "../workflow/lib/engine.ts";
import {
  planBatch,
  planUniquePath,
  type OperationConfig,
} from "../workflow/lib/planner.ts";
import { probeImage } from "../workflow/lib/probe.ts";
import { detectTools, type AvailableTools } from "../workflow/lib/tools.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(TESTS_DIR, "..", "workflow");

interface Fixtures {
  readonly png: string;
  readonly jpg: string;
  readonly gif: string;
}

function createFixtures(tmpDir: string): Fixtures {
  const swiftCode = String.raw`
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
`;

  execFileSync("swift", ["-", tmpDir], { input: swiftCode, encoding: "utf8" });

  return {
    png: path.join(tmpDir, "alpha-p3.png"),
    jpg: path.join(tmpDir, "My Photo (2026) 'café' $1.jpg"),
    gif: path.join(tmpDir, "anim.gif"),
  };
}

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgtools-case-"));
  return Promise.resolve(fn(dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

describe("Image Tools workflow", () => {
  let tools: AvailableTools;
  let baseTmp: string;
  let fixtures: Fixtures;

  before(() => {
    tools = detectTools();
    baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "imgtools-suite-"));
    fixtures = createFixtures(baseTmp);
  });

  after(() => {
    fs.rmSync(baseTmp, { recursive: true, force: true });
  });

  function copyFixture(key: keyof Fixtures, destDir: string): string {
    const src = fixtures[key];
    const dst = path.join(destDir, path.basename(src));
    fs.copyFileSync(src, dst);
    return dst;
  }

  it("workflow plist and ui.json are valid", () => {
    const plistJson = execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", path.join(WORKFLOW_DIR, "info.plist")],
      { encoding: "utf8" },
    );
    const plist = JSON.parse(plistJson) as {
      bundleid: string;
      objects: Array<{ type: string }>;
    };
    assert.equal(plist.bundleid, "kau.sh.alfred.imagetools");
    const types = new Set(plist.objects.map((o) => o.type));
    assert.ok(types.has("alfred.workflow.trigger.action"));
    assert.ok(types.has("alfred.workflow.userinterface.alfredui"));

    const ui = JSON.parse(
      fs.readFileSync(path.join(WORKFLOW_DIR, "convert.alfredui", "ui.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.ok("window" in ui);
    assert.ok("variablesconfig" in ui);
  });

  it("plans collision-safe output paths", () => {
    const existing = new Set(["/tmp/a.webp", "/tmp/a-2.webp"]);
    const reserved = new Set<string>();
    const p1 = planUniquePath("/tmp/a.png", "webp", "", reserved, (p) => existing.has(p));
    const p2 = planUniquePath("/tmp/a.jpg", "webp", "", reserved, (p) => existing.has(p));
    assert.equal(p1, "/tmp/a-3.webp");
    assert.equal(p2, "/tmp/a-4.webp");
  });

  it("warns about missing tools on a clean machine", async () => {
    const noBrew: AvailableTools = {
      sips: "/usr/bin/sips",
      cwebp: null,
      dwebp: null,
      gif2webp: null,
      webpmux: null,
      magick: null,
      oxipng: null,
      pngquant: null,
    };
    const img = await probeImage(fixtures.png, tools);
    const plans = planBatch([img], { mode: "convert", targetFormat: "webp" }, noBrew);
    assert.ok(plans[0].blockingError);
    assert.match(plans[0].blockingError, /brew install webp/);
  });

  it("converts PNG and JPEG to WebP while preserving originals, ICC profile, and collision safety", async (t) => {
    if (!tools.cwebp) {
      t.skip("cwebp not installed");
      return;
    }
    await withTempDir(async (d) => {
      const png = copyFixture("png", d);
      const jpg = copyFixture("jpg", d);
      const origPngBytes = fs.readFileSync(png);
      const origJpgBytes = fs.readFileSync(jpg);

      const imgs = [await probeImage(png, tools), await probeImage(jpg, tools)];
      assert.equal(imgs[0].hasAlpha, true);
      assert.equal(imgs[0].iccProfile, "Display P3");

      const cfg: OperationConfig = {
        mode: "convert",
        targetFormat: "webp",
        quality: 86,
        lossless: false,
        keepExif: true,
      };
      const plans = planBatch(imgs, cfg, tools);
      const res = [
        await executeItem(plans[0], cfg, tools),
        await executeItem(plans[1], cfg, tools),
      ];
      assert.deepEqual(
        res.map((r) => r.status),
        ["ok", "ok"],
      );

      assert.ok(fs.readFileSync(png).equals(origPngBytes));
      assert.ok(fs.readFileSync(jpg).equals(origJpgBytes));

      const outPngWebp = res[0].outputPath;
      assert.ok(outPngWebp);
      const probedWebp = await probeImage(outPngWebp, tools);
      assert.equal(probedWebp.iccProfile, "Display P3");
      assert.equal(probedWebp.hasAlpha, true);

      const plans2 = planBatch([await probeImage(png, tools)], cfg, tools);
      const res2 = await executeItem(plans2[0], cfg, tools);
      assert.equal(res2.status, "ok");
      assert.ok((res2.outputPath ?? "").endsWith("alpha-p3-2.webp"));
      assert.ok(fs.existsSync(outPngWebp));
    });
  });

  it("preserves animation when converting animated GIF to WebP", async (t) => {
    if (!tools.gif2webp) {
      t.skip("gif2webp not installed");
      return;
    }
    await withTempDir(async (d) => {
      const gif = copyFixture("gif", d);
      const img = await probeImage(gif, tools);
      assert.equal(img.isAnimated, true);

      const cfg: OperationConfig = { mode: "convert", targetFormat: "webp", quality: 86 };
      const plan = planBatch([img], cfg, tools)[0];
      const res = await executeItem(plan, cfg, tools);
      assert.equal(res.status, "ok");
      assert.ok(res.outputPath);
      const outInfo = await probeImage(res.outputPath, tools);
      assert.equal(outInfo.isAnimated, true);
    });
  });

  it("warns and converts transparent PNG to JPEG", async () => {
    await withTempDir(async (d) => {
      const png = copyFixture("png", d);
      const img = await probeImage(png, tools);
      const cfg: OperationConfig = { mode: "convert", targetFormat: "jpeg", quality: 85 };
      const plan = planBatch([img], cfg, tools)[0];
      assert.ok(plan.warnings.some((w) => w.toLowerCase().includes("transparency")));
      const res = await executeItem(plan, cfg, tools);
      assert.equal(res.status, "ok");
      assert.ok((res.outputPath ?? "").endsWith(".jpg"));
    });
  });

  it("runs optimize_action CLI and shrinks high-quality JPEG", async () => {
    await withTempDir((d) => {
      const jpg = copyFixture("jpg", d);
      const origSize = fs.statSync(jpg).size;
      const stdout = execFileSync(
        process.execPath,
        [path.join(WORKFLOW_DIR, "bin", "optimize_action.ts"), jpg],
        { encoding: "utf8" },
      );
      const payload = JSON.parse(stdout) as {
        alfredworkflow: { arg: string; variables: { notif_title: string } };
      };
      assert.match(payload.alfredworkflow.variables.notif_title, /Optimized/);
      const optPath = payload.alfredworkflow.arg;
      assert.ok(fs.existsSync(optPath));
      assert.ok(fs.statSync(optPath).size < origSize);
    });
  });

  it("handles ui_bridge init, measure, and convert actions", async (t) => {
    if (!tools.cwebp) {
      t.skip("cwebp not installed");
      return;
    }
    await withTempDir((d) => {
      const png = copyFixture("png", d);
      const bridge = path.join(WORKFLOW_DIR, "convert.alfredui", "scripts", "bridge.sh");

      interface UiResponse {
        update: {
          ids: {
            file_list: {
              data: {
                src: Array<{ "row_title.text": string; "row_detail.text": string }>;
              };
            };
          };
        };
      }

      const initJson = JSON.parse(
        execFileSync(bridge, ["init", "webp", "86", "0", "1", png], { encoding: "utf8" }),
      ) as UiResponse;
      const rows = initJson.update.ids.file_list.data.src;
      assert.equal(rows.length, 1);
      assert.match(rows[0]["row_title.text"], /alpha-p3\.webp/);

      const measJson = JSON.parse(
        execFileSync(bridge, ["measure", "webp", "86", "0", "1", png], { encoding: "utf8" }),
      ) as UiResponse;
      assert.match(measJson.update.ids.file_list.data.src[0]["row_detail.text"], /Measured:/);
      assert.equal(fs.existsSync(path.join(d, "alpha-p3.webp")), false);

      const convJson = JSON.parse(
        execFileSync(bridge, ["convert", "webp", "86", "0", "1", png], { encoding: "utf8" }),
      ) as UiResponse;
      assert.match(convJson.update.ids.file_list.data.src[0]["row_detail.text"], /✓ Saved/);
      assert.equal(fs.existsSync(path.join(d, "alpha-p3.webp")), true);
    });
  });
});
