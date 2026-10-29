#!/bin/bash
# Release packaging (macOS, this Mac's architecture). Signs the built app with the "Meridian Signing"
# certificate (the first time, macOS asks to let codesign use its key: Always Allow), then writes to
# chromium/dist/:
#   Meridian-<version>-mac-<arch>.dmg   drag to Applications
#   Meridian-<version>-mac-<arch>.zip   for install.sh and the in-app updater
#   SHA256SUMS.txt                      checked by both
#   SHA256SUMS.txt.sig                  the updater trusts no checksum without it (upload it too)
# Every release must be signed with the same certificate: the updater only takes an app signed like
# the one running, and the Keychain's "Always Allow" survives updates. (Moving to a Developer ID
# needs one release first that trusts its Team ID too: see SECURITY.md.)
# MERIDIAN_SIGN_ID: another identity, e.g. "Developer ID Application: Name (TEAMID)".
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
# The version, sealed by the signature below: the updater refuses an app whose file doesn't say the
# release's version, or isn't newer than the running one (no older build passed off as a new one).
printf '%s\n' "$VERSION" > "$APP/Contents/Resources/meridian-version"

# Signs inside out like Chrome's own signing: libraries, helper tools, helper apps (renderers and GPU
# may JIT), the framework, then the app (camera, microphone, location… as Chrome asks for them), all
# with the hardened runtime. A self-signed certificate has no Team ID, so library validation can't
# hold and is switched off; with a Developer ID it stays on and the result is notarized.
sign_all() {
  local id="$1" ent="$OUT/stage/entitlements" fw ver vd ts=()
  mkdir -p "$ent"
  fw="$APP/Contents/Frameworks/Meridian Framework.framework"
  ver="$(ls "$fw/Versions" | grep -v Current | head -1)"
  vd="$fw/Versions/$ver"
  cp "$DIR/src/chrome/app/app-entitlements.plist" "$ent/app.plist"
  cp "$DIR/src/chrome/app/helper-renderer-entitlements.plist" "$ent/jit.plist"
  /usr/libexec/PlistBuddy -c "Clear dict" "$ent/plain.plist" >/dev/null 2>&1 || \
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n' > "$ent/plain.plist"
  if [ -z "$TEAM" ]; then
    for f in app jit plain; do
      /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$ent/$f.plist"
    done
  else
    ts=(--timestamp)
  fi
  local cs=(codesign --force ${ts[@]+"${ts[@]}"} -s "$id")
  for lib in "$vd"/Libraries/*.dylib; do "${cs[@]}" "$lib"; done
  for tool in chrome_crashpad_handler app_mode_loader web_app_shortcut_copier; do
    [ -e "$vd/Helpers/$tool" ] && "${cs[@]}" --options runtime --entitlements "$ent/plain.plist" "$vd/Helpers/$tool"
  done
  # restrict: no DYLD_ variables, and @executable_path library paths only under library validation,
  # which a certificate without a Team ID can't have. So the Aperitif helpers (they load
  # libaperitif.dylib by such a path) go without it then.
  local restrict
  for helper in "$vd"/Helpers/*.app; do
    restrict=restrict,
    case "$(basename "$helper")" in *Aperitif*) [ -z "$TEAM" ] && restrict= ;; esac
    case "$(basename "$helper")" in
      *Renderer*|*GPU*) "${cs[@]}" --options "${restrict}kill,runtime" --entitlements "$ent/jit.plist" "$helper" ;;
      *) "${cs[@]}" --options runtime --entitlements "$ent/plain.plist" "$helper" ;;
    esac
  done
  "${cs[@]}" "$vd"
  "${cs[@]}" --options runtime --entitlements "$ent/app.plist" "$APP"
}

TEAM=""
if [ "${1:-}" = "--unsigned" ]; then
  echo "Unsigned (ad-hoc): only for trying the packaging; the updater won't take it."
  codesign --force --deep -s - "$APP"
else
  security find-identity -p codesigning | grep -q "\"$ID\"" || {
    echo "No \"$ID\" code-signing identity in the keychain." >&2; exit 1; }
  # A Developer ID certificate carries the Team ID: "Developer ID Application: Name (TEAMID)".
  case "$ID" in "Developer ID Application:"*) TEAM="$(echo "$ID" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')" ;; esac
  sign_all "$ID"
fi
codesign --verify --deep --strict "$APP"
echo "Signature: $(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"

# The zip: what install.sh and the updater unpack (ditto keeps the signature intact).
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$NAME.zip"
# The disk image: the app and a link to Applications.
ln -s /Applications "$OUT/stage/dmg/Applications"
hdiutil create -quiet -volname "Meridian" -srcfolder "$OUT/stage/dmg" -ov -format UDZO "$OUT/$NAME.dmg"
rm -rf "$OUT/stage"

# Notarized (Developer ID only): MERIDIAN_NOTARY_PROFILE names a profile saved with
#   xcrun notarytool store-credentials <name> --apple-id … --team-id … --password <app-specific>
if [ -n "$TEAM" ] && [ -n "${MERIDIAN_NOTARY_PROFILE:-}" ]; then
  echo "Notarizing (a few minutes)…"
  xcrun notarytool submit "$OUT/$NAME.dmg" --keychain-profile "$MERIDIAN_NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUT/$NAME.dmg"
  # The zip carries the app: staple it too and zip it again.
  T="$(mktemp -d)"; ditto -x -k "$OUT/$NAME.zip" "$T"
  xcrun stapler staple "$T/Meridian.app"
  rm "$OUT/$NAME.zip"; ditto -c -k --sequesterRsrc --keepParent "$T/Meridian.app" "$OUT/$NAME.zip"; rm -rf "$T"
fi

(cd "$OUT" && shasum -a 256 "$NAME.dmg" "$NAME.zip" > SHA256SUMS.txt)

# The checksums, signed with Meridian's release key (Ed25519; the private key never enters the repo).
# The updater only trusts SHA256SUMS.txt under this signature, checked with the public key built
# into it (kReleaseKey in update_check.h). The first run creates the key: back it up, since releases
# signed with any other key are refused by every installed Meridian.
# MERIDIAN_RELEASE_KEY: another key file.
KEY_FILE="${MERIDIAN_RELEASE_KEY:-$HOME/.config/meridian/release-ed25519.pem}" \
SUMS="$OUT/SHA256SUMS.txt" HEADER="$DIR/src/chrome/browser/meridian/update_check.h" \
node --input-type=module -e '
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const { KEY_FILE, SUMS, HEADER } = process.env;
if (!fs.existsSync(KEY_FILE)) {
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  console.error(`Created the release key ${KEY_FILE}: back it up.`);
}
fs.chmodSync(KEY_FILE, 0o600);
const key = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
const pub = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
// The key built into the updater must be this one, or no installed Meridian takes the release.
const m = /kReleaseKey = \{([^}]*)\}/.exec(fs.readFileSync(HEADER, "utf8"));
const built = m ? Buffer.from(m[1].match(/0x[0-9a-f]{2}/gi).map((b) => parseInt(b, 16))) : Buffer.alloc(0);
if (!built.equals(pub)) {
  console.error(`kReleaseKey in update_check.h isn’t this key. Its public key: ${pub.toString("base64")}`);
  console.error([...pub].map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", "));
  process.exit(1);
}
const sig = crypto.sign(null, fs.readFileSync(SUMS), key);
fs.writeFileSync(`${SUMS}.sig`, sig.toString("base64") + "\n");
'
ls -lh "$OUT"
cat "$OUT/SHA256SUMS.txt"
