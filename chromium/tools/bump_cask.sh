#!/bin/bash
# Points the Homebrew cask (github.com/Undermove/homebrew-tap, Casks/meridian.rb) at a published release.
#   chromium/tools/bump_cask.sh <version>     e.g. 1.4.0 or v1.4.0
# Run it after the release is published (not while it's a draft): it downloads that release's
# Meridian-<version>-mac-arm64.dmg, hashes it, checks the hash against the release's SHA256SUMS.txt,
# sets version and sha256 in the cask, commits and pushes to the tap's main branch.
# The tap also bumps itself once a day (.github/workflows/bump.yml there), so a forgotten run only
# delays `brew install` by a day.
set -euo pipefail

REPO=Undermove/meridian-browser
TAP=Undermove/homebrew-tap
CASK=Casks/meridian.rb

[ $# -eq 1 ] || { echo "usage: $0 <version>" >&2; exit 2; }
ver="${1#v}"
[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a version: $1" >&2; exit 2; }
command -v gh >/dev/null || { echo "needs the GitHub CLI (gh)" >&2; exit 1; }

# The release must be published: the tags endpoint doesn't return drafts.
draft="$(gh api "repos/$REPO/releases/tags/v$ver" --jq '.draft' 2>/dev/null || true)"
[ "$draft" = "false" ] || { echo "v$ver is not a published release of $REPO" >&2; exit 1; }

work="$(mktemp -d "${TMPDIR:-/tmp}/meridian-cask.XXXXXX")"
trap 'rm -rf "$work"' EXIT

dmg="Meridian-$ver-mac-arm64.dmg"
gh release download "v$ver" -R "$REPO" -p "$dmg" -p SHA256SUMS.txt -D "$work/dl" \
  || { echo "could not download $dmg from v$ver" >&2; exit 1; }
[ -s "$work/dl/$dmg" ] || { echo "$dmg is missing from v$ver" >&2; exit 1; }
sha="$(shasum -a 256 "$work/dl/$dmg" | cut -d' ' -f1)"
if [ -s "$work/dl/SHA256SUMS.txt" ]; then
  listed="$(awk -v f="$dmg" '$2 == f || $2 == "*"f {print $1}' "$work/dl/SHA256SUMS.txt")"
  if [ -n "$listed" ] && [ "$listed" != "$sha" ]; then
    echo "sha256 mismatch: $dmg is $sha, SHA256SUMS.txt says $listed" >&2; exit 1
  fi
fi

gh repo clone "$TAP" "$work/tap" -- -q
cd "$work/tap"
cur="$(sed -nE 's/^  version "([^"]+)"$/\1/p' "$CASK")"
if [ "$cur" = "$ver" ] && grep -q "^  sha256 \"$sha\"$" "$CASK"; then
  echo "cask is already at $ver"; exit 0
fi
newest="$(printf '%s\n%s\n' "$cur" "$ver" | sort -V | tail -n1)"
[ "$newest" = "$ver" ] || { echo "cask is at $cur, newer than $ver: not going back" >&2; exit 1; }

sed -i '' -E "s/^  version \"[^\"]+\"$/  version \"$ver\"/" "$CASK"
sed -i '' -E "s/^  sha256 \"[0-9a-f]+\"$/  sha256 \"$sha\"/" "$CASK"
# shellcheck disable=SC2015 # fails when either grep does
grep -q "^  version \"$ver\"$" "$CASK" && grep -q "^  sha256 \"$sha\"$" "$CASK" \
  || { echo "could not update $CASK" >&2; exit 1; }

git add "$CASK"
git commit -q -m "meridian $ver"
git push -q origin HEAD:main
echo "cask: $cur -> $ver ($sha)"
