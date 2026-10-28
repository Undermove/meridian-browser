#!/bin/bash
# Release packaging (macOS, this Mac's architecture). Signs the built app with the "Meridian Signing"
# certificate (the first time, macOS asks to let codesign use its key: Always Allow), then writes to
# chromium/dist/:
#   Meridian-<version>-mac-<arch>.dmg   drag to Applications
#   Meridian-<version>-mac-<arch>.zip   for install.sh and the in-app updater
#   SHA256SUMS.txt                      checked by both
# Every release must be signed with the same certificate: the updater only takes an app signed like
# the one running, and the Keychain's "Always Allow" survives updates.
#   chromium/package.sh [--unsigned]   (--unsigned: an ad-hoc build, for trying the packaging only)
set -euo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/src/out/Release/Meridian.app"
ID="${MERIDIAN_SIGN_ID:-Meridian Signing}"
VERSION="$(sed -n 's/.*kVersion\[\] = "\(.*\)";/\1/p' "$DIR/src/chrome/browser/meridian/update_check.h")"
ARCH="$(uname -m)"; [ "$ARCH" = x86_64 ] && ARCH=x64
NAME="Meridian-$VERSION-mac-$ARCH"
OUT="$HERE/dist"
[ -n "$VERSION" ] || { echo "No version in update_check.h" >&2; exit 1; }
[ -d "$SRC" ] || { echo "Build first: $SRC is missing" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/stage/dmg"
APP="$OUT/stage/dmg/Meridian.app"
ditto "$SRC" "$APP"

if [ "${1:-}" = "--unsigned" ]; then
  echo "Unsigned (ad-hoc): only for trying the packaging; the updater won't take it."
  codesign --force --deep -s - "$APP"
else
  security find-identity -p codesigning | grep -q "\"$ID\"" || {
    echo "No \"$ID\" code-signing identity in the keychain." >&2; exit 1; }
  # No hardened runtime: V8's JIT in the helpers would need entitlements, and without notarization it
  # brings nothing. --deep signs the helpers and frameworks inside first.
  codesign --force --deep -s "$ID" "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "Signature: $(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"

# The zip: what install.sh and the updater unpack (ditto keeps the signature intact).
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$NAME.zip"
# The disk image: the app and a link to Applications.
ln -s /Applications "$OUT/stage/dmg/Applications"
hdiutil create -quiet -volname "Meridian" -srcfolder "$OUT/stage/dmg" -ov -format UDZO "$OUT/$NAME.dmg"
rm -rf "$OUT/stage"

(cd "$OUT" && shasum -a 256 "$NAME.dmg" "$NAME.zip" > SHA256SUMS.txt)
ls -lh "$OUT"
cat "$OUT/SHA256SUMS.txt"
