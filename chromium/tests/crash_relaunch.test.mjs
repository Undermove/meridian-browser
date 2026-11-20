// When the browser process crashes, every window and the agents working in them go with it. A
// watcher reopens Meridian after a crash (not after a clean quit). Here in its dry mode: it only
// leaves its mark, so no window appears on the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MARK = 'Meridian Crash Relaunch';
const exitType = (profile) => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8')).profile?.exit_type; } catch { return undefined; } };
const waitFor = async (what, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (what()) return true; return false; };

test('a crash of the browser reopens it (the watcher marks it); a clean quit does not', { skip: process.platform !== 'darwin' && 'macOS watcher' }, async () => {
  // A crash.
  let profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['about:blank'], { profile, args: ['--meridian-crash-relaunch=dry'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.ok(await waitFor(() => exitType(profile) === 'Crashed'), 'the running browser counts as not cleanly exited');
    process.kill(b.proc.pid, 'SIGSEGV');
    assert.ok(await waitFor(() => fs.existsSync(path.join(profile, MARK))), 'the watcher would reopen Meridian');
    assert.equal(fs.readFileSync(path.join(profile, MARK), 'utf8'), 'would relaunch');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }

  // A clean quit: nothing to reopen.
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  b = await launch(['about:blank'], { profile, args: ['--meridian-crash-relaunch=dry'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.quit();
    assert.equal(exitType(profile), 'Normal');
    await sleep(4000);
    assert.equal(fs.existsSync(path.join(profile, MARK)), false, 'a clean quit is not reopened');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }

  // Tests themselves never get a watcher (no flag, no mark).
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  b = await launch(['about:blank'], { profile });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    process.kill(b.proc.pid, 'SIGSEGV');
    await sleep(4000);
    assert.equal(fs.existsSync(path.join(profile, MARK)), false);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
