#!/bin/bash
# After committing changes on the `meridian` branch in Chromium's src, writes them back here as patches.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${CHROMIUM_DIR:-$HOME/repos/chromium}/src"
rm -f "$HERE"/patches/*.patch
git format-patch -q --no-signature --zero-commit -o "$HERE/patches" "$(cat "$HERE/CHROMIUM_REVISION")..meridian"
# The generated commit is rebuilt by tools/generate.sh on apply.
rm -f "$HERE"/patches/*-Meridian-generated-*.patch
# Keep numbering contiguous.
i=1; for f in "$HERE"/patches/*.patch; do n=$(printf '%04d' $i); b=$(basename "$f"); [ "${b:0:4}" = "$n" ] || mv "$f" "$HERE/patches/$n-${b:5}"; i=$((i+1)); done
ls "$HERE/patches"
