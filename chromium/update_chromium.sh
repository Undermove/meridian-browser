#!/bin/bash
# Moves Meridian to the newest Chromium of its branch (or to another branch), then builds, tests,
# packages (signed) and drafts a GitHub release for the next version. Stops at the first problem
# (a patch that no longer applies, a failing test), leaving everything as it was before.
#   chromium/update_chromium.sh                    newest build of the current branch
#   chromium/update_chromium.sh --branch 8160      move to branch 8160 (a new Chrome milestone)
#   options: --version 0.5.2 (default: the next patch version), --no-release (stop after packaging)
set -Eeuo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
export PATH="$DIR/depot_tools:$PATH"
SRC="$DIR/src"
BRANCH=""; VERSION=""; RELEASE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --no-release) RELEASE=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

OLD_REV="$(cat "$HERE/CHROMIUM_REVISION")"
OLD_VER="$(cat "$HERE/CHROMIUM_VERSION")"
[ -n "$BRANCH" ] || BRANCH="$(echo "$OLD_VER" | cut -d. -f3)"
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { echo "Chromium's src has uncommitted changes" >&2; exit 1; }
[ "$(git -C "$SRC" rev-parse --abbrev-ref HEAD)" = meridian ] || { echo "src isn't on the meridian branch" >&2; exit 1; }

say "Fetching branch $BRANCH…"
git -C "$SRC" fetch -q origin "+refs/branch-heads/$BRANCH:refs/remotes/branch-heads/$BRANCH"
NEW_REV="$(git -C "$SRC" rev-parse "branch-heads/$BRANCH")"
NEW_VER="$(git -C "$SRC" show "$NEW_REV:chrome/VERSION" | sed -n 's/^.*=//p' | paste -sd. -)"
if [ "$NEW_REV" = "$OLD_REV" ]; then say "Already on $NEW_VER ($BRANCH)."; exit 0; fi
say "Chromium $OLD_VER → $NEW_VER"

BACKUP="backup/meridian-$(date +%Y%m%d-%H%M%S)"
git -C "$SRC" branch "$BACKUP" meridian
restore() {
  echo "Stopped. Putting src back on $BACKUP." >&2
  git -C "$SRC" rebase --abort 2>/dev/null || true
  git -C "$SRC" checkout -q -B meridian "$BACKUP"
}
trap restore ERR

say "Moving the Meridian patches…"
git -C "$SRC" rebase -q --onto "$NEW_REV" "$OLD_REV" meridian

say "Dependencies (V8, Skia, …)…"
# Detached, so gclient doesn't try to rebase the meridian branch itself.
git -C "$SRC" checkout -q --detach meridian
(cd "$DIR" && gclient sync -D --no-history --nohooks --revision "src@$(git -C "$SRC" rev-parse HEAD)" >/dev/null)
git -C "$SRC" checkout -q meridian
(cd "$DIR" && gclient runhooks >/dev/null)

if [ -z "$VERSION" ]; then
  CUR="$(sed -n 's/.*kVersion\[\] = "\(.*\)";/\1/p' "$SRC/chrome/browser/meridian/update_check.h")"
  VERSION="$(echo "$CUR" | awk -F. '{print $1"."$2"."$3+1}')"
fi
say "Meridian $VERSION"
sed -i '' "s/inline constexpr char kVersion\[\] = \".*\";/inline constexpr char kVersion[] = \"$VERSION\";/" \
  "$SRC/chrome/browser/meridian/update_check.h"
git -C "$SRC" commit -q -am "Meridian: version $VERSION (Chromium $NEW_VER)"

say "Building (long after a branch change)…"
caffeinate -i "$HERE/build.sh" >/dev/null
(cd "$SRC" && autoninja -C out/Release meridian_unittests >/dev/null)

say "Tests…"
"$HERE/tests/run.sh"

trap - ERR
echo "$NEW_REV" > "$HERE/CHROMIUM_REVISION"
echo "$NEW_VER" > "$HERE/CHROMIUM_VERSION"
"$HERE/export.sh" >/dev/null
say "Packaging (signed)…"
"$HERE/package.sh"
git -C "$REPO_ROOT" add -A chromium
git -C "$REPO_ROOT" commit -q -m "Chromium port: Chromium $NEW_VER, Meridian $VERSION"
git -C "$REPO_ROOT" push -q origin HEAD

if [ "$RELEASE" = 1 ]; then
  say "Drafting the release (publish it on GitHub when you're happy)…"
  D="$HERE/dist"
  gh release create "v$VERSION" -R Undermove/meridian-browser --draft \
    --target "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)" --title "Meridian $VERSION" \
    --notes "Chromium $NEW_VER (from $OLD_VER): the latest fixes from Chrome, including security fixes." \
    "$D/Meridian-$VERSION-mac-"*.dmg "$D/Meridian-$VERSION-mac-"*.zip "$D/SHA256SUMS.txt" "$D/SHA256SUMS.txt.sig"
fi
say "Done: Meridian $VERSION on Chromium $NEW_VER."
