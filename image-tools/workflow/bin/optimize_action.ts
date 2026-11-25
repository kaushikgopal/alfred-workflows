#!/usr/bin/env node
/** Instant 'Optimize Image' Alfred File Action entry point. */

import path from "node:path";
import { executeBatch } from "../lib/engine.ts";
import {
  formatBytes,
  formatDelta,
  planBatch,
  type OperationConfig,
} from "../lib/planner.ts";
import { probeImages } from "../lib/probe.ts";
import { detectTools } from "../lib/tools.ts";

function emitAlfredOutput(title: string, text: string, arg = ""): void {
  const payload = {
    alfredworkflow: {
      arg,
      variables: {
        notif_title: title,
        notif_text: text,
      },
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

export async function main(argv: readonly string[]): Promise<number> {
  const paths = argv.filter(Boolean);
  if (paths.length === 0) {
    emitAlfredOutput("Optimize Image", "No image files were passed.");
    return 0;
  }

  const tools = detectTools();
  const images = await probeImages(paths, tools);
  const config: OperationConfig = {
    mode: "optimize",
    targetFormat: "optimize",
    quality: null,
    lossless: false,
    keepExif: true,
    skipIfLarger: true,
  };
  const plans = planBatch(images, config, tools);
  const results = await executeBatch(plans, config, tools, false);

  const okItems = results.filter((r) => r.status === "ok");
  const skippedItems = results.filter((r) => r.status === "skipped");
  const errorItems = results.filter((r) => r.status === "error");

  const totalIn = okItems.reduce((acc, r) => acc + r.plan.source.sizeBytes, 0);
  const totalOut = okItems.reduce((acc, r) => acc + (r.outputBytes ?? 0), 0);
  const saved = Math.max(0, totalIn - totalOut);

  if (results.length === 1) {
    const r = results[0];
    const name = r.plan.source.filename;
    if (r.status === "ok") {
      const outName = path.basename(r.outputPath ?? r.plan.outputFilename);
      emitAlfredOutput(
        `Optimized ${name}`,
        `Saved ${outName} (${r.message})`,
        r.outputPath ?? "",
      );
    } else if (r.status === "skipped") {
      emitAlfredOutput(`Skipped ${name}`, r.message);
    } else {
      emitAlfredOutput(`Failed: ${name}`, r.message);
    }
    return 0;
  }

  const parts: string[] = [];
  if (okItems.length > 0) {
    const delta = formatDelta(totalIn, totalOut);
    parts.push(`${okItems.length} optimized (saved ${formatBytes(saved)}, ${delta})`);
  }
  if (skippedItems.length > 0) {
    parts.push(`${skippedItems.length} already optimal`);
  }
  if (errorItems.length > 0) {
    const firstErr = errorItems[0].message;
    parts.push(`${errorItems.length} failed (${firstErr})`);
  }

  const title = errorItems.length === 0 ? "Optimize Image" : "Optimize Image (with errors)";
  emitAlfredOutput(title, parts.length > 0 ? parts.join(" · ") : "Nothing to do");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
