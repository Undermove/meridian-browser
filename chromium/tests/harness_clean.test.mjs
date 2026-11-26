// The harness cleans what killed runs left in the temp folder (harness.mjs cleanAbandoned), without a
// browser: an old, unused test profile goes; one a browser still holds, one a process names, or one
// written in lately stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanAbandoned } from './harness.mjs';

test('abandoned meridian-e2e-*/meridian-empty-* folders go; ones in use or recent stay', { skip: process.platform === 'win32' && 'not cleaned on Windows yet' }, async () => {
  const old = (Date.now() - 2 * 3600_000) / 1000;
  const make = (prefix, files = {}) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    for (const [n, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
      fs.writeFileSync(path.join(d, n), body);
    }
    return d;
  };
  const age = (d) => {
    for (const e of fs.readdirSync(d, { recursive: true })) fs.lutimesSync(path.join(d, e), old, old);
    fs.utimesSync(d, old, old);
  };
  const abandoned = make('meridian-e2e-', { 'Default/Preferences': '{}' });
  const empty = make('meridian-empty-');
  const locked = make('meridian-e2e-', { 'Default/Preferences': '{}' });
  fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(locked, 'SingletonLock'));
  const deadLock = make('meridian-e2e-', { 'Default/Preferences': '{}' });
  fs.symlinkSync(`${os.hostname()}-999999`, path.join(deadLock, 'SingletonLock'));
  const named = make('meridian-e2e-');
  const recent = make('meridian-e2e-', { 'Default/Preferences': '{}' });
  const other = make('meridian-guardx-');
  for (const d of [abandoned, empty, locked, deadLock, named, other]) age(d);
  // Only its deepest file written lately: still in use.
  age(recent); fs.writeFileSync(path.join(recent, 'Default/Preferences'), '{"x":1}');
  // A process that names it (as a stand-in CLI's --cwd or a browser's --user-data-dir would).
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', named]);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const gone = cleanAbandoned();
    for (const d of [abandoned, empty, deadLock]) {
      assert.ok(!fs.existsSync(d), `${path.basename(d)} should go`);
      assert.ok(gone.includes(d));
    }
    for (const d of [locked, named, recent, other]) assert.ok(fs.existsSync(d), `${path.basename(d)} should stay`);
  } finally {
    holder.kill();
    for (const d of [locked, named, recent, other]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a test file killed from outside still removes its browsers\' folders', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  // A child that loads the harness, registers a folder the way launch() does, then is killed.
  const marker = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const h = await import(${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)});
    h._trackForTest(${JSON.stringify(marker)});
    console.log('ready');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, MERIDIAN_KEEP_TEMP: '1', MERIDIAN_SPACE_GUARD: 'off' } });
  await new Promise((r, j) => { child.stdout.on('data', (b) => String(b).includes('ready') && r()); child.on('exit', () => j(new Error('child ended early'))); });
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  const left = fs.existsSync(marker);
  fs.rmSync(marker, { recursive: true, force: true });
  assert.ok(!left, 'the folder of a killed run should be gone');
});
