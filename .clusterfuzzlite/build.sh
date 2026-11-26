#!/bin/bash -eu
# Builds the Jazzer.js fuzz targets (fuzz/*.fuzz.js) for ClusterFuzzLite.
#
# Like OSS-Fuzz's compile_javascript_fuzzer, but Jazzer.js comes from fuzz/package-lock.json (so its
# version is pinned and checked) instead of the app's own dependencies. Each target becomes
# $OUT/<name>_fuzzer, a wrapper that runs Jazzer.js on it, plus <name>_fuzzer.dict and
# <name>_fuzzer_seed_corpus.zip (from fuzz/corpus/<name>/) where there are some.

cd "$SRC/meridian"
# Exact versions and hashes from the lockfiles. No install scripts: the MCP SDK needs none and
# Jazzer.js ships its native fuzzer prebuilt.
npm ci --no-audit --no-fund --ignore-scripts
npm ci --prefix fuzz --no-audit --no-fund --ignore-scripts

rm -rf "$OUT/meridian"
cp -r "$SRC/meridian" "$OUT/meridian"

for target in fuzz/*.fuzz.js; do
  name="$(basename "$target" .fuzz.js)_fuzzer"
  # The MCP target also instruments the MCP SDK, where the JSON-RPC parsing lives.
  instrument=''
  if [ "$name" = mcp_bridge_fuzzer ]; then
    instrument='--includes=/mcp/ --includes=/src/ --includes=/fuzz/ --includes=/@modelcontextprotocol/sdk/ --excludes=/fuzz/node_modules/'
  fi
  sync='--sync'
  if grep -q 'async function' "$target"; then sync=''; fi
  cat > "$OUT/$name" <<WRAPPER
#!/bin/bash
project_dir=\$(dirname "\$0")/meridian
"\$project_dir/fuzz/node_modules/@jazzer.js/core/dist/cli.js" "\$project_dir/$target" $sync $instrument \$JAZZERJS_EXTRA_ARGS -- "\$@"
WRAPPER
  chmod +x "$OUT/$name"
  dict="fuzz/$(basename "$target" .fuzz.js).dict"
  if [ -f "$dict" ]; then cp "$dict" "$OUT/$name.dict"; fi
  seeds="fuzz/corpus/$(basename "$target" .fuzz.js)"
  if [ -d "$seeds" ]; then zip -jq "$OUT/${name}_seed_corpus.zip" "$seeds"/*; fi
done
ls -l "$OUT"
