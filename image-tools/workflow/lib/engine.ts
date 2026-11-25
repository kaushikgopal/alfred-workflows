/** Image conversion and optimization execution engine with atomic, non-clobbering writes. */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatBytes,
  formatDelta,
  type OperationConfig,
  type PlannedItem,
} from "./planner.ts";
import { mapPool } from "./probe.ts";
import type { AvailableTools } from "./tools.ts";

export interface ExecutionResult {
  readonly plan: PlannedItem;
  readonly status: "ok" | "skipped" | "error";
  readonly outputPath: string | null;
  readonly outputBytes: number | null;
  readonly message: string;
}

function runCommand(cmd: readonly string[]): Promise<readonly [number, string]> {
  const [bin, ...args] = cmd;
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      const msg = (stderr || stdout || (err ? err.message : "")).trim();
      resolve([code, msg]);
    });
  });
}

async function sipsConvert(
  sipsBin: string,
  src: string,
  dst: string,
  targetFmt: string,
  quality: number | null,
  lossless: boolean,
): Promise<readonly [boolean, string]> {
  const cmd = [sipsBin, "-s", "format", targetFmt];
  if (targetFmt === "jpeg" || targetFmt === "heic" || targetFmt === "avif") {
    if (lossless && (targetFmt === "heic" || targetFmt === "avif")) {
      cmd.push("-s", "formatOptions", "100");
    } else if (quality !== null) {
      cmd.push("-s", "formatOptions", String(quality));
    }
  }
  cmd.push(src, "--out", dst);
  const [code, err] = await runCommand(cmd);
  return [code === 0, err];
}

