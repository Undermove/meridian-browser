// Moving in from other browsers (fake folders in each browser's own format, never the real ones):
// Brave, Edge, Vivaldi and Opera keep their profiles as Chrome does, so each profile becomes a
// space with its bookmarks, the tabs it had open and its sign-ins; macOS asks about the browser's
// own "<Name> Safe Storage" keychain item. Opera keeps its one profile right in its folder.
// Firefox (profiles.ini, places.sqlite) and Safari (Bookmarks.plist, History.db) bring bookmarks
// and history only, and say so. The first run and Import from Another Browser list every browser
// found here to pick from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { launch, SB } from './harness.mjs';
import { writeHistory, writePasswords } from './chromium_profile.mjs';

const H = 'app.$.tabstrip.handler_';
const OB = 'app.$.onboarding.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `meridian-${name}-`));

async function serve() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url} cookie:${req.headers.cookie || ''}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, hits, port, url: (p) => `http://127.0.0.1:${port}${p}` };
}

// A Chromium profile's Cookies database, encrypted the way Chromium browsers on macOS do it.
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
    insert.run(toChrome(Date.now() - 1000), r.host, r.name, Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]), toChrome(Date.now() + 86400000), toChrome(Date.now()), r.port);
  }
  db.close();
}

const bookmark = (name, url) => ({ type: 'url', name, url });
const folder = (name, children) => ({ type: 'folder', name, children });
const bookmarks = (bar, other = []) => JSON.stringify({ version: 1, roots: {
  bookmark_bar: folder('Bookmarks bar', bar), other: folder('Other bookmarks', other), synced: folder('Mobile bookmarks', []),
} });

// A Chromium browser's folder as Chrome keeps it: "Local State" naming the profiles, a folder per
// profile with its Bookmarks. `root`: Opera's way, the one profile right in the folder.
function fakeChromium(name, profiles, { root = false } = {}) {
  const dir = tmp(name);
  const info = {};
  profiles.forEach((p, i) => { info[i ? `Profile ${i}` : 'Default'] = { name: p.name }; });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: root ? {} : info } }));
  profiles.forEach((p, i) => {
    const pdir = root ? dir : path.join(dir, i ? `Profile ${i}` : 'Default');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'Bookmarks'), bookmarks(p.bar, p.other));
  });
  return dir;
}

