"""Tool discovery and missing-dependency guidance for Image Tools workflow."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Dict, Optional

SEARCH_PATHS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
)

INSTALL_HINTS: Dict[str, str] = {
    "cwebp": "brew install webp",
    "dwebp": "brew install webp",
    "gif2webp": "brew install webp",
    "webpmux": "brew install webp",
    "magick": "brew install imagemagick",
    "oxipng": "brew install oxipng",
    "pngquant": "brew install pngquant",
}


@dataclass(frozen=True)
class AvailableTools:
    sips: Optional[str]
    cwebp: Optional[str]
    dwebp: Optional[str]
    gif2webp: Optional[str]
    webpmux: Optional[str]
    magick: Optional[str]
    oxipng: Optional[str]
    pngquant: Optional[str]

    def has(self, name: str) -> bool:
        return bool(getattr(self, name, None))

    def missing_hint(self, name: str) -> str:
        cmd = INSTALL_HINTS.get(name)
        if cmd:
            return f"Missing '{name}'. Install with: {cmd}"
        return f"Missing required tool '{name}'."


def find_executable(name: str, extra_paths: tuple[str, ...] = SEARCH_PATHS) -> Optional[str]:
    """Find an executable in PATH or standard macOS/Homebrew locations."""
    found = shutil.which(name)
    if found:
        return found
    for directory in extra_paths:
        candidate = os.path.join(directory, name)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def detect_tools() -> AvailableTools:
    """Detect built-in and optional Homebrew image tools on this Mac."""
    return AvailableTools(
        sips=find_executable("sips"),
        cwebp=find_executable("cwebp"),
        dwebp=find_executable("dwebp"),
        gif2webp=find_executable("gif2webp"),
        webpmux=find_executable("webpmux"),
        magick=find_executable("magick"),
        oxipng=find_executable("oxipng"),
        pngquant=find_executable("pngquant"),
    )
