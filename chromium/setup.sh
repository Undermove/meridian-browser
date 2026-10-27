#!/bin/bash
# One-time: fetch Chromium (no git history, ~32 GB) at the pinned revision next to this repo,
# apply Meridian's patches and generate the build directory.
#   CHROMIUM_DIR defaults to ~/repos/chromium.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
mkdir -p "$DIR" && cd "$DIR"
touch .metadata_never_index   # keep Spotlight out of millions of files
[ -d depot_tools ] || git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$DIR/depot_tools:$PATH"
[ -d src/.git ] || fetch --nohooks --no-history chromium
cd src
REV="$(cat "$HERE/CHROMIUM_REVISION")"
if [ "$(git rev-parse HEAD)" != "$REV" ] && ! git merge-base --is-ancestor "$REV" HEAD 2>/dev/null; then
  git fetch --depth=1 origin "$REV" && git checkout -q "$REV"
fi
gclient sync -D --no-history --nohooks && gclient runhooks
# Xcode needs the Metal compiler for ANGLE's shaders.
xcrun -f metal >/dev/null 2>&1 || xcodebuild -downloadComponent MetalToolchain
"$HERE/apply.sh"
mkdir -p out/Release && cp "$HERE/args.gn" out/Release/args.gn && gn gen out/Release
echo "Ready. Build with: $HERE/build.sh"
