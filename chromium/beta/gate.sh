#!/bin/bash
# Beta gate (flags OFF = out/Release, not the beta app): logs to $R/<name>.tap, status lines to $R/status
S=/private/tmp/claude-501/-Users-dmitryafonchenko-repos-ai-hub/ef3827b0-b381-44a6-8e80-c33c99c0472a/scratchpad
R=$S/beta/${RUN:-run1}; mkdir -p $R
cd $S/beta-repo/chromium/tests
export MERIDIAN_LOG=$R/browser.log
A=(--test --test-force-exit --test-concurrency=1 --test-timeout=90000 --test-reporter=tap)
WARN="journey.test.mjs little.test.mjs link_preview.test.mjs"
H1=$(ls *.test.mjs | awk '$0<"onboarding.test.mjs" && $0!="journey.test.mjs" && $0!="little.test.mjs" && $0!="link_preview.test.mjs" && $0!="beta.test.mjs"')
H2=$(ls *.test.mjs | awk '$0>"onboarding.test.mjs"')
st() { echo "$(date +%H:%M:%S) $*" >> $R/status; }
st start
timeout 600 nice -n 10 node "${A[@]}" agent_asks.test.mjs > $R/smoke.tap 2>&1; st "smoke $?"
MERIDIAN_SPACE_GUARD=warn timeout 2400 nice -n 10 node "${A[@]}" journey.test.mjs > $R/journey.tap 2>&1; st "journey $?"
timeout 5400 nice -n 10 node "${A[@]}" $H1 > $R/half1.tap 2>&1; st "half1 $?"
MERIDIAN_SPACE_GUARD=warn timeout 1200 nice -n 10 node "${A[@]}" little.test.mjs link_preview.test.mjs > $R/half1-warn.tap 2>&1; st "half1-warn $?"
timeout 1800 nice -n 10 node "${A[@]}" onboarding.test.mjs > $R/onboarding.tap 2>&1; st "onboarding $?"
timeout 5400 nice -n 10 node "${A[@]}" $H2 > $R/half2.tap 2>&1; st "half2 $?"
st done
