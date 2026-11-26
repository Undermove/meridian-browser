#!/bin/bash
# The release gate (chromium/RELEASE_CHECKLIST.md), in the order it is worth failing:
#   1. Mac-only words Windows would show (lint)
#   2. the newcomer journey on every "real computer" (journey.test.mjs)
#   3. the onboarding tests alone
#   4. the full suite in two halves (one browser at a time)
#   5. crash reports of the test build written meanwhile
# Every test file also runs the isolation guard (tests/isolation.mjs): a file that touched the
# owner's real AI configs fails by name.
#   chromium/tools/quality_gate.sh [<log dir>]     MERIDIAN_APP=<binary> to gate a packaged build
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="${1:-$(mktemp -d "${TMPDIR:-/tmp}/meridian-gate-XXXXXX")}"
mkdir -p "$LOGS"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fail=()
step() {  # name, command…
  local name="$1"; shift
  echo "== $name"
  if "$@" > "$LOGS/$name.log" 2>&1; then echo "   ok"; else echo "   FAILED (see $LOGS/$name.log)"; fail+=("$name"); fi
  grep -E '^# (pass|fail|todo|skipped)' "$LOGS/$name.log" | tr '\n' ' ' | sed 's/^/   /'; echo
}
cd "$HERE/tests"
tests=(--test --test-force-exit --test-concurrency=1 --test-timeout=180000 --test-reporter=tap)
all=($(ls ./*.test.mjs | sort))
half=$(( (${#all[@]} + 1) / 2 ))

step lint node "$HERE/tools/lint_platform_words.mjs"
step journey env MERIDIAN_QG_OUT="$LOGS/journey" node "${tests[@]}" ./journey.test.mjs
step onboarding node "${tests[@]}" ./onboarding.test.mjs ./onboard_claude.test.mjs ./platform_words.test.mjs
step suite-1 node "${tests[@]}" "${all[@]:0:$half}"
step suite-2 node "${tests[@]}" "${all[@]:$half}"
step crashes node "$HERE/tools/test_crashes.mjs" --since "$started"
"$HERE/tools/clean_temp.sh" >/dev/null 2>&1 || true

echo
if [ ${#fail[@]} -eq 0 ]; then echo "Gate: green. Logs: $LOGS"; exit 0; fi
echo "Gate: RED — ${fail[*]}. Logs: $LOGS"
exit 1
