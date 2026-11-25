# Alfred Workflows

## Layout

Modern workflows live under `<slug>/workflow/` so scripts, Alfred 6 UI JSON (`.alfredui/`), and `info.plist` stay diffable in git:

- `image-tools/` — Optimize Image and Convert Image Universal Actions (`tests/` holds disposable-fixture tests)
- `text-transformer/` — Alfred Team's Text Transformer with custom `Unwrap` and `Strip Clean` additions
- `emoji-search/` — Customized Emoji Search with curated symbols and generated Unicode entries (see `emoji-search/AGENTS.md`)
- `pseudo-xml-surround/` — Prompt for XML-like tags and paste a surrounded block
- `xdg-base-directories/` — Snippet/list picker for XDG variable names

Legacy `.alfredextension` and `.alfredworkflow` files at the repo root are historical; leave them as-is.

## What to Track vs. Omit

- **Track:** `workflow/info.plist`, workflow scripts, `.alfredui/` packages, custom icons, tests, and small (<100 KB) packaged `.alfredworkflow` archives when convenient.
- **Omit:** runtime `prefs.plist`, `__pycache__/`, `.DS_Store`, upstream Alfred Gallery screenshots (`images/about/`), and multi-megabyte upstream or regeneratable asset dumps (such as `emoji-search`'s upstream emoji PNGs and generated Unicode SVGs).

## Packaging a Workflow

Package any `<slug>/workflow/` directory into an importable `.alfredworkflow` archive with `./scripts/pack.sh`:

```fish
./scripts/pack.sh image-tools "Image Tools.alfredworkflow"
./scripts/pack.sh text-transformer
```

Double-click the generated `.alfredworkflow` (or `open <file>`) to import or update it in Alfred 6.

## Validation

Before committing workflow changes:

```fish
plutil -lint <slug>/workflow/info.plist
python3 -m unittest discover -s image-tools/tests -v
```
