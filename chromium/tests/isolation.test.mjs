// The isolation guard itself (isolation.mjs) and the stand-ins' fence (machines.mjs): a leak is
// caught, by name, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, changedSince, stripOwnerEnv, REAL_HOME } from './isolation.mjs';
import { machine } from './machines.mjs';

test('a guarded file that changes is named; its contents never are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-guard-'));
  try {
    const list = [{ file: path.join(dir, 'config.toml') }, { file: path.join(dir, '.claude.json'), claudeJson: true }, { file: path.join(dir, 'absent.json') }];
    fs.writeFileSync(list[0].file, 'model = "x"\n');
    fs.writeFileSync(list[1].file, JSON.stringify({ numStartups: 1, mcpServers: { files: {} } }));
    const before = snapshot(list);
    assert.ok(before.every((b) => !b.hash.includes('model')), 'hashes only');
    assert.deepEqual(changedSince(before, list), []);
    // Claude Code's own bookkeeping isn't a test's doing…
    fs.writeFileSync(list[1].file, JSON.stringify({ numStartups: 2, tipsHistory: { a: 1 }, mcpServers: { files: {} } }));
    assert.deepEqual(changedSince(before, list), []);
    // …a server added, a test folder written in, any change to the others, is.
    fs.writeFileSync(list[1].file, JSON.stringify({ numStartups: 2, mcpServers: { files: {}, meridian: { command: '/x' } } }));
    fs.appendFileSync(list[0].file, '[mcp_servers.meridian]\n');
    fs.writeFileSync(list[2].file, '{}');
    assert.deepEqual(changedSince(before, list).length, 3);
    fs.writeFileSync(list[1].file, JSON.stringify({ numStartups: 2, mcpServers: { files: {} }, projects: { [path.join(os.tmpdir(), 'meridian-e2e-x')]: {} } }));
    assert.ok(changedSince(before, list).some((f) => f.endsWith('.claude.json')), 'a test folder in it is a trace');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the owner’s login environment never reaches what a test starts', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-guard-bin-'));
  try {
    fs.writeFileSync(path.join(bin, 'claude'), '', { mode: 0o755 });
    const env = { CLAUDE_CONFIG_DIR: path.join(REAL_HOME, '.claude-personal'), CODEX_HOME: '/x', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', MERIDIAN_APP: '/a', LANG: 'en_US.UTF-8',
      PATH: [path.join(REAL_HOME, '.local', 'bin'), bin, '/usr/bin', path.dirname(process.execPath)].join(path.delimiter) };
    stripOwnerEnv(env);
    assert.deepEqual(Object.keys(env).sort(), ['LANG', 'MERIDIAN_APP', 'PATH']);
    assert.deepEqual(env.PATH.split(path.delimiter), ['/usr/bin', path.dirname(process.execPath)]);
    assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined, 'this test process runs without it too');
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test('a stand-in refuses to run when it sees a path outside the test home, and says so in refused.log', { skip: process.platform === 'win32' && 'stand-ins as plain scripts here' }, () => {
  const m = machine('two-claude-accounts');
  try {
    const bin = m.truth.claudeCode.path;
    const run = (env, args = ['--version']) => { try { return { out: execFileSync(bin, args, { env: { PATH: '/usr/bin:/bin', ...env }, cwd: m.project, encoding: 'utf8' }), code: 0 }; } catch (e) { return { out: e.stdout + e.stderr, code: e.status }; } };
    assert.equal(run({ HOME: m.home, CLAUDE_CONFIG_DIR: path.join(m.home, '.claude-personal') }).code, 0);
    assert.match(run({ HOME: m.home, CLAUDE_CONFIG_DIR: path.join(m.home, '.claude-personal') }, ['auth', 'status']).out, /"loggedIn":true/);
    assert.deepEqual(m.refused(), []);
    const leak = run({ HOME: m.home, CLAUDE_CONFIG_DIR: path.join(REAL_HOME, '.claude-personal') });
    assert.equal(leak.code, 97);
    assert.match(leak.out, /refused to run/);
    assert.equal(run({ HOME: REAL_HOME }).code, 97, 'the real HOME');
    assert.equal(run({ HOME: m.home }, ['mcp', 'add', '-s', 'user', 'x', '--', path.join(REAL_HOME, 'bin', 'x')]).code, 97, 'a real path as an argument');
    assert.equal(m.refused().length, 3);
    // Versions behave as they do for real: an older copy can't read a newer sign-in.
    const old = machine('native-and-old-on-path');
    try {
      const oldBin = path.join(old.root, 'sys', 'usr', 'local', 'bin', 'claude');
      const out = execFileSync(oldBin, ['auth', 'status'], { env: { PATH: '/usr/bin:/bin', HOME: old.home }, cwd: old.project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      assert.fail(`the old copy said ${out}`);
    } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; assert.match(String(e.stdout), /"loggedIn":false/); } finally { old.clean(); }
  } finally { m.clean(); }
});

test('a browser app started outside the build under test (as the Dock or LaunchServices would) is named', { skip: process.platform !== 'darwin' && 'macOS' }, async () => {
  const { startSpaceWatch, screenTaken, forget } = await import('./space_guard.mjs');
  startSpaceWatch();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-guard-app-'));
  const exe = path.join(dir, 'Arc.app', 'Contents', 'MacOS', 'Arc');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  // (node under that name: a copied system binary isn't allowed to run.)
  fs.symlinkSync(process.execPath, exe);
  const from = Date.now();
  // Its parent goes away at once: launchd adopts it, as it does an app the Dock opens.
  execFileSync('/bin/sh', ['-c', '"$0" -e "setTimeout(() => {}, 4000)" >/dev/null 2>&1 &', exe]);
  try {
    let taken = [];
    for (let i = 0; i < 30 && !taken.length; i++) { await new Promise((r) => setTimeout(r, 200)); taken = screenTaken(from, Date.now(), new Set()); }
    assert.ok(taken.some((t) => t.includes(exe)), JSON.stringify(taken));
  } finally {
    try { execFileSync('/usr/bin/pkill', ['-f', exe]); } catch {}
    forget((e) => e.alien?.exe === exe);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Space guard: the person switching Spaces himself passes; a switch with no input, a test browser in front or seen fails', () => {
  return import('./space_guard.mjs').then(({ classify }) => {
    const pids = new Set([4242]);
    const run = (list) => classify(list, 1000, 9000, pids);
    const start = { t: 900, space: 1, front: 77, idle: 30 };
    // 26.11: the owner moved between his Spaces (a swipe, ⌘⇥) about once a minute, each right after
    // his own input; and back again, and the frontmost app changed on the other Space.
    let r = run([start, { t: 2000, space: 423, front: 88, idle: 0.6 }, { t: 2500, space: 423, front: 99, idle: 4 }, { t: 3000, space: 1, front: 77, idle: 1.1 }]);
    assert.deepEqual(r.taken, []);
    assert.equal(r.own.length, 2);
    // An app switched it, nobody touched anything.
    r = run([start, { t: 2000, space: 18, front: 77, idle: 12.5 }]);
    assert.match(r.taken.join(), /Space switched \(1 → 18\).*no input from the person \(last 12.5 s before\)/);
    // A test browser in front, or one of its windows seen: fails whatever the person did.
    r = run([start, { t: 2000, space: 1, front: 4242, idle: 0.2 }]);
    assert.match(r.taken.join(), /pid 4242\) became the frontmost/);
    r = run([start, { t: 2000, shown: 4242, window: 7 }, { t: 2100, shown: 5555, window: 8 }]);
    assert.equal(r.taken.length, 1);
    assert.match(r.taken[0], /window of a test browser \(pid 4242, window 7\) could be seen/);
    // Old watcher lines (no idle): a switch counts, as before.
    r = run([start, { t: 2000, space: 2, front: 77 }]);
    assert.equal(r.taken.length, 1);
    // Events outside the test's time don't count.
    assert.deepEqual(run([start, { t: 9500, space: 2, front: 77, idle: 50 }]).taken, []);
  });
});
