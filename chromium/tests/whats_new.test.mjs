// After an update, the first window opens the changelog at the new version's entry, once; a new
// install doesn't (it's onboarded instead), nor does the same version again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';

test('after an update the changelog opens at the new version, once; not on a new install', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Changelog</title><h1>Changelog</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = `http://127.0.0.1:${server.address().port}/changelog.html`;
  const args = [`--meridian-test-changelog-url=${page}`];
  const urls = (b) => b.eval(`[...${T}.tabs_.values()].map((t) => t.url)`);
  // A profile last run by an older version.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { last_version: '0.0.1', onboarded: true } }));
  // A new install.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b;
  try {
    b = await launch(['about:blank'], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    const version = (await b.eval(`${T}.handler_.getSettings().then((r) => r.settings.version)`));
    assert.match(version, /^\d+\.\d+\.\d+$/);
    await b.waitFor(`[...${T}.tabs_.values()].some((t) => t.url === ${JSON.stringify(`${page}#v${version}`)} && t.isActive)`, 10000,
      `[...${T}.tabs_.values()].map((t) => t.url)`);
    await b.quit();

    // The same version again: no changelog.
    b = await launch([], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await sleep(2500);
    const again = await urls(b);
    assert.equal(again.filter((u) => u.startsWith(page)).length <= 1, true, `no second changelog: ${again}`);
    await b.close();

    // A new install: none.
    b = await launch(['about:blank'], { profile: fresh, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await sleep(2500);
    assert.ok(!(await urls(b)).some((u) => u.startsWith(page)), 'no changelog on a new install');
  } finally {
    await b?.close();
    server.close();
    for (const d of [profile, fresh]) fs.rmSync(d, { recursive: true, force: true });
  }
});
