#!/usr/bin/env node
/** Alfred 6 UI bridge for 'Convert Image' (and advanced Optimize). */

import path from "node:path";
import { executeBatch, type ExecutionResult } from "../lib/engine.ts";
import {
  ALWAYS_LOSSLESS,
  DEFAULT_QUALITY,
  FORMAT_LABEL,
  LOSSLESS_CAPABLE,
  formatBytes,
  formatDelta,
  planBatch,
  type OperationConfig,
  type PlannedItem,
} from "../lib/planner.ts";
import { probeImages } from "../lib/probe.ts";
import { detectTools } from "../lib/tools.ts";

export function parseFileArgs(rawArgs: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of rawArgs) {
    if (!item) continue;
    const stripped = item.trim();
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      try {
        const parsed: unknown = JSON.parse(stripped);
        if (Array.isArray(parsed)) {
          for (const p of parsed) {
            if (typeof p === "string" && p.trim()) {
              out.push(p.trim());
            }
          }
          continue;
        }
      } catch {
        // fall through to raw parsing
      }
    }
    if (item.includes("\t")) {
      for (const part of item.split("\t")) {
        if (part.trim()) out.push(part.trim());
      }
    } else {
      out.push(item);
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of out) {
    if (!seen.has(p)) {
      seen.add(p);
      unique.push(p);
    }
  }
  return unique;
}

export function parseBool(val: string | null | undefined, defaultVal = false): boolean {
  if (val === null || val === undefined || val === "") return defaultVal;
  const s = String(val).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function parseQuality(val: string, fmt: string): number | null {
  const trimmed = String(val).trim();
  if (trimmed !== "") {
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return Math.max(1, Math.min(100, Math.trunc(parsed)));
    }
  }
  return DEFAULT_QUALITY[fmt] ?? null;
}

export function parseFormat(val: string): string {
  if (!val) return "webp";
  const s = val.trim();
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const obj: unknown = JSON.parse(s);
      if (obj && typeof obj === "object" && "value" in obj && (obj as { value?: unknown }).value) {
        return String((obj as { value: unknown }).value).toLowerCase();
      }
    } catch {
      // fall through
    }
  }
  return s.toLowerCase();
}

function dimensionsStr(plan: PlannedItem): string {
  if (plan.source.width && plan.source.height) {
    return `${plan.source.width}×${plan.source.height}`;
  }
  return "—";
}

interface UiRow {
  uid: string;
  "row_title.text": string;
  "row_detail.text": string;
  "row_detail.colour": string;
}

function rowFromPlan(
  plan: PlannedItem,
  statusOverride: string | null = null,
  statusColor: string | null = null,
): UiRow {
  const src = plan.source;
  const arrowLine = !plan.blockingError
    ? `${src.filename}  →  ${plan.outputFilename}`
    : src.filename;
  const metaParts = [
    src.formatName.toUpperCase() || "FILE",
    dimensionsStr(plan),
    formatBytes(src.sizeBytes),
    plan.modeLabel,
  ];
  if (src.hasAlpha) metaParts.push("Alpha");
  if (src.isAnimated) metaParts.push("Animated");

  let detail: string;
  if (statusOverride !== null) {
    detail = statusOverride;
  } else if (plan.blockingError) {
    detail = `✗ ${plan.blockingError}`;
  } else if (plan.warnings.length > 0) {
    detail = `${metaParts.join(" · ")}  |  ⚠ ${plan.warnings[0]}`;
  } else {
    detail = metaParts.join(" · ");
  }

  let colour: string;
  if (statusColor) {
    colour = statusColor;
  } else if (plan.blockingError) {
    colour = "systemRedColor";
  } else if (plan.warnings.length > 0) {
    colour = "systemOrangeColor";
  } else {
    colour = "secondaryLabelColor";
  }

  return {
    uid: src.path,
    "row_title.text": arrowLine,
    "row_detail.text": detail,
    "row_detail.colour": colour,
  };
}

