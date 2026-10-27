#!/bin/bash
# Incremental build (minutes after the first one). The app lands in out/Release/Chromium.app.
set -euo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
export PATH="$DIR/depot_tools:$PATH"
cd "$DIR/src" && caffeinate -i autoninja -C out/Release chrome
echo "Built: $DIR/src/out/Release/Chromium.app"
