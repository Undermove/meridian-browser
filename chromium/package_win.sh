#!/bin/bash
# Release packaging on Windows (Git Bash): the installer, written to chromium/dist/.
#   Meridian-<version>-win-<arch>-setup.exe   installs for the current user, no administrator
#   SHA256SUMS-win.txt, SHA256SUMS-win.txt.sig   what the in-app updater checks it against
#   Meridian-win.exe                          the same installer for the site's download button
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
# The site's download button links to releases/latest/download/Meridian-win.exe: the same installer
# under that name (x64, what the button promises). Upload it with the rest; it isn't in the
# checksums, which are the updater's.
[ "$ARCH" != x64 ] || cp "$DIST/$NAME" "$DIST/Meridian-win.exe"
# The checksum the in-app updater checks the installer against, in a file of Windows's own (the
# Mac's SHA256SUMS.txt is made and signed on the Mac), signed with Meridian's release key like the
# Mac's (package.sh): the updater trusts no checksum without that signature. The key is never
# created here: it is the one in ~/.config/meridian/release-ed25519.pem on the Mac, copied to the
# same place on this computer (or MERIDIAN_RELEASE_KEY=<file>). Without it the release still
# installs by hand, but installed Meridians won't update themselves to it.
rm -f "$DIST/SHA256SUMS-win.txt" "$DIST/SHA256SUMS-win.txt.sig" "$DIST/SHA256SUMS.txt"
(cd "$DIST" && sha256sum "$NAME" | sed 's/ \*/  /' > SHA256SUMS-win.txt)
KEY_FILE="${MERIDIAN_RELEASE_KEY:-$HOME/.config/meridian/release-ed25519.pem}"
if [ -f "$KEY_FILE" ]; then
  KEY_FILE="$(native_path "$KEY_FILE")" SUMS="$(native_path "$DIST/SHA256SUMS-win.txt")" \
  HEADER="$(native_path "$DIR/src/chrome/browser/meridian/update_check.h")" \
  node --input-type=module -e '
import crypto from "node:crypto";
import fs from "node:fs";
const { KEY_FILE, SUMS, HEADER } = process.env;
const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
const pub = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
// The key built into the updater must be this one, or no installed Meridian takes the release.
const m = /kReleaseKey = \{([^}]*)\}/.exec(fs.readFileSync(HEADER, "utf8"));
const built = m ? Buffer.from(m[1].match(/0x[0-9a-f]{2}/gi).map((b) => parseInt(b, 16))) : Buffer.alloc(0);
if (!built.equals(pub)) {
  console.error("kReleaseKey in update_check.h is not this key: nothing signed.");
  process.exit(1);
}
fs.writeFileSync(`${SUMS}.sig`, crypto.sign(null, fs.readFileSync(SUMS), key).toString("base64") + "\n");
'
  echo "Signed: SHA256SUMS-win.txt.sig"
else
  echo "NOT SIGNED: no release key at $KEY_FILE. Installed Meridians will not update to this build." >&2
fi
cat "$DIST/SHA256SUMS-win.txt"
echo "Packaged: $DIST/$NAME ($(du -h "$DIST/$NAME" | cut -f1))"
