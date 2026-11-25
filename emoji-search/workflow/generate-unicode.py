#!/usr/bin/env python3
"""Generate static Alfred results; never called by Alfred."""

import argparse
import json
from math import ceil
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unicodedata
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape


# Inclusive Unicode 17.0 Blocks.txt ranges.
BLOCKS = (
    (0x0000, 0x007F, "Basic Latin"),
    (0x0080, 0x00FF, "Latin-1 Supplement"),
    (0x0100, 0x017F, "Latin Extended-A"),
    (0x0180, 0x024F, "Latin Extended-B"),
    (0x0370, 0x03FF, "Greek and Coptic"),
    (0x1E00, 0x1EFF, "Latin Extended Additional"),
    (0x2000, 0x206F, "General Punctuation"),
    (0x2070, 0x209F, "Superscripts and Subscripts"),
    (0x20A0, 0x20CF, "Currency Symbols"),
    (0x2100, 0x214F, "Letterlike Symbols"),
    (0x2150, 0x218F, "Number Forms"),
    (0x2190, 0x21FF, "Arrows"),
    (0x2200, 0x22FF, "Mathematical Operators"),
    (0x2300, 0x23FF, "Miscellaneous Technical"),
    (0x2460, 0x24FF, "Enclosed Alphanumerics"),
    (0x2500, 0x257F, "Box Drawing"),
    (0x2580, 0x259F, "Block Elements"),
    (0x25A0, 0x25FF, "Geometric Shapes"),
    (0x2600, 0x26FF, "Miscellaneous Symbols"),
    (0x2700, 0x27BF, "Dingbats"),
)
START = "    items: [\n"
END = "\n    ]\n  })"
PREFIX = '    {"uid":"unicode-'
SVG_NS = "http://www.w3.org/2000/svg"
ICON_SIZE = 128
MAX_INK = 112


def generate_items(seen):
    for first, last, block in BLOCKS:
        items = []
        for point in range(first, last + 1):
            char = chr(point)
            if (char in seen or not char.isprintable() or char.isspace()
                    or unicodedata.category(char).startswith("M")):
                continue
            name = unicodedata.name(char, None)
            if name is None:
                continue
            seen.add(char)
            code = f"{point:04X}"
            uid = f"unicode-{code}"
            items.append({
                "uid": uid,
                "title": f"{name.title()} {char}",
                "subtitle": f"U+{code} · {block}",
                "match": f"{name} U+{code} {code} {char}",
                "arg": char,
                "icon": {"path": f"icons/{uid}.svg"},
            })
        yield first, last, block, items


def svg_icon(char, size, view_size, x, y):
    return (f'<svg xmlns="{SVG_NS}" width="{size}" height="{size}" viewBox="0 0 {view_size} {view_size}">'
            f'<text x="{x:g}" y="{y:g}" text-anchor="middle" font-family="-apple-system, sans-serif" '
            f'font-size="96" font-weight="500" fill="#8c8c8c">{escape(char)}</text></svg>\n')


def measure_icons(directory, items, svgs):
    result = subprocess.run(["swift", "-O", str(directory / "measure-svg-ink.swift")],
                            input="".join(svgs), capture_output=True, text=True, check=True,
                            encoding="utf-8")
    for item, line in zip(items, result.stdout.splitlines(), strict=True):
        try:
            left, top, right, bottom = map(int, line.split())
        except ValueError:
            raise ValueError(f"{item['uid']}: {line}") from None
        yield left, top, right, bottom


def render_icons(directory, items):
    # The macOS SVG decoder ignores dominant-baseline. Position the visible
    # ink instead, measuring font fallback on a canvas large enough not to clip.
    probe_size = 256
    center = probe_size // 2
    probes = [svg_icon(item["arg"], probe_size, probe_size, center, center) for item in items]
    svgs = []
    for item, (left, top, right, bottom) in zip(items, measure_icons(directory, items, probes)):
        view_size = max(ICON_SIZE, ceil(max(right - left, bottom - top) * ICON_SIZE / MAX_INK))
        x = center + (view_size - left - right) / 2
        y = center + (view_size - top - bottom) / 2
        svgs.append(svg_icon(item["arg"], ICON_SIZE, view_size, x, y))

    for item, (left, top, right, bottom) in zip(items, measure_icons(directory, items, svgs)):
        if (min(left, top, ICON_SIZE - right, ICON_SIZE - bottom) < 4
                or abs(left + right - ICON_SIZE) > 4 or abs(top + bottom - ICON_SIZE) > 4):
            raise ValueError(f"{item['uid']}: SVG ink is off-center or cropped: {left, top, right, bottom}")
    return svgs


def check_icon(path, char):
    root = ET.parse(path).getroot()
    if (root.tag != f"{{{SVG_NS}}}svg" or len(root) != 1
            or root[0].tag != f"{{{SVG_NS}}}text" or len(root[0]) or root[0].text != char):
        raise ValueError("expected an SVG text icon for the result character")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify rows and icon files without writing")
    args = parser.parse_args()
    if unicodedata.unidata_version != "17.0.0":
        parser.error(f"expected Unicode 17.0.0, got {unicodedata.unidata_version}")

    directory = Path(__file__).resolve().parent
    script = directory / "emoji.js"
    source = script.read_text(encoding="utf-8")
    head, body = source.split(START, 1)
    rows, tail = body.rsplit(END, 1)
    items = json.loads(f"[{rows}]")
    base = [item for item in items if not item["uid"].startswith("unicode-")]
    base_rows = rows.split("\n" + PREFIX, 1)[0].removesuffix(",")
    if json.loads(f"[{base_rows}]") != base:
        parser.error("expected generated results as a compact suffix of the items array")
    for key in ("uid", "arg"):
        if len({item[key] for item in items}) != len(items):
            parser.error(f"duplicate {key} in emoji.js")

    generated = []
    for first, last, block, additions in generate_items({item["arg"] for item in base}):
        print(f"{first:04X}–{last:04X}  {block}: {len(additions)}")
        generated.extend(additions)
    print(f"{len(base)} existing + {len(generated)} generated = {len(base) + len(generated)}")

    if args.check:
        if items != base + generated:
            parser.error("generated results do not match emoji.js; rerun without --check")
        for item in generated:
            path = item["icon"]["path"]
            try:
                check_icon(directory / path, item["arg"])
            except (OSError, ET.ParseError, ValueError) as error:
                parser.error(f"{path}: {error}")
        return

    new_rows = ",\n".join("    " + json.dumps(item, ensure_ascii=False, separators=(",", ":"))
                           for item in generated)
    updated_rows = ",\n".join(filter(None, (base_rows, new_rows)))
    updated = head + START + updated_rows + END + tail
    try:
        svgs = render_icons(directory, generated) if generated else []
    except subprocess.CalledProcessError as error:
        parser.error(f"could not measure SVG ink: {error.stderr.strip()}")
    except ValueError as error:
        parser.error(str(error))

    # Verify every rendering before installing new icons or changing the rows.
    with TemporaryDirectory(dir=directory) as staging:
        for item, svg in zip(generated, svgs):
            path = directory / item["icon"]["path"]
            if not path.is_file() or path.read_text(encoding="utf-8") != svg:
                candidate = Path(staging) / path.name
                candidate.write_text(svg, encoding="utf-8")
                candidate.replace(path)
        if updated != source:
            candidate = Path(staging) / script.name
            candidate.write_text(updated, encoding="utf-8")
            shutil.copymode(script, candidate)
            if script.read_text(encoding="utf-8") != source:
                parser.error("emoji.js changed during generation; review and retry")
            candidate.replace(script)


if __name__ == "__main__":
    main()
