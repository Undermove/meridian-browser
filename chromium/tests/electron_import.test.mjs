// Moving from the earlier (Electron) Meridian: a fixture state.json and cookie database, never the
// real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/electron/state.json');
const OB = 'app.$.onboarding.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;

// A cookie database encrypted like Chromium on macOS (here with a test "Meridian Safe Storage").
function writeCookies(file, password, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('version', '24');
    CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT,
      encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
      last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER,
      source_scheme INTEGER, source_port INTEGER)`);
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const toChrome = (ms) => BigInt(ms) * 1000n + 11644473600000000n;
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '', ?, '/', ?, 0, 0, ?, 1, 1, 1, 1, 1, ?)");
  for (const r of rows) {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([crypto.createHash('sha256').update(r.host).digest(), Buffer.from(r.value)]);
    insert.run(toChrome(Date.now() - 1000), r.host, r.name, Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]),
      toChrome(Date.now() + 86400000), toChrome(Date.now()), r.port);
  }
  db.close();
}

test('the previous Meridian moves in: spaces, favorites, archive, settings, link rules and sign-ins', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>cookie:${req.headers.cookie || ''}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-electron-'));
  fs.copyFileSync(FIXTURE, path.join(dir, 'state.json'));
  writeCookies(path.join(dir, 'Partitions', 'profile-default', 'Cookies'), 'test-pass', [{ host: '127.0.0.1', name: 'sid', value: 'old-meridian', port }]);
  const b = await launch(['about:blank'], { args: ['--meridian-onboarding', `--meridian-electron-dir=${dir}`, '--meridian-electron-safe-storage=test-pass'] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'electron'`);
    assert.equal(await b.eval(`${OB}.querySelector('h2').textContent`), 'Welcome to the new Meridian');
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`), ['2 spaces', '4 tabs', '2 favorites']);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!!${OB}.querySelector('.confirm')`);
    await b.click(`${OB}.getElementById('confirmContinue')`);
    await b.waitFor(`${step} === 'default'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    assert.match(await b.eval(`${OB}.querySelector('.hero').textContent`), /1 sign-ins brought over/);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!app.$.onboarding.open`);

    const state = await b.state();
    assert.deepEqual(state.spaces.map((s) => s.name), ['Personal', 'Work']);
    const work = await b.eval(`app.$.tabstrip.state_.spaces[1]`);
    assert.equal(state.active, work.id, 'the space that was open');
    assert.deepEqual([work.color, work.color2, work.icon], ['#4facfe', '#00f2fe', '💼']);
    assert.deepEqual((await b.favorites()).map((f) => f.title), ['Calendar', 'GitHub dup']); // the default profile's copy wins
    const personal = await b.eval(`app.$.tabstrip.state_.spaces[0].pinned.map((p) => [p.title, p.isFolder, p.open])`);
    assert.deepEqual(personal, [['Mail', false, true], ['Reading', true, false]]);
    // Settings and the link rule, now pointing at the new Work space.
    const { settings } = await b.eval('app.$.tabstrip.handler_.getSettings()');
    assert.deepEqual([settings.sidebarRight, settings.adblock, settings.archiveAfterHours, settings.mode], [true, false, 24, 'developer']);
    assert.equal(settings.atc.fallback, 'main');
    assert.equal(settings.atc.rules[0].target, `space:${work.id}`);
    // The archive.
    await b.eval('app.$.tabstrip.runCommand(9, 0)');
    await b.waitFor(`[...app.$.archive.shadowRoot.querySelectorAll('.entry .title')].some((e) => e.textContent.includes('Old page'))`);
    await b.key('Escape', 'Escape', 27);
    // Still signed in.
    await b.eval(`app.$.tabstrip.tabStripService_.createTabAt(null, 'http://127.0.0.1:${port}/')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length && [...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'cookie:sid=old-meridian')`);
  } finally { await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
