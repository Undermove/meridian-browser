#!/bin/bash
# Runs the E2E tests against the built Meridian (one browser at a time) and the C++ unit tests.
#   chromium/tests/run.sh [name-pattern]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="${CHROMIUM_DIR:-$HOME/repos/chromium}"
fail=0
# The Workbench page (chrome://workbench) from the current UI sources.
"$HERE/../tools/workbench_assets.sh" "$DIR/src/out/Release/Meridian.app/Contents/Resources/workbench" >/dev/null || fail=1
"$DIR/src/out/Release/meridian_unittests" --gtest_brief=1 2>&1 | tail -2 || fail=1
cd "$HERE"
args=(--test --test-force-exit --test-concurrency=1 --test-timeout=90000)
[ $# -gt 0 ] && args+=(--test-name-pattern="$1")
node "${args[@]}" ./*.test.mjs || fail=1
"$HERE/../tools/clean_temp.sh" || true
exit $fail
