/** Pure planning rules: format metadata, defaults, collision-safe paths, and warnings. */

import fs from "node:fs";
import path from "node:path";
import type { ImageInfo } from "./probe.ts";
import { missingHint, type AvailableTools } from "./tools.ts";

export const DEFAULT_QUALITY: Readonly<Record<string, number>> = {
  webp: 86,
  jpeg: 85,
  avif: 82,
  heic: 82,
};

export const FORMAT_EXT: Readonly<Record<string, string>> = {
  webp: "webp",
  jpeg: "jpg",
  png: "png",
  avif: "avif",
  heic: "heic",
  tiff: "tiff",
  gif: "gif",
};

export const FORMAT_LABEL: Readonly<Record<string, string>> = {
  webp: "WebP",
  jpeg: "JPEG",
  png: "PNG",
  avif: "AVIF",
  heic: "HEIC",
  tiff: "TIFF",
  gif: "GIF",
  optimize: "Optimize (Same Format)",
};

export const LOSSLESS_CAPABLE: ReadonlySet<string> = new Set(["webp", "avif", "heic"]);
export const ALWAYS_LOSSLESS: ReadonlySet<string> = new Set(["png", "tiff", "gif"]);
export const QUALITY_FORMATS: ReadonlySet<string> = new Set(["webp", "jpeg", "avif", "heic"]);
export const ALPHA_CAPABLE: ReadonlySet<string> = new Set([
  "webp",
  "png",
  "avif",
  "heic",
  "tiff",
  "gif",
]);
export const ANIMATION_CAPABLE: ReadonlySet<string> = new Set(["webp", "gif"]);

export interface OperationConfig {
  readonly mode: "convert" | "optimize";
  readonly targetFormat: string;
  readonly quality?: number | null;
  readonly lossless?: boolean;
  readonly keepExif?: boolean;
  readonly skipIfLarger?: boolean;
}

export interface PlannedItem {
  readonly source: ImageInfo;
  readonly effectiveFormat: string;
  readonly outputPath: string;
  readonly outputFilename: string;
  readonly quality: number | null;
  readonly lossless: boolean;
  readonly modeLabel: string;
  readonly warnings: readonly string[];
  readonly blockingError: string | null;
}

