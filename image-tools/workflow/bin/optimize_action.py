#!/usr/bin/env python3
"""Instant 'Optimize Image' Alfred File Action entry point."""

from __future__ import annotations

import json
import os
import sys

WORKFLOW_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, WORKFLOW_DIR)

from lib.engine import execute_item
from lib.planner import OperationConfig, format_bytes, format_delta, plan_batch
from lib.probe import probe_image
from lib.tools import detect_tools


def _emit_alfred_output(title: str, text: str, arg: str = "") -> None:
    payload = {
        "alfredworkflow": {
            "arg": arg,
            "variables": {
                "notif_title": title,
                "notif_text": text,
            },
        }
    }
    sys.stdout.write(json.dumps(payload))


def main(argv: list[str]) -> int:
    paths = [p for p in argv if p]
    if not paths:
        _emit_alfred_output("Optimize Image", "No image files were passed.")
        return 0

    tools = detect_tools()
    images = [probe_image(p, tools) for p in paths]
    config = OperationConfig(
        mode="optimize",
        target_format="optimize",
        quality=None,  # format-specific near-lossless defaults
        lossless=False,
        keep_exif=True,
        skip_if_larger=True,
    )
    plans = plan_batch(images, config, tools)
    results = [execute_item(plan, config, tools, dry_run_measure=False) for plan in plans]

    ok_items = [r for r in results if r.status == "ok"]
    skipped_items = [r for r in results if r.status == "skipped"]
    error_items = [r for r in results if r.status == "error"]

    total_in = sum(r.plan.source.size_bytes for r in ok_items)
    total_out = sum(r.output_bytes or 0 for r in ok_items)
    saved = max(0, total_in - total_out)

    if len(results) == 1:
        r = results[0]
        name = r.plan.source.filename
        if r.status == "ok":
            out_name = os.path.basename(r.output_path or r.plan.output_filename)
            _emit_alfred_output(
                f"Optimized {name}",
                f"Saved {out_name} ({r.message})",
                r.output_path or "",
            )
        elif r.status == "skipped":
            _emit_alfred_output(f"Skipped {name}", r.message)
        else:
            _emit_alfred_output(f"Failed: {name}", r.message)
        return 0

    parts = []
    if ok_items:
        delta = format_delta(total_in, total_out)
        parts.append(f"{len(ok_items)} optimized (saved {format_bytes(saved)}, {delta})")
    if skipped_items:
        parts.append(f"{len(skipped_items)} already optimal")
    if error_items:
        first_err = error_items[0].message
        parts.append(f"{len(error_items)} failed ({first_err})")

    title = "Optimize Image" if not error_items else "Optimize Image (with errors)"
    _emit_alfred_output(title, " · ".join(parts) if parts else "Nothing to do")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
