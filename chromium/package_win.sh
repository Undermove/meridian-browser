#!/bin/bash
# Release packaging on Windows (Git Bash): the installer, written to chromium/dist/.
#   Meridian-<version>-win-<arch>-setup.exe   installs for the current user, no administrator
#   SHA256SUMS.txt
# It is Chromium's own installer (mini_installer) with Meridian's ad blocking rules and Workbench
# page inside: it puts Meridian in %LOCALAPPDATA%\Meridian Browser\Application, adds the Start menu
# and desktop shortcuts and the entry in Windows's list of apps, and a newer one installs over an
# older one. Not signed yet: Windows SmartScreen warns on the first run.
#   chromium/package_win.sh
set -euo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/tools/platform.sh"
[ "$MERIDIAN_OS" = win ] || { echo "package_win.sh is for Windows; macOS has package.sh" >&2; exit 1; }
command -v autoninja >/dev/null 2>&1 || export PATH="$DIR/depot_tools:$PATH"
OUT="$DIR/src/out/Release"
VERSION="$(sed -n 's/.*kVersion\[\] = "\(.*\)";/\1/p' "$DIR/src/chrome/browser/meridian/update_check.h")"
[ -n "$VERSION" ] || { echo "No version in update_check.h" >&2; exit 1; }
ARCH="$(sed -n 's/^target_cpu = "\(.*\)"$/\1/p' "$OUT/args.gn")"; ARCH="${ARCH:-x64}"

# The browser with its data files (build.sh), then the installer around them.
"$HERE/build.sh"
(cd "$DIR/src" && autoninja -C out/Release mini_installer)

DIST="$HERE/dist"
NAME="Meridian-$VERSION-win-$ARCH-setup.exe"
mkdir -p "$DIST"
cp "$OUT/mini_installer.exe" "$DIST/$NAME"
(cd "$DIST" && sha256sum "$NAME" > SHA256SUMS.txt)
echo "Packaged: $DIST/$NAME ($(du -h "$DIST/$NAME" | cut -f1))"