export function clampQuality(value: number | null | undefined, fmt: string): number | null {
  if (!QUALITY_FORMATS.has(fmt)) return null;
  if (value === null || value === undefined || Number.isNaN(value)) {
    return DEFAULT_QUALITY[fmt] ?? 85;
  }
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

export function formatBytes(numBytes: number): string {
  if (numBytes < 1024) return `${numBytes} B`;
  if (numBytes < 1024 * 1024) return `${(numBytes / 1024).toFixed(1)} KB`;
  return `${(numBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDelta(oldBytes: number, newBytes: number): string {
  if (oldBytes <= 0) return "";
  const pct = ((newBytes - oldBytes) / oldBytes) * 100.0;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}%`;
}

export function planUniquePath(
  sourcePath: string,
  targetExt: string,
  suffix: string,
  reserved: Set<string>,
  existsFn: (p: string) => boolean = fs.existsSync,
): string {
  const directory = path.dirname(sourcePath);
  const parsed = path.parse(sourcePath);
  const ext = targetExt.replace(/^\.+/, "").toLowerCase();

  const base = `${parsed.name}${suffix}`;
  let candidate = path.join(directory, `${base}.${ext}`);
  if (!reserved.has(candidate) && !existsFn(candidate)) {
    reserved.add(candidate);
    return candidate;
  }

  let counter = 2;
  while (true) {
    candidate = path.join(directory, `${base}-${counter}.${ext}`);
    if (!reserved.has(candidate) && !existsFn(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
    counter++;
  }
}

export function checkToolRequirement(
  sourceFmt: string,
  targetFmt: string,
  isAnimated: boolean,
  tools: AvailableTools,
): readonly [string | null, string | null] {
  if (sourceFmt === "svg" && !tools.magick) {
    return [`Converting SVG requires ImageMagick. ${missingHint("magick")}`, null];
  }

  if (targetFmt === "webp") {
    if (isAnimated && sourceFmt === "gif") {
      if (!tools.gif2webp && !tools.magick) {
        return [`Animated GIF → WebP requires gif2webp. ${missingHint("gif2webp")}`, null];
      }
    } else if (!tools.cwebp && !tools.magick) {
      return [`WebP encoding is not built into macOS. ${missingHint("cwebp")}`, null];
    }
  }

  if (sourceFmt === "webp" && targetFmt !== "webp") {
    if (isAnimated && !tools.magick) {
      return [`Animated WebP conversion requires ImageMagick. ${missingHint("magick")}`, null];
    }
    if (!tools.sips && !tools.dwebp && !tools.magick) {
      return [`WebP decoding requires sips or dwebp. ${missingHint("dwebp")}`, null];
    }
  }

  if (targetFmt === "png" && sourceFmt === "png") {
    if (!tools.oxipng && !tools.magick) {
      return [
        null,
        "macOS built-ins cannot optimize PNGs effectively. Install oxipng (brew install oxipng) for strong lossless PNG compression.",
      ];
    }
    if (!tools.oxipng && tools.magick) {
      return [
        null,
        "Using ImageMagick for PNG compression (modest savings). For stronger lossless PNG optimization: brew install oxipng",
      ];
    }
  }

  if (targetFmt !== "webp" && !tools.sips && !tools.magick) {
    return ["Neither sips nor ImageMagick is available.", null];
  }

  return [null, null];
}

export function planBatch(
  images: readonly ImageInfo[],
  config: OperationConfig,
  tools: AvailableTools,
  existsFn: (p: string) => boolean = fs.existsSync,
): PlannedItem[] {
  const reserved = new Set<string>();
  const plans: PlannedItem[] = [];

  for (const img of images) {
    if (img.error) {
      plans.push({
        source: img,
        effectiveFormat: "",
        outputPath: "",
        outputFilename: "—",
        quality: null,
        lossless: false,
        modeLabel: "Error",
        warnings: [],
        blockingError: img.error,
      });
      continue;
    }

    const isOptimize = config.mode === "optimize" || config.targetFormat === "optimize";
    const effectiveFmt = isOptimize ? img.formatName : config.targetFormat;

    if (!(effectiveFmt in FORMAT_EXT)) {
      plans.push({
        source: img,
        effectiveFormat: effectiveFmt,
        outputPath: "",
        outputFilename: "—",
        quality: null,
        lossless: false,
        modeLabel: "Unsupported",
        warnings: [],
        blockingError: `Unsupported format: .${img.ext || "unknown"}`,
      });
      continue;
    }

    let lossless: boolean;
    let quality: number | null;
    if (ALWAYS_LOSSLESS.has(effectiveFmt)) {
      lossless = true;
      quality = null;
    } else if (LOSSLESS_CAPABLE.has(effectiveFmt) && Boolean(config.lossless)) {
      lossless = true;
      quality = null;
    } else {
      lossless = false;
      quality = clampQuality(config.quality, effectiveFmt);
    }

    const modeLabel = lossless ? "Lossless" : `Lossy q=${quality}`;
    const targetExt = isOptimize && img.ext ? img.ext : FORMAT_EXT[effectiveFmt];
    const suffix = isOptimize || effectiveFmt === img.formatName ? "-optimized" : "";
    const outPath = planUniquePath(img.path, targetExt, suffix, reserved, existsFn);

    const warnings: string[] = [];
    const [blockingErr, toolWarn] = checkToolRequirement(
      img.formatName,
      effectiveFmt,
      img.isAnimated,
      tools,
    );
    if (toolWarn) warnings.push(toolWarn);
    if (img.hasAlpha && !ALPHA_CAPABLE.has(effectiveFmt)) {
      warnings.push("Has transparency — JPEG flattens alpha onto white");
    }
    if (img.isAnimated && !ANIMATION_CAPABLE.has(effectiveFmt)) {
      warnings.push(
        `Animated ${img.formatName.toUpperCase()} — ${effectiveFmt.toUpperCase()} keeps only frame 1`,
      );
    }

    plans.push({
      source: img,
      effectiveFormat: effectiveFmt,
      outputPath: outPath,
      outputFilename: path.basename(outPath),
      quality,
      lossless,
      modeLabel,
      warnings,
      blockingError: blockingErr,
    });
  }

  return plans;
}
