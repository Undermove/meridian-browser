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
import { execFileSync } from 'node:child_process';
import { launch, SB, APP } from './harness.mjs';

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
      assert.deepEqual(await b.eval(`${H}.importArcLogins()`), { imported: 0, passwords: 0, cards: 0, error: 'denied' });
    } finally { await b.close(); }

    b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'] });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      assert.deepEqual(await b.eval(`${H}.importArcLogins()`), { imported: 2, passwords: 0, cards: 0, error: '' });
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
  // The cookie in the jar of the profile the tab is in (a restored tab's title can still be the
  // one it was saved with, before it loads again).
  const cookieOf = async (p) => {
    for (let i = 0; i < 80; i++) {
      const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url === u(p));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        const reply = await new Promise((r) => {
          ws.onmessage = (m) => r(JSON.parse(m.data));
          ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [u('')] } }));
        });
        ws.close();
        const sid = reply.result?.cookies?.find((c) => c.name === 'sid');
        if (sid) return `sid=${sid.value}`;
      }
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
      assert.deepEqual(await b.eval(`${H}.importArcLogins()`), { imported: 2, passwords: 0, cards: 0, error: '' });
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

// An extension that marks the pages it runs on with its name, packed as a CRX with a new key, and
// its Web Store id (the key's hash in a–p).
// With `popup`, its toolbar button opens popup.html ("Popup <name>").
function packExtension(dir, name, { popup = false } = {}) {
  const src = path.join(dir, name);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: `Mark ${name}`, version: '1.0',
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['mark.js'], run_at: 'document_start' }],
    ...(popup ? { action: { default_popup: 'popup.html', default_title: `Mark ${name}` } } : {}),
  }));
  if (popup) fs.writeFileSync(path.join(src, 'popup.html'), `<title>Popup ${name}</title><p>${name}`);
  fs.writeFileSync(path.join(src, 'mark.js'), `document.documentElement.dataset['mark' + ${JSON.stringify(name)}] = '1';`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = path.join(dir, `${name}.pem`);
  fs.writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const hash = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
  const id = [...hash].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pack-'));
  try {
    execFileSync(APP, [`--user-data-dir=${udd}`, `--pack-extension=${src}`, `--pack-extension-key=${pem}`, '--no-message-box'], { stdio: 'ignore', timeout: 60000 });
  } finally { fs.rmSync(udd, { recursive: true, force: true }); }
  return { id, crx: fs.readFileSync(`${src}.crx`) };
}

// A Web Store of `extensions` (update checks and downloads), and what was asked of it.
async function store(extensions) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.method + ' ' + req.url.slice(0, 80));
    const u = new URL(req.url, 'http://x');
    const crx = u.pathname.match(/^\/crx\/(\w+)$/);
    if (crx) {
      const e = extensions.find((x) => x.id === crx[1]);
      res.writeHead(e ? 200 : 404, { 'content-type': 'application/x-chrome-extension' });
      return res.end(e?.crx);
    }
    const ids = u.searchParams.getAll('x').map((x) => new URLSearchParams(x).get('id'));
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(`<?xml version='1.0' encoding='UTF-8'?><gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>${
      ids.map((id) => extensions.some((x) => x.id === id)
        ? `<app appid='${id}' status='ok'><updatecheck status='ok' codebase='http://127.0.0.1:${port}/crx/${id}' version='1.0' /></app>`
        : `<app appid='${id}' status='ok'><updatecheck status='noupdate' /></app>`).join('')}</gupdate>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/update`, asked, close: () => { server.closeAllConnections(); server.close(); } };
}

// Arc's extensions as Arc keeps them (User Data/<profile>/Extensions/<id>/<version>/manifest.json).
function arcExtension(arcDir, profileDir, id, name) {
  const dir = path.join(arcDir, 'User Data', profileDir, 'Extensions', id, '1.0_0');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version: '1.0' }));
}

