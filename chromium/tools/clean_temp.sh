#!/bin/bash
# Removes what builds and test browsers leave in the temp folders. build.sh and tests/run.sh call it.
#   chromium/tools/clean_temp.sh [-n]   (-n: only list what would go)
# Chromium copies the app into …/X/<bundle id>.code_sign_clone/ at launch and removes the copy on a
# normal quit. A killed browser leaves it behind, and each copy keeps that build's files on disk:
# a few thousand of them filled 70 GB. A copy made around the launch of a running browser is kept.
set -uo pipefail
dry=0; [ "${1:-}" = "-n" ] && dry=1
T="${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"; T="${T%/}"
X="$(dirname "$T")/X"

# When each running Meridian or Chromium browser process started (seconds).
starts=()
while read -r pid; do
  s="$(ps -o lstart= -p "$pid" 2>/dev/null | xargs)"
  [ -n "$s" ] && starts+=("$(date -j -f "%a %b %d %T %Y" "$s" +%s)")
done < <(pgrep -f '/Contents/MacOS/(Meridian|Chromium)( --|$)')

drop() { if [ $dry = 1 ]; then echo "would remove $1"; else rm -rf "$1"; fi; }

n=0
for d in "$X/dev.meridian.browser.code_sign_clone" "$X/org.chromium.Chromium.code_sign_clone"; do
  [ -d "$d" ] || continue
  for c in "$d"/code_sign_clone.*; do
    [ -e "$c" ] || continue
    born="$(stat -f %B "$c")"; keep=0
    for s in ${starts[@]+"${starts[@]}"}; do
      if [ "$born" -ge $((s - 60)) ] && [ "$born" -le $((s + 300)) ]; then keep=1; fi
    done
    [ $keep = 0 ] && { drop "$c"; n=$((n + 1)); }
  done
done

# Build logs older than 3 days; libraries OpenCode unpacks on every run and temp dirs of killed
# test browsers, older than a day.
while IFS= read -r f; do drop "$f"; n=$((n + 1)); done < <(
  find "$T" -maxdepth 1 -name 'siso.*.log.*' -mtime +3 2>/dev/null
  find "$T" -maxdepth 1 -name '.*-00000000.dylib' -mtime +1 2>/dev/null
  find "$T" -maxdepth 1 -name 'dev.meridian.browser.*' -mtime +1 2>/dev/null)
echo "temp cleanup: $n removed, $(df -h "$HOME" | awk 'NR==2 {print $4}') free"
