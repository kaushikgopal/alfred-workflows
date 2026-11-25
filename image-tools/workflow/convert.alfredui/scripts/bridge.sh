#!/bin/sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/env python3 "${SCRIPT_DIR}/../../bin/ui_bridge.py" "$@"