async function encodeToTemp(
  plan: PlannedItem,
  config: OperationConfig,
  tools: AvailableTools,
  workDir: string,
): Promise<readonly [string | null, string | null]> {
  const src = plan.source.path;
  const srcFmt = plan.source.formatName;
  const dstFmt = plan.effectiveFormat;
  const ext = path.extname(plan.outputFilename) || `.${dstFmt}`;
  const tmpOut = path.join(workDir, `out${ext}`);
  const keepExif = config.keepExif ?? true;

  // 1. Animated GIF -> WebP via gif2webp (or magick)
  if (dstFmt === "webp" && plan.source.isAnimated && srcFmt === "gif") {
    if (tools.gif2webp) {
      const cmd = [tools.gif2webp, "-quiet", "-mt"];
      if (plan.lossless) {
        cmd.push("-lossless");
      } else {
        cmd.push("-lossy", "-q", String(plan.quality ?? 86));
      }
      cmd.push(src, "-o", tmpOut);
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "gif2webp failed"];
    }
    if (tools.magick) {
      const cmd = [tools.magick, src];
      if (plan.lossless) {
        cmd.push("-define", "webp:lossless=true");
      } else {
        cmd.push("-quality", String(plan.quality ?? 86));
      }
      cmd.push(tmpOut);
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "magick failed"];
    }
  }

  // 2. Target WebP (still or animated WebP)
  if (dstFmt === "webp") {
    if (plan.source.isAnimated && tools.magick) {
      const cmd = [tools.magick, src];
      if (plan.lossless) {
        cmd.push("-define", "webp:lossless=true");
      } else {
        cmd.push("-quality", String(plan.quality ?? 86));
      }
      cmd.push(tmpOut);
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "magick failed"];
    }

    if (tools.cwebp) {
      let cwebpInput = src;
      if (srcFmt !== "png" && srcFmt !== "jpeg" && srcFmt !== "tiff" && srcFmt !== "webp") {
        const decodedPng = path.join(workDir, "decoded.png");
        if (srcFmt === "svg" && tools.magick) {
          const [code, err] = await runCommand([tools.magick, "-background", "none", src, decodedPng]);
          if (code !== 0) return [null, err || "Failed to rasterize SVG"];
        } else if (tools.sips) {
          const [ok, err] = await sipsConvert(tools.sips, src, decodedPng, "png", null, true);
          if (!ok) return [null, err || "Failed to decode source image"];
        } else if (tools.magick) {
          const [code, err] = await runCommand([tools.magick, src, decodedPng]);
          if (code !== 0) return [null, err || "Failed to decode source image"];
        }
        cwebpInput = decodedPng;
      }

      if (!keepExif && srcFmt === "jpeg" && tools.magick) {
        const orientedPng = path.join(workDir, "oriented.png");
        const [code] = await runCommand([tools.magick, src, "-auto-orient", orientedPng]);
        if (code === 0) cwebpInput = orientedPng;
      }

      const cmd = [tools.cwebp, "-quiet", "-mt", "-m", "4"];
      if (plan.lossless) {
        cmd.push("-lossless");
      } else {
        cmd.push("-q", String(plan.quality ?? 86), "-alpha_q", "95");
      }
      cmd.push("-metadata", keepExif ? "all" : "icc");
      cmd.push(cwebpInput, "-o", tmpOut);
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "cwebp failed"];
    }

    if (tools.magick) {
      const cmd = [tools.magick, src];
      if (!keepExif) cmd.push("-auto-orient", "-strip");
      if (plan.lossless) {
        cmd.push("-define", "webp:lossless=true");
      } else {
        cmd.push("-quality", String(plan.quality ?? 86));
      }
      cmd.push(tmpOut);
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "magick failed"];
    }

    return [null, "No WebP encoder available (brew install webp)"];
  }

  // 3. PNG optimization (PNG -> PNG)
  if (dstFmt === "png" && srcFmt === "png") {
    if (tools.oxipng) {
      const cmd = [tools.oxipng, "-o", "4", "--quiet"];
      if (!keepExif) cmd.push("--strip", "safe");
      cmd.push("--out", tmpOut, src);
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "oxipng failed"];
    }
    if (tools.magick) {
      const cmd = [tools.magick, src];
      if (!keepExif) {
        cmd.push("-define", "png:exclude-chunk=eXIf,tEXt,zTXt,iTXt");
      }
      cmd.push(
        "-define", "png:compression-level=9",
        "-define", "png:compression-strategy=1",
        tmpOut,
      );
      const [code, err] = await runCommand(cmd);
      return code === 0 ? [tmpOut, null] : [null, err || "magick PNG compression failed"];
    }
  }

  // 4. SVG input -> any raster format via magick
  if (srcFmt === "svg") {
    if (!tools.magick) {
      return [null, "ImageMagick required for SVG input (brew install imagemagick)"];
    }
    const cmd = [tools.magick, "-background", dstFmt === "jpeg" ? "white" : "none", src];
    if (dstFmt === "jpeg") cmd.push("-alpha", "remove", "-alpha", "off");
    if (plan.quality !== null && !plan.lossless) {
      cmd.push("-quality", String(plan.quality));
    }
    cmd.push(tmpOut);
    const [code, err] = await runCommand(cmd);
    return code === 0 ? [tmpOut, null] : [null, err || "magick SVG conversion failed"];
  }

  // 5. Transparent image -> JPEG: flatten cleanly onto white
  if (dstFmt === "jpeg" && plan.source.hasAlpha && tools.magick) {
    const cmd = [
      tools.magick,
      src,
      "-auto-orient",
      "-background", "white",
      "-alpha", "remove",
      "-alpha", "off",
      "-quality", String(plan.quality ?? 85),
    ];
    if (!keepExif) cmd.push("+profile", "exif,xmp,iptc");
    cmd.push(tmpOut);
    const [code, err] = await runCommand(cmd);
    return code === 0 ? [tmpOut, null] : [null, err || "magick JPEG conversion failed"];
  }

  // 6. Animated WebP -> GIF via magick
  if (dstFmt === "gif" && plan.source.isAnimated && tools.magick) {
    const [code, err] = await runCommand([tools.magick, src, tmpOut]);
    return code === 0 ? [tmpOut, null] : [null, err || "magick GIF conversion failed"];
  }

  // 7. Strip EXIF while keeping ICC profile via magick when requested
  if (
    !keepExif &&
    tools.magick &&
    (dstFmt === "jpeg" || dstFmt === "png" || dstFmt === "heic" || dstFmt === "avif" || dstFmt === "tiff")
  ) {
    const cmd = [tools.magick, src, "-auto-orient", "+profile", "exif,xmp,iptc"];
    if (plan.quality !== null && !plan.lossless) {
      cmd.push("-quality", String(plan.quality));
    }
    cmd.push(tmpOut);
    const [code] = await runCommand(cmd);
    if (code === 0) return [tmpOut, null];
  }

  // 8. Native macOS sips
  if (tools.sips) {
    const [ok, err] = await sipsConvert(
      tools.sips,
      src,
      tmpOut,
      dstFmt,
      plan.quality,
      plan.lossless,
    );
    if (ok) return [tmpOut, null];
    if (tools.magick) {
      const cmd = [tools.magick, src];
      if (plan.quality !== null && !plan.lossless) {
        cmd.push("-quality", String(plan.quality));
      }
      cmd.push(tmpOut);
      const [code, merr] = await runCommand(cmd);
      if (code === 0) return [tmpOut, null];
      return [null, merr || err];
    }
    return [null, err || "sips conversion failed"];
  }

  return [null, "No compatible encoder found"];
}