function collectWarnings(plans: readonly PlannedItem[]): string {
  const seen: string[] = [];
  for (const p of plans) {
    if (p.blockingError && !seen.includes(p.blockingError)) {
      seen.push(p.blockingError);
    }
    for (const w of p.warnings) {
      if (!seen.includes(w)) seen.push(w);
    }
  }
  if (seen.length === 0) return "";
  return `⚠ ${seen.slice(0, 2).join("  •  ")}`;
}

function controlsUpdate(
  targetFmt: string,
  qualityVal: number | null,
  lossless: boolean,
): Record<string, Record<string, unknown>> {
  const isOptimize = targetFmt === "optimize";
  const losslessAllowed = LOSSLESS_CAPABLE.has(targetFmt) || isOptimize;
  const alwaysLossless = ALWAYS_LOSSLESS.has(targetFmt);

  const effectiveLossless = alwaysLossless ? true : losslessAllowed ? lossless : false;
  const qualityEnabled = !effectiveLossless && !alwaysLossless;

  const btnLabel = isOptimize
    ? "Optimize"
    : `Convert to ${FORMAT_LABEL[targetFmt] ?? targetFmt.toUpperCase()}`;

  const qualityField: Record<string, unknown> = { enabled: qualityEnabled };
  if (qualityVal !== null) {
    qualityField.text = String(qualityVal);
  }

  return {
    lossless_check: {
      enabled: losslessAllowed,
      checked: effectiveLossless,
    },
    quality_field: qualityField,
    convert_btn: {
      text: btnLabel,
    },
  };
}

