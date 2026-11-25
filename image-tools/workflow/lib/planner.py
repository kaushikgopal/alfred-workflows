"""Pure planning rules: format metadata, defaults, collision-safe paths, and warnings."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set, Tuple

from .probe import ImageInfo
from .tools import AvailableTools

# Visually near-lossless defaults (hard to tell apart from original)
DEFAULT_QUALITY: Dict[str, int] = {
    "webp": 86,
    "jpeg": 85,
    "avif": 82,
    "heic": 82,
}

FORMAT_EXT: Dict[str, str] = {
    "webp": "webp",
    "jpeg": "jpg",
    "png": "png",
    "avif": "avif",
    "heic": "heic",
    "tiff": "tiff",
    "gif": "gif",
}

FORMAT_LABEL: Dict[str, str] = {
    "webp": "WebP",
    "jpeg": "JPEG",
    "png": "PNG",
    "avif": "AVIF",
    "heic": "HEIC",
    "tiff": "TIFF",
    "gif": "GIF",
    "optimize": "Optimize (Same Format)",
}

# Formats that support a lossless toggle in our workflow
LOSSLESS_CAPABLE: Set[str] = {"webp", "avif", "heic"}
# Formats that are always lossless
ALWAYS_LOSSLESS: Set[str] = {"png", "tiff", "gif"}
# Formats that accept a quality (1-100) parameter when lossy
QUALITY_FORMATS: Set[str] = {"webp", "jpeg", "avif", "heic"}
# Formats that support transparency
ALPHA_CAPABLE: Set[str] = {"webp", "png", "avif", "heic", "tiff", "gif"}
# Formats that support animation
ANIMATION_CAPABLE: Set[str] = {"webp", "gif"}


@dataclass(frozen=True)
class OperationConfig:
    mode: str  # "convert" or "optimize"
    target_format: str  # "webp", "jpeg", "png", "avif", "heic", "tiff", "gif", or "optimize"
    quality: Optional[int] = None  # None means format-specific default
    lossless: bool = False
    keep_exif: bool = True
    skip_if_larger: bool = False  # True for optimize mode


@dataclass(frozen=True)
class PlannedItem:
    source: ImageInfo
    effective_format: str
    output_path: str
    output_filename: str
    quality: Optional[int]
    lossless: bool
    mode_label: str  # e.g. "Lossy q=86", "Lossless"
    warnings: Tuple[str, ...] = ()
    blocking_error: Optional[str] = None


def clamp_quality(value: Optional[int], fmt: str) -> Optional[int]:
    if fmt not in QUALITY_FORMATS:
        return None
    if value is None:
        return DEFAULT_QUALITY.get(fmt, 85)
    return max(1, min(100, int(value)))


def format_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def format_delta(old_bytes: int, new_bytes: int) -> str:
    if old_bytes <= 0:
        return ""
    pct = ((new_bytes - old_bytes) / old_bytes) * 100.0
    sign = "+" if pct > 0 else ""
    return f"{sign}{pct:.0f}%"


def plan_unique_path(
    source_path: str,
    target_ext: str,
    suffix: str,
    reserved: Set[str],
    exists_fn: Callable[[str], bool] = os.path.exists,
) -> str:
    """Compute a collision-safe output path beside source_path, never overwriting existing files."""
    directory = os.path.dirname(source_path)
    stem = os.path.splitext(os.path.basename(source_path))[0]
    ext = target_ext.lstrip(".").lower()

    base = f"{stem}{suffix}"
    candidate = os.path.join(directory, f"{base}.{ext}")
    if candidate not in reserved and not exists_fn(candidate):
        reserved.add(candidate)
        return candidate

    counter = 2
    while True:
        candidate = os.path.join(directory, f"{base}-{counter}.{ext}")
        if candidate not in reserved and not exists_fn(candidate):
            reserved.add(candidate)
            return candidate
        counter += 1


def check_tool_requirement(
    source_fmt: str,
    target_fmt: str,
    is_animated: bool,
    tools: AvailableTools,
) -> Tuple[Optional[str], Optional[str]]:
    """Return (blocking_error, warning) for tool availability."""
    if source_fmt == "svg":
        if not tools.magick:
            return (
                f"Converting SVG requires ImageMagick. {tools.missing_hint('magick')}",
                None,
            )

    if target_fmt == "webp":
        if is_animated and source_fmt == "gif":
            if not tools.gif2webp and not tools.magick:
                return (
                    f"Animated GIF → WebP requires gif2webp. {tools.missing_hint('gif2webp')}",
                    None,
                )
        elif not tools.cwebp and not tools.magick:
            return (
                f"WebP encoding is not built into macOS. {tools.missing_hint('cwebp')}",
                None,
            )

    if source_fmt == "webp" and target_fmt != "webp":
        if is_animated and not tools.magick:
            return (
                f"Animated WebP conversion requires ImageMagick. {tools.missing_hint('magick')}",
                None,
            )
        if not tools.sips and not tools.dwebp and not tools.magick:
            return (
                f"WebP decoding requires sips or dwebp. {tools.missing_hint('dwebp')}",
                None,
            )

    if target_fmt == "png" and source_fmt == "png":
        if not tools.oxipng and not tools.magick:
            return (
                None,
                "macOS built-ins cannot optimize PNGs effectively. Install oxipng (brew install oxipng) for strong lossless PNG compression.",
            )
        if not tools.oxipng and tools.magick:
            return (
                None,
                "Using ImageMagick for PNG compression (modest savings). For stronger lossless PNG optimization: brew install oxipng",
            )

    if target_fmt not in ("webp",) and not tools.sips and not tools.magick:
        return ("Neither sips nor ImageMagick is available.", None)

    return (None, None)


def plan_batch(
    images: List[ImageInfo],
    config: OperationConfig,
    tools: AvailableTools,
    exists_fn: Callable[[str], bool] = os.path.exists,
) -> List[PlannedItem]:
    """Plan output paths, modes, warnings, and blocking errors for a batch of images."""
    reserved: Set[str] = set()
    plans: List[PlannedItem] = []

    for img in images:
        if img.error:
            plans.append(
                PlannedItem(
                    source=img,
                    effective_format="",
                    output_path="",
                    output_filename="—",
                    quality=None,
                    lossless=False,
                    mode_label="Error",
                    blocking_error=img.error,
                )
            )
            continue

        is_optimize = config.mode == "optimize" or config.target_format == "optimize"
        effective_fmt = img.format_name if is_optimize else config.target_format

        if effective_fmt not in FORMAT_EXT:
            plans.append(
                PlannedItem(
                    source=img,
                    effective_format=effective_fmt,
                    output_path="",
                    output_filename="—",
                    quality=None,
                    lossless=False,
                    mode_label="Unsupported",
                    blocking_error=f"Unsupported format: .{img.ext or 'unknown'}",
                )
            )
            continue

        # Determine lossless vs lossy
        if effective_fmt in ALWAYS_LOSSLESS:
            lossless = True
            quality = None
        elif effective_fmt in LOSSLESS_CAPABLE and config.lossless:
            lossless = True
            quality = None
        else:
            lossless = False
            quality = clamp_quality(config.quality, effective_fmt)

        mode_label = "Lossless" if lossless else f"Lossy q={quality}"

        # Output path & collision suffix
        target_ext = img.ext if (is_optimize and img.ext) else FORMAT_EXT[effective_fmt]
        suffix = "-optimized" if (is_optimize or effective_fmt == img.format_name) else ""
        out_path = plan_unique_path(img.path, target_ext, suffix, reserved, exists_fn=exists_fn)

        warnings: List[str] = []
        blocking_err, tool_warn = check_tool_requirement(
            img.format_name, effective_fmt, img.is_animated, tools
        )
        if tool_warn:
            warnings.append(tool_warn)

        if img.has_alpha and effective_fmt not in ALPHA_CAPABLE:
            warnings.append("Has transparency — JPEG flattens alpha onto white")

        if img.is_animated and effective_fmt not in ANIMATION_CAPABLE:
            warnings.append(f"Animated {img.format_name.upper()} — {effective_fmt.upper()} keeps only frame 1")

        plans.append(
            PlannedItem(
                source=img,
                effective_format=effective_fmt,
                output_path=out_path,
                output_filename=os.path.basename(out_path),
                quality=quality,
                lossless=lossless,
                mode_label=mode_label,
                warnings=tuple(warnings),
                blocking_error=blocking_err,
            )
        )

    return plans
