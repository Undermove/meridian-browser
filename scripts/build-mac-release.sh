#!/usr/bin/env bash
# macOS release build (CI): every build is signed with the same "Meridian Signing" certificate, so the
# Keychain's "Always Allow" survives updates (ad-hoc signatures change with every build, and macOS then asks
# again). Without the certificate (forks, local runs without secrets) it falls back to an ad-hoc build.
#   env: MAC_SIGN_P12 (base64 .p12), MAC_SIGN_P12_PASSWORD
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${MAC_SIGN_P12:-}" ]; then
  echo "No signing certificate: ad-hoc build."
  exec npx electron-builder --mac --publish never
fi
KC="$RUNNER_TEMP/meridian-sign.keychain-db"
KPW="$(openssl rand -hex 16)"
printf '%s' "$MAC_SIGN_P12" | base64 --decode > "$RUNNER_TEMP/id.p12"
security create-keychain -p "$KPW" "$KC"
security set-keychain-settings -lut 3600 "$KC"
security unlock-keychain -p "$KPW" "$KC"
security import "$RUNNER_TEMP/id.p12" -k "$KC" -P "$MAC_SIGN_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KPW" "$KC" >/dev/null
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
rm -f "$RUNNER_TEMP/id.p12"
for arch in arm64 x64; do
  npx electron-builder --mac dir --$arch --publish never
  app=dist/mac-arm64/Meridian.app; [ "$arch" = x64 ] && app=dist/mac/Meridian.app
  scripts/sign-local.sh "$app"
  # Package the signed app as-is (identity null: don't re-sign).
  npx electron-builder --mac dmg zip --$arch --prepackaged "$app" -c.mac.identity=null --publish never
done
