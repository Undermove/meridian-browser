// Import from Arc (a fixture in Arc's format, never the real Arc data): spaces, pinned tabs, folders,
// favorites, and Arc's open tabs as Today tabs that load only when opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { launch, SB } from './harness.mjs';

const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const H = 'app.$.tabstrip.handler_';

test('Arc import: preview, then spaces, pins, folders, favorites and Today', async () => {
  // Arc's open tabs point at a local server, which counts what actually loads.
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.writeFileSync(path.join(arcDir, 'StorableSidebar.json'),
    fs.readFileSync(path.join(ARC, 'StorableSidebar.json'), 'utf8').replace('https://news.ycombinator.com/', `http://127.0.0.1:${server.address().port}/hn`));
  const b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { preview } = await b.eval(`${H}.getArcPreview()`);
    assert.deepEqual(
      { s: preview.spaceCount, p: preview.pinnedCount, t: preview.todayCount, f: preview.favoriteCount },
      { s: 2, p: 3, t: 2, f: 3 });
    assert.deepEqual(preview.spaces.map((s) => [s.name, s.icon, s.color]), [['Work', '💼', '#ff8000'], ['Home', '', '']]);

    assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Work,Home'`);
    // The untouched first space made way for Arc's; Work is shown.
    await b.waitFor(`${SB}.querySelector('.space-name')?.textContent === 'Work'`);
    const pinned = await b.pinned();
    assert.deepEqual(pinned.map((p) => [p.title, p.folder]), [['Linear', false], ['Design', true]]);
    // Home was in Arc's second profile: it gets its own Meridian profile, with that profile's favorite.
    const st = await b.eval(`${H}.getState().then(({state}) => state)`);
    assert.deepEqual(st.profiles.map((p) => [p.id, p.name]), [['', 'Default'], ['Meridian Profile Arc 2', 'Home']]);
    assert.equal(st.spaces.find((s) => s.name === 'Home').profileId, 'Meridian Profile Arc 2');
    assert.equal(st.spaces.find((s) => s.name === 'Work').profileId, '');
    assert.deepEqual((await b.favorites()).map((f) => f.title), ['Gmail']);
    // Arc's open tabs, in Today, not loaded until opened.
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title).includes('Arc today')`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(hits, [], 'Arc tabs wait to be opened');
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'HN')`);
    for (let i = 0; i < 50 && !hits.includes('/hn'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(hits.includes('/hn'), 'an Arc tab loads when opened');
  } finally { await b.close(); server.close(); fs.rmSync(arcDir, { recursive: true, force: true }); }
});

// A fake Arc profile's Cookies database, encrypted the way Arc (Chromium on macOS) does it.
function writeArcCookies(dir, password, rows) {
  fs.mkdirSync(path.join(dir, 'Network'), { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Network', 'Cookies'));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('version', '24');
    CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT,
      encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
      last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER,
      source_scheme INTEGER, source_port INTEGER)`);
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const toChrome = (ms) => BigInt(ms) * 1000n + 11644473600000000n;
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, \'\', ?, \'\', ?, \'/\', ?, 0, 0, ?, 1, 1, 1, 1, 1, ?)');
  for (const r of rows) {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plain = Buffer.concat([crypto.createHash('sha256').update(r.host).digest(), Buffer.from(r.value)]);
    const enc = Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
    insert.run(toChrome(Date.now() - 1000), r.host, r.name, enc, toChrome(r.expires ?? Date.now() + 86400000), toChrome(Date.now()), r.port);
  }
  db.close();
}

test('Arc logins: cookies come over, so sites stay signed in; Deny imports nothing', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>cookie:${req.headers.cookie || ''}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arcDir, 'StorableSidebar.json'));
  writeArcCookies(path.join(arcDir, 'User Data', 'Default'), 'test-pass', [
    { host: '127.0.0.1', name: 'sid', value: 'signed-in', port },
    { host: '127.0.0.1', name: 'old', value: 'expired', port, expires: Date.now() - 1000 },
  ]);
  // Another Arc profile: its cookie goes to that profile's Meridian profile.
  writeArcCookies(path.join(arcDir, 'User Data', 'Profile 2'), 'test-pass', [{ host: '127.0.0.1', name: 'sid', value: 'other', port }]);
  try {
    let b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=__deny__'] });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      assert.equal((await b.eval(`${H}.getArcPreview()`)).preview.loginsAvailable, true);
      assert.deepEqual(await b.eval(`${H}.importArcLogins()`), { imported: 0, error: 'denied' });
    } finally { await b.close(); }

    b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'] });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      assert.deepEqual(await b.eval(`${H}.importArcLogins()`), { imported: 2, error: '' });
      await b.eval(`app.$.tabstrip.tabStripService_.createTabAt(null, 'http://127.0.0.1:${port}/')`);
      await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'cookie:sid=signed-in')`);
      // The sidebar after the sign-ins: Home (Arc's Profile 2) has that profile's cookie.
      assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
      const home = (await b.eval(`${H}.getState().then(({state}) => state)`)).spaces.find((s) => s.name === 'Home');
      await b.eval(`${H}.activateSpace(${JSON.stringify(home.id)})`);
      // In this window, its tabs in Arc's Profile 2's Meridian profile.
      await b.waitFor(`app.$.tabstrip.state_.profileId === 'Meridian Profile Arc 2'`);
      await b.eval(`app.$.tabstrip.openUrl('http://127.0.0.1:${port}/')`);
      let titles = [];
      for (let i = 0; i < 50 && !titles.includes('cookie:sid=other'); i++) {
        titles = await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(titles.includes('cookie:sid=other'), JSON.stringify(titles));
    } finally { await b.close(); }
  } finally { server.close(); fs.rmSync(arcDir, { recursive: true, force: true }); }
});
