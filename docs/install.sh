#!/usr/bin/env bash
# Meridian installer for macOS and Linux.
#
#   curl -fsSL https://meridianbrowser.app/install.sh | bash
#
# Downloads the latest release from GitHub, checks it against the release's signed SHA256SUMS.txt and installs it:
#   macOS: /Applications/Meridian.app (or ~/Applications if /Applications isn't writable)
#   Linux: ~/.local/share/meridian/Meridian.AppImage, plus a menu entry
# Run it again any time to update. Nothing runs with sudo.

set -euo pipefail

REPO="Undermove/meridian-browser"
# MERIDIAN_RELEASE_API: another release feed (tests).
API="${MERIDIAN_RELEASE_API:-https://api.github.com/repos/$REPO/releases/latest}"

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is needed."

# The public half of Meridian's release key, the same one the in-app updater has built in.
RELEASE_KEY="E81BNuBRDek4M67kA4CrZJZ52HG4UhmiHy3zIM8XxbY="
RELEASE_KEY_DER="MCowBQYDK2VwAyEAE81BNuBRDek4M67kA4CrZJZ52HG4UhmiHy3zIM8XxbY="

# Is $1 (SHA256SUMS.txt) signed by the release key, with $2 (its .sig)? macOS's own openssl has no
# Ed25519, so there the check runs in the JavaScript that comes with the system.
verify_signature() {
  local sums="$1" sig="$2" work="$TMP/verify"
  mkdir -p "$work"
  base64 --decode < "$sig" > "$work/sig.bin" 2>/dev/null || return 1
  [ "$(wc -c < "$work/sig.bin" | tr -d ' ')" = 64 ] || return 1
  if [ "$OS" != "Darwin" ]; then
    command -v openssl >/dev/null || fail "openssl is needed to check the download's signature."
    printf '%s' "$RELEASE_KEY_DER" | base64 --decode > "$work/key.der"
    openssl pkeyutl -verify -pubin -keyform DER -inkey "$work/key.der" -rawin -in "$sums" -sigfile "$work/sig.bin" >/dev/null 2>&1
    return
  fi
  printf '%s' "$RELEASE_KEY" | base64 --decode > "$work/key.bin"
  local hash sig_hex key_hex
  hash="$( { head -c 32 "$work/sig.bin"; cat "$work/key.bin" "$sums"; } | /usr/bin/openssl dgst -sha512 -binary | od -An -v -tx1 | tr -d ' \n')"
  sig_hex="$(od -An -v -tx1 "$work/sig.bin" | tr -d ' \n')"
  key_hex="$(od -An -v -tx1 "$work/key.bin" | tr -d ' \n')"
  cat > "$work/verify.js" <<'JS'
function run(argv) {
  const P = (1n << 255n) - 19n, L = (1n << 252n) + 27742317777372353535851937790883648493n;
  const mod = (a, m = P) => { a %= m; return a < 0n ? a + m : a; };
  const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; };
  const inv = (a) => pow(a, P - 2n);
  const D = mod(-121665n * inv(121666n)), I = pow(2n, (P - 1n) / 4n);
  const le = (hex) => BigInt('0x' + hex.match(/../g).reverse().join(''));
  const add = ([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) => {
    const A = mod((Y1 - X1) * (Y2 - X2)), B = mod((Y1 + X1) * (Y2 + X2)), C = mod(2n * T1 * D * T2), E2 = mod(2n * Z1 * Z2);
    const E = B - A, F = E2 - C, G = E2 + C, H = B + A;
    return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
  };
  const mul = (p, n) => { let r = [0n, 1n, 1n, 0n]; while (n > 0n) { if (n & 1n) r = add(r, p); p = add(p, p); n >>= 1n; } return r; };
  const point = (hex) => {
    const n = le(hex), sign = n >> 255n, y = n & ((1n << 255n) - 1n);
    if (y >= P) return null;
    const y2 = y * y % P, u = mod(y2 - 1n), v = mod(D * y2 + 1n), v3 = v * v * v % P;
    let x = u * v3 % P * pow(u * (v3 * v3 % P * v % P) % P, (P - 5n) / 8n) % P;
    const vx2 = v * x * x % P;
    if (vx2 !== u) { if (vx2 !== mod(-u)) return null; x = x * I % P; }
    if (x === 0n && sign === 1n) return null;
    if ((x & 1n) !== sign) x = P - x;
    return [x, y, 1n, x * y % P];
  };
  const [sig, key, hash] = argv;
  const S = le(sig.slice(64));
  const R = point(sig.slice(0, 64)), A = point(key);
  const G = point('58' + '66'.repeat(31));
  if (S >= L || !R || !A) return 'bad';
  const left = mul(G, S), right = add(R, mul(A, mod(le(hash), L)));
  return mod(left[0] * right[2] - right[0] * left[2]) === 0n && mod(left[1] * right[2] - right[1] * left[2]) === 0n ? 'ok' : 'bad';
}
JS
  [ "$(/usr/bin/osascript -l JavaScript "$work/verify.js" "$sig_hex" "$key_hex" "$hash" 2>/dev/null)" = ok ]
}

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
    esac
    # Meridian 0.5+ (built on Chromium) is macOS-only for now.
    printf '%s' "$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null)" | grep -q -- "$PATTERN" ||
      fail "Meridian for Linux isn't out yet: the current release is macOS-only. Linux comes later." ;;
  *) fail "This installer is for macOS and Linux. On Windows, download the .exe from https://github.com/$REPO/releases/latest" ;;
