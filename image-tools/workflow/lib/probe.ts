/** Fast image metadata probing using macOS built-ins and lightweight header checks. */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AvailableTools } from "./tools.ts";

export interface ImageInfo {
  readonly path: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly ext: string;
  readonly formatName: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly hasAlpha: boolean;
  readonly isAnimated: boolean;
  readonly iccProfile: string | null;
  readonly error: string | null;
}

export const EXT_TO_FORMAT: Readonly<Record<string, string>> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  jpe: "jpeg",
  png: "png",
  webp: "webp",
  avif: "avif",
  heic: "heic",
  heif: "heic",
  gif: "gif",
  tif: "tiff",
  tiff: "tiff",
  bmp: "bmp",
  psd: "psd",
  jp2: "jp2",
  tga: "tga",
  ico: "ico",
  icns: "icns",
  svg: "svg",
};

export function normalizeFormat(extOrFmt: string): string {
  const key = extOrFmt.toLowerCase().replace(/^\.+/, "");
  return EXT_TO_FORMAT[key] ?? key;
}

function readPrefixBytes(filePath: string, maxBytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

function isAnimatedGif(filePath: string): boolean {
  const data = readPrefixBytes(filePath, 1024 * 512);
  if (!data || data.length < 13) return false;
  const sig = data.subarray(0, 6).toString("ascii");
  if (sig !== "GIF87a" && sig !== "GIF89a") return false;

  let pos = 13;
  const packed = data[10];
  if (packed & 0x80) {
    pos += 3 * (1 << ((packed & 0x07) + 1));
  }
  let frames = 0;
  const n = data.length;
  while (pos < n) {
    const block = data[pos++];
    if (block === 0x2c) {
      frames++;
      if (frames > 1) return true;
      if (pos + 9 > n) break;
      const lctPacked = data[pos + 8];
      pos += 9;
      if (lctPacked & 0x80) {
        pos += 3 * (1 << ((lctPacked & 0x07) + 1));
      }
      pos += 1; // LZW minimum code size
      while (pos < n && data[pos] !== 0) {
        pos += 1 + data[pos];
      }
      pos += 1;
    } else if (block === 0x21) {
      if (pos >= n) break;
      pos += 1; // extension label
      while (pos < n && data[pos] !== 0) {
        pos += 1 + data[pos];
      }
      pos += 1;
    } else if (block === 0x3b) {
      break;
    } else {
      break;
    }
  }
  return false;
}

function isAnimatedWebp(filePath: string): boolean {
  const header = readPrefixBytes(filePath, 32);
  if (!header || header.length < 21) return false;
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP" &&
    header.subarray(12, 16).toString("ascii") === "VP8X"
  ) {
    return Boolean(header[20] & 0x02);
  }
  return false;
}

function isAnimatedPng(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const sig = Buffer.allocUnsafe(8);
    if (fs.readSync(fd, sig, 0, 8, 0) < 8) return false;
    if (!sig.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return false;
    }
    const hdr = Buffer.allocUnsafe(8);
    let offset = 8;
    while (true) {
      if (fs.readSync(fd, hdr, 0, 8, offset) < 8) return false;
      const length = hdr.readUInt32BE(0);
      const chunkType = hdr.subarray(4, 8).toString("ascii");
      if (chunkType === "acTL") return true;
      if (chunkType === "IDAT" || chunkType === "IEND") return false;
      offset += 8 + length + 4;
    }
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

const SIPS_KEYS = new Set(["format", "pixelWidth", "pixelHeight", "hasAlpha", "profile"]);

function probeWithSips(filePath: string, sipsBin: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile(
      sipsBin,
      [
        "-g", "format",
        "-g", "pixelWidth",
        "-g", "pixelHeight",
        "-g", "hasAlpha",
        "-g", "profile",
        filePath,
      ],
      { encoding: "utf8" },
      (err, stdout) => {
        const props: Record<string, string> = {};
        if (err) {
          resolve(props);
          return;
        }
        for (const line of stdout.split(/\r?\n/)) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          const val = line.slice(colon + 1).trim();
          if (SIPS_KEYS.has(key)) {
            props[key] = val;
          }
        }
        resolve(props);
      },
    );
  });
}

export async function probeImage(filePath: string, tools: AvailableTools): Promise<ImageInfo> {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).replace(/^\.+/, "").toLowerCase();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return {
      path: filePath,
      filename,
      sizeBytes: 0,
      ext,
      formatName: normalizeFormat(ext),
      width: null,
      height: null,
      hasAlpha: false,
      isAnimated: false,
      iccProfile: null,
      error: "File not found",
    };
  }

  if (stat.isDirectory()) {
    return {
      path: filePath,
      filename,
      sizeBytes: 0,
      ext,
      formatName: "",
      width: null,
      height: null,
      hasAlpha: false,
      isAnimated: false,
      iccProfile: null,
      error: "Folders are not supported",
    };
  }

  let fmt = normalizeFormat(ext);
  let width: number | null = null;
  let height: number | null = null;
  let hasAlpha = false;
  let iccProfile: string | null = null;

  if (tools.sips && fmt !== "svg") {
    const props = await probeWithSips(filePath, tools.sips);
    if (props.format) {
      fmt = normalizeFormat(props.format);
    }
    if (props.pixelWidth && /^\d+$/.test(props.pixelWidth)) {
      width = Number.parseInt(props.pixelWidth, 10);
    }
    if (props.pixelHeight && /^\d+$/.test(props.pixelHeight)) {
      height = Number.parseInt(props.pixelHeight, 10);
    }
    hasAlpha = (props.hasAlpha ?? "").toLowerCase() === "yes";
    const prof = props.profile;
    if (prof && prof.toLowerCase() !== "<nil>") {
      iccProfile = prof;
    }
  }

  let isAnimated = false;
  if (fmt === "gif") {
    isAnimated = isAnimatedGif(filePath);
  } else if (fmt === "webp") {
    isAnimated = isAnimatedWebp(filePath);
  } else if (fmt === "png") {
    isAnimated = isAnimatedPng(filePath);
  }

  return {
    path: filePath,
    filename,
    sizeBytes: stat.size,
    ext,
    formatName: fmt,
    width,
    height,
    hasAlpha,
    isAnimated,
    iccProfile,
    error: null,
  };
}

export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

export function probeImages(
  paths: readonly string[],
  tools: AvailableTools,
  maxWorkers?: number,
): Promise<ImageInfo[]> {
  const workers = maxWorkers ?? Math.min(paths.length || 1, os.availableParallelism() || 4, 8);
  return mapPool(paths, workers, (p) => probeImage(p, tools));
}