// A session file (SNSS) with these tabs open: from a Meridian run, which writes them the way every
// Chromium browser does.
async function sessionWith(urls) {
  const run = tmp('e2e');
  const b = await launch(urls, { profile: run });
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].filter((r) => r.tab.title.startsWith('page /open')).length === ${urls.length}`, 15000);
    await sleep(1500);
  } finally { await b.quit(); }
  const sessions = path.join(run, 'Default', 'Sessions');
  const files = fs.readdirSync(sessions).filter((n) => n.startsWith('Session_')).map((f) => [f, fs.readFileSync(path.join(sessions, f))]);
  fs.rmSync(run, { recursive: true, force: true });
  return (into) => {
    fs.mkdirSync(path.join(into, 'Sessions'), { recursive: true });
    for (const [f, data] of files) fs.writeFileSync(path.join(into, 'Sessions', f), data);
  };
}

// Firefox: profiles.ini and a profile's places.sqlite (bookmarks and history in one database).
function fakeFirefox(url) {
  const dir = tmp('firefox');
  const rel = 'Profiles/abcd1234.default-release';
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Profiles/old.default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles.ini'), [
    '[Install4F96D1932A9F858E]', `Default=${rel}`, 'Locked=1', '',
    '[Profile1]', 'Name=default', 'IsRelative=1', 'Path=Profiles/old.default', 'Default=1', '',
    '[Profile0]', 'Name=default-release', 'IsRelative=1', `Path=${rel}`, '',
    '[General]', 'StartWithLastProfile=1', 'Version=2', ''].join('\n'));
  const db = new DatabaseSync(path.join(dir, rel, 'places.sqlite'));
  db.exec(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR,
      visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL,
      frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT, foreign_count INTEGER DEFAULT 0 NOT NULL,
      url_hash INTEGER DEFAULT 0 NOT NULL, description TEXT, preview_image_url TEXT, origin_id INTEGER);
    CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER,
      position INTEGER, title LONGVARCHAR, keyword_id INTEGER, folder_type TEXT, dateAdded INTEGER,
      lastModified INTEGER, guid TEXT, syncStatus INTEGER NOT NULL DEFAULT 0, syncChangeCounter INTEGER NOT NULL DEFAULT 1);`);
  const now = BigInt(Date.now()) * 1000n;
  const place = db.prepare('INSERT INTO moz_places(id, url, title, visit_count, typed, last_visit_date) VALUES (?, ?, ?, ?, ?, ?)');
  place.run(1, url('/fx-mail'), 'Fx Mail', 3, 1, now - 3600000000n);
  place.run(2, url('/fx-spec'), 'Fx Spec', 1, 0, now - 7200000000n);
  place.run(3, 'https://example.com/fx-read', 'Fx Read', 2, 0, now - 1800000000n);
  place.run(4, 'place:sort=8&maxResults=10', 'Most visited', 0, 0, null);
  const mark = db.prepare('INSERT INTO moz_bookmarks(id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)');
  mark.run(1, 2, null, 0, 0, '', 'root________');
  mark.run(2, 2, null, 1, 0, 'menu', 'menu________');
  mark.run(3, 2, null, 1, 1, 'toolbar', 'toolbar_____');
  mark.run(4, 2, null, 1, 2, 'tags', 'tags________');
  mark.run(5, 2, null, 1, 3, 'unfiled', 'unfiled_____');
  mark.run(6, 2, null, 1, 4, 'mobile', 'mobile______');
  mark.run(10, 1, 1, 3, 0, 'Fx Mail', 'aaaaaaaaaaa1');
  mark.run(11, 2, null, 3, 1, 'Work', 'aaaaaaaaaaa2');
  mark.run(12, 1, 2, 11, 0, 'Fx Spec', 'aaaaaaaaaaa3');
  mark.run(13, 1, 4, 3, 2, 'Most visited', 'aaaaaaaaaaa4');
  mark.run(14, 3, null, 3, 3, '', 'aaaaaaaaaaa5');
  db.close();
  return dir;
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const leaf = (title, url) => `<dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>${xml(url)}</string><key>URIDictionary</key><dict><key>title</key><string>${xml(title)}</string></dict></dict>`;
const list = (title, kids) => `<dict><key>Title</key><string>${xml(title)}</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>Children</key><array>${kids.join('')}</array></dict>`;

