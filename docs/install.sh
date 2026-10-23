#!/usr/bin/env bash
# Meridian installer for macOS and Linux.
#
#   curl -fsSL https://undermove.github.io/meridian-browser/install.sh | bash
#
# Downloads the latest release from GitHub, checks it against the release's SHA256SUMS.txt and installs it:
#   macOS: /Applications/Meridian.app (or ~/Applications if /Applications isn't writable)
#   Linux: ~/.local/share/meridian/Meridian.AppImage, plus a menu entry
# Run it again any time to update. Nothing runs with sudo.

set -euo pipefail

REPO="Undermove/meridian-browser"
API="https://api.github.com/repos/$REPO/releases/latest"

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is needed."

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin)
    # An Intel shell on Apple silicon (Rosetta) still gets the native build.
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH=arm64; else ARCH=x64; fi
    PATTERN="-mac-$ARCH.zip" ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) PATTERN="-linux-x86_64.AppImage" ;;
      aarch64|arm64) PATTERN="-linux-arm64.AppImage" ;;
      *) fail "No Meridian build for $ARCH yet." ;;
    esac ;;
  *) fail "This installer is for macOS and Linux. On Windows, download the .exe from https://github.com/$REPO/releases/latest" ;;
esac

say "Looking up the latest Meridian release…"
RELEASE="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || fail "Couldn't reach GitHub. Check your internet connection and try again."
URL="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*'"$PATTERN"'"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
SUMS_URL="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*SHA256SUMS.txt"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$URL" ] || fail "Couldn't find a download for your computer ($PATTERN) in the latest release."
FILE="${URL##*/}"
VERSION="$(printf '%s' "$FILE" | sed -E 's/^Meridian-([0-9][^-]*)-.*/\1/')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading Meridian $VERSION ($FILE)…"
curl -fL --progress-bar -o "$TMP/$FILE" "$URL" || fail "Download failed."

if [ -n "$SUMS_URL" ]; then
  curl -fsSL -o "$TMP/SHA256SUMS.txt" "$SUMS_URL" || fail "Couldn't download the checksums."
  EXPECTED="$(grep " $FILE\$" "$TMP/SHA256SUMS.txt" | awk '{print $1}')"
  [ -n "$EXPECTED" ] || fail "$FILE isn't listed in SHA256SUMS.txt."
  if command -v shasum >/dev/null; then ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')"; else ACTUAL="$(sha256sum "$TMP/$FILE" | awk '{print $1}')"; fi
  [ "$EXPECTED" = "$ACTUAL" ] || fail "Checksum mismatch: the download is damaged or was tampered with. Nothing was installed."
  say "Checksum OK."
fi

if [ "$OS" = "Darwin" ]; then
  DEST="${MERIDIAN_INSTALL_DIR:-/Applications}"
  [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
  if [ -z "${MERIDIAN_NO_OPEN:-}" ] && pgrep -xq Meridian; then
    say "Closing Meridian to update it (your tabs come back)…"
    osascript -e 'quit app "Meridian"' >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq Meridian || break; sleep 1; done
  fi
  ditto -x -k "$TMP/$FILE" "$TMP/app"
  [ -d "$TMP/app/Meridian.app" ] || fail "The download doesn't contain Meridian.app."
  rm -rf "$DEST/Meridian.app"
  mv "$TMP/app/Meridian.app" "$DEST/"
  # Files fetched with curl aren't quarantined, but clear the flag in case something added it.
  xattr -dr com.apple.quarantine "$DEST/Meridian.app" 2>/dev/null || true
  say "Installed Meridian $VERSION to $DEST. Opening it…"
  [ -n "${MERIDIAN_NO_OPEN:-}" ] || open "$DEST/Meridian.app"
else
  DIR="$HOME/.local/share/meridian"
  mkdir -p "$DIR" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
  mv "$TMP/$FILE" "$DIR/Meridian.AppImage"
  chmod +x "$DIR/Meridian.AppImage"
  curl -fsSL -o "$HOME/.local/share/icons/hicolor/512x512/apps/meridian.png" \
    "https://raw.githubusercontent.com/$REPO/main/build/icon-1024.png" 2>/dev/null || true
  cat > "$HOME/.local/share/applications/meridian.desktop" <<EOF
[Desktop Entry]
Name=Meridian
Comment=The open-source Arc browser alternative
Exec="$DIR/Meridian.AppImage" %U
Icon=meridian
Type=Application
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
StartupWMClass=Meridian
EOF
  command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
  say "Installed Meridian $VERSION. Find it in your app menu, or run: $DIR/Meridian.AppImage"
  if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
    say "If it doesn't start, install FUSE 2 (Ubuntu: sudo apt install libfuse2t64, older: libfuse2)."
  fi
  ( "$DIR/Meridian.AppImage" >/dev/null 2>&1 & ) || true
fi
