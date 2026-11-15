#!/bin/bash
# Incremental build (minutes after the first one). The app lands in out/Release: Meridian.app on
# macOS, chrome (Linux) or chrome.exe (Windows) with its files around it elsewhere.
set -euo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/tools/platform.sh"
command -v autoninja >/dev/null 2>&1 || export PATH="$DIR/depot_tools:$PATH"
# Google API keys (Safe Browsing): kept outside the repository, in ~/.config/meridian/google_api_keys
# ("google_api_key = \"…\"" lines, gn syntax). Their values end up in the build's args.gn.
KEYS="$HOME/.config/meridian/google_api_keys"
ARGS="$(cat "$HERE/args.gn")"
[ -f "$KEYS" ] && ARGS="$ARGS
$(cat "$KEYS")"
if [ "$ARGS" != "$(cat "$DIR/src/out/Release/args.gn" 2>/dev/null)" ]; then
  mkdir -p "$DIR/src/out/Release"
  printf '%s\n' "$ARGS" > "$DIR/src/out/Release/args.gn"
  (cd "$DIR/src" && gn gen out/Release >/dev/null)
fi
"$HERE/tools/clean_temp.sh" || true
cd "$DIR/src" && keep_awake autoninja -C out/Release chrome
RES="$(meridian_resources "$DIR/src/out/Release")"
# Ad blocking rules: fetched again when missing or older than a week.
RULES="$RES/meridian_adblock.dat"
if [ -z "$(find "$RULES" -mtime -7 2>/dev/null)" ]; then "$HERE/tools/adblock.sh"; fi
# The Workbench page, Monaco and xterm (chrome://workbench serves them from here).
"$HERE/tools/workbench_assets.sh" "$RES/workbench"
echo "Built: $(meridian_binary "$DIR/src/out/Release")"
