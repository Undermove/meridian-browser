#!/bin/bash
# Generated branding, kept out of patches/ because it is large: product strings in all 81 languages
# ("Chromium" -> "Meridian", translations re-keyed) and the app icons made from build/icon-1024.png.
# apply.sh runs this and commits the result as "Meridian (generated): ..."; export.sh skips that commit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
cd "${CHROMIUM_DIR:-$HOME/repos/chromium}/src"
python3 "$HERE/tools/rebrand_strings.py"
SRC="$REPO/build/icon-1024.png"; T=chrome/app/theme/chromium
for n in 16 32 64 128 256 512 1024; do sips -z $n $n "$SRC" --out $T/mac/Assets.xcassets/AppIcon.appiconset/appicon_$n.png >/dev/null; done
for f in $T/mac/Assets.xcassets/Icon.iconset/*.png; do
  sz=$(sips -g pixelWidth "$f" | awk '/pixelWidth/{print $2}'); sips -z "$sz" "$sz" "$SRC" --out "$f" >/dev/null
done
for n in 16 24 48 64 128 256; do sips -z $n $n "$SRC" --out $T/product_logo_$n.png >/dev/null; done
cp "$REPO/build/icon.icns" $T/mac/app.icns
cp "$REPO/build/icon.svg" $T/product_logo.svg
OUT="$(mktemp -d)"
xcrun actool --compile "$OUT" --platform macosx --minimum-deployment-target 12.0 --app-icon AppIcon \
  --output-partial-info-plist "$OUT/partial.plist" $T/mac/Assets.xcassets >/dev/null
cp "$OUT/Assets.car" $T/mac/Assets.car && rm -rf "$OUT"
echo "Generated strings and icons."
