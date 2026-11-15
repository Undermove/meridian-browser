#!/bin/bash
# One-time: fetch Chromium (no git history, ~32 GB) at the pinned revision next to this repo,
# apply Meridian's patches and generate the build directory. macOS, Linux, or Windows in Git Bash
# (there with depot_tools on PATH and DEPOT_TOOLS_WIN_TOOLCHAIN=0, as Chromium's instructions say).
#   CHROMIUM_DIR defaults to ~/repos/chromium.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/tools/platform.sh"
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
mkdir -p "$DIR" && cd "$DIR"
if [ "$MERIDIAN_OS" = mac ]; then touch .metadata_never_index; fi   # keep Spotlight out of millions of files
# depot_tools: the one already on PATH, or a copy next to the checkout.
if ! command -v gclient >/dev/null 2>&1; then
  [ -d depot_tools ] || git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
  export PATH="$DIR/depot_tools:$PATH"
fi
[ -d src/.git ] || fetch --nohooks --no-history chromium
cd src
REV="$(cat "$HERE/CHROMIUM_REVISION")"
if [ "$(git rev-parse HEAD)" != "$REV" ] && ! git merge-base --is-ancestor "$REV" HEAD 2>/dev/null; then
  git fetch --depth=1 origin "$REV" && git checkout -q "$REV"
fi
gclient sync -D --no-history --nohooks
# Chromium's packages for building on Linux (asks for the sudo password).
if [ "$MERIDIAN_OS" = linux ]; then ./build/install-build-deps.sh --no-prompt --no-chromeos-fonts; fi
gclient runhooks
# Xcode needs the Metal compiler for ANGLE's shaders.
if [ "$MERIDIAN_OS" = mac ]; then
  xcrun -f metal >/dev/null 2>&1 || xcodebuild -downloadComponent MetalToolchain
fi
"$HERE/apply.sh"
mkdir -p out/Release && cp "$HERE/args.gn" out/Release/args.gn && gn gen out/Release
echo "Ready. Build with: $HERE/build.sh"
