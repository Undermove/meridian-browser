#!/bin/bash
# Rebuilds the Meridian WebUI sources (chrome/browser/resources/webui_browser/meridian: the
# sidebar, command bar, Workbench and settings TypeScript) from chromium/patches without a
# Chromium checkout, so code scanning can read them. Only the files the patches create are
# rebuilt; edits to upstream Chromium files need the checkout and are left out.
# Usage: extract_webui_sources.sh <dest>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$1"
rm -rf "$dest"
mkdir -p "$dest"
git -C "$dest" init -q
for p in "$here"/patches/*.patch; do
  git -C "$dest" apply --whitespace=nowarn --include='chrome/browser/resources/webui_browser/meridian/*' "$p"
done
rm -rf "$dest/.git"
echo "$(find "$dest" -type f | wc -l | tr -d ' ') files in $dest"
