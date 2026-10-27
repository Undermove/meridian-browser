#!/bin/bash
# Assembles the Workbench page (chrome://workbench) into a folder: the page and
# its scripts from the Meridian UI (src/renderer/dev), the bridge to the C++
# handler, and Monaco + xterm. Usage: workbench_assets.sh <dest>
# (Meridian.app/Contents/Resources/workbench in a build.)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
dest="$1"
cache="${MERIDIAN_VENDOR_CACHE:-$here/.vendor}"
monaco=0.57.0; xterm=6.0.0; fit=0.11.0

if [ ! -d "$cache/node_modules/monaco-editor/min" ] || [ ! -d "$cache/node_modules/@xterm/xterm/lib" ]; then
  mkdir -p "$cache"
  (cd "$cache" && npm install --no-save --no-package-lock --ignore-scripts --silent \
    "monaco-editor@$monaco" "@xterm/xterm@$xterm" "@xterm/addon-fit@$fit")
fi

rm -rf "$dest.tmp"
mkdir -p "$dest.tmp/vendor"
for f in workbench.html workbench.js workbench-pro.js workbench.css secret-detect.js mission-chip.js; do
  cp "$repo/src/renderer/dev/$f" "$dest.tmp/$f"
done
cp "$repo/src/renderer/icons.js" "$dest.tmp/icons.js"
cp "$here/workbench/bridge.js" "$dest.tmp/bridge.js"
# Docker sandboxes: the image recipe, and the Mission Control hook node runs inside it.
mkdir -p "$dest.tmp/sandbox" "$dest.tmp/hooks"
cp "$repo/build/sandbox/Dockerfile" "$dest.tmp/sandbox/Dockerfile"
cp "$repo/src/agents/hooks/mission-hook.js" "$dest.tmp/hooks/mission-hook.js"
# The bridge goes first: it is what gives the page `window.workbench`.
perl -0pi -e 's|(<script src="/vendor/xterm/lib/xterm.js"></script>)|<script src="bridge.js"></script>\n  $1|' "$dest.tmp/workbench.html"
grep -q 'src="bridge.js"' "$dest.tmp/workbench.html"
rsync -a --exclude '*.map' "$cache/node_modules/monaco-editor/min/" "$dest.tmp/vendor/monaco/"
mkdir -p "$dest.tmp/vendor/xterm" "$dest.tmp/vendor/xterm-fit"
rsync -a --exclude '*.map' "$cache/node_modules/@xterm/xterm/css" "$cache/node_modules/@xterm/xterm/lib" "$dest.tmp/vendor/xterm/"
rsync -a --exclude '*.map' "$cache/node_modules/@xterm/addon-fit/lib" "$dest.tmp/vendor/xterm-fit/"
rm -rf "$dest"
mv "$dest.tmp" "$dest"
echo "workbench assets: $dest"