// The marks of the extensions that ran on the page at `url`.
async function marksOn(b, url) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50; i++) {
    const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url === url);
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const reply = await new Promise((r) => {
        ws.onmessage = (m) => r(JSON.parse(m.data));
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.readyState === 'complete' ? Object.keys(document.documentElement.dataset).filter((k) => k.startsWith('mark')).sort().join(',') : null`, returnByValue: true } }));
      });
      ws.close();
      const v = reply.result?.result?.value;
      if (v !== null && v !== undefined) return v;
    }
    await sleep(200);
  }
  return 'not loaded';
}

// Arc: each Arc profile's extensions are there in Meridian, in that profile's spaces only, with
// nothing to add by hand: imported now, or before Meridian added them (0.5.13).
for (const imported of ['now', 'by 0.5.13']) {
  test(`Arc's extensions come over into their own profile's spaces (imported ${imported})`, { skip: imported !== 'now' && !fs.existsSync(OLD) && 'no 0.5.13 app' }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ext-'));
    const personal = packExtension(work, 'Personal');
    const office = packExtension(work, 'Office');
    const web = await store([personal, office]);
    const s = await cookieEcho();
    const arcDir = arcWithTwoProfiles(s.u);
    arcExtension(arcDir, 'Default', personal.id, 'Mark Personal');
    arcExtension(arcDir, 'Profile 2', office.id, 'Mark Office');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-arc-'));
    const args = [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass', `--apps-gallery-update-url=${web.url}`, '--meridian-test-unsigned-store'];
    try {
      if (imported !== 'now') {
        const old = await launch(['about:blank'], { profile, args, app: OLD });
        try {
          await old.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
          assert.equal((await old.eval(`${H}.importArc()`)).ok, true);
          await old.quit();
        } finally { await old.close(); }
      }
      const b = await launch(imported === 'now' ? ['about:blank'] : [], { profile, args });
      try {
        await b.waitFor(`app.$.tabstrip.state_?.spaces.length >= 1`);
        if (imported === 'now') {
          await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
          assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
        }
        const spaces = (await b.eval(`${H}.getState().then(({state}) => state)`)).spaces;
        const inSpace = async (name, page) => {
          await b.eval(`${H}.activateSpace(${JSON.stringify(spaces.find((x) => x.name === name).id)})`);
          await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(s.u(page))})`);
          return marksOn(b, s.u(page));
        };
        const left = async () => (await b.eval(`${H}.getArcExtensions().then(({extensions}) => extensions.filter((x) => !x.installed).map((x) => x.name))`));
        // Installed in the background: wait until both arrived.
        const main = spaces.find((x) => !x.profileId).name;
        let personalMarks = '', homeMarks = '';
        for (let i = 0, end = Date.now() + 60000; Date.now() < end && !(personalMarks === 'markPersonal' && homeMarks === 'markOffice'); i++) {
          if (i) await new Promise((r) => setTimeout(r, 2000));
          personalMarks = await inSpace(main, `p${i}`);
          homeMarks = await inSpace('Home', `h${i}`);
        }
        assert.equal(personalMarks, 'markPersonal', `the personal extension, only, in ${main}; store: ${web.asked.join(' | ')}`);
        assert.equal(homeMarks, 'markOffice', 'the work one, only, in Home');
        assert.deepEqual(await left(), [], 'nothing left to add in Home');
        await b.eval(`${H}.activateSpace(${JSON.stringify(spaces.find((x) => x.name === main).id)})`);
        assert.deepEqual(await left(), [], `nothing left to add in ${main} (and not Home's)`);
      } finally { await b.close(); }
    } finally {
      s.close(); web.close();
      for (const d of [work, arcDir, profile]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
}

// Arc: the site controls (the sliders) show the shown space's extensions as tiles, all of them,
// not only pinned; a click opens the extension's popup, from its own profile.
test('the site controls show the shown space\'s extensions; a click opens its popup', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ext-'));
  const personal = packExtension(work, 'Personal', { popup: true });
  const office = packExtension(work, 'Office', { popup: true });
  const web = await store([personal, office]);
  const s = await cookieEcho();
  const arcDir = arcWithTwoProfiles(s.u);
  arcExtension(arcDir, 'Default', personal.id, 'Mark Personal');
  arcExtension(arcDir, 'Profile 2', office.id, 'Mark Office');
  const args = [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass', `--apps-gallery-update-url=${web.url}`, '--meridian-test-unsigned-store'];
  const b = await launch(['about:blank'], { args });
  const SC = 'app.$.siteControl.shadowRoot';
  const tiles = () => b.eval(`[...${SC}.querySelectorAll('.ext-btn')].map((t) => t.title)`);
  const popups = async () => (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.endsWith('/popup.html')).map((t) => t.title);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
    const spaces = (await b.eval(`${H}.getState().then(({state}) => state)`)).spaces;
    const main = spaces.find((x) => !x.profileId);
    const home = spaces.find((x) => x.name === 'Home');
    for (const [space, want, other] of [[main, 'Mark Personal', 'Mark Office'], [home, 'Mark Office', 'Mark Personal']]) {
      await b.eval(`${H}.activateSpace(${JSON.stringify(space.id)})`);
      await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(s.u(`page-${space.name}`))})`);
      await b.waitFor(`app.$.tabstrip.state_.profileId === ${JSON.stringify(space.profileId || '')}`);
      // Installed in the background: open the controls until its tile is there.
      let got = [];
      for (let i = 0; i < 30 && !got.includes(want); i++) {
        if (await b.eval('app.$.siteControl.open')) await b.eval(`${SC}.getElementById('shield').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))`);
        await b.waitFor(`!app.$.locationIconButton.hidden`);
        await b.click('app.$.locationIconButton');
        await b.waitFor('app.$.siteControl.open');
        await sleep(600);
        got = await tiles();
        if (!got.includes(want)) await sleep(1000);
      }
      assert.deepEqual(got, [want], `${space.name}: only its own extension, shown without pinning (not ${other})`);
      await b.click(`[...${SC}.querySelectorAll('.ext-btn')].find((t) => t.title === ${JSON.stringify(want)})`);
      const name = want.split(' ')[1];
      let open = [];
      for (let i = 0; i < 40 && !open.includes(`Popup ${name}`); i++) { await sleep(150); open = await popups(); }
      assert.ok(open.includes(`Popup ${name}`), `${space.name}: its popup opened: ${JSON.stringify(open)}`);
      assert.equal(await b.eval('app.$.siteControl.open'), false, 'the controls closed for it');
      // Closes the popup (Escape in it) before the next space.
      const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.url.endsWith('/popup.html'));
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }));
      await sleep(300); ws.close();
      for (let i = 0; i < 20 && (await popups()).length; i++) await sleep(150);
    }
    // Manage (in Home): chrome://extensions of Home's profile.
    await b.click('app.$.locationIconButton');
    await b.waitFor('app.$.siteControl.open');
    await b.click(`${SC}.getElementById('manageExtensions')`);
    let listed = null;
    for (let i = 0; i < 40 && !listed; i++) {
      await sleep(200);
      const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith('chrome://extensions'));
      if (!t) continue;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      const reply = await new Promise((r) => {
        ws.onmessage = (m) => r(JSON.parse(m.data));
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'chrome.developerPrivate.getExtensionsInfo().then((l) => l.map((x) => x.name).filter((n) => n.startsWith("Mark")))', awaitPromise: true, returnByValue: true } }));
      });
      ws.close();
      listed = reply.result?.result?.value || null;
    }
    assert.deepEqual(listed, ['Mark Office'], 'Manage in Home lists Home\'s extensions');
  } finally {
    await b.close(); s.close(); web.close();
    for (const d of [work, arcDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Arc's "Login Data": its saved passwords, encrypted like its cookies (no host hash).
function writeArcPasswords(dir, password, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Login Data'));
  db.exec(`CREATE TABLE logins(origin_url VARCHAR NOT NULL, action_url VARCHAR, username_element VARCHAR,
    username_value VARCHAR, password_element VARCHAR, password_value BLOB, submit_element VARCHAR,
    signon_realm VARCHAR NOT NULL, date_created INTEGER NOT NULL, blacklisted_by_user INTEGER NOT NULL,
    scheme INTEGER NOT NULL, password_type INTEGER, times_used INTEGER, form_data BLOB, display_name VARCHAR,
    icon_url VARCHAR, federation_url VARCHAR, skip_zero_click INTEGER, generation_upload_status INTEGER,
    possible_username_pairs BLOB, id INTEGER PRIMARY KEY AUTOINCREMENT, date_last_used INTEGER NOT NULL DEFAULT 0,
    moving_blocked_for BLOB, date_password_modified INTEGER NOT NULL DEFAULT 0)`);
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const now = BigInt(Date.now()) * 1000n + 11644473600000000n;
  const insert = db.prepare(`INSERT INTO logins(origin_url, action_url, username_element, username_value, password_element,
    password_value, submit_element, signon_realm, date_created, blacklisted_by_user, scheme, times_used, federation_url)
    VALUES (?, ?, 'user', ?, 'pass', ?, '', ?, ?, 0, 0, 1, ?)`);
  for (const r of rows) {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const enc = Buffer.concat([Buffer.from('v10'), c.update(Buffer.from(r.password)), c.final()]);
    const origin = new URL(r.url).origin;
    insert.run(r.url, r.url, r.username, enc, `${origin}/`, now, r.federation || '');
  }
  db.close();
}

// The usernames and sites in chrome://password-manager of the shown space's profile.
async function savedPasswords(b) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await b.eval(`app.$.tabstrip.openUrl('chrome://password-manager/passwords')`);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith('chrome://password-manager'));
    if (!t) continue;
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const reply = await new Promise((r) => {
      ws.onmessage = (m) => r(JSON.parse(m.data));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'chrome.passwordsPrivate.getSavedPasswordList().then((l) => l.map((x) => `${x.username}@${x.affiliatedDomains[0].name}`).sort())', awaitPromise: true, returnByValue: true } }));
    });
    ws.close();
    const list = reply.result?.result?.value;
    if (list) {
      // Closes that tab (it's in the space's list).
      await fetch(`${b.base}/json/close/${t.id}`);
      return list;
    }
  }
  return null;
}

test('Arc\'s saved passwords come over from Settings, each into its space\'s profile; again adds nothing', async () => {
  const s = await cookieEcho();
  const arcDir = arcWithTwoProfiles(s.u);
  writeArcPasswords(path.join(arcDir, 'User Data', 'Default'), 'test-pass', [
    { url: 'https://bank.example/login', username: 'alice', password: 'pa55-personal' },
    // A federated sign-in has no password: it stays behind.
    { url: 'https://social.example/', username: 'alice', password: '', federation: 'https://accounts.google.com' },
  ]);
  writeArcPasswords(path.join(arcDir, 'User Data', 'Profile 2'), 'test-pass', [
    { url: 'https://tax.example/signin', username: 'bob', password: 'pa55-work' },
  ]);
  const b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'] });
  const ST = 'app.$.settings.shadowRoot';
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Arc's spaces came in earlier (without its sign-ins).
    assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
    const press = async () => {
      await b.eval(`app.$.tabstrip.runCommand(13, 0)`);  // Meridian > Settings
      await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('importArcPasswords')`);
      await b.click(`${ST}.getElementById('importArcPasswords')`);
      await b.waitFor(`!/Bringing/.test(${ST}.getElementById('arcPasswordsNote').textContent) && /\\./.test(${ST}.getElementById('arcPasswordsNote').textContent)`);
      const note = (await b.eval(`${ST}.getElementById('arcPasswordsNote').textContent`)).trim();
      await b.eval(`${ST}.getElementById('close').click()`);
      await b.waitFor('!app.$.settings.open');
      return note;
    };
    assert.equal(await press(), '2 passwords brought over.');
    const spaces = (await b.eval(`${H}.getState().then(({state}) => state)`)).spaces;
    const main = spaces.find((x) => !x.profileId);
    const home = spaces.find((x) => x.name === 'Home');
    await b.eval(`${H}.activateSpace(${JSON.stringify(main.id)})`);
    assert.deepEqual(await savedPasswords(b), ['alice@bank.example'], 'the personal space has Arc Default\'s password');
    await b.eval(`${H}.activateSpace(${JSON.stringify(home.id)})`);
    await b.waitFor(`app.$.tabstrip.state_.profileId === 'Meridian Profile Arc 2'`);
    assert.deepEqual(await savedPasswords(b), ['bob@tax.example'], 'Home has Arc Profile 2\'s password');
    // Again: they're all there, nothing doubles.
    assert.equal(await press(), 'They’re all here already.');
    assert.deepEqual(await savedPasswords(b), ['bob@tax.example']);
  } finally {
    await b.close(); s.close();
    fs.rmSync(arcDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the rest of Arc

const chromeTime = (ms) => BigInt(Math.round(ms)) * 1000n + 11644473600000000n;

// Arc's "History": pages with how often they were visited and typed.
function writeArcHistory(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
    visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
    last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`);
  const insert = db.prepare('INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, 5, 2, ?)');
  for (const r of rows) insert.run(r.url, r.title, chromeTime(r.at ?? Date.now() - 3600000));
  db.close();
}

// Arc's "Web Data": things typed into forms, an address, a card (its number and security code
// encrypted like the passwords) and site searches (one made by the person, one Arc's own).
function writeArcWebData(dir, password, { forms = [], address, card, engines = [] }) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Web Data'));
  db.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
    INSERT INTO meta VALUES('version', '154');
    CREATE TABLE autofill(name VARCHAR, value VARCHAR, value_lower VARCHAR, date_created INTEGER DEFAULT 0,
      date_last_used INTEGER DEFAULT 0, count INTEGER DEFAULT 1, PRIMARY KEY (name, value));
    CREATE TABLE addresses(guid VARCHAR PRIMARY KEY, use_count INTEGER NOT NULL DEFAULT 0, use_date INTEGER NOT NULL DEFAULT 0,
      date_modified INTEGER NOT NULL DEFAULT 0, language_code VARCHAR, label VARCHAR, initial_creator_id INTEGER DEFAULT 0,
      record_type INTEGER);
    CREATE TABLE address_type_tokens(guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER DEFAULT 0,
      observations BLOB, PRIMARY KEY (guid, type));
    CREATE TABLE credit_cards(guid VARCHAR PRIMARY KEY, name_on_card VARCHAR, expiration_month INTEGER, expiration_year INTEGER,
      card_number_encrypted BLOB, date_modified INTEGER NOT NULL DEFAULT 0, use_count INTEGER NOT NULL DEFAULT 0,
      use_date INTEGER NOT NULL DEFAULT 0, billing_address_id VARCHAR, nickname VARCHAR, is_user_confirmed INTEGER DEFAULT 0);
    CREATE TABLE local_stored_cvc(guid VARCHAR PRIMARY KEY, value_encrypted BLOB, last_updated_timestamp INTEGER);
    CREATE TABLE keywords(id INTEGER PRIMARY KEY, short_name VARCHAR NOT NULL, keyword VARCHAR NOT NULL, favicon_url VARCHAR NOT NULL,
      url VARCHAR NOT NULL, safe_for_autoreplace INTEGER, originating_url VARCHAR, date_created INTEGER DEFAULT 0,
      usage_count INTEGER DEFAULT 0, input_encodings VARCHAR, suggest_url VARCHAR, prepopulate_id INTEGER DEFAULT 0,
      created_by_policy INTEGER DEFAULT 0, last_modified INTEGER DEFAULT 0, sync_guid VARCHAR, alternate_urls VARCHAR,
      image_url VARCHAR, search_url_post_params VARCHAR, suggest_url_post_params VARCHAR, image_url_post_params VARCHAR,
      new_tab_url VARCHAR, last_visited INTEGER DEFAULT 0, created_from_play_api INTEGER DEFAULT 0, is_active INTEGER DEFAULT 0,
      starter_pack_id INTEGER DEFAULT 0, enforced_by_policy INTEGER DEFAULT 0, featured_by_policy INTEGER DEFAULT 0, url_hash BLOB)`);
  const now = Math.floor(Date.now() / 1000) - 60;
  for (const [name, value] of forms) {
    db.prepare('INSERT INTO autofill VALUES (?, ?, ?, ?, ?, 1)').run(name, value, value.toLowerCase(), now - 600, now);
  }
  if (address) {
    db.prepare('INSERT INTO addresses VALUES (?, 3, ?, ?, \'\', \'\', 70073, 0)').run('addr-1', now, now);
    for (const [type, value] of Object.entries(address)) {
      db.prepare('INSERT INTO address_type_tokens VALUES (\'addr-1\', ?, ?, 4, NULL)').run(Number(type), value);
    }
  }
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const encrypt = (text) => {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from('v10'), c.update(Buffer.from(text)), c.final()]);
  };
  if (card) {
    db.prepare('INSERT INTO credit_cards VALUES (\'card-1\', ?, ?, ?, ?, ?, 2, ?, \'\', ?, 1)')
      .run(card.name, card.month, card.year, encrypt(card.number), now, now, card.nickname || '');
    if (card.cvc) db.prepare('INSERT INTO local_stored_cvc VALUES (\'card-1\', ?, ?)').run(encrypt(card.cvc), now);
  }
  for (const e of engines) {
    db.prepare(`INSERT INTO keywords(short_name, keyword, favicon_url, url, safe_for_autoreplace, date_created, input_encodings,
      prepopulate_id, last_modified, sync_guid, alternate_urls, is_active) VALUES (?, ?, '', ?, ?, ?, 'UTF-8', ?, ?, ?, '[]', 1)`)
      .run(e.name, e.keyword, e.url, e.auto ? 1 : 0, chromeTime(Date.now() - 86400000), e.prepopulate || 0,
        chromeTime(Date.now() - 86400000), crypto.randomUUID());
  }
  db.close();
}