export async function buildResponse(
  action: string,
  targetFmt: string,
  qualityRaw: string,
  losslessRaw: string,
  keepExifRaw: string,
  fileArgs: readonly string[],
): Promise<Record<string, unknown>> {
  const files = parseFileArgs(fileArgs);
  const tools = detectTools();
  const images = await probeImages(files, tools);

  const lossless = parseBool(losslessRaw, false);
  const keepExif = parseBool(keepExifRaw, true);
  const isOptimize = targetFmt === "optimize";

  const quality = !isOptimize
    ? parseQuality(qualityRaw, targetFmt)
    : qualityRaw.trim()
      ? parseQuality(qualityRaw, "webp")
      : null;

  const config: OperationConfig = {
    mode: isOptimize ? "optimize" : "convert",
    targetFormat: targetFmt,
    quality,
    lossless,
    keepExif,
    skipIfLarger: isOptimize,
  };
  const plans = planBatch(images, config, tools);

  const totalIn = images.reduce((acc, img) => acc + img.sizeBytes, 0);
  const count = images.length;
  const noun = count === 1 ? "file" : "files";
  const summary = `${count} ${noun} selected · ${formatBytes(totalIn)} total · Copies saved beside originals`;
  const banner = collectWarnings(plans);

  const idsUpdate: Record<string, unknown> = controlsUpdate(targetFmt, quality, lossless);
  idsUpdate.summary_label = { text: summary };
  idsUpdate.warning_label = { text: banner, hidden: !banner };

  if (action === "init") {
    idsUpdate.format_picker = { selected: targetFmt };
    idsUpdate.exif_check = { checked: keepExif };
  }

  if (action === "init" || action === "refresh") {
    const rows = plans.map((p) => rowFromPlan(p));
    idsUpdate.file_list = { data: { type: "basic", src: rows } };
    idsUpdate.status_label = {
      text: "Press ↩︎ to convert · ⌘P to measure actual output size",
      colour: "secondaryLabelColor",
    };
    idsUpdate.run_progress = { hidden: true, progress: 0.0 };
    return {
      variables: {
        target_format: targetFmt,
        quality: quality !== null ? String(quality) : "",
        lossless: lossless ? "1" : "0",
        keep_exif: keepExif ? "1" : "0",
      },
      update: { relayout: true, ids: idsUpdate },
    };
  }

  if (action === "measure") {
    const results: ExecutionResult[] = await executeBatch(plans, config, tools, true);
    const rows: UiRow[] = [];
    let measuredIn = 0;
    let measuredOut = 0;
    for (const r of results) {
      if (r.status === "ok") {
        measuredIn += r.plan.source.sizeBytes;
        measuredOut += r.outputBytes ?? 0;
        rows.push(rowFromPlan(r.plan, r.message, "systemBlueColor"));
      } else if (r.status === "skipped") {
        rows.push(rowFromPlan(r.plan, `↷ ${r.message}`, "systemOrangeColor"));
      } else {
        rows.push(rowFromPlan(r.plan, `✗ ${r.message}`, "systemRedColor"));
      }
    }

    const delta = measuredIn > 0 ? formatDelta(measuredIn, measuredOut) : "";
    const statusText =
      measuredIn > 0
        ? `Measured total: ${formatBytes(measuredIn)} → ${formatBytes(measuredOut)} (${delta}) · Not saved yet`
        : "Measurement finished (see rows above)";
    idsUpdate.file_list = { data: { type: "basic", src: rows } };
    idsUpdate.status_label = { text: statusText, colour: "systemBlueColor" };
    idsUpdate.run_progress = { hidden: true, progress: 1.0 };
    return { update: { relayout: true, ids: idsUpdate } };
  }

  if (action === "convert") {
    const results = await executeBatch(plans, config, tools, false);
    const rows: UiRow[] = [];
    let okCount = 0;
    let skipCount = 0;
    let errCount = 0;
    let okIn = 0;
    let okOut = 0;

    for (const r of results) {
      if (r.status === "ok") {
        okCount++;
        okIn += r.plan.source.sizeBytes;
        okOut += r.outputBytes ?? 0;
        const savedName = path.basename(r.outputPath ?? r.plan.outputFilename);
        const row = rowFromPlan(
          r.plan,
          `✓ Saved ${savedName} · ${r.message}`,
          "systemGreenColor",
        );
        row["row_title.text"] = `${r.plan.source.filename}  →  ${savedName}`;
        rows.push(row);
      } else if (r.status === "skipped") {
        skipCount++;
        rows.push(rowFromPlan(r.plan, `↷ Skipped: ${r.message}`, "systemOrangeColor"));
      } else {
        errCount++;
        rows.push(rowFromPlan(r.plan, `✗ Error: ${r.message}`, "systemRedColor"));
      }
    }

    const parts: string[] = [];
    if (okCount > 0) {
      parts.push(
        `✓ ${okCount} saved (${formatBytes(okIn)} → ${formatBytes(okOut)}, ${formatDelta(okIn, okOut)})`,
      );
    }
    if (skipCount > 0) parts.push(`${skipCount} skipped`);
    if (errCount > 0) parts.push(`${errCount} failed`);

    const statusColor =
      errCount > 0 ? "systemRedColor" : okCount === 0 ? "systemOrangeColor" : "systemGreenColor";
    idsUpdate.file_list = { data: { type: "basic", src: rows } };
    idsUpdate.status_label = { text: parts.join(" · ") || "Done", colour: statusColor };
    idsUpdate.run_progress = { hidden: true, progress: 1.0 };
    return { update: { relayout: true, ids: idsUpdate } };
  }

  return {};
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length < 5) {
    process.stdout.write(JSON.stringify({}));
    return 0;
  }
  let action = argv[0];
  const targetFmt = parseFormat(argv[1]);
  let qualityRaw = argv[2];
  const losslessRaw = argv[3];
  const keepExifRaw = argv[4];
  const fileArgs = argv.slice(5);

  if (action === "format_changed") {
    action = "refresh";
    if (targetFmt in DEFAULT_QUALITY) {
      qualityRaw = String(DEFAULT_QUALITY[targetFmt]);
    }
  }

  const resp = await buildResponse(
    action,
    targetFmt,
    qualityRaw,
    losslessRaw,
    keepExifRaw,
    fileArgs,
  );
  process.stdout.write(JSON.stringify(resp));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
