#!/bin/bash
# Puts Meridian's patches on a fresh `meridian` branch at the pinned Chromium revision.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "${CHROMIUM_DIR:-$HOME/repos/chromium}/src"
git checkout -q -B meridian "$(cat "$HERE/CHROMIUM_REVISION")"
git -c user.email=meridian@localhost -c user.name=Meridian am -q --3way "$HERE"/patches/*.patch
echo "Applied $(ls "$HERE"/patches/*.patch | wc -l | tr -d ' ') patches."
