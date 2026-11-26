#!/bin/bash
# Moves Meridian to the newest Chromium of its branch (or to another branch), then builds, tests
# and packages (signed) the next version, and opens a pull request to main with it: the patches on
# a new branch chromium-<Chromium version>. Never a push to main, never a release: the release is
# made from main after the PR is reviewed and merged (chromium/RELEASE_CHECKLIST.md). Stops at the
# first problem (a patch that no longer applies, a failing test), leaving everything as it was.
#   chromium/update_chromium.sh                    newest build of the current branch
#   chromium/update_chromium.sh --branch 8160      move to branch 8160 (a new Chrome milestone)
#   options: --version 0.5.2 (default: the next patch version), --no-pr (stop after packaging,
#   committed on the new branch but not pushed)
set -Eeuo pipefail
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
. "$HERE/tools/platform.sh"
command -v gclient >/dev/null 2>&1 || export PATH="$DIR/depot_tools:$PATH"
SRC="$DIR/src"
BRANCH=""; VERSION=""; PR=1
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --no-pr) PR=0; shift ;;
    # (The old option: there is no release to skip any more.)
    --no-release) shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

OLD_REV="$(cat "$HERE/CHROMIUM_REVISION")"
OLD_VER="$(cat "$HERE/CHROMIUM_VERSION")"
[ -n "$BRANCH" ] || BRANCH="$(echo "$OLD_VER" | cut -d. -f3)"
# (FFmpeg on its own meridian branch, tools/subrepo_patches.sh, isn't a change to src.)
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no --ignore-submodules=all)" ] || { echo "Chromium's src has uncommitted changes" >&2; exit 1; }
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
"$HERE/tools/subrepo_patches.sh" detach
(cd "$DIR" && gclient sync -D --no-history --nohooks --revision "src@$(git -C "$SRC" rev-parse HEAD)" >/dev/null)
git -C "$SRC" checkout -q meridian
"$HERE/tools/subrepo_patches.sh" apply >/dev/null
(cd "$DIR" && gclient runhooks >/dev/null)

if [ -z "$VERSION" ]; then
  CUR="$(sed -n 's/.*kVersion\[\] = "\(.*\)";/\1/p' "$SRC/chrome/browser/meridian/update_check.h")"
  VERSION="$(echo "$CUR" | awk -F. '{print $1"."$2"."$3+1}')"
fi
say "Meridian $VERSION"
sed_inplace "s/inline constexpr char kVersion\[\] = \".*\";/inline constexpr char kVersion[] = \"$VERSION\";/" \
  "$SRC/chrome/browser/meridian/update_check.h"
git -C "$SRC" commit -q -am "Meridian: version $VERSION (Chromium $NEW_VER)"

say "Building (long after a branch change)…"
keep_awake "$HERE/build.sh" >/dev/null
(cd "$SRC" && autoninja -C out/Release meridian_unittests >/dev/null)

say "Tests…"
"$HERE/tests/run.sh"

trap - ERR
echo "$NEW_REV" > "$HERE/CHROMIUM_REVISION"
echo "$NEW_VER" > "$HERE/CHROMIUM_VERSION"
"$HERE/export.sh" >/dev/null
say "Packaging (signed)…"
"$HERE/package.sh"
# On a branch of its own (from the checkout's main, as the workflow pulls it): a pull request,
# never a push to main.
UPDATE_BRANCH="chromium-$NEW_VER"
git -C "$REPO_ROOT" checkout -q -b "$UPDATE_BRANCH"
git -C "$REPO_ROOT" add -A chromium
git -C "$REPO_ROOT" commit -q -m "Chromium $NEW_VER, Meridian $VERSION"
if [ "$PR" = 1 ]; then
  say "Opening the pull request…"
  git -C "$REPO_ROOT" push -q -u origin "$UPDATE_BRANCH"
  (cd "$REPO_ROOT" && gh pr create -R Undermove/meridian-browser --base main --head "$UPDATE_BRANCH" \
    --title "Chromium $NEW_VER, Meridian $VERSION" \
    --body "Chromium $NEW_VER (from $OLD_VER): the latest fixes from Chrome, including security fixes. Built, tested (chromium/tests/run.sh) and packaged by chromium/update_chromium.sh. Before merging and releasing: chromium/RELEASE_CHECKLIST.md.")
fi
say "Done: Meridian $VERSION on Chromium $NEW_VER, on branch $UPDATE_BRANCH. The release is made from main once the PR is merged."
