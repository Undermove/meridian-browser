// Import from Google Chrome (a fake Chrome folder in Chrome's format, never the real one): each
// Chrome profile becomes a space named as in Chrome, its bookmarks pinned tabs and folders (the bar
// on top, "Other bookmarks" as a folder), the tabs it had open Today tabs that load only when opened;
// another profile gets a Meridian profile of its own; its sign-ins (cookies) come over, so sites stay
// signed in. From the welcome tour (no Arc on this computer) and from File > Import from Chrome.
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
import { packExtension, store, writeHistory, writePasswords } from './chromium_profile.mjs';

const H = 'app.$.tabstrip.handler_';
const OB = 'app.$.onboarding.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Chrome profile's Cookies database, encrypted the way Chrome on macOS does it.
function writeCookies(dir, password, rows) {
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
    insert.run(toChrome(Date.now() - 1000), r.host, r.name, Buffer.concat([Buffer.from(r.prefix || 'v10'), c.update(plain), c.final()]), toChrome(Date.now() + 86400000), toChrome(Date.now()), r.port);
  }
  db.close();
}

const bookmark = (name, url) => ({ type: 'url', name, url });
const folder = (name, children) => ({ type: 'folder', name, children });

// A fake Chrome folder: "Personal" (Default) with bookmarks, open tabs and a sign-in; "Work"
// (Profile 1) with a bookmark. The open tabs are a real session file: Meridian writes them the
// way Chrome does, so a Meridian run with those tabs makes one.
async function fakeChrome(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-chrome-'));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' } } } }));
  const personal = path.join(dir, 'Default');
  const work = path.join(dir, 'Profile 1');
  fs.mkdirSync(personal, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(personal, 'Bookmarks'), JSON.stringify({ version: 1, roots: {
    bookmark_bar: folder('Bookmarks bar', [bookmark('Mail', url('/mail')), folder('Docs', [bookmark('Spec', url('/spec')), bookmark('Bookmarklet', 'javascript:alert(1)')]), folder('Empty', [])]),
    other: folder('Other bookmarks', [bookmark('Recipes', url('/recipes'))]),
    synced: folder('Mobile bookmarks', []),
  } }));
  fs.writeFileSync(path.join(work, 'Bookmarks'), JSON.stringify({ version: 1, roots: {
    bookmark_bar: folder('Bookmarks bar', [bookmark('Tracker', url('/tracker'))]), other: folder('Other bookmarks', []), synced: folder('Mobile bookmarks', []),
  } }));
  // The session file: from a Meridian run with two tabs open.
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch([url('/open-one'), url('/open-two')], { profile: run });
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].filter((r) => r.tab.title.startsWith('page /open')).length === 2`, 15000);
    await sleep(1500);
  } finally { await b.quit(); }
  const sessions = path.join(run, 'Default', 'Sessions');
  fs.mkdirSync(path.join(personal, 'Sessions'));
  for (const f of fs.readdirSync(sessions).filter((n) => n.startsWith('Session_'))) fs.copyFileSync(path.join(sessions, f), path.join(personal, 'Sessions', f));
  fs.rmSync(run, { recursive: true, force: true });
  return dir;
}

test('Chrome import: a space per profile with its bookmarks and open tabs, another profile of its own, sign-ins', async () => {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url} cookie:${req.headers.cookie || ''}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const chrome = await fakeChrome(url);
  writeCookies(path.join(chrome, 'Default'), 'test-pass', [{ host: '127.0.0.1', name: 'sid', value: 'signed-in', port }]);
  hits.length = 0;
  const b = await launch(['about:blank'], { args: [`--meridian-chrome-dir=${chrome}`, '--meridian-chrome-safe-storage=test-pass'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { preview } = await b.eval(`${H}.getArcPreview('chrome')`);
    assert.deepEqual(
      { s: preview.spaceCount, p: preview.pinnedCount, t: preview.todayCount, f: preview.favoriteCount, logins: preview.loginsAvailable },
      { s: 2, p: 4, t: 2, f: 0, logins: true });
    assert.deepEqual(preview.spaces.map((s) => s.name), ['Personal', 'Work']);

    // File > Import from Chrome: the moving-in step, said for Chrome.
    await b.eval(`app.$.onboarding.show('chrome')`);
    await b.waitFor(`app.$.onboarding.open && ${OB}.querySelector('h2')?.textContent.includes('Bring everything from Chrome')`);
    // Real counts: Chrome's profiles, the tabs it has open, its bookmarks.
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`), ['2 profiles', '2 open tabs', '4 bookmarks']);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!!${OB}.querySelector('.confirm')`);
    assert.match(await b.eval(`${OB}.querySelector('.confirm').textContent`), /copies\s+Chrome’s sign-ins/);
    // What macOS will show for Chrome's keychain item, and the button to press: Allow (Meridian
    // reads it once), not Always Allow.
    const mock = `${OB}.querySelector('.confirm meridian-mac-ask').shadowRoot`;
    assert.match(await b.eval(`${mock}.querySelector('.title').textContent`), /“Chrome Safe Storage”/);
    assert.equal(await b.eval(`${mock}.querySelector('.press').textContent.trim()`), 'Allow');
    assert.match(await b.eval(`${OB}.querySelector('.confirm').textContent.replace(/\\s+/g, ' ')`), /Pressed Deny\? Your tabs and bookmarks still come over/);
    await b.click(`${OB}.getElementById('confirmContinue')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Personal,Work'`, 15000);

    // Personal: the bookmarks bar on top, a folder for its folder, "Other bookmarks" as a folder;
    // no bookmarklet, no empty folder.
    const pinned = await b.pinned();
    assert.deepEqual(pinned.filter((p) => p.depth === 0).map((p) => [p.title, p.folder]), [['Mail', false], ['Docs', true], ['Other bookmarks', true]]);
    // Work is Chrome's other profile: a Meridian profile of its own.
    const st = await b.eval(`${H}.getState().then(({state}) => state)`);
    assert.equal(st.spaces.find((s) => s.name === 'Work').profileId, 'Meridian Profile Chrome 1');
    assert.equal(st.spaces.find((s) => s.name === 'Personal').profileId, '');
    // The tabs Chrome had open: Today tabs, not loaded until opened.
    await b.waitFor(`['/open-one', '/open-two'].every((p) => [...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.url === ${JSON.stringify(url(''))} + p))`, 10000).catch(async (e) => {
      throw new Error(e.message + ' rows=' + JSON.stringify(await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => [r.tab.title, r.tab.url])`)) + ' tabs=' + JSON.stringify(await b.eval(`[...app.$.tabstrip.tabs_.values()].map((t) => [t.title, t.url])`)) + ' state=' + JSON.stringify(await b.state()));
    });
    await sleep(800);
    assert.deepEqual(hits.filter((h) => h.startsWith('/open')), [], 'they wait to be opened');

    // Signed in: Chrome's cookie came over.
    await b.waitFor(`[...${OB}.querySelectorAll('.whisper')].some((e) => e.textContent.includes('still signed in'))`, 10000).catch(async (e) => {
      throw new Error(e.message + ' ' + JSON.stringify(await b.eval(`[app.$.onboarding.open, ${step}, [...${OB}.querySelectorAll('.whisper')].map((e) => e.textContent.trim())]`)));
    });
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(url('/check'))})`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'page /check cookie:sid=signed-in')`, 10000);
    // Imported once: said so.
    assert.equal(await b.eval(`app.$.tabstrip.state_.spaces.length`), 2);
  } finally { await b.close(); server.close(); fs.rmSync(chrome, { recursive: true, force: true }); }
});

test('the welcome tour moves in from Chrome when there is no Arc', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const chrome = await fakeChrome(url);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-noarc-'));
  const b = await launch(['about:blank'], { args: ['--meridian-onboarding', `--meridian-arc-dir=${empty}`, `--meridian-chrome-dir=${chrome}`, '--meridian-chrome-safe-storage=test-pass'] });
  try {
    await b.waitFor(`${step} === 'hello'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'arc'`);
    assert.match(await b.eval(`${OB}.querySelector('h2').textContent`), /Bring everything from Chrome/);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Personal,Work'`, 15000);
  } finally { await b.close(); server.close(); fs.rmSync(chrome, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }); }
});

