# Image Tools (Alfred 6 Workflow)

Non-destructive image optimization and format conversion from Finder via Alfred 6 Universal Actions.

## Universal Actions

Select one or more image files in Finder and open Alfred Universal Actions:

1. **Optimize Image** — Runs immediately with visually near-lossless defaults (`WebP q=86`, `JPEG q=85`, `HEIC/AVIF q=82`, lossless `PNG`). Saves copies beside originals (`name-optimized.ext`, collision-safe `-2`, `-3`, …). Skips files that are already optimal.
2. **Convert Image** — Opens a native Alfred 6 UI (`convert.alfredui`) inside Alfred:
   - Choose format: **WebP**, **JPEG**, **PNG**, **AVIF**, **HEIC**, **TIFF**, **GIF**, or **Keep Original Format (Optimize)** when you want custom optimization settings.
   - Toggle **Lossless** (when supported), adjust **Quality**, and toggle **Keep EXIF** (ICC color profiles such as Display P3 are always preserved).
   - Preview proposed output filenames (including collision suffixes) and warnings (such as transparency flattened onto white for JPEG, or missing Homebrew tools).
   - Press **`⌘P`** to measure actual encoded sizes in a temporary folder before writing any files.
   - Press **`↩︎`** (or **`⌘↩`**) to convert and review per-file results in place.

## Tool Requirements

- **Built-in macOS (`sips`):** Handles JPEG, PNG, HEIC, AVIF, TIFF, and GIF.
- **WebP (`brew install webp`):** Required for WebP encoding (`cwebp`, `gif2webp`), because macOS ImageIO only reads WebP.
- **ImageMagick (`brew install imagemagick`):** Optional; enables SVG input, clean white-background flattening for alpha → JPEG, animated WebP, and fallback PNG compression.
- **oxipng (`brew install oxipng`):** Optional; used automatically when installed for stronger lossless PNG optimization.

If a required tool is missing on another Mac, the workflow reports the exact `brew install` command instead of failing silently.

## Install locally (symlink)

```fish
ln -s ~/dev/oss/alfred-workflows/image-tools/workflow \
  "$HOME/Library/Application Support/Alfred/Alfred.alfredpreferences/workflows/user.workflow.kaush-image-tools"
```

## Run tests

```fish
node --test ~/dev/oss/alfred-workflows/image-tools/tests/image_tools.test.ts
```
