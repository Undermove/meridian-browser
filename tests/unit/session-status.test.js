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
    URL,
    wb: { onHostCommand: (fn) => { host.listener = fn; }, toHost: (m) => host.sent.push(m), termLastAnswer: async (id) => (host.answers || {})[id] || '' },
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
  assert.equal(SS.words('t1'), 'Needs permission: Bash(dotnet test)');
  SS.report({ on: false });
  assert.equal(SS.get('t1').state, '');
});

// ---------------------------------------------------------------- what a session wants (kinds)

// Objects from the page's context, compared as data.
const plain = (x) => JSON.parse(JSON.stringify(x));
const st = (state, extra = {}) => ({ state, text: '', tool: null, ask: null, turn: { files: [], failed: false, error: false }, ...extra });
const turn = (t) => ({ turn: { files: [], failed: false, error: false, ...t } });

test('classify: a permission prompt, from its question or from the notification', () => {
  const { SS } = load();
  assert.equal(SS.classify(st('needs', { ask: { tool: 'Bash', summary: '$ npm test' } })), 'permission');
  assert.equal(SS.classify(st('needs', { text: 'Needs permission: Bash · $ npm test' })), 'permission');
  assert.equal(SS.classify(st('needs', { text: 'Claude needs your permission to use Bash' })), 'permission');
  assert.equal(SS.classify(st('needs')), 'permission');
});

test('classify: a question — AskUserQuestion, or a notification that waits without a permission', () => {
  const { SS } = load();
  assert.equal(SS.classify(st('needs', { ask: { tool: 'AskUserQuestion', summary: '' } })), 'question');
  assert.equal(SS.classify(st('working', { tool: { name: 'AskUserQuestion', summary: '' } })), 'question');
  assert.equal(SS.classify(st('needs', { text: 'Which database should I use?' })), 'question');
  assert.equal(SS.classify(st('working', { tool: { name: 'Bash', summary: '$ ls' } })), 'working');
});

test('classify: an ended turn — error, then a PR link, then a result, else done', () => {
  const { SS } = load();
  const pr = 'Opened https://github.com/Undermove/meridian-browser/pull/283 for review.';
  assert.equal(SS.classify(st('done', turn({ error: true })), pr), 'error', 'a failed turn outranks its PR');
  assert.equal(SS.classify(st('done', turn({ failed: true })), ''), 'error', 'its last tool call failed');
  assert.equal(SS.classify(st('done'), pr), 'pr');
  assert.equal(SS.classify(st('done'), 'See https://gitlab.example.com/team/app/-/merge_requests/7'), 'pr');
  assert.equal(SS.classify(st('done'), 'https://bitbucket.org/acme/web/pull-requests/12 is up'), 'pr');
  assert.equal(SS.classify(st('done', turn({ files: ['src/a.ts'] })), pr), 'pr', 'a PR outranks the files');
  assert.equal(SS.classify(st('done', turn({ files: ['src/a.ts'] })), 'Changed it.'), 'result');
  assert.equal(SS.classify(st('done'), 'Deployed: https://example.com/preview'), 'result');
  assert.equal(SS.classify(st('done'), 'Not a PR: github.com/a/b/pull/1 without a scheme, nor https://github.com/a/b/issues/3'), 'result', 'a page, not a PR');
  assert.equal(SS.classify(st('done'), 'All tests pass.'), 'done');
  assert.equal(SS.classify(st('idle', turn({ error: true })), pr), '', 'seen: nothing to show');
  assert.equal(SS.classify(st('')), '');
});

test('priority: permission and question > error > PR > result > done > working; top() counts that rank', () => {
  const { SS, host } = load();
  assert.deepEqual(['permission', 'question', 'error', 'pr', 'result', 'done', 'working', ''].map(SS.rank), [5, 5, 4, 3, 2, 1, 0, -1]);
  SS.report({ on: true, onScreen: '', order: ['a', 'b', 'c', 'd', 'e'] });
  host.listener(mission({
    a: { chat: 'working' },
    b: { chat: 'done', turn: { files: ['x.md'] } },
    c: { chat: 'done', turn: { error: true } },
    d: { chat: 'needs', ask: { tool: 'Bash', summary: '$ rm -rf build' } },
    e: { chat: 'working', tool: { name: 'AskUserQuestion', summary: '' } },
  }));
  assert.deepEqual(plain(SS.top(['a', 'b', 'c', 'd', 'e'])), { kind: 'permission', count: 2 });
  assert.deepEqual(plain(SS.top(['a', 'b', 'c'])), { kind: 'error', count: 1 });
  assert.deepEqual(plain(SS.top(['a', 'b'])), { kind: 'result', count: 1 });
  assert.deepEqual(plain(SS.top(['a'])), { kind: 'working', count: 1 });
  assert.deepEqual(plain(SS.top([])), { kind: '', count: 0 });
  // The page tells Meridian its top kind, for the sidebar's mark.
  assert.deepEqual(plain(host.sent.at(-1).badge), { kind: 'permission', count: 2 });
});

test('words and links: a PR opens in a tab, a written file is the result', async () => {
  const { SS, host } = load();
  SS.report({ on: true, onScreen: '', order: ['p', 'r'] });
  host.answers = { p: 'Done.\nPR: https://github.com/o/r/pull/41 and later https://github.com/o/r/pull/42' };
  host.listener(mission({ p: { chat: 'done' }, r: { chat: 'done', turn: { files: ['src/hero.tsx', 'src/hero.css'] } } }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(SS.kind('p'), 'pr');
  assert.equal(SS.words('p'), 'PR #42 ready for review', 'the last link');
  assert.equal(SS.words('r'), 'Result: src/hero.tsx +1 file');
  assert.deepEqual(plain(SS.info('r').link), { type: 'file', path: 'src/hero.tsx', label: 'src/hero.tsx' });
  assert.equal(SS.open('p'), true);
  assert.deepEqual(plain(host.sent.at(-1)), { type: 'link', url: 'https://github.com/o/r/pull/42' });
  assert.equal(SS.words('x'), '');
});