function atomicMoveNoClobber(srcTmp: string, dstPath: string): string {
  const dstDir = path.dirname(dstPath);
  const parsed = path.parse(dstPath);
  const staged = path.join(
    dstDir,
    `.alfred-imgtmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}${parsed.ext}`,
  );
  fs.copyFileSync(srcTmp, staged);
  try {
    let candidate = dstPath;
    let counter = 2;
    while (true) {
      try {
        fs.linkSync(staged, candidate);
        return candidate;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          candidate = path.join(dstDir, `${parsed.name}-${counter}${parsed.ext}`);
          counter++;
          continue;
        }
        throw err;
      }
    }
  } finally {
    try {
      fs.unlinkSync(staged);
    } catch {
      // ignore cleanup error
    }
  }
}

export async function executeItem(
  plan: PlannedItem,
  config: OperationConfig,
  tools: AvailableTools,
  dryRunMeasure = false,
): Promise<ExecutionResult> {
  if (plan.blockingError) {
    return {
      plan,
      status: "error",
      outputPath: null,
      outputBytes: null,
      message: plan.blockingError,
    };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alfred-imgtools-"));
  try {
    const [tmpOut, err] = await encodeToTemp(plan, config, tools, tmpDir);
    if (err || !tmpOut || !fs.existsSync(tmpOut)) {
      return {
        plan,
        status: "error",
        outputPath: null,
        outputBytes: null,
        message: err || "Encoding failed",
      };
    }

    const outBytes = fs.statSync(tmpOut).size;
    const inBytes = plan.source.sizeBytes;
    const delta = formatDelta(inBytes, outBytes);

    if (config.skipIfLarger && outBytes >= inBytes) {
      return {
        plan,
        status: "skipped",
        outputPath: null,
        outputBytes: outBytes,
        message: `Already optimal (${formatBytes(inBytes)} → ${formatBytes(outBytes)})`,
      };
    }

    if (dryRunMeasure) {
      return {
        plan,
        status: "ok",
        outputPath: null,
        outputBytes: outBytes,
        message: `Measured: ${formatBytes(inBytes)} → ${formatBytes(outBytes)} (${delta})`,
      };
    }

    try {
      const finalPath = atomicMoveNoClobber(tmpOut, plan.outputPath);
      return {
        plan,
        status: "ok",
        outputPath: finalPath,
        outputBytes: outBytes,
        message: `${formatBytes(inBytes)} → ${formatBytes(outBytes)} (${delta})`,
      };
    } catch (exc) {
      return {
        plan,
        status: "error",
        outputPath: null,
        outputBytes: null,
        message: `Could not save output: ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function executeBatch(
  plans: readonly PlannedItem[],
  config: OperationConfig,
  tools: AvailableTools,
  dryRunMeasure = false,
  maxWorkers?: number,
): Promise<ExecutionResult[]> {
  const workers = maxWorkers ?? Math.min(plans.length || 1, os.availableParallelism() || 4, 8);
  return mapPool(plans, workers, (p) => executeItem(p, config, tools, dryRunMeasure));
}
