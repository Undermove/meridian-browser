// The Workbench's session states (src/renderer/dev/session-status.js) from Mission Control's messages,
// no browser needed. Run: node --test 'tests/unit/*.test.js'
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderer/dev/session-status.js'), 'utf8');

// The page script in a context of its own, with a stand-in for the Workbench's host bridge.
function load() {
  const host = { listener: null, sent: [] };
  const ctx = vm.createContext({
    console,
    wb: { onHostCommand: (fn) => { host.listener = fn; }, toHost: (m) => host.sent.push(m), termLastAnswer: async () => '' },
  });
  vm.runInContext(SOURCE, ctx);
  return { SS: vm.runInContext('SessionStatus', ctx), host };
}
const mission = (sessions) => ({ type: 'mission', sessions });

test('"Working" and its tool come in two messages (UserPromptSubmit, then PreToolUse): the words follow the second', () => {
  const { SS, host } = load();
  SS.report({ on: true, onScreen: 't2', order: ['t1', 't2'] });
  assert.equal(host.sent.length, 1);
  let changes = 0;
  SS.onChange(() => changes++);
  // Mission Control flushes every 80 ms: the prompt's hook can land alone.
  host.listener(mission({ t1: { chat: 'working' } }));
  assert.equal(SS.words('t1'), 'Working');
  assert.equal(changes, 1);
  const since = SS.get('t1').since;
  host.listener(mission({ t1: { chat: 'working', tool: { name: 'Bash', summary: '$ npm run e2e' } } }));
  assert.equal(SS.words('t1'), 'Working · Bash(npm run e2e)');
  assert.equal(changes, 2, 'a new tool in the same state is a change');
  assert.equal(SS.get('t1').since, since, 'the same state keeps its start');
  // The same message again changes nothing.
  host.listener(mission({ t1: { chat: 'working', tool: { name: 'Bash', summary: '$ npm run e2e' } } }));
  assert.equal(changes, 2);
});

test('nothing is kept while the page lists no sessions', () => {
  const { SS, host } = load();
  host.listener(mission({ t1: { chat: 'working' } }));
  assert.equal(SS.get('t1').state, '');
  SS.report({ on: true, onScreen: '', order: ['t1'] });
  host.listener(mission({ t1: { chat: 'needs', ask: { tool: 'Bash', summary: '$ dotnet test' } } }));
  assert.equal(SS.words('t1'), 'Needs you · Allow Bash(dotnet test)?');
  SS.report({ on: false });
  assert.equal(SS.get('t1').state, '');
});
