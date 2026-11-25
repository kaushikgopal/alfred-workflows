"""Image conversion and optimization execution engine with atomic, non-clobbering writes."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import List, Optional, Tuple

from .planner import OperationConfig, PlannedItem, format_bytes, format_delta
from .tools import AvailableTools


@dataclass(frozen=True)
class ExecutionResult:
    plan: PlannedItem
    status: str  # "ok", "skipped", "error"
    output_path: Optional[str]
    output_bytes: Optional[int]
    message: str


def _run(cmd: List[str]) -> Tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    err = (proc.stderr or proc.stdout or "").strip()
    return proc.returncode, err


def _sips_convert(
    sips_bin: str,
    src: str,
    dst: str,
    target_fmt: str,
    quality: Optional[int],
    lossless: bool,
) -> Tuple[bool, str]:
    cmd = [sips_bin, "-s", "format", target_fmt]
    if target_fmt in ("jpeg", "heic", "avif"):
        if lossless and target_fmt in ("heic", "avif"):
            cmd.extend(["-s", "formatOptions", "100"])
        elif quality is not None:
            cmd.extend(["-s", "formatOptions", str(quality)])
    cmd.extend([src, "--out", dst])
    code, err = _run(cmd)
    return code == 0, err


def _encode_to_temp(
    plan: PlannedItem,
    config: OperationConfig,
    tools: AvailableTools,
    work_dir: str,
) -> Tuple[Optional[str], Optional[str]]:
    """Encode a single planned item into work_dir and return (temp_output_path, error)."""
    src = plan.source.path
    src_fmt = plan.source.format_name
    dst_fmt = plan.effective_format
    ext = os.path.splitext(plan.output_filename)[1] or f".{dst_fmt}"
    tmp_out = os.path.join(work_dir, f"out{ext}")

    # 1. Animated GIF -> WebP via gif2webp (or magick)
    if dst_fmt == "webp" and plan.source.is_animated and src_fmt == "gif":
        if tools.gif2webp:
            cmd = [tools.gif2webp, "-quiet", "-mt"]
            if plan.lossless:
                cmd.append("-lossless")
            else:
                cmd.extend(["-lossy", "-q", str(plan.quality or 86)])
            cmd.extend([src, "-o", tmp_out])
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "gif2webp failed")
        if tools.magick:
            cmd = [tools.magick, src]
            if plan.lossless:
                cmd.extend(["-define", "webp:lossless=true"])
            else:
                cmd.extend(["-quality", str(plan.quality or 86)])
            cmd.append(tmp_out)
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "magick failed")

    # 2. Target WebP (still)
    if dst_fmt == "webp":
        # Animated WebP -> WebP via magick
        if plan.source.is_animated and tools.magick:
            cmd = [tools.magick, src]
            if plan.lossless:
                cmd.extend(["-define", "webp:lossless=true"])
            else:
                cmd.extend(["-quality", str(plan.quality or 86)])
            cmd.append(tmp_out)
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "magick failed")

        if tools.cwebp:
            cwebp_input = src
            # cwebp reads PNG, JPEG, TIFF, WebP directly. Decode HEIC/AVIF/GIF/BMP/SVG to temp PNG first.
            if src_fmt not in ("png", "jpeg", "tiff", "webp"):
                decoded_png = os.path.join(work_dir, "decoded.png")
                if src_fmt == "svg" and tools.magick:
                    code, err = _run([tools.magick, "-background", "none", src, decoded_png])
                    if code != 0:
                        return None, err or "Failed to rasterize SVG"
                elif tools.sips:
                    ok, err = _sips_convert(tools.sips, src, decoded_png, "png", None, True)
                    if not ok:
                        return None, err or "Failed to decode source image"
                elif tools.magick:
                    code, err = _run([tools.magick, src, decoded_png])
                    if code != 0:
                        return None, err or "Failed to decode source image"
                cwebp_input = decoded_png

            # If stripping EXIF on a JPEG, bake orientation first so portrait photos don't rotate sideways
            if not config.keep_exif and src_fmt == "jpeg" and tools.magick:
                oriented_png = os.path.join(work_dir, "oriented.png")
                code, _ = _run([tools.magick, src, "-auto-orient", oriented_png])
                if code == 0:
                    cwebp_input = oriented_png

            cmd = [tools.cwebp, "-quiet", "-mt", "-m", "4"]
            if plan.lossless:
                cmd.append("-lossless")
            else:
                cmd.extend(["-q", str(plan.quality or 86), "-alpha_q", "95"])
            cmd.extend(["-metadata", "all" if config.keep_exif else "icc"])
            cmd.extend([cwebp_input, "-o", tmp_out])
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "cwebp failed")

        if tools.magick:
            cmd = [tools.magick, src]
            if not config.keep_exif:
                cmd.extend(["-auto-orient", "-strip"])
            if plan.lossless:
                cmd.extend(["-define", "webp:lossless=true"])
            else:
                cmd.extend(["-quality", str(plan.quality or 86)])
            cmd.append(tmp_out)
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "magick failed")

        return None, "No WebP encoder available (brew install webp)"

    # 3. PNG optimization (PNG -> PNG)
    if dst_fmt == "png" and src_fmt == "png":
        if tools.oxipng:
            cmd = [tools.oxipng, "-o", "4", "--quiet"]
            if not config.keep_exif:
                cmd.extend(["--strip", "safe"])
            cmd.extend(["--out", tmp_out, src])
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "oxipng failed")
        if tools.magick:
            cmd = [tools.magick, src]
            if not config.keep_exif:
                cmd.extend(["-define", "png:exclude-chunk=eXIf,tEXt,zTXt,iTXt"])
            cmd.extend([
                "-define", "png:compression-level=9",
                "-define", "png:compression-strategy=1",
                tmp_out,
            ])
            code, err = _run(cmd)
            return (tmp_out, None) if code == 0 else (None, err or "magick PNG compression failed")

    # 4. SVG input -> any raster format via magick
    if src_fmt == "svg":
        if not tools.magick:
            return None, "ImageMagick required for SVG input (brew install imagemagick)"
        cmd = [tools.magick, "-background", "white" if dst_fmt == "jpeg" else "none", src]
        if dst_fmt == "jpeg":
            cmd.extend(["-alpha", "remove", "-alpha", "off"])
        if plan.quality is not None and not plan.lossless:
            cmd.extend(["-quality", str(plan.quality)])
        cmd.append(tmp_out)
        code, err = _run(cmd)
        return (tmp_out, None) if code == 0 else (None, err or "magick SVG conversion failed")

    # 5. Transparent image -> JPEG: flatten cleanly onto white (avoids black halos)
    if dst_fmt == "jpeg" and plan.source.has_alpha and tools.magick:
        cmd = [
            tools.magick,
            src,
            "-auto-orient",
            "-background",
            "white",
            "-alpha",
            "remove",
            "-alpha",
            "off",
            "-quality",
            str(plan.quality or 85),
        ]
        if not config.keep_exif:
            cmd.extend(["+profile", "exif,xmp,iptc"])
        cmd.append(tmp_out)
        code, err = _run(cmd)
        return (tmp_out, None) if code == 0 else (None, err or "magick JPEG conversion failed")

    # 6. Animated WebP -> GIF via magick
    if dst_fmt == "gif" and plan.source.is_animated and tools.magick:
        code, err = _run([tools.magick, src, tmp_out])
        return (tmp_out, None) if code == 0 else (None, err or "magick GIF conversion failed")

    # 7. Strip EXIF while keeping ICC profile via magick when requested
    if not config.keep_exif and tools.magick and dst_fmt in ("jpeg", "png", "heic", "avif", "tiff"):
        cmd = [tools.magick, src, "-auto-orient", "+profile", "exif,xmp,iptc"]
        if plan.quality is not None and not plan.lossless:
            cmd.extend(["-quality", str(plan.quality)])
        cmd.append(tmp_out)
        code, err = _run(cmd)
        if code == 0:
            return tmp_out, None

    # 8. Native macOS sips (fast, preserves ICC & EXIF, supports jpeg/png/heic/avif/tiff/gif)
    if tools.sips:
        ok, err = _sips_convert(tools.sips, src, tmp_out, dst_fmt, plan.quality, plan.lossless)
        if ok:
            return tmp_out, None
        # Fallback to magick if sips couldn't handle an edge format
        if tools.magick:
            cmd = [tools.magick, src]
            if plan.quality is not None and not plan.lossless:
                cmd.extend(["-quality", str(plan.quality)])
            cmd.append(tmp_out)
            code, merr = _run(cmd)
            if code == 0:
                return tmp_out, None
            return None, merr or err
        return None, err or "sips conversion failed"

    return None, "No compatible encoder found"


def _atomic_move_no_clobber(src_tmp: str, dst_path: str) -> str:
    """Move src_tmp to dst_path without ever overwriting an existing file."""
    dst_dir = os.path.dirname(dst_path)
    stem, ext = os.path.splitext(os.path.basename(dst_path))

    # Stage inside destination directory so rename/link is same-filesystem atomic
    staged = os.path.join(dst_dir, f".alfred-imgtmp-{os.getpid()}-{os.urandom(4).hex()}{ext}")
    shutil.copy2(src_tmp, staged)
    try:
        candidate = dst_path
        counter = 2
        while True:
            try:
                os.link(staged, candidate)
                return candidate
            except FileExistsError:
                candidate = os.path.join(dst_dir, f"{stem}-{counter}{ext}")
                counter += 1
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


def execute_item(
    plan: PlannedItem,
    config: OperationConfig,
    tools: AvailableTools,
    dry_run_measure: bool = False,
) -> ExecutionResult:
    """Execute (or honestly measure in a temp dir) a single PlannedItem."""
    if plan.blocking_error:
        return ExecutionResult(
            plan=plan,
            status="error",
            output_path=None,
            output_bytes=None,
            message=plan.blocking_error,
        )

    with tempfile.TemporaryDirectory(prefix="alfred-imgtools-") as tmpdir:
        tmp_out, err = _encode_to_temp(plan, config, tools, tmpdir)
        if err or not tmp_out or not os.path.exists(tmp_out):
            return ExecutionResult(
                plan=plan,
                status="error",
                output_path=None,
                output_bytes=None,
                message=err or "Encoding failed",
            )

        out_bytes = os.path.getsize(tmp_out)
        in_bytes = plan.source.size_bytes
        delta = format_delta(in_bytes, out_bytes)

        if config.skip_if_larger and out_bytes >= in_bytes:
            return ExecutionResult(
                plan=plan,
                status="skipped",
                output_path=None,
                output_bytes=out_bytes,
                message=f"Already optimal ({format_bytes(in_bytes)} → {format_bytes(out_bytes)})",
            )

        if dry_run_measure:
            return ExecutionResult(
                plan=plan,
                status="ok",
                output_path=None,
                output_bytes=out_bytes,
                message=f"Measured: {format_bytes(in_bytes)} → {format_bytes(out_bytes)} ({delta})",
            )

        try:
            final_path = _atomic_move_no_clobber(tmp_out, plan.output_path)
        except OSError as exc:
            return ExecutionResult(
                plan=plan,
                status="error",
                output_path=None,
                output_bytes=None,
                message=f"Could not save output: {exc}",
            )

        return ExecutionResult(
            plan=plan,
            status="ok",
            output_path=final_path,
            output_bytes=out_bytes,
            message=f"{format_bytes(in_bytes)} → {format_bytes(out_bytes)} ({delta})",
        )


def execute_batch(
    plans: List[PlannedItem],
    config: OperationConfig,
    tools: AvailableTools,
    dry_run_measure: bool = False,
    max_workers: Optional[int] = None,
) -> List[ExecutionResult]:
    """Execute or measure a batch of planned items in parallel while preserving input order."""
    if len(plans) <= 1:
        return [execute_item(p, config, tools, dry_run_measure=dry_run_measure) for p in plans]
    workers = max_workers or min(len(plans), os.cpu_count() or 4, 8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda p: execute_item(p, config, tools, dry_run_measure=dry_run_measure), plans))
