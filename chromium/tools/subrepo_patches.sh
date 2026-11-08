#!/bin/bash
# Meridian's patches to Chromium's own git dependencies (FFmpeg, which Meridian ships without its
# H.264 and AAC decoders): patches/<path>/*.patch, on a `meridian` branch of that dependency at the
# revision Chromium's DEPS pins.
#   tools/subrepo_patches.sh apply    after gclient sync (apply.sh, update_chromium.sh)
#   tools/subrepo_patches.sh export   after committing on that branch (export.sh)
#   tools/subrepo_patches.sh detach   before gclient sync, so it doesn't rebase the branch
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
export PATH="$DIR/depot_tools:$PATH"
cd "$DIR/src"
SUBREPOS=(third_party/ffmpeg)
for sub in "${SUBREPOS[@]}"; do
  case "$1" in
    apply)
      base="$(gclient getdep -r "src/$sub")"
      git -C "$sub" checkout -q -B meridian "$base"
      git -C "$sub" -c user.email=meridian@localhost -c user.name=Meridian am -q --3way "$HERE/patches/$sub"/*.patch
      echo "Applied $(ls "$HERE/patches/$sub"/*.patch | wc -l | tr -d ' ') patches to $sub." ;;
    export)
      base="$(gclient getdep -r "src/$sub")"
      mkdir -p "$HERE/patches/$sub"
      rm -f "$HERE/patches/$sub"/*.patch
      git -C "$sub" format-patch -q --no-signature --zero-commit -o "$HERE/patches/$sub" "$base..meridian" ;;
    detach)
      git -C "$sub" checkout -q --detach ;;
    *) echo "usage: $0 apply|export|detach" >&2; exit 2 ;;
  esac
done
