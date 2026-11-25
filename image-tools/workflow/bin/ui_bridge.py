#!/usr/bin/env python3
"""Alfred 6 UI bridge for 'Convert Image' (and advanced Optimize)."""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional

WORKFLOW_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if WORKFLOW_DIR not in sys.path:
    sys.path.insert(0, WORKFLOW_DIR)

from lib.engine import ExecutionResult, execute_item
from lib.planner import (
    ALWAYS_LOSSLESS,
    DEFAULT_QUALITY,
    FORMAT_LABEL,
    LOSSLESS_CAPABLE,
    OperationConfig,
    PlannedItem,
    format_bytes,
    format_delta,
    plan_batch,
)
from lib.probe import probe_image
from lib.tools import detect_tools


def parse_file_args(raw_args: List[str]) -> List[str]:
    """Normalize file paths passed from Alfred UI (array, JSON string, or tab-separated)."""
    out: List[str] = []
    for item in raw_args:
        if not item:
            continue
        stripped = item.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    for p in parsed:
                        if isinstance(p, str) and p.strip():
                            out.append(p.strip())
                    continue
            except json.JSONDecodeError:
                pass
        if "\t" in item:
            for part in item.split("\t"):
                if part.strip():
                    out.append(part.strip())
        else:
            out.append(item)
    # Deduplicate preserving order
    seen = set()
    unique: List[str] = []
    for p in out:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


def parse_bool(val: str, default: bool = False) -> bool:
    if val is None or val == "":
        return default
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def parse_quality(val: str, fmt: str) -> Optional[int]:
    try:
        q = int(float(str(val).strip()))
        return max(1, min(100, q))
    except (ValueError, TypeError):
        return DEFAULT_QUALITY.get(fmt)


def parse_format(val: str) -> str:
    if not val:
        return "webp"
    s = val.strip()
    if s.startswith("{") and s.endswith("}"):
        try:
            obj = json.loads(s)
            if isinstance(obj, dict) and obj.get("value"):
                return str(obj["value"]).lower()
        except json.JSONDecodeError:
            pass
    return s.lower()


def _dimensions_str(plan: PlannedItem) -> str:
    if plan.source.width and plan.source.height:
        return f"{plan.source.width}×{plan.source.height}"
    return "—"


def _row_from_plan(plan: PlannedItem, status_override: Optional[str] = None, status_color: Optional[str] = None) -> Dict[str, Any]:
    src = plan.source
    arrow_line = f"{src.filename}  →  {plan.output_filename}" if not plan.blocking_error else src.filename
    meta_parts = [
        src.format_name.upper() or "FILE",
        _dimensions_str(plan),
        format_bytes(src.size_bytes),
        plan.mode_label,
    ]
    if src.has_alpha:
        meta_parts.append("Alpha")
    if src.is_animated:
        meta_parts.append("Animated")

    if status_override is not None:
        detail = status_override
    elif plan.blocking_error:
        detail = f"✗ {plan.blocking_error}"
    elif plan.warnings:
        detail = f"{' · '.join(meta_parts)}  |  ⚠ {plan.warnings[0]}"
    else:
        detail = " · ".join(meta_parts)

    row: Dict[str, Any] = {
        "uid": src.path,
        "row_title.text": arrow_line,
        "row_detail.text": detail,
    }
    if status_color:
        row["row_detail.colour"] = status_color
    elif plan.blocking_error:
        row["row_detail.colour"] = "systemRedColor"
    elif plan.warnings:
        row["row_detail.colour"] = "systemOrangeColor"
    else:
        row["row_detail.colour"] = "secondaryLabelColor"
    return row


def _collect_warnings(plans: List[PlannedItem]) -> str:
    seen: List[str] = []
    for p in plans:
        if p.blocking_error and p.blocking_error not in seen:
            seen.append(p.blocking_error)
        for w in p.warnings:
            if w not in seen:
                seen.append(w)
    if not seen:
        return ""
    return "⚠ " + "  •  ".join(seen[:2])


def _controls_update(target_fmt: str, quality_val: Optional[int], lossless: bool) -> Dict[str, Any]:
    is_optimize = target_fmt == "optimize"
    lossless_allowed = (target_fmt in LOSSLESS_CAPABLE) or is_optimize
    always_lossless = target_fmt in ALWAYS_LOSSLESS

    effective_lossless = True if always_lossless else (lossless if lossless_allowed else False)
    quality_enabled = (not effective_lossless) and (not always_lossless)

    btn_label = "Optimize" if is_optimize else f"Convert to {FORMAT_LABEL.get(target_fmt, target_fmt.upper())}"

    updates: Dict[str, Any] = {
        "lossless_check": {
            "enabled": lossless_allowed,
            "checked": effective_lossless,
        },
        "quality_field": {
            "enabled": quality_enabled,
        },
        "convert_btn": {
            "text": btn_label,
        },
    }
    if quality_val is not None:
        updates["quality_field"]["text"] = str(quality_val)
    return updates


