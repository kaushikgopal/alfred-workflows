/** Tool discovery and missing-dependency guidance for Image Tools workflow. */

import fs from "node:fs";
import path from "node:path";

export const SEARCH_PATHS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

export const INSTALL_HINTS: Readonly<Record<string, string>> = {
  cwebp: "brew install webp",
  dwebp: "brew install webp",
  gif2webp: "brew install webp",
  webpmux: "brew install webp",
  magick: "brew install imagemagick",
  oxipng: "brew install oxipng",
  pngquant: "brew install pngquant",
};

export interface AvailableTools {
  readonly sips: string | null;
  readonly cwebp: string | null;
  readonly dwebp: string | null;
  readonly gif2webp: string | null;
  readonly webpmux: string | null;
  readonly magick: string | null;
  readonly oxipng: string | null;
  readonly pngquant: string | null;
}

export function missingHint(name: string): string {
  const cmd = INSTALL_HINTS[name];
  if (cmd) {
    return `Missing '${name}'. Install with: ${cmd}`;
  }
  return `Missing required tool '${name}'.`;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  extraPaths: readonly string[] = SEARCH_PATHS,
): string | null {
  const envDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...envDirs, ...extraPaths]) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function detectTools(): AvailableTools {
  return {
    sips: findExecutable("sips"),
    cwebp: findExecutable("cwebp"),
    dwebp: findExecutable("dwebp"),
    gif2webp: findExecutable("gif2webp"),
    webpmux: findExecutable("webpmux"),
    magick: findExecutable("magick"),
    oxipng: findExecutable("oxipng"),
    pngquant: findExecutable("pngquant"),
  };
}
