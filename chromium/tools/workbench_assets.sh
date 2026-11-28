#!/bin/bash
# Assembles the Workbench page (chrome://workbench) into a folder: the page and
# its scripts from the Meridian UI (src/renderer/dev), the bridge to the C++
# handler, and Monaco + xterm. Usage: workbench_assets.sh <dest>
# (Meridian.app/Contents/Resources/workbench in a macOS build, workbench/ next to the
# executable elsewhere.)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
dest="$1"
cache="${MERIDIAN_VENDOR_CACHE:-$here/.vendor}"
# Monaco and xterm come from tools/workbench-vendor: exact versions and a lockfile with hashes
# (npm ci), so a build gets the same bytes every time. A changed lockfile reinstalls them.
vendor="$here/tools/workbench-vendor"

if ! cmp -s "$vendor/package-lock.json" "$cache/package-lock.json" \
   || [ ! -d "$cache/node_modules/monaco-editor/min" ] || [ ! -d "$cache/node_modules/@xterm/xterm/lib" ] || [ ! -d "$cache/node_modules/@xterm/addon-unicode-graphemes/lib" ]; then
  mkdir -p "$cache"
  rm -rf "$cache/node_modules"
  cp "$vendor/package.json" "$vendor/package-lock.json" "$cache/"
  (cd "$cache" && npm ci --ignore-scripts --no-audit --no-fund --silent)
fi

rm -rf "$dest.tmp"
mkdir -p "$dest.tmp/vendor"
for f in workbench.html workbench.js workbench-pro.js workbench.css secret-detect.js mission-chip.js context-insights.js source-control.js terminal-extras.js session-status.js chats.js chats.css studio.js studio-words.js studio-transcript.js studio.css; do
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
cp -R "$cache/node_modules/monaco-editor/min" "$dest.tmp/vendor/monaco"
mkdir -p "$dest.tmp/vendor/xterm" "$dest.tmp/vendor/xterm-fit" "$dest.tmp/vendor/xterm-unicode-graphemes"
cp -R "$cache/node_modules/@xterm/xterm/css" "$cache/node_modules/@xterm/xterm/lib" "$dest.tmp/vendor/xterm/"
cp -R "$cache/node_modules/@xterm/addon-fit/lib" "$dest.tmp/vendor/xterm-fit/"
cp -R "$cache/node_modules/@xterm/addon-unicode-graphemes/lib" "$dest.tmp/vendor/xterm-unicode-graphemes/"
find "$dest.tmp/vendor" -name '*.map' -delete
rm -rf "$dest"
mv "$dest.tmp" "$dest"
echo "workbench assets: $dest"