def build_response(
    action: str,
    target_fmt: str,
    quality_raw: str,
    lossless_raw: str,
    keep_exif_raw: str,
    file_args: List[str],
) -> Dict[str, Any]:
    files = parse_file_args(file_args)
    tools = detect_tools()
    images = [probe_image(p, tools) for p in files]

    lossless = parse_bool(lossless_raw, default=False)
    keep_exif = parse_bool(keep_exif_raw, default=True)
    is_optimize = target_fmt == "optimize"

    # When switching formats via picker, if user left quality blank or invalid, fall back to format default
    quality = parse_quality(quality_raw, target_fmt) if not is_optimize else (
        parse_quality(quality_raw, "webp") if quality_raw.strip() else None
    )

    config = OperationConfig(
        mode="optimize" if is_optimize else "convert",
        target_format=target_fmt,
        quality=quality,
        lossless=lossless,
        keep_exif=keep_exif,
        skip_if_larger=is_optimize,
    )
    plans = plan_batch(images, config, tools)

    total_in = sum(img.size_bytes for img in images)
    count = len(images)
    noun = "file" if count == 1 else "files"
    summary = f"{count} {noun} selected · {format_bytes(total_in)} total · Copies saved beside originals"
    banner = _collect_warnings(plans)

    ids_update = _controls_update(target_fmt, quality, lossless)
    ids_update["summary_label"] = {"text": summary}
    ids_update["warning_label"] = {
        "text": banner,
        "hidden": not bool(banner),
    }

    if action == "init":
        ids_update["format_picker"] = {"selected": target_fmt}
        ids_update["exif_check"] = {"checked": keep_exif}

    if action in ("init", "refresh"):
        rows = [_row_from_plan(p) for p in plans]
        ids_update["file_list"] = {"data": {"type": "basic", "src": rows}}
        ids_update["status_label"] = {
            "text": "Press ↩︎ to convert · ⌘P to measure actual output size",
            "colour": "secondaryLabelColor",
        }
        ids_update["run_progress"] = {"hidden": True, "progress": 0.0}
        return {
            "variables": {
                "target_format": target_fmt,
                "quality": str(quality) if quality is not None else "",
                "lossless": "1" if lossless else "0",
                "keep_exif": "1" if keep_exif else "0",
            },
            "update": {"relayout": True, "ids": ids_update},
        }

    if action == "measure":
        results: List[ExecutionResult] = [
            execute_item(p, config, tools, dry_run_measure=True) for p in plans
        ]
        rows = []
        measured_in = 0
        measured_out = 0
        for r in results:
            if r.status == "ok":
                measured_in += r.plan.source.size_bytes
                measured_out += r.output_bytes or 0
                rows.append(_row_from_plan(r.plan, status_override=r.message, status_color="systemBlueColor"))
            elif r.status == "skipped":
                rows.append(_row_from_plan(r.plan, status_override=f"↷ {r.message}", status_color="systemOrangeColor"))
            else:
                rows.append(_row_from_plan(r.plan, status_override=f"✗ {r.message}", status_color="systemRedColor"))

        delta = format_delta(measured_in, measured_out) if measured_in > 0 else ""
        status_text = (
            f"Measured total: {format_bytes(measured_in)} → {format_bytes(measured_out)} ({delta}) · Not saved yet"
            if measured_in > 0
            else "Measurement finished (see rows above)"
        )
        ids_update["file_list"] = {"data": {"type": "basic", "src": rows}}
        ids_update["status_label"] = {"text": status_text, "colour": "systemBlueColor"}
        ids_update["run_progress"] = {"hidden": True, "progress": 1.0}
        return {"update": {"relayout": True, "ids": ids_update}}

    if action == "convert":
        results = [
            execute_item(p, config, tools, dry_run_measure=False) for p in plans
        ]
        rows = []
        ok_count = 0
        skip_count = 0
        err_count = 0
        ok_in = 0
        ok_out = 0
        for r in results:
            if r.status == "ok":
                ok_count += 1
                ok_in += r.plan.source.size_bytes
                ok_out += r.output_bytes or 0
                saved_name = os.path.basename(r.output_path or r.plan.output_filename)
                row = _row_from_plan(
                    r.plan,
                    status_override=f"✓ Saved {saved_name} · {r.message}",
                    status_color="systemGreenColor",
                )
                row["row_title.text"] = f"{r.plan.source.filename}  →  {saved_name}"
                rows.append(row)
            elif r.status == "skipped":
                skip_count += 1
                rows.append(_row_from_plan(r.plan, status_override=f"↷ Skipped: {r.message}", status_color="systemOrangeColor"))
            else:
                err_count += 1
                rows.append(_row_from_plan(r.plan, status_override=f"✗ Error: {r.message}", status_color="systemRedColor"))

        parts = []
        if ok_count:
            parts.append(f"✓ {ok_count} saved ({format_bytes(ok_in)} → {format_bytes(ok_out)}, {format_delta(ok_in, ok_out)})")
        if skip_count:
            parts.append(f"{skip_count} skipped")
        if err_count:
            parts.append(f"{err_count} failed")

        status_color = "systemRedColor" if err_count else ("systemOrangeColor" if not ok_count else "systemGreenColor")
        ids_update["file_list"] = {"data": {"type": "basic", "src": rows}}
        ids_update["status_label"] = {"text": " · ".join(parts) or "Done", "colour": status_color}
        ids_update["run_progress"] = {"hidden": True, "progress": 1.0}
        return {"update": {"relayout": True, "ids": ids_update}}

    return {}


def main(argv: List[str]) -> int:
    if len(argv) < 5:
        sys.stdout.write(json.dumps({}))
        return 0
    action = argv[0]
    target_fmt = parse_format(argv[1])
    quality_raw = argv[2]
    lossless_raw = argv[3]
    keep_exif_raw = argv[4]
    file_args = argv[5:]

    # When user changes format picker, reset quality to the new format's visually-transparent default
    if action == "format_changed":
        action = "refresh"
        if target_fmt in DEFAULT_QUALITY:
            quality_raw = str(DEFAULT_QUALITY[target_fmt])

    resp = build_response(action, target_fmt, quality_raw, lossless_raw, keep_exif_raw, file_args)
    sys.stdout.write(json.dumps(resp))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
