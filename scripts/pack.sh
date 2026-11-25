#!/bin/sh
# Package any <slug>/workflow/ directory into an importable .alfredworkflow archive.
# Usage: ./scripts/pack.sh <workflow-dir> [output-name.alfredworkflow]
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <workflow-dir> [output-file.alfredworkflow]" >&2
  exit 1
fi

DIR="$(cd "$1" && pwd)"
WF_DIR="$DIR/workflow"
if [ ! -f "$WF_DIR/info.plist" ]; then
  echo "Error: $WF_DIR/info.plist not found" >&2
  exit 1
fi

NAME="${2:-$(basename "$DIR").alfredworkflow}"
case "$NAME" in
  /*) OUT="$NAME" ;;
  *)  OUT="$DIR/$NAME" ;;
esac

rm -f "$OUT"
(
  cd "$WF_DIR"
  zip -qr "$OUT" . -x "*/__pycache__/*" "*.pyc" ".DS_Store" "*/.DS_Store" "prefs.plist"
)
echo "Packed: $OUT"
