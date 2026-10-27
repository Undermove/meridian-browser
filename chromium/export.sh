#!/bin/bash
# After committing changes on the `meridian` branch in Chromium's src, writes them back here as patches.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${CHROMIUM_DIR:-$HOME/repos/chromium}/src"
rm -f "$HERE"/patches/*.patch
git format-patch -q --no-signature --zero-commit -o "$HERE/patches" "$(cat "$HERE/CHROMIUM_REVISION")..meridian"
ls "$HERE/patches"
