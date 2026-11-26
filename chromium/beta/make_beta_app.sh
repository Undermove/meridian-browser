#!/bin/bash
# Makes "Meridian Beta.app" from out/Release/Meridian.app and (with --install) puts it in
# ~/Applications. Never touches /Applications/Meridian.app or the main profile.
#   make_beta_app.sh <repo-with-workbench-assets> [--install]
set -euo pipefail
REPO="$1"; INSTALL="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HOME/repos/chromium/src/out/Release/Meridian.app"
CR="$HOME/repos/chromium/src"
STAGE="$HERE/stage"
APP="$STAGE/Meridian Beta.app"
DEST="$HOME/Applications/Meridian Beta.app"
ID="Developer ID Application: Dmitrii Afonchenko (323MYL73WD)"
TEAM=323MYL73WD
PL="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy

rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto "$SRC" "$APP"

# Workbench assets from the integrated repo (never a plain copy: bridge.js must be in the page).
bash "$REPO/chromium/tools/workbench_assets.sh" "$APP/Contents/Resources/workbench"
n="$(grep -c 'bridge.js' "$APP/Contents/Resources/workbench/workbench.html")"
[ "$n" = 1 ] || { echo "workbench.html has bridge.js $n times" >&2; exit 1; }

# Identity: its own bundle id, name, profile folder; the beta switch (beta.h).
$PB -c "Set :CFBundleIdentifier dev.meridian.browser.beta" "$PL"
$PB -c "Set :CFBundleName Meridian Beta" "$PL"
$PB -c "Set :CFBundleDisplayName Meridian Beta" "$PL"
$PB -c "Delete :LSHasLocalizedDisplayName" "$PL" 2>/dev/null || true
$PB -c "Delete :CrProductDirName" "$PL" 2>/dev/null || true
$PB -c "Add :CrProductDirName string Meridian Beta" "$PL"
$PB -c "Delete :MeridianBeta" "$PL" 2>/dev/null || true
$PB -c "Add :MeridianBeta bool true" "$PL"
# The icon: app.icns (tinted, BETA badge) instead of the asset catalog's.
$PB -c "Delete :CFBundleIconName" "$PL" 2>/dev/null || true
cp "$HERE/beta.icns" "$APP/Contents/Resources/app.icns"
# Updater / Sparkle-style keys, if any, out.
for k in SUFeedURL KSProductID KSUpdateURL; do $PB -c "Delete :$k" "$PL" 2>/dev/null || true; done
VERSION="$(sed -n 's/.*kVersion\[\] = "\(.*\)";/\1/p' "$CR/chrome/browser/meridian/update_check.h")"
printf '%s\n' "$VERSION" > "$APP/Contents/Resources/meridian-version"
cp "$HERE/refresh-data.command" "$APP/Contents/Resources/refresh-data.command"

# Signing, inside out, as package.sh does (hardened runtime; JIT for renderer/GPU helpers).
ent="$STAGE/entitlements"; mkdir -p "$ent"
fw="$APP/Contents/Frameworks/Meridian Framework.framework"
ver="$(find "$fw/Versions" -mindepth 1 -maxdepth 1 ! -name Current -exec basename {} \; | head -1)"
vd="$fw/Versions/$ver"
cp "$CR/chrome/app/app-entitlements.plist" "$ent/app.plist"
cp "$CR/chrome/app/helper-renderer-entitlements.plist" "$ent/jit.plist"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n' > "$ent/plain.plist"
cs=(codesign --force --timestamp=none -s "$ID")
for lib in "$vd"/Libraries/*.dylib; do "${cs[@]}" "$lib"; done
for tool in chrome_crashpad_handler app_mode_loader web_app_shortcut_copier; do
  [ -e "$vd/Helpers/$tool" ] && "${cs[@]}" --options runtime --entitlements "$ent/plain.plist" "$vd/Helpers/$tool"
done
for helper in "$vd"/Helpers/*.app; do
  case "$(basename "$helper")" in
    *Renderer*|*GPU*) "${cs[@]}" --options restrict,kill,runtime --entitlements "$ent/jit.plist" "$helper" ;;
    *) "${cs[@]}" --options runtime --entitlements "$ent/plain.plist" "$helper" ;;
  esac
done
"${cs[@]}" "$vd"
"${cs[@]}" --options runtime --entitlements "$ent/app.plist" "$APP"
codesign --verify --deep --strict "$APP"
echo "Signed: $(codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|TeamIdentifier)=' | tr '\n' ' ')"
spctl -a -vv "$APP" 2>&1 | head -3 || true

if [ "$INSTALL" = "--install" ]; then
  if ps -axo args= | grep -F "Meridian Beta.app/Contents/MacOS/Meridian" | grep -vq grep; then
    echo "Meridian Beta is running: not replacing it." >&2; exit 1
  fi
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  ditto "$APP" "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST"
  cp "$HERE/refresh-data.command" "$HOME/Applications/Обновить данные из Meridian.command"
  chmod +x "$HOME/Applications/Обновить данные из Meridian.command"
  echo "Installed: $DEST"
fi
