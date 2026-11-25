# Emoji Search (Custom Unicode & Symbol Additions)

Source and maintenance assets for the customized `Emoji Search` Alfred workflow (`kau.sh.alfred.emojisearch`).

## What is tracked here

- `workflow/info.plist`, `workflow/icon.png`
- `workflow/emoji.js` (includes the 86 curated symbol entries, original emoji entries, and generated Unicode suffix)
- `workflow/generate-unicode.py`, `workflow/measure-svg-ink.swift`, `workflow/render-symbol-icons.swift`
- `workflow/icons/symbol-*.png` (the 86 curated symbol icons that the generator does not recreate)
- `AGENTS.md` (full maintenance and regeneration instructions)

## What is intentionally omitted

- Upstream emoji PNGs (`icons/1f*.png`, ~9.4 MB) and generated Unicode SVGs (`icons/unicode-*.svg`, 2,548 files).
- Regenerate the Unicode SVGs in an installed copy of the workflow using `workflow/generate-unicode.py` (see `AGENTS.md`).