// Safari: ~/Library/Safari's Bookmarks.plist (the favorites bar, the menu, the reading list) and
// History.db.
function fakeSafari(url) {
  const dir = tmp('safari');
  fs.writeFileSync(path.join(dir, 'Bookmarks.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Children</key><array>
<dict><key>Title</key><string>History</string><key>WebBookmarkType</key><string>WebBookmarkTypeProxy</string></dict>
${list('BookmarksBar', [leaf('Sf Mail', url('/sf-mail')), list('Trips', [leaf('Sf Map', url('/sf-map'))])])}
${list('BookmarksMenu', [leaf('Sf News', url('/sf-news'))])}
${list('com.apple.ReadingList', [])}
</array><key>Title</key><string></string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></plist>`);
  const db = new DatabaseSync(path.join(dir, 'History.db'));
  db.exec(`CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, domain_expansion TEXT NULL,
      visit_count INTEGER NOT NULL, daily_visit_counts BLOB NOT NULL DEFAULT x'', weekly_visit_counts BLOB NULL,
      autocomplete_triggers BLOB NULL, should_recompute_derived_visit_counts INTEGER NOT NULL DEFAULT 0, visit_count_score INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT, history_item INTEGER NOT NULL, visit_time REAL NOT NULL,
      title TEXT NULL, load_successful BOOLEAN NOT NULL DEFAULT 1, http_non_get BOOLEAN NOT NULL DEFAULT 0, synthesized BOOLEAN NOT NULL DEFAULT 0,
      redirect_source INTEGER NULL, redirect_destination INTEGER NULL, origin INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
      attributes INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0);`);
  const apple = (ms) => ms / 1000 - 978307200;
  db.prepare('INSERT INTO history_items(id, url, visit_count) VALUES (?, ?, ?)').run(1, 'https://example.com/sf-read', 2);
  db.prepare('INSERT INTO history_items(id, url, visit_count) VALUES (?, ?, ?)').run(2, url('/sf-mail'), 1);
  const visit = db.prepare('INSERT INTO history_visits(history_item, visit_time, title) VALUES (?, ?, ?)');
  visit.run(1, apple(Date.now() - 7200000), 'Old title');
  visit.run(1, apple(Date.now() - 3600000), 'Sf Read');
  visit.run(2, apple(Date.now() - 1800000), 'Sf Mail');
  db.close();
  return dir;
}

const stats = (b) => b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`);

test('Brave: a space per profile with its bookmarks, open tabs and sign-ins; macOS asks about “Brave Safe Storage”', async () => {
  const s = await serve();
  const session = await sessionWith([s.url('/open-one'), s.url('/open-two')]);
  const brave = fakeChromium('brave', [
    { name: 'Home', bar: [bookmark('Mail', s.url('/mail')), folder('Docs', [bookmark('Spec', s.url('/spec'))])], other: [bookmark('Recipes', s.url('/recipes'))] },
    { name: 'Work', bar: [bookmark('Tracker', s.url('/tracker'))] },
  ]);
  session(path.join(brave, 'Default'));
  writeCookies(path.join(brave, 'Default'), 'brave-pass', [{ host: '127.0.0.1', name: 'sid', value: 'brave-in', port: s.port }]);
  writePasswords(path.join(brave, 'Default'), 'brave-pass', [{ url: 'https://accounts.example.com/login', username: 'ada', password: 'hunter2' }]);
  s.hits.length = 0;
  const b = await launch(['about:blank'], { args: [`--meridian-brave-dir=${brave}`, '--meridian-brave-safe-storage=brave-pass', '--lang=en-US'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.onboarding.show('brave')`);
    await b.waitFor(`app.$.onboarding.open && ${OB}.querySelector('h2')?.textContent.includes('Bring everything from Brave')`);
    // Real counts, the passwords counted without decrypting them.
    assert.deepEqual(await stats(b), ['2 profiles', '2 open tabs', '4 bookmarks', '1 password']);
    assert.match(await b.eval(`${OB}.querySelector('.whisper.top').textContent.replace(/\\s+/g, ' ')`), /Each Brave profile becomes a space/);
    assert.equal(await b.eval(`!!${OB}.getElementById('limited')`), false);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!!${OB}.querySelector('.confirm')`);
    const mock = `${OB}.querySelector('.confirm meridian-mac-ask').shadowRoot`;
    assert.match(await b.eval(`${mock}.querySelector('.title').textContent`), /“Brave Safe Storage”/);
    assert.match(await b.eval(`${OB}.querySelector('.confirm').textContent.replace(/\\s+/g, ' ')`), /copies Brave’s sign-ins.*Pressed Deny\? Your tabs and bookmarks still come over/);
    await b.click(`${OB}.getElementById('confirmContinue')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Home,Work'`, 15000);
    const pinned = await b.pinned();
    assert.deepEqual(pinned.filter((p) => p.depth === 0).map((p) => [p.title, p.folder]), [['Mail', false], ['Docs', true], ['Other bookmarks', true]]);
    const st = await b.eval(`${H}.getState().then(({state}) => state)`);
    assert.equal(st.spaces.find((x) => x.name === 'Work').profileId, 'Meridian Profile Brave 1');
    // Brave's open tabs: Today tabs that wait to be opened.
    await b.waitFor(`['/open-one', '/open-two'].every((p) => [...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.url === ${JSON.stringify(s.url(''))} + p))`, 10000);
    assert.deepEqual(s.hits.filter((h) => h.startsWith('/open')), []);
    // Signed in: Brave's cookie came over.
    await b.waitFor(`[...${OB}.querySelectorAll('.whisper')].some((e) => e.textContent.includes('still signed in'))`, 10000);
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(s.url('/check'))})`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'page /check cookie:sid=brave-in')`, 10000);
  } finally { await b.close(); s.server.close(); fs.rmSync(brave, { recursive: true, force: true }); }
});

