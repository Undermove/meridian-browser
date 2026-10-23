#!/usr/bin/env bash
# Re-sign a local macOS build with a stable self-signed identity ("Meridian Signing", shared with the release builds), so the
# Keychain's "Always Allow" for "Meridian Safe Storage" survives rebuilds. Ad-hoc builds are identified
# by their code hash, which changes on every build, so macOS asks again each time.
#   Create the identity once: Keychain Access → Certificate Assistant → Create a Certificate…
#   (Name: Meridian Local Signing, Type: Code Signing), or see the README.
# Usage: scripts/sign-local.sh [path/to/Meridian.app]
set -euo pipefail
APP="${1:-dist-next/mac-arm64/Meridian.app}"
ID="${MERIDIAN_SIGN_ID:-Meridian Signing}"
if ! security find-identity -p codesigning | grep -q "\"$ID\""; then
  echo "No \"$ID\" code-signing identity in your keychain; leaving the ad-hoc signature." >&2
  exit 0
fi
ENT="$(dirname "$0")/../node_modules/app-builder-lib/templates/entitlements.mac.plist"
codesign --force --deep --options runtime --entitlements "$ENT" -s "$ID" "$APP"
codesign -v --deep "$APP"
echo "Signed $APP with \"$ID\": $(codesign -d -r- "$APP" 2>&1 | tail -1)"
