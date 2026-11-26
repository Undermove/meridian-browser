#!/bin/bash
# Beta soak, one browser at a time, all under nice: MCP agent scenarios + ordinary actions on
# Meridian Beta.app (flags on) for SOAK_MIN, then feature/everyday test loops until SOAK_TOTAL.
S=/private/tmp/claude-501/-Users-dmitryafonchenko-repos-ai-hub/ef3827b0-b381-44a6-8e80-c33c99c0472a/scratchpad
R=$S/beta/${SOAK_DIR:-soak2}; mkdir -p $R
T=$S/beta-repo/chromium/tests
BETA="$HOME/Applications/Meridian Beta.app/Contents/MacOS/Meridian"
export MERIDIAN_LOG=$R/browser.log TESTS=$T SOAK_MIN=${SOAK_MIN:-30}
A=(--test --test-force-exit --test-concurrency=1 --test-timeout=90000 --test-reporter=tap)
st() { echo "$(date +%H:%M:%S) $*" >> $R/status; }
END=$(( $(date +%s) + ${SOAK_TOTAL:-55}*60 ))
st start
cd $T
MERIDIAN_APP="$BETA" timeout $(( (SOAK_MIN+15)*60 )) nice -n 10 node --test --test-force-exit --test-reporter=tap $S/beta/soak.test.mjs > $R/mcp.tap 2>&1; st "mcp-on-beta $?"
FILES="${SOAK_FILES:-studio.test.mjs workbench_chats.test.mjs toolkit.test.mjs boosts.test.mjs workbench.test.mjs ask_switch.test.mjs chat.test.mjs tidy.test.mjs spaces.test.mjs pinned.test.mjs agent_tab_close.test.mjs}"
i=0
while [ $(date +%s) -lt $END ]; do i=$((i+1)); timeout 2400 nice -n 10 node "${A[@]}" $FILES > $R/loop$i.tap 2>&1; st "loop$i $? $(grep -E '^# (pass|fail)' $R/loop$i.tap | tr '\n' ' ')"; done
st done