test('both Arc and Chrome here: the tour moves in from Arc, Chrome is one click away, with its real counts', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const chrome = await fakeChrome(url);
  writePasswords(path.join(chrome, 'Default'), 'test-pass', [
    { url: 'https://accounts.example.com/login', username: 'ada', password: 'hunter2' },
    { url: 'https://mail.example.com/', username: 'ada', password: 'x' },
  ]);
  const arc = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc/StorableSidebar.json'), path.join(arc, 'StorableSidebar.json'));
  const b = await launch(['about:blank'], { args: ['--meridian-onboarding', `--meridian-arc-dir=${arc}`, `--meridian-chrome-dir=${chrome}`, '--meridian-chrome-safe-storage=test-pass', '--lang=en-US'] });
  try {
    await b.waitFor(`${step} === 'hello'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'arc'`);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.source')].map((e) => [e.textContent.trim(), e.classList.contains('on')])`), [['From Arc', true], ['From Chrome', false]]);
    assert.match(await b.eval(`${OB}.querySelector('h2').textContent`), /Bring everything from Arc/);
    await b.click(`[...${OB}.querySelectorAll('.source')][1]`);
    await b.waitFor(`${OB}.querySelector('h2').textContent.includes('Bring everything from Chrome')`);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`), ['2 profiles', '2 open tabs', '4 bookmarks', '2 passwords']);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!!${OB}.querySelector('.confirm')`);
    await b.click(`${OB}.getElementById('confirmContinue')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Personal,Work'`, 15000);
  } finally { await b.close(); server.close(); fs.rmSync(chrome, { recursive: true, force: true }); fs.rmSync(arc, { recursive: true, force: true }); }
});