// Arc's "Preferences": a site's notifications allowed, its location blocked, and a one-time
// camera grant (that stays behind).
function writeArcPreferences(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  const entry = (setting, expiration = '0') => ({ setting, expiration, last_modified: '13370000000000000', lifetime: '0' });
  fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({
    profile: { content_settings: { exceptions: {
      notifications: { [`${origin},*`]: entry(1) },
      geolocation: { [`${origin},*`]: entry(2) },
      media_stream_camera: { [`${origin},*`]: entry(1, String(Date.now() * 1000 + 11644473600000000 + 3600e6)) },
      durable_storage: { [`${origin},*`]: entry(1) },
    } } },
  }));
}

// Pages of the test site. /store keeps a localStorage value and an IndexedDB record (to make Arc's
// site data with a real Chromium); /ls and /idb show them in the title; /search shows its query.
async function siteWithStorage() {
  const page = (body) => `<!doctype html><meta charset="utf-8"><body><script>${body}</script>`;
  const idbRead = `const r = indexedDB.open('arc', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('who');
      g.onsuccess = () => { document.title = 'idb:' + (g.result || ''); }; g.onerror = () => { document.title = 'idb:'; }; };`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (u.pathname === '/store') {
      res.end(page(`localStorage.setItem('token', 'arc-session');
        const r = indexedDB.open('arc', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put('arc-user', 'who');
          t.oncomplete = () => { document.title = 'stored'; }; };`));
    } else if (u.pathname === '/ls') {
      res.end(page(`document.title = 'ls:' + (localStorage.getItem('token') || '');`));
    } else if (u.pathname === '/idb') {
      res.end(page(idbRead));
    } else if (u.pathname === '/search') {
      res.end(`<title>search:${u.searchParams.get('q')}</title>`);
    } else {
      res.end(`<title>${decodeURIComponent(u.pathname.slice(1))}</title>`);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, u: (p) => `${origin}${p.startsWith('/') ? '' : '/'}${p}`, close: () => { server.closeAllConnections(); server.close(); } };
}

