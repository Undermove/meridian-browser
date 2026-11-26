# Fuzz targets

[Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) targets for the shipped JavaScript
that reads untrusted input. [ClusterFuzzLite](https://google.github.io/clusterfuzzlite/) runs them:
5 minutes on pull requests that touch the code (`.github/workflows/cflite-pr.yml`) and 30 minutes a
day (`cflite-batch.yml`). The build is `.clusterfuzzlite/build.sh`.

| Target | Code | Input |
| --- | --- | --- |
| `mcp_bridge` | `mcp/meridian-mcp.js` + the MCP SDK's stdio transport | JSON-RPC bytes from the MCP client, answers from the browser |
| `tool_input` | `validateInput` in `src/agent/tools.js` | tool arguments from a model or MCP client |
| `mission_hook` | `src/agents/hooks/mission-hook.js` | Claude Code hook events, Codex notify arguments |
| `secret_detect` | `src/renderer/dev/secret-detect.js` | pasted text, `.env` files |
| `terminal_paths` | `imagePathsIn` in `src/renderer/dev/terminal-extras.js` | whatever a program prints in a Workbench terminal |

Each target also checks properties (not only "doesn't throw"): accepted tool arguments match the
schema, secret matches are the text at their range, the hook sends only short fields, and so on.
Bugs they found have regression tests in `tests/unit/`.

Run one locally:

```sh
npm ci && npm ci --prefix fuzz
npx --prefix fuzz jazzer fuzz/tool_input.fuzz.js /tmp/corpus --sync -- -max_total_time=60 -dict=fuzz/tool_input.dict
# mcp_bridge is async (no --sync) and also instruments the SDK:
npx --prefix fuzz jazzer fuzz/mcp_bridge.fuzz.js /tmp/mcp-corpus fuzz/corpus/mcp_bridge \
  --includes=/mcp/ --includes=/src/ --includes=/fuzz/ --includes=/@modelcontextprotocol/sdk/ --excludes=/fuzz/node_modules/ \
  -- -max_total_time=60 -dict=fuzz/mcp_bridge.dict
```

A crash file from CI reproduces with `npx --prefix fuzz jazzer fuzz/<target>.fuzz.js <crash file>`.
