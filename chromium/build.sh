#!/bin/bash
# Incremental build (minutes after the first one). The app lands in out/Release/Meridian.app.
set -euo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$DIR/depot_tools:$PATH"
cd "$DIR/src" && caffeinate -i autoninja -C out/Release chrome
# Ad blocking rules: fetched again when missing or older than a week.
RULES="$DIR/src/out/Release/Meridian.app/Contents/Resources/meridian_adblock.dat"
if [ -z "$(find "$RULES" -mtime -7 2>/dev/null)" ]; then "$HERE/tools/adblock.sh"; fi
echo "Built: $DIR/src/out/Release/Meridian.app"
