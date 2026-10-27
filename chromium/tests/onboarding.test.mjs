// The welcome tour: first start of a profile. Arc is always a fixture here (or an empty folder),
// never the real Arc data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';

const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const OB = `app.$.onboarding.shadowRoot`;
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const C = { welcomeTour: 11, importArc: 12 };

test('without Arc: hello → a setup from the apps → preview → links → done, once', async () => {
  const noArc = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-noarc-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const args = ['--meridian-onboarding', `--meridian-arc-dir=${noArc}`, '--lang=en-US'];
  let b = await launch(['about:blank'], { profile, args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'tailor'`);
    // Without looking at the apps: the everyday setup (the same on every machine).
    await b.click(`${OB}.getElementById('useApps')`);
    await b.waitFor(`!${OB}.getElementById('useApps').classList.contains('on')`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'preview'`, 15000);
    assert.equal(await b.eval(`${OB}.querySelector('.persona').textContent`), 'Set up for everyday browsing');
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.pv-fav')].map((f) => f.title)`), ['Gmail', 'YouTube', 'Google Maps', 'WhatsApp']);
    // Leave Maps out.
    await b.click(`[...${OB}.querySelectorAll('.pv-fav')][2]`);
    await b.waitFor(`[...${OB}.querySelectorAll('.pv-fav')][2].classList.contains('off')`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`); // Not now
    await b.waitFor(`${step} === 'done'`);
    await b.click(`${OB}.getElementById('next')`); // Start browsing
    await b.waitFor(`!app.$.onboarding.open`);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Personal']);
    assert.deepEqual((await b.favorites()).map((f) => f.title), ['Gmail', 'YouTube', 'WhatsApp']);
    await b.quit();
    // Finished: the next start goes straight to the browser.
    b = await launch([], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-fav').length === 3`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await b.eval('app.$.onboarding.open'), false);
    // Help > Welcome Tour opens it again; Skip closes it.
    await b.eval(`app.$.tabstrip.runCommand(${C.welcomeTour}, 0)`);
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('skip')`);
    await b.waitFor(`!app.$.onboarding.open`);
  } finally {
    await b.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(noArc, { recursive: true, force: true });
  }
});

test('with Arc: Bring everything, after saying macOS will ask; File > Import from Arc opens that step', async () => {
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arcDir, 'StorableSidebar.json'));
  // A cookies database the importer finds (empty is enough: the step offers sign-ins).
  fs.mkdirSync(path.join(arcDir, 'User Data', 'Default', 'Network'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(arcDir, 'User Data', 'Default', 'Network', 'Cookies'));
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, source_scheme INTEGER)");
  db.close();
  const b = await launch(['about:blank'], { args: ['--meridian-onboarding', `--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'arc'`);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`), ['2 spaces', '5 tabs', '2 favorites']);
    assert.ok(await b.eval(`${OB}.getElementById('logins').classList.contains('on')`));
    await b.click(`${OB}.getElementById('next')`); // Bring everything
    // First: macOS will ask for permission.
    await b.waitFor(`!!${OB}.querySelector('.confirm')`);
    await b.click(`${OB}.getElementById('confirmContinue')`);
    await b.waitFor(`${step} === 'default'`, 15000);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Work', 'Home']);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!app.$.onboarding.open`);
    // File > Import from Arc: straight to the Arc step.
    await b.eval(`app.$.tabstrip.runCommand(${C.importArc}, 0)`);
    await b.waitFor(`${step} === 'arc'`);
    assert.equal(await b.eval(`!!${OB}.getElementById('fresh')`), false);
    await b.click(`${OB}.getElementById('skip')`);
    await b.waitFor(`!app.$.onboarding.open`);
  } finally { await b.close(); fs.rmSync(arcDir, { recursive: true, force: true }); }
});
