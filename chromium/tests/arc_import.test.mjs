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

// Arc's fixture with a Home space (Arc's Profile 2) that has a pinned tab, an open tab and a
// favorite on `u`, and a cookie in each Arc profile: "personal" in Default, "work" in Profile 2.
function arcWithTwoProfiles(u) {
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  const sb = JSON.parse(fs.readFileSync(path.join(ARC, 'StorableSidebar.json'), 'utf8'));
  const items = sb.sidebar.containers[1].items;
  const item = (id) => items.find((x) => typeof x === 'object' && x.id === id);
  item('home-pinned').childrenIds = ['hp'];
  item('home-unpinned').childrenIds = ['ht'];
  items.push('hp', { id: 'hp', data: { tab: { savedURL: u('homepin'), savedTitle: 'HomePin' } } });
  items.push('ht', { id: 'ht', data: { tab: { savedURL: u('hometoday'), savedTitle: 'HomeToday' } } });
  item('fav-gmail2').data.tab.savedURL = u('homefav');
  fs.writeFileSync(path.join(arcDir, 'StorableSidebar.json'), JSON.stringify(sb));
  const port = Number(new URL(u('')).port);
  writeArcCookies(path.join(arcDir, 'User Data', 'Default'), 'test-pass', [{ host: '127.0.0.1', name: 'sid', value: 'personal', port }]);
  writeArcCookies(path.join(arcDir, 'User Data', 'Profile 2'), 'test-pass', [{ host: '127.0.0.1', name: 'sid', value: 'work', port }]);
  return arcDir;
}

// Pages titled with their path and the cookie they got.
async function cookieEcho() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url} ${req.headers.cookie || 'none'}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { u: (p) => `http://127.0.0.1:${server.address().port}/${p}`, close: () => { server.closeAllConnections(); server.close(); } };
}

// In the Home space, opens its pinned tab, its open tab, its favorite and a new tab, and returns
// the cookie each page got.
async function homeCookies(b, u) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cookieOf = async (p) => {
    for (let i = 0; i < 80; i++) {
      const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url === u(p) && x.title.startsWith('/'));
      if (t) return t.title.split(' ')[1];
      await sleep(100);
    }
    return 'not loaded';
  };
  const home = (await b.eval(`${H}.getState().then(({state}) => state)`)).spaces.find((s) => s.name === 'Home');
  await b.eval(`${H}.activateSpace(${JSON.stringify(home.id)})`);
  await b.waitFor(`app.$.tabstrip.state_.profileId === 'Meridian Profile Arc 2'`);
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1 && [...${SB}.querySelectorAll('#pinned > meridian-item')].some((e) => e.item.title === 'HomePin')`);
  const out = {};
  await b.click(`[...${SB}.querySelectorAll('#pinned > meridian-item')].find((e) => e.item.title === 'HomePin').shadowRoot.querySelector('.row')`);
  out.pinned = await cookieOf('homepin');
  await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url.includes('hometoday') || r.tab.title.startsWith('HomeToday')).shadowRoot.querySelector('.row')`);
  out.today = await cookieOf('hometoday');
  await b.click(`[...${SB}.querySelectorAll('meridian-fav')].find((f) => f.item.title === 'Gmail 2').shadowRoot.querySelector('.fav')`);
  out.favorite = await cookieOf('homefav');
  await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(u('homenew'))})`);
  out.newTab = await cookieOf('homenew');
  return out;
}

const WORK = { pinned: 'sid=work', today: 'sid=work', favorite: 'sid=work', newTab: 'sid=work' };

test('a space of another Arc profile is signed in as that profile: its pinned, open and new tabs and its favorites, also after a restart', async () => {
  // 0.5.13: the sidebar came first (as onboarding does it), its open tabs were made before their
  // profile existed, in the main one, and every tab opened from the sidebar followed them there.
  const s = await cookieEcho();
  const arcDir = arcWithTwoProfiles(s.u);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-arc-'));
  const args = [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'];
  try {
    let b = await launch(['about:blank'], { profile, args });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
      assert.deepEqual(await b.eval(`${H}.importArcLogins()`), { imported: 2, error: '' });
      assert.deepEqual(await homeCookies(b, s.u), WORK);
      await b.quit();
    } finally { await b.close(); }
    b = await launch([], { profile, args });
    try {
      await b.waitFor(`app.$.tabstrip.state_?.spaces.length === 2`);
      assert.deepEqual(await homeCookies(b, s.u), WORK, 'after a restart');
    } finally { await b.close(); }
  } finally { s.close(); fs.rmSync(arcDir, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});

const OLD = process.env.MERIDIAN_OLD_ARC_APP ||
    path.join(os.homedir(), 'Library/Application Support/Meridian Backups/Meridian-0.5.13-test1.app/Contents/MacOS/Meridian');

test('tabs 0.5.13 put in the main profile move to their space\'s profile, unarchived', { skip: !fs.existsSync(OLD) && 'no 0.5.13 app' }, async () => {
  const s = await cookieEcho();
  const arcDir = arcWithTwoProfiles(s.u);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-arc-'));
  const args = [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'];
  try {
    let b = await launch(['about:blank'], { profile, args, app: OLD });
    b.invariants = false;
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
      await b.eval(`${H}.importArcLogins()`);
      const before = await homeCookies(b, s.u);
      assert.equal(before.pinned, 'sid=personal', '0.5.13 made the mistake');
      await new Promise((r) => setTimeout(r, 2000));
      await b.quit();
    } finally { await b.close(); }
    b = await launch([], { profile, args });
    try {
      await b.waitFor(`app.$.tabstrip.state_?.spaces.length === 2`);
      assert.deepEqual(await homeCookies(b, s.u), WORK);
      const { tabs } = await b.eval(`${H}.searchArchive('')`);
      assert.deepEqual(tabs.map((t) => t.url).filter((x) => x.includes('/home')), [], 'nothing archived');
    } finally { await b.close(); }
  } finally { s.close(); fs.rmSync(arcDir, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});
