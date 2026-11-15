#!/bin/bash
# Ad and tracker blocking rules for the app: EasyList + EasyPrivacy, converted to
# Chromium's subresource filter format and put with the build's resources
# (Meridian.app/Contents/Resources on macOS, next to the executable elsewhere).
#   chromium/tools/adblock.sh [out_dir]      (default: out/Release)
# EasyList and EasyPrivacy are by The EasyList authors (https://easylist.to),
# dual licensed GPLv3 / CC BY-SA 3.0.
set -euo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
. "$(dirname "$0")/platform.sh"
OUT="$DIR/src/${1:-out/Release}"
command -v autoninja >/dev/null 2>&1 || export PATH="$DIR/depot_tools:$PATH"
autoninja -C "$OUT" ruleset_converter >/dev/null
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/easylist.txt" https://easylist.to/easylist/easylist.txt
curl -fsSL -o "$TMP/easyprivacy.txt" https://easylist.to/easylist/easyprivacy.txt
# Network rules only: Chromium's indexer trips over some of EasyList's element
# hiding (CSS) rules.
"$OUT/ruleset_converter" --input_format=filter-list --output_format=unindexed-ruleset \
  --input_files="$TMP/easylist.txt,$TMP/easyprivacy.txt" --output_file_url="$TMP/meridian_adblock.dat" 2>/dev/null
RES="$(meridian_resources "$OUT")"
cp "$TMP/meridian_adblock.dat" "$RES/meridian_adblock.dat"
echo "ruleset: $(du -h "$RES/meridian_adblock.dat" | cut -f1)"
