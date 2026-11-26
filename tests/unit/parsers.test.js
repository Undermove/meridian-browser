// Regression tests for bugs the fuzz targets in fuzz/ found. Run: node --test 'tests/unit/*.test.js'
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { byName, validateInput } = require('../../src/agent/tools.js');
const { fromCodex } = require('../../src/agents/hooks/mission-hook.js');

test('validateInput: names Object.prototype has are unknown fields, not schema entries', () => {
  // fuzz/tool_input.fuzz.js: wait_for accepted {"valueOf": …}; properties[key] found Object.prototype's.
  for (const key of ['valueOf', 'constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const input = JSON.parse(`{"query":"x",${JSON.stringify(key)}:1}`);
    assert.equal(validateInput(byName.search_tabs, input), `unknown field: ${key}`);
  }
  assert.equal(validateInput(byName.search_tabs, { query: 'x' }), null);
});

test('mission hook: a Codex notify argument that is JSON but not an object', () => {
  // fuzz/mission_hook.fuzz.js: fromCodex('null') threw (and the event was dropped).
  for (const arg of ['null', '5', '"text"', 'true', '[]']) {
    assert.deepEqual(fromCodex(arg), { kind: 'codex', event: 'Notify', session_id: undefined, turn_id: undefined, cwd_name: undefined });
  }
  assert.equal(fromCodex('{"type":"agent-turn-complete","thread-id":"t1"}').event, 'TurnComplete');
});
