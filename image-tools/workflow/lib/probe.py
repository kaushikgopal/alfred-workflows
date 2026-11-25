"""Fast image metadata probing using macOS built-ins and lightweight header checks."""

from __future__ import annotations

import os
import struct
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import List, Optional

from .tools import AvailableTools


@dataclass(frozen=True)
class ImageInfo:
    path: str
    filename: str
    size_bytes: int
    ext: str  # lowercase without leading dot
    format_name: str  # normalized: png, jpeg, webp, avif, heic, gif, tiff, bmp, etc.
    width: Optional[int]
    height: Optional[int]
    has_alpha: bool
    is_animated: bool
    icc_profile: Optional[str]
    error: Optional[str] = None


EXT_TO_FORMAT = {
    "jpg": "jpeg",
    "jpeg": "jpeg",
    "jpe": "jpeg",
    "png": "png",
    "webp": "webp",
    "avif": "avif",
    "heic": "heic",
    "heif": "heic",
    "gif": "gif",
    "tif": "tiff",
    "tiff": "tiff",
    "bmp": "bmp",
    "psd": "psd",
    "jp2": "jp2",
    "tga": "tga",
    "ico": "ico",
    "icns": "icns",
    "svg": "svg",
}


def normalize_format(ext_or_fmt: str) -> str:
    key = ext_or_fmt.lower().lstrip(".")
    return EXT_TO_FORMAT.get(key, key)


def _is_animated_gif(path: str) -> bool:
    """Detect whether a GIF has more than one image descriptor (0x2C)."""
    try:
        with open(path, "rb") as f:
            data = f.read(1024 * 512)  # first 512 KB is enough to find 2nd frame
        if not (data.startswith(b"GIF87a") or data.startswith(b"GIF89a")):
            return False
        # Skip header (6) + logical screen descriptor (7)
        pos = 13
        if len(data) < pos:
            return False
        packed = data[10]
        if packed & 0x80:  # global color table
            gct_size = 3 * (2 ** ((packed & 0x07) + 1))
            pos += gct_size
        frames = 0
        n = len(data)
        while pos < n:
            block = data[pos]
            pos += 1
            if block == 0x2C:  # Image Descriptor
                frames += 1
                if frames > 1:
                    return True
                if pos + 9 > n:
                    break
                lct_packed = data[pos + 8]
                pos += 9
                if lct_packed & 0x80:
                    pos += 3 * (2 ** ((lct_packed & 0x07) + 1))
                # LZW minimum code size
                pos += 1
                while pos < n and data[pos] != 0:
                    pos += 1 + data[pos]
                pos += 1
            elif block == 0x21:  # Extension
                if pos >= n:
                    break
                pos += 1  # label
                while pos < n and data[pos] != 0:
                    pos += 1 + data[pos]
                pos += 1
            elif block == 0x3B:  # Trailer
                break
            else:
                break
        return False
    except OSError:
        return False


def _is_animated_webp(path: str) -> bool:
    """Detect WebP animation by checking VP8X animation flag (bit 1)."""
    try:
        with open(path, "rb") as f:
            header = f.read(32)
        if len(header) >= 21 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
            if header[12:16] == b"VP8X":
                flags = header[20]
                return bool(flags & 0x02)
        return False
    except OSError:
        return False


def _is_animated_png(path: str) -> bool:
    """Detect APNG by looking for an acTL chunk before IDAT."""
    try:
        with open(path, "rb") as f:
            sig = f.read(8)
            if sig != b"\x89PNG\r\n\x1a\n":
                return False
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    return False
                length, chunk_type = struct.unpack(">I4s", hdr)
                if chunk_type == b"acTL":
                    return True
                if chunk_type == b"IDAT" or chunk_type == b"IEND":
                    return False
                f.seek(length + 4, os.SEEK_CUR)
    except OSError:
        return False


def _probe_with_sips(path: str, sips_bin: str) -> dict[str, str]:
    res = subprocess.run(
        [
            sips_bin,
            "-g",
            "format",
            "-g",
            "pixelWidth",
            "-g",
            "pixelHeight",
            "-g",
            "hasAlpha",
            "-g",
            "profile",
            path,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    props: dict[str, str] = {}
    if res.returncode != 0:
        return props
    for line in res.stdout.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            key = k.strip()
            val = v.strip()
            if key in ("format", "pixelWidth", "pixelHeight", "hasAlpha", "profile"):
                props[key] = val
    return props


def probe_image(path: str, tools: AvailableTools) -> ImageInfo:
    """Probe an image file for size, format, dimensions, alpha, animation, and ICC profile."""
    filename = os.path.basename(path)
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    if not os.path.exists(path):
        return ImageInfo(
            path=path,
            filename=filename,
            size_bytes=0,
            ext=ext,
            format_name=normalize_format(ext),
            width=None,
            height=None,
            has_alpha=False,
            is_animated=False,
            icc_profile=None,
            error="File not found",
        )
    if os.path.isdir(path):
        return ImageInfo(
            path=path,
            filename=filename,
            size_bytes=0,
            ext=ext,
            format_name="",
            width=None,
            height=None,
            has_alpha=False,
            is_animated=False,
            icc_profile=None,
            error="Folders are not supported",
        )

    size_bytes = os.path.getsize(path)
    fmt = normalize_format(ext)
    width: Optional[int] = None
    height: Optional[int] = None
    has_alpha = False
    icc_profile: Optional[str] = None

    if tools.sips and fmt != "svg":
        props = _probe_with_sips(path, tools.sips)
        if props.get("format"):
            fmt = normalize_format(props["format"])
        if props.get("pixelWidth", "").isdigit():
            width = int(props["pixelWidth"])
        if props.get("pixelHeight", "").isdigit():
            height = int(props["pixelHeight"])
        has_alpha = props.get("hasAlpha", "").lower() == "yes"
        prof = props.get("profile")
        if prof and prof.lower() != "<nil>":
            icc_profile = prof

    is_animated = False
    if fmt == "gif":
        is_animated = _is_animated_gif(path)
    elif fmt == "webp":
        is_animated = _is_animated_webp(path)
    elif fmt == "png":
        is_animated = _is_animated_png(path)

    return ImageInfo(
        path=path,
        filename=filename,
        size_bytes=size_bytes,
        ext=ext,
        format_name=fmt,
        width=width,
        height=height,
        has_alpha=has_alpha,
        is_animated=is_animated,
        icc_profile=icc_profile,
    )


def probe_images(paths: List[str], tools: AvailableTools, max_workers: Optional[int] = None) -> List[ImageInfo]:
    """Probe multiple image files in parallel while preserving input order."""
    if len(paths) <= 1:
        return [probe_image(p, tools) for p in paths]
    workers = max_workers or min(len(paths), os.cpu_count() or 4, 8)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda p: probe_image(p, tools), paths))