// Arc's own site data, made the way Arc (Chromium) makes it: a browser visits /store, and its
// "Local Storage" and "IndexedDB" folders become Arc's.
async function seedArcSiteData(s, arcProfileDir) {
  // Arc's Chromium keeps localStorage in LevelDB ("Local Storage/leveldb"); this one is moving
  // to SQLite in a field trial, so without the trials.
  const b = await launch([s.u('/store')], { args: ['--disable-field-trial-config'] });
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'stored')`, 15000);
    await new Promise((r) => setTimeout(r, 6000));  // localStorage commits after a few seconds
    await b.quit();
    if (!fs.existsSync(path.join(b.profile, 'Default', 'Local Storage'))) {
      throw new Error(`no site data made: ${fs.readdirSync(b.profile)} / ${fs.readdirSync(path.join(b.profile, 'Default'))}`);
    }
    for (const sub of ['Local Storage', 'IndexedDB']) {
      fs.cpSync(path.join(b.profile, 'Default', sub), path.join(arcProfileDir, sub), { recursive: true });
    }
  } finally { await b.close(); }
}

async function pageEval(b, prefix, expression) {
  const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(prefix));
  if (!t) return undefined;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const reply = await new Promise((r) => {
    ws.onmessage = (m) => r(JSON.parse(m.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return reply.result?.result?.value;
}

// The list a chrome://settings page shows (addresses or cards), through its own private API.
async function settingsList(b, page, expression) {
  await b.eval(`app.$.tabstrip.openUrl('chrome://settings/${page}')`);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const list = await pageEval(b, 'chrome://settings', expression);
    if (list) {
      const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith('chrome://settings'));
      await fetch(`${b.base}/json/close/${t.id}`);
      return list;
    }
  }
  return null;
}

const KEYCODE = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, 9: 25, 7: 26, 8: 28, 0: 29, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38,
  k: 40, n: 45, m: 46, '.': 47, ' ': 49,
};

test('the rest of Arc comes over from Settings: history, form entries, an address and a card, site permissions, a site search, sites\' data, Air Traffic Control and the archive; again adds nothing', async () => {
  const s = await siteWithStorage();
  const arcDir = arcWithTwoProfiles(s.u);
  const arcDefault = path.join(arcDir, 'User Data', 'Default');
  const arcWork = path.join(arcDir, 'User Data', 'Profile 2');
  await seedArcSiteData(s, arcDefault);
  writeArcHistory(arcDefault, [{ url: s.u('/kiwi-arc-personal'), title: 'kiwi-arc-personal' }]);
  writeArcHistory(arcWork, [{ url: s.u('/kiwi-arc-work'), title: 'kiwi-arc-work' }]);
  writeArcWebData(arcDefault, 'test-pass', {
    forms: [['email', 'alice@example.com'], ['city', 'Batumi']],
    address: { 7: 'Alice Example', 77: '1 Rustaveli Ave', 33: 'Batumi', 35: '6000', 36: 'GE', 9: 'alice@example.com' },
    card: { name: 'Alice Example', month: 4, year: 2031, number: '4111111111111111', cvc: '123', nickname: 'Travel' },
    engines: [
      { name: 'Kiwi search', keyword: 'kiwi', url: `${s.origin}/search?q={searchTerms}` },
      { name: 'Arc built-in', keyword: 'arcbuiltin', url: 'https://example.com/?q={searchTerms}', prepopulate: 1 },
    ],
  });
  writeArcPreferences(arcDefault, s.origin);
  // Arc's archive: a tab of Home, and one of a page that isn't on the web.
  const apple = (ms) => ms / 1000 - 978307200;
  fs.writeFileSync(path.join(arcDir, 'StorableArchiveItems.json'), JSON.stringify({ version: 1, items: [
    'a1', { sidebarItem: { id: 'a1', title: null, childrenIds: [], data: { tab: { savedURL: s.u('/old-arc-tab'), savedTitle: 'Old Arc tab' } } },
      source: { space: { _0: 's-home' } }, archivedAt: apple(Date.now() - 86400000), reason: 'manual' },
    'a2', { sidebarItem: { id: 'a2', title: null, childrenIds: [], data: { tab: { savedURL: 'file:///etc/hosts', savedTitle: 'Hosts' } } },
      source: { space: { _0: 's-work' } }, archivedAt: apple(Date.now() - 7200000), reason: 'auto' },
  ] }));
  // Air Traffic Control: zoom links to Home; one rule about the app a link comes from can't be kept.
  fs.writeFileSync(path.join(arcDir, 'StorableLinkRouting.json'), JSON.stringify({ version: 1,
    defaultDestination: { space: { _0: { mostRecent: {} } } },
    rules: [
      { id: 'r1', destination: { space: { _0: { specific: { _0: 's-home' } } } },
        sourceComponents: [{ id: 'c1', componentType: { urlMatch: { _0: { contains: {} }, _1: 'zoom.us' } } }] },
      { id: 'r2', destination: { littleArc: { _0: { mostRecent: {} } } },
        sourceComponents: [{ id: 'c2', componentType: { sourceApp: { _0: 'com.tinyspeck.slackmacgap' } } }] },
    ] }));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const args = [`--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass', '--meridian-test-keys'];
  const ST = 'app.$.settings.shadowRoot';
  let b = await launch(['about:blank'], { profile, args });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Arc's spaces came in earlier, without the rest.
    assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
    const press = async (button, note) => {
      await b.eval(`app.$.tabstrip.runCommand(13, 0)`);  // Meridian > Settings
      await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('${button}')`);
      await b.click(`${ST}.getElementById('${button}')`);
      await b.waitFor(`!/Bringing/.test(${ST}.getElementById('${note}').textContent) && /\\./.test(${ST}.getElementById('${note}').textContent)`, 30000);
      const text = (await b.eval(`${ST}.getElementById('${note}').textContent`)).replace(/\s+/g, ' ').trim();
      await b.eval(`${ST}.getElementById('close').click()`);
      await b.waitFor('!app.$.settings.open');
      return text;
    };
    assert.equal(await press('importArcData', 'arcDataNote'),
      'Brought over: 2 pages of history, 2 form entries, 1 address, 2 site permissions, 1 site search, ' +
      'data of 1 site (1 more site when Meridian next opens), 1 Air Traffic Control rule, 1 archived tab.');
    // The card comes with the passwords (Arc's key opens both).
    assert.equal(await press('importArcPasswords', 'arcPasswordsNote'), '1 card brought over.');

    const T = 'app.$.tabstrip';
    const spaces = (await b.eval(`${H}.getState().then(({state}) => state)`)).spaces;
    const home = spaces.find((x) => x.name === 'Home');
    const work = spaces.find((x) => x.name === 'Work');
    await b.eval(`${H}.activateSpace(${JSON.stringify(work.id)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(work.id)}`);

    // The site's localStorage is there at once.
    await b.eval(`${T}.openUrl(${JSON.stringify(s.u('/ls'))})`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title.startsWith('ls:'))`);
    assert.equal(await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('ls:')).tab.title`), 'ls:arc-session');
    // Its permissions: notifications allowed, location blocked, the one-time camera grant not kept.
    assert.deepEqual(await pageEval(b, s.u('/ls'), `Promise.all(['notifications', 'geolocation', 'camera'].map((name) =>
      navigator.permissions.query({ name }).then((p) => p.state)))`), ['granted', 'denied', 'prompt']);

    // ⌘T knows Arc's history: the personal profile's here, the work profile's in Home.
    const press1 = ([code, ch], mods = 0) => b.eval(`${T}.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
    const type = async (text) => { for (const ch of text) await press1([KEYCODE[ch], ch]); };
    const CB = 'app.$.commandBar.shadowRoot';
    const matches = () => b.eval(`(() => {
      const dd = ${CB}.getElementById('address').shadowRoot.querySelector('cr-searchbox-dropdown');
      return dd && !dd.hidden ? [...dd.shadowRoot.querySelectorAll('cr-searchbox-match')].map((m) => m.match?.destinationUrl?.url ?? m.match?.destinationUrl ?? '') : [];
    })()`);
    const suggest = async (text) => {
      await b.click('app.$.contentRegion');
      await press1([17, 't'], 1 << 20);
      await b.waitFor('app.$.commandBar.open');
      await type(text);
      let seen = '', since = Date.now(), got = [];
      for (const end = Date.now() + 8000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
        got = await matches();
        const now = JSON.stringify(got);
        if (now !== seen) { seen = now; since = Date.now(); } else if (Date.now() - since > 700 && got.length) break;
      }
      return got.join(' | ');
    };
    const esc = async () => { await press1([53, '\u001b']); await b.waitFor('!app.$.commandBar.open'); };
    let got = await suggest('kiwi');
    assert.match(got, /kiwi-arc-personal/, got);
    assert.doesNotMatch(got, /kiwi-arc-work/, got);
    await esc();
    // Arc's site search: "kiwi pear" + Return searches the site.
    await suggest('kiwi pear');
    await press1([36, '\r']);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'search:pear')`);
    await b.eval(`${H}.activateSpace(${JSON.stringify(home.id)})`);
    await b.waitFor(`${T}.state_.profileId === 'Meridian Profile Arc 2'`);
    got = await suggest('kiwi');
    assert.match(got, /kiwi-arc-work/, got);
    assert.doesNotMatch(got, /kiwi-arc-personal/, got);
    await esc();
    await b.eval(`${H}.activateSpace(${JSON.stringify(work.id)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(work.id)}`);

    // The address and the card, in Chromium's settings.
    assert.deepEqual(await settingsList(b, 'addresses', `chrome.autofillPrivate.getAddressList().then((l) => l.map((a) => a.metadata.summaryLabel))`), ['Alice Example']);
    assert.deepEqual(await settingsList(b, 'payments', `chrome.autofillPrivate.getCreditCardList().then((l) => l.map((c) => [c.nickname, c.cardNumber.slice(-4), Number(c.expirationMonth), Number(c.expirationYear)]))`),
      [['Travel', '1111', 4, 2031]]);

    // Air Traffic Control: zoom links go to Home; other links to the space you're in.
    const { settings } = await b.eval(`${H}.getSettings()`);
    assert.deepEqual(settings.atc.rules.map((r) => [r.pattern, r.target]), [['*zoom.us*', `space:${home.id}`]]);
    assert.equal(settings.atc.fallback, 'main');
    // The archive: Arc's tab of Home (the local file stays behind).
    // (The settings pages closed above are in it too.)
    const archived = async (q) => (await b.eval(`${H}.searchArchive(${JSON.stringify(q)})`)).tabs.map((t) => [t.title, t.spaceId]);
    assert.deepEqual(await archived('Old Arc'), [['Old Arc tab', home.id]]);
    assert.deepEqual(await archived('Hosts'), []);

    // Again: all here already.
    assert.equal(await press('importArcData', 'arcDataNote'), 'It’s all here already.');
    assert.equal(await press('importArcPasswords', 'arcPasswordsNote'), 'They’re all here already.');
    await b.quit();

    // The site's database moved in when Meridian opened again.
    b = await launch([s.u('/idb')], { profile, args });
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title.startsWith('idb:'))`, 15000);
    assert.equal(await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('idb:')).tab.title`), 'idb:arc-user');
    assert.equal(fs.existsSync(path.join(profile, 'Default', 'Meridian Arc Staged')), false);
  } finally {
    await b.close(); s.close();
    fs.rmSync(arcDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
