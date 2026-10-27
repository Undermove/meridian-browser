#!/bin/bash
# Puts Meridian's patches on a fresh `meridian` branch at the pinned Chromium revision.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${CHROMIUM_DIR:-$HOME/repos/chromium}/src"
git checkout -q -B meridian "$(cat "$HERE/CHROMIUM_REVISION")"
GIT=(git -c user.email=meridian@localhost -c user.name=Meridian)
"${GIT[@]}" am -q --3way "$HERE"/patches/*.patch
echo "Applied $(ls "$HERE"/patches/*.patch | wc -l | tr -d ' ') patches."
"$HERE/tools/generate.sh"
"${GIT[@]}" add -A chrome/app components/strings components/components_chromium_strings.grd
"${GIT[@]}" commit -qm "Meridian (generated): product strings and icons"