esac

say "Looking up the latest Meridian release…"
RELEASE="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" || fail "Couldn't reach GitHub. Check your internet connection and try again."
URL="$(printf '%s' "$RELEASE" | grep -o '"browser_download_url": *"[^"]*/Meridian-[0-9][^"/]*'"$PATTERN"'"' | head -1 | sed 's/.*"\(http[^"]*\)"/\1/')"
SUMS_URL="$(printf '%s' "$RELEASE" | { grep -o '"browser_download_url": *"[^"]*SHA256SUMS.txt"' || true; } | head -1 | sed 's/.*"\(http[^"]*\)"/\1/')"
SIG_URL="$(printf '%s' "$RELEASE" | { grep -o '"browser_download_url": *"[^"]*SHA256SUMS.txt.sig"' || true; } | head -1 | sed 's/.*"\(http[^"]*\)"/\1/')"
[ -n "$URL" ] || fail "Couldn't find a download for your computer ($PATTERN) in the latest release."
FILE="${URL##*/}"
VERSION="$(printf '%s' "$FILE" | sed -E 's/^Meridian-([0-9][^-]*)-.*/\1/')"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading Meridian $VERSION ($FILE)…"
curl -fL --progress-bar -o "$TMP/$FILE" "$URL" || fail "Download failed."

[ -n "$SUMS_URL" ] && [ -n "$SIG_URL" ] || fail "This release has no signed checksums. Nothing was installed."
curl -fsSL -o "$TMP/SHA256SUMS.txt" "$SUMS_URL" || fail "Couldn't download the checksums."
curl -fsSL -o "$TMP/SHA256SUMS.txt.sig" "$SIG_URL" || fail "Couldn't download the checksums' signature."
verify_signature "$TMP/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt.sig" || fail "The release's signature isn't Meridian's. Nothing was installed."
EXPECTED="$(awk -v f="$FILE" '$2 == f {print $1; exit}' "$TMP/SHA256SUMS.txt")"
[ -n "$EXPECTED" ] || fail "$FILE isn't listed in SHA256SUMS.txt."
if command -v shasum >/dev/null; then ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')"; else ACTUAL="$(sha256sum "$TMP/$FILE" | awk '{print $1}')"; fi
[ "$EXPECTED" = "$ACTUAL" ] || fail "Checksum mismatch: the download is damaged or was tampered with. Nothing was installed."
say "Signature and checksum OK."

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
  codesign --verify --deep --strict "$TMP/app/Meridian.app" 2>/dev/null || fail "The download's signature is broken. Nothing was installed."
  rm -rf "$DEST/Meridian.app"
  mv "$TMP/app/Meridian.app" "$DEST/"
  # Files fetched with curl aren't quarantined, but clear the flag in case something added it.
  xattr -dr com.apple.quarantine "$DEST/Meridian.app" 2>/dev/null || true
  # Opened while the screen is locked, Meridian can't read its keychain key (your saved sign-ins), so
  # it would only ask for a restart: leave the opening to you.
  if ioreg -n Root -d1 2>/dev/null | grep -q '"CGSSessionScreenIsLocked" = Yes'; then
    say "Installed Meridian $VERSION to $DEST. Your screen is locked, so it isn't opened: open it when you're back."
  else
    say "Installed Meridian $VERSION to $DEST. Opening it…"
    [ -n "${MERIDIAN_NO_OPEN:-}" ] || open "$DEST/Meridian.app"
  fi
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
