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
