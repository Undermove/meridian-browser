#!/bin/bash
# Signs a release's Windows checksums on the Mac, where Meridian's release key stays: downloads
# SHA256SUMS-win.txt and the installers it lists from the GitHub release (a draft too), checks each
# installer against it, signs it with the release key as package.sh signs SHA256SUMS.txt, and
# uploads SHA256SUMS-win.txt.sig next to it. The Windows updater trusts no checksum without it.
#   chromium/tools/sign_win_sums.sh v0.6.0 <sha256 of each installer, as the Windows build reported it>
#   MERIDIAN_RELEASE_KEY: another key file.
# The hashes come from the build machine, not from the release: only those installers get signed.
set -euo pipefail
TAG="${1:?usage: sign_win_sums.sh <tag> <sha256 from the Windows build>...}"
shift
[ "$#" -gt 0 ] || { echo "usage: sign_win_sums.sh <tag> <sha256 from the Windows build>..." >&2; exit 1; }
for want in "$@"; do
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || { echo "Not a sha256: $want" >&2; exit 1; }
done
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
REPO="${MERIDIAN_REPO:-Undermove/meridian-browser}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

gh release download "$TAG" -R "$REPO" -D "$TMP" -p SHA256SUMS-win.txt
# Every line "<sha256>  <file>", every file in the release and matching it: only what is really
# there gets the key's signature.
[ -s "$TMP/SHA256SUMS-win.txt" ] || { echo "SHA256SUMS-win.txt is empty" >&2; exit 1; }
while read -r sum name; do
  name="${name#\*}"
  [[ "$sum" =~ ^[0-9a-f]{64}$ && "$name" =~ ^Meridian-[0-9.]+-win-[a-z0-9]+-setup\.exe$ ]] || {
    echo "Not a checksum line for an installer: $sum $name" >&2; exit 1; }
  reported=0
  for want in "$@"; do [ "$want" = "$sum" ] && reported=1; done
  [ "$reported" = 1 ] || { echo "$name isn't the installer the Windows build reported: nothing signed." >&2; exit 1; }
  gh release download "$TAG" -R "$REPO" -D "$TMP" -p "$name"
  actual="$(shasum -a 256 "$TMP/$name" | cut -d' ' -f1)"
  [ "$actual" = "$sum" ] || { echo "$name in the release doesn't match SHA256SUMS-win.txt" >&2; exit 1; }
  echo "✔ $name matches"
done < "$TMP/SHA256SUMS-win.txt"

KEY_FILE="${MERIDIAN_RELEASE_KEY:-$HOME/.config/meridian/release-ed25519.pem}" \
SUMS="$TMP/SHA256SUMS-win.txt" HEADER="$DIR/src/chrome/browser/meridian/update_check.h" \
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
gh release upload "$TAG" -R "$REPO" --clobber "$TMP/SHA256SUMS-win.txt.sig"
echo "Signed and uploaded SHA256SUMS-win.txt.sig to $TAG"