test('Edge asks about “Microsoft Edge Safe Storage”; Deny still brings tabs and bookmarks', async () => {
  const s = await serve();
  const edge = fakeChromium('edge', [{ name: 'Profile 1', bar: [bookmark('Outlook', s.url('/outlook'))] }]);
  writePasswords(path.join(edge, 'Default'), 'edge-pass', [{ url: 'https://accounts.example.com/login', username: 'ada', password: 'x' }]);
  writeHistory(path.join(edge, 'Default'), [{ url: 'https://example.com/edge-read', title: 'Edge read' }]);
  const b = await launch(['about:blank'], { args: [`--meridian-edge-dir=${edge}`, '--meridian-edge-safe-storage=__deny__', '--lang=en-US'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.onboarding.show('edge')`);
    await b.waitFor(`app.$.onboarding.open && ${OB}.querySelector('h2')?.textContent.includes('Bring everything from Edge')`);
    assert.deepEqual(await stats(b), ['1 profile', '1 bookmark', '1 password']);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!!${OB}.querySelector('.confirm')`);
    const mock = `${OB}.querySelector('.confirm meridian-mac-ask').shadowRoot`;
    assert.match(await b.eval(`${mock}.querySelector('.title').textContent`), /“Microsoft Edge Safe Storage”/);
    await b.click(`${OB}.getElementById('confirmContinue')`);
    // Edge's own name for an unnamed profile ("Profile 1") gives way to "Edge".
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Edge'`, 15000);
    assert.deepEqual((await b.pinned()).map((p) => p.title), ['Outlook']);
    await b.waitFor(`[...${OB}.querySelectorAll('.whisper')].some((e) => e.textContent.includes('weren’t brought over'))`, 10000);
    assert.match(await b.eval(`[...${OB}.querySelectorAll('.whisper')].map((e) => e.textContent).join(' ')`), /Import from Another Browser \(Edge\)/);
  } finally { await b.close(); s.server.close(); fs.rmSync(edge, { recursive: true, force: true }); }
});

test('Opera keeps its profile in its own folder; Vivaldi as Chrome: both counted and brought', async () => {
  const s = await serve();
  const opera = fakeChromium('opera', [{ name: '', bar: [bookmark('Speed dial', s.url('/dial')), bookmark('News', s.url('/news'))] }], { root: true });
  writePasswords(opera, 'opera-pass', [{ url: 'https://accounts.example.com/login', username: 'ada', password: 'x' }]);
  const vivaldi = fakeChromium('vivaldi', [{ name: 'Vivaldi', bar: [bookmark('Forum', s.url('/forum'))] }]);
  const b = await launch(['about:blank'], { args: [`--meridian-opera-dir=${opera}`, '--meridian-opera-safe-storage=opera-pass', `--meridian-vivaldi-dir=${vivaldi}`, '--lang=en-US'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { preview } = await b.eval(`${H}.getArcPreview('opera')`);
    assert.deepEqual({ s: preview.spaceCount, p: preview.pinnedCount, pw: preview.passwordCount, logins: preview.loginsAvailable }, { s: 1, p: 2, pw: 1, logins: true });
    assert.equal((await b.eval(`${H}.getArcPreview('vivaldi')`)).preview.pinnedCount, 1);
    assert.equal((await b.eval(`${H}.importArc('opera')`)).ok, true);
    await b.waitFor(`app.$.tabstrip.state_.spaces.some((s) => s.name === 'Opera')`, 15000);
    const pw = await b.eval(`${H}.importArcPasswords('opera')`);
    assert.deepEqual([pw.imported, pw.error], [1, '']);
    assert.equal((await b.eval(`${H}.importArc('vivaldi')`)).ok, true);
    await b.waitFor(`app.$.tabstrip.state_.spaces.some((s) => s.name === 'Vivaldi')`, 15000);
  } finally { await b.close(); s.server.close(); fs.rmSync(opera, { recursive: true, force: true }); fs.rmSync(vivaldi, { recursive: true, force: true }); }
});

test('Firefox: bookmarks and history only, and the step says so; no keychain question', async () => {
  const s = await serve();
  const fx = fakeFirefox(s.url);
  const b = await launch(['about:blank'], { args: [`--meridian-firefox-dir=${fx}`, '--lang=en-US'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.onboarding.show('firefox')`);
    await b.waitFor(`app.$.onboarding.open && ${OB}.querySelector('h2')?.textContent.includes('Bring everything from Firefox')`);
    // The profile with places.sqlite only; javascript-free web pages only ("place:" queries stay).
    assert.deepEqual(await stats(b), ['2 bookmarks', '3 pages of history']);
    assert.match(await b.eval(`${OB}.getElementById('limited').textContent.replace(/\\s+/g, ' ')`), /Only bookmarks and history come from Firefox: its open tabs, passwords and sign-ins stay there/);
    assert.equal(await b.eval(`!!${OB}.getElementById('logins')`), false);
    await b.click(`${OB}.getElementById('next')`);
    assert.equal(await b.eval(`!!${OB}.querySelector('.confirm')`), false);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Firefox'`, 15000);
    const pinned = await b.pinned();
    assert.deepEqual(pinned.filter((p) => p.depth === 0).map((p) => [p.title, p.folder]), [['Fx Mail', false], ['Work', true]]);
    await b.waitFor(`[...${OB}.querySelectorAll('.whisper')].some((e) => e.textContent.includes('history and the rest came too'))`, 10000);
    // Again: nothing twice.
    const again = await b.eval(`${H}.importArcData('firefox')`);
    assert.equal(again.result.history, 0);
  } finally { await b.close(); s.server.close(); fs.rmSync(fx, { recursive: true, force: true }); }
});

test('Safari: favorites bar on top, the menu as a folder, its history; no keychain question', { skip: process.platform === 'win32' && 'Safari is macOS only' }, async () => {
  const s = await serve();
  const sf = fakeSafari(s.url);
  const b = await launch(['about:blank'], { args: [`--meridian-safari-dir=${sf}`, '--lang=en-US'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.onboarding.show('safari')`);
    await b.waitFor(`app.$.onboarding.open && ${OB}.querySelector('h2')?.textContent.includes('Bring everything from Safari')`);
    assert.deepEqual(await stats(b), ['3 bookmarks', '2 pages of history']);
    assert.ok(await b.eval(`!!${OB}.getElementById('limited')`));
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Safari'`, 15000);
    const pinned = await b.pinned();
    assert.deepEqual(pinned.filter((p) => p.depth === 0).map((p) => [p.title, p.folder]), [['Sf Mail', false], ['Trips', true], ['Bookmarks menu', true]]);
    await b.waitFor(`[...${OB}.querySelectorAll('.whisper')].some((e) => e.textContent.includes('history and the rest came too'))`, 10000);
    const again = await b.eval(`${H}.importArcData('safari')`);
    assert.equal(again.result.history, 0);
  } finally { await b.close(); s.server.close(); fs.rmSync(sf, { recursive: true, force: true }); }
});

test('Safari’s files kept private by macOS: says how to allow Meridian, brings nothing', { skip: (process.platform === 'win32' && 'Safari is macOS only') || process.getuid?.() === 0 }, async () => {
  const s = await serve();
  const sf = fakeSafari(s.url);
  fs.chmodSync(path.join(sf, 'Bookmarks.plist'), 0o000);
  fs.chmodSync(path.join(sf, 'History.db'), 0o000);
  const log = path.join(sf, 'asks.log');
  const b = await launch(['about:blank'], { args: [`--meridian-safari-dir=${sf}`, `--meridian-test-system-asks=${log}`, '--lang=en-US'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.onboarding.show('safari')`);
    await b.waitFor(`app.$.onboarding.open && !!${OB}.getElementById('fullDisk')`);
    assert.match(await b.eval(`${OB}.querySelector('.whisper.top').textContent.replace(/\\s+/g, ' ')`), /Full Disk Access/);
    assert.equal(await b.eval(`${OB}.getElementById('next').textContent.trim()`), 'Continue');
    await b.click(`${OB}.getElementById('fullDisk')`);
    for (let i = 0; i < 20 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('settings full-disk')); i++) await sleep(250);
    assert.match(fs.readFileSync(log, 'utf8'), /settings full-disk/);
  } finally {
    await b.close(); s.server.close();
    fs.chmodSync(path.join(sf, 'Bookmarks.plist'), 0o600); fs.chmodSync(path.join(sf, 'History.db'), 0o600);
    fs.rmSync(sf, { recursive: true, force: true });
  }
});

test('the first run lists every browser found; Import from Another Browser too; the menu names each', async () => {
  const s = await serve();
  const chrome = fakeChromium('chrome', [{ name: 'Personal', bar: [bookmark('Mail', s.url('/mail'))] }]);
  const brave = fakeChromium('brave', [{ name: 'Brave', bar: [bookmark('Search', s.url('/search')), bookmark('News', s.url('/news'))] }]);
  const fx = fakeFirefox(s.url);
  const empty = tmp('noarc');
  const args = ['--meridian-onboarding', `--meridian-arc-dir=${empty}`, `--meridian-chrome-dir=${chrome}`, `--meridian-brave-dir=${brave}`, `--meridian-firefox-dir=${fx}`, '--lang=en-US'];
  const b = await launch(['about:blank'], { args });
  try {
    await b.waitFor(`${step} === 'hello'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'arc'`);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.source')].map((e) => [e.textContent.trim(), e.classList.contains('on')])`),
      [['From Chrome', true], ['From Brave', false], ['From Firefox', false]]);
    await b.click(`[...${OB}.querySelectorAll('.source')][1]`);
    await b.waitFor(`${OB}.querySelector('h2').textContent.includes('Bring everything from Brave')`);
    assert.deepEqual(await stats(b), ['1 profile', '2 bookmarks']);
    await b.click(`[...${OB}.querySelectorAll('.source')][2]`);
    await b.waitFor(`${OB}.querySelector('h2').textContent.includes('Bring everything from Firefox')`);
    assert.ok(await b.eval(`!!${OB}.getElementById('limited')`));
    await b.eval(`app.$.onboarding.finish_()`);
    await b.waitFor(`!app.$.onboarding.open`);

    // Meridian > Import from Another Browser… (the command bar's way to it): every one but Arc,
    // the moving-in step only.
    await b.eval(`app.onCommandBarFeature_(new CustomEvent('x', { detail: 'import-other' }))`);
    await b.waitFor(`${step} === 'arc'`);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.source')].map((e) => e.textContent.trim())`), ['From Chrome', 'From Brave', 'From Firefox']);
    assert.deepEqual(await b.eval(`app.$.onboarding.steps_`), ['arc', 'done']);
    await b.eval(`app.$.onboarding.open = false`);

    // The app menu (Windows' button; the sidebar's menu): "Import from …" for each browser found.
    assert.deepEqual((await b.eval(`${H}.findImportSources()`)).kinds, ['chrome', 'brave', 'firefox']);
    await b.eval(`app.$.tabstrip.openAppMenu(10, 10)`);
    await b.waitFor(`!!app.$.tabstrip.menu_`);
    assert.deepEqual(await b.eval(`app.$.tabstrip.menu_.entries.map((e) => e.label).filter((l) => l.startsWith('Import'))`),
      ['Import from Arc…', 'Import from Chrome…', 'Import from Brave…', 'Import from Firefox…']);
  } finally { await b.close(); s.server.close(); for (const d of [chrome, brave, fx, empty]) fs.rmSync(d, { recursive: true, force: true }); }
});