test('Chrome’s extensions, saved passwords and history come over too', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const chrome = await fakeChrome(url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ext-'));
  const ext = packExtension(tmp, 'Chromy');
  const web = await store([ext]);
  // As Chrome keeps it: Extensions/<id>/<version>/manifest.json.
  const extDir = path.join(chrome, 'Default', 'Extensions', ext.id, '1.0_0');
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Mark Chromy', version: '1.0' }));
  writePasswords(path.join(chrome, 'Default'), 'test-pass', [{ url: 'https://accounts.example.com/login', username: 'ada', password: 'hunter2' }]);
  writeHistory(path.join(chrome, 'Default'), [{ url: 'https://example.com/read-later', title: 'Read later' }]);
  const b = await launch(['about:blank'], { args: [`--meridian-chrome-dir=${chrome}`, '--meridian-chrome-safe-storage=test-pass', `--apps-gallery-update-url=${web.url}`, '--meridian-test-unsigned-store', '--meridian-test-no-external-extensions'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.equal((await b.eval(`${H}.importArc('chrome')`)).ok, true);
    // Passwords, then history.
    const pw = await b.eval(`${H}.importArcPasswords('chrome')`);
    assert.equal(pw.error, '');
    assert.equal(pw.imported, 1);
    const { result } = await b.eval(`${H}.importArcData('chrome')`);
    assert.equal(result.error, '');
    assert.ok(result.history >= 1, `history: ${JSON.stringify(result)}`);
    // The extension, from the (test) Web Store: it runs on pages.
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(url('/marked'))})`);
    let marked = false;
    for (let i = 0; i < 60 && !marked; i++) {
      await sleep(500);
      try {
        const page = await b.page(url('/marked'), 1000);
        marked = await page.eval(`document.documentElement.dataset.markChromy === '1'`);
        if (!marked) await page.eval('location.reload(), true');
      } catch {}
    }
    assert.ok(marked, `Chrome's extension runs: asked ${JSON.stringify(web.asked)}`);
  } finally { await b.close(); server.close(); web.close(); fs.rmSync(chrome, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Chrome on Windows locks its cookies to itself (App-Bound Encryption, "v20"): Meridian says the
// sign-ins can't come, and brings the passwords all the same.
test('sign-ins Chrome locked to itself: said so; its passwords come all the same', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const chrome = await fakeChrome((p) => `http://127.0.0.1:${port}${p}`);
  writeCookies(path.join(chrome, 'Default'), 'test-pass', [{ host: '127.0.0.1', name: 'sid', value: 'locked', port, prefix: 'v20' }]);
  writePasswords(path.join(chrome, 'Default'), 'test-pass', [{ url: 'https://accounts.example.com/login', username: 'ada', password: 'hunter2' }]);
  const b = await launch(['about:blank'], { args: [`--meridian-chrome-dir=${chrome}`, '--meridian-chrome-safe-storage=test-pass'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.deepEqual(await b.eval(`${H}.importArcLogins('chrome')`), { imported: 0, passwords: 1, cards: 0, error: 'app-bound' });
  } finally { await b.close(); server.close(); fs.rmSync(chrome, { recursive: true, force: true }); }
});
