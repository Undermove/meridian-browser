#!/bin/bash
# Sourced by the chromium/ scripts: what differs between macOS, Linux and Windows (Git Bash).
#   MERIDIAN_OS            mac | linux | win
#   meridian_resources D   where the build in D keeps Meridian's own data files (ad blocking rules,
#                          the Workbench page): inside the app bundle on macOS, next to the
#                          executable elsewhere (as the C++ side looks them up)
#   meridian_binary D      the browser executable of the build in D
#   keep_awake CMD…        runs CMD, keeping a Mac from sleeping meanwhile
#   sed_inplace EXPR FILE  sed -i, which BSD and GNU sed spell differently
case "$(uname -s)" in
  Darwin) MERIDIAN_OS=mac ;;
  Linux) MERIDIAN_OS=linux ;;
  MINGW*|MSYS*|CYGWIN*) MERIDIAN_OS=win ;;
  *) echo "Unsupported system: $(uname -s)" >&2; exit 1 ;;
esac

meridian_resources() {
  if [ "$MERIDIAN_OS" = mac ]; then echo "$1/Meridian.app/Contents/Resources"; else echo "$1"; fi
}

meridian_binary() {
  case "$MERIDIAN_OS" in
    mac) echo "$1/Meridian.app/Contents/MacOS/Meridian" ;;
    linux) echo "$1/chrome" ;;
    win) echo "$1/chrome.exe" ;;
  esac
}

keep_awake() {
  if command -v caffeinate >/dev/null 2>&1; then caffeinate -i "$@"; else "$@"; fi
}

sed_inplace() {
  if [ "$MERIDIAN_OS" = mac ]; then sed -i '' "$1" "$2"; else sed -i "$1" "$2"; fi
}
