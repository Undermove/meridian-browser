// Arc logins (cookies) import: src/importers/arc-cookies.js + the import:arc-logins flow in main.js.
// A fake Arc data folder (StorableSidebar.json + "User Data/<profile>/Cookies" in Chromium's v24
// schema, encrypted with a known password) stands in for Arc via the dev-only MERIDIAN_ARC_DIR hook,
// and MERIDIAN_ARC_SAFE_STORAGE stands in for the keychain. The real keychain and Arc's real cookies
// are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { test, expect, launchMeridian, closeMeridian, e2eLog, setDialogResponse, openTabDirect, inTab, seedState } = require('../fixtures/meridian');
const { importArcCookies, findArcProfiles, decryptValue, deriveKey, toCookieDetails } = require('../../src/importers/arc-cookies');

const PASSWORD = 'test-safe-storage-password==';
const OFFSET_US = 11644473600000000n;
const chromeTime = (unixSec) => BigInt(Math.round(unixSec)) * 1000000n + OFFSET_US;
const DAY = 86400;

const SCHEMA = `
CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);`;

// Chromium macOS: "v10" + AES-128-CBC(PBKDF2-SHA1(pw, "saltysalt", 1003, 16), IV = 16 spaces), and
// since DB version 24 the plaintext starts with SHA256(host_key).
function encrypt(value, host, { password = PASSWORD, badHash = false } = {}) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const hash = crypto.createHash('sha256').update(badHash ? 'wrong.example' : host).digest();
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), c.update(Buffer.concat([hash, Buffer.from(value, 'utf8')])), c.final()]);
}

function writeCookiesDb(file, cookies) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.prepare("INSERT INTO meta VALUES ('version', '24')").run();
  db.prepare("INSERT INTO meta VALUES ('last_compatible_version', '24')").run();
  const ins = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, 0)`);
  const now = chromeTime(Date.now() / 1000);
  for (const c of cookies) {
    const expires = c.expires == null ? 0n : chromeTime(c.expires);
    const enc = c.plain ? Buffer.alloc(0) : encrypt(c.value, c.host, c);
    ins.run(now, c.host, c.partition || '', c.name, c.plain ? c.value : '', enc, c.path || '/', expires, c.secure ? 1 : 0, c.httpOnly ? 1 : 0,
      now, c.expires == null ? 0 : 1, c.expires == null ? 0 : 1, c.sameSite ?? -1, c.secure ? 2 : 1, c.secure ? 443 : 80, now);
  }
  db.close();
}

// Arc's sidebar: one space on the Default profile, one on "Profile 3". "Profile 9" exists on disk
// but no space uses it (a deleted Arc profile) and must not be imported.
function sidebar() {
  const space = (title, profile) => ({ title, profile, containerIDs: ['pinned', title + '-pinned', 'unpinned', title + '-unpinned'], customInfo: {} });
  return {
    sidebar: {
      containers: [{}, {
        items: ['Home-pinned', { childrenIds: [] }, 'Home-unpinned', { childrenIds: [] }, 'Work-pinned', { childrenIds: [] }, 'Work-unpinned', { childrenIds: [] }],
        spaces: ['s1', space('Home', { default: true }), 's2', space('Work', { custom: { _0: { directoryBasename: 'Profile 3' } } })],
        topAppsContainerIDs: [],
      }],
    },
  };
}

function fakeArc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-arc-'));
  fs.writeFileSync(path.join(root, 'StorableSidebar.json'), JSON.stringify(sidebar()));
  const ud = path.join(root, 'User Data');
  const now = Date.now() / 1000;
  writeCookiesDb(path.join(ud, 'Default', 'Cookies'), [
    { host: '127.0.0.1', name: 'arc_sid', value: 'home-session-ä', expires: now + 30 * DAY, httpOnly: true, sameSite: 1 },
    { host: '127.0.0.1', name: 'arc_plain', value: 'plain-v', expires: now + 30 * DAY, plain: true },
    { host: '127.0.0.1', name: 'arc_session', value: 'until-quit', expires: null },
    { host: '.example.test', name: 'dom', value: 'domain-v', expires: now + 10 * DAY, secure: true, sameSite: 2 },
    { host: 'secure.example.test', name: '__Host-id', value: 'host-v', expires: now + 10 * DAY, secure: true, sameSite: 0 },
    { host: '127.0.0.1', name: 'arc_old', value: 'gone', expires: now - DAY },
    { host: 'embed.example.test', name: 'chips', value: 'p', expires: now + DAY, secure: true, partition: 'https://top.example.test' },
    { host: '127.0.0.1', name: 'arc_badhash', value: 'x', expires: now + DAY, badHash: true },
  ]);
  writeCookiesDb(path.join(ud, 'Profile 3', 'Cookies'), [
    { host: '127.0.0.1', name: 'arc_sid', value: 'work-session', expires: now + 30 * DAY, httpOnly: true },
  ]);
  writeCookiesDb(path.join(ud, 'Profile 9', 'Cookies'), [
    { host: '127.0.0.1', name: 'ghost', value: 'nope', expires: now + 30 * DAY },
  ]);
  fs.mkdirSync(path.join(ud, 'Guest Profile'), { recursive: true });
  return root;
}

const cookiesIn = (app, partition) => app.evaluate(async ({ session }, p) => (await session.fromPartition(p).cookies.get({}))
  .map(({ name, value, domain, path: pth, secure, httpOnly, sameSite, session: s, hostOnly, expirationDate }) => ({ name, value, domain, path: pth, secure, httpOnly, sameSite, session: s, hostOnly, expirationDate })), partition);

// ---------------------------------------------------------------- pure node

test('decrypts Chromium v10 values (v24 domain hash checked) and maps rows to Electron cookies', () => {
  const key = deriveKey(PASSWORD);
  expect(decryptValue(encrypt('hello', '.a.test'), key, '.a.test', 24)).toBe('hello');
  expect(() => decryptValue(encrypt('hello', '.a.test', { badHash: true }), key, '.a.test', 24)).toThrow();
  expect(() => decryptValue(encrypt('hello', '.a.test', { password: 'other' }), key, '.a.test', 24)).toThrow();
  const now = Date.now() / 1000;
  const base = { name: 'n', path: '/', is_secure: 1n, is_httponly: 0n, samesite: 2n, source_scheme: 2n, top_frame_site_key: '', is_persistent: 1n };
  const d = toCookieDetails({ ...base, host_key: '.a.test', expires_utc: chromeTime(now + DAY) }, 'v', now);
  expect(d).toMatchObject({ url: 'https://a.test/', domain: '.a.test', secure: true, httpOnly: false, sameSite: 'strict', value: 'v' });
  expect(Math.abs(d.expirationDate - (now + DAY))).toBeLessThan(1);
  const hostOnly = toCookieDetails({ ...base, host_key: 'a.test', name: '__Host-x', expires_utc: 0n, is_persistent: 0n, samesite: -1n }, 'v', now);
  expect(hostOnly.domain).toBeUndefined();
  expect(hostOnly.expirationDate).toBeUndefined();
  expect(hostOnly.sameSite).toBe('unspecified');
  expect(toCookieDetails({ ...base, host_key: 'a.test', expires_utc: chromeTime(now - 1) }, 'v', now)).toEqual({ skip: 'expired' });
  expect(toCookieDetails({ ...base, host_key: 'a.test', expires_utc: 0n, top_frame_site_key: 'https://b.test' }, 'v', now)).toEqual({ skip: 'partitioned' });
});

test('finds real profile folders only and maps them like the sidebar import', () => {
  const root = fakeArc();
  try {
    const found = findArcProfiles(path.join(root, 'User Data')).map((p) => [p.dir, p.profileId]);
    expect(found).toEqual([['Default', 'default'], ['Profile 3', 'arc-profile-3'], ['Profile 9', 'arc-profile-9']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a refused password imports nothing and the password is asked once', async () => {
  const root = fakeArc();
  try {
    const set = [];
    let asked = 0;
    const sessionFor = () => ({ cookies: { set: async (d) => set.push(d), flushStore: async () => {} } });
    const denied = Object.assign(new Error('You didn’t allow access'), { code: 'denied' });
    await expect(importArcCookies({ userDataDir: path.join(root, 'User Data'), sessionFor, getPassword: async () => { asked++; throw denied; } })).rejects.toMatchObject({ code: 'denied' });
    expect(asked).toBe(1);
    expect(set).toHaveLength(0);
    // no Arc data: the keychain isn't even asked
    await expect(importArcCookies({ userDataDir: path.join(root, 'nope'), sessionFor, getPassword: async () => { asked++; return PASSWORD; } })).rejects.toMatchObject({ code: 'no-data' });
    expect(asked).toBe(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- in the app

test.describe('in the app', () => {
  let arcRoot;
  test.beforeEach(() => { arcRoot = fakeArc(); });
  test.afterEach(() => { fs.rmSync(arcRoot, { recursive: true, force: true }); });

  test('imports Arc cookies into the matching profile sessions; pages see them', async ({ userDataDir, server }) => {
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_ARC_DIR: arcRoot, MERIDIAN_ARC_SAFE_STORAGE: PASSWORD } });
    try {
      expect(await m.page.evaluate(() => api.arcLoginsAvailable())).toBe(true);
      await setDialogResponse(m.app, 1); // Continue
      const r = await m.page.evaluate(() => api.importArcLogins());
      expect(r.ok).toBe(true);
      const byId = Object.fromEntries(r.profiles.map((p) => [p.profileId, p]));
      expect(Object.keys(byId).sort()).toEqual(['arc-profile-3', 'default']); // Profile 9 isn't in Arc's sidebar
      expect(byId.default).toMatchObject({ imported: 5, skipped: 2, failed: 1 });
      expect(byId['arc-profile-3']).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
      expect(r.total).toBe(6);

      const dialogs = (await e2eLog(m.app)).dialogs;
      expect(dialogs[0].message).toMatch(/Arc logins/);
      expect(dialogs[0].detail).toMatch(/Arc Safe Storage/);
      expect(dialogs[0].detail).toMatch(/Nothing leaves this computer/);
      expect(dialogs.at(-1).message).toBe('Imported 6 logins into 2 profiles.');
      expect(dialogs.at(-1).detail).toMatch(/signed in here too/);

      const def = await cookiesIn(m.app, 'persist:profile-default');
      const c = Object.fromEntries(def.map((x) => [x.name, x]));
      expect(Object.keys(c).sort()).toEqual(['__Host-id', 'arc_plain', 'arc_session', 'arc_sid', 'dom']);
      expect(c.arc_sid).toMatchObject({ value: 'home-session-ä', domain: '127.0.0.1', hostOnly: true, httpOnly: true, secure: false, sameSite: 'lax', session: false });
      expect(c.arc_sid.expirationDate).toBeGreaterThan(Date.now() / 1000 + 29 * DAY);
      expect(c.arc_plain.value).toBe('plain-v');
      expect(c.arc_session).toMatchObject({ session: true });
      expect(c.dom).toMatchObject({ value: 'domain-v', domain: '.example.test', hostOnly: false, secure: true, sameSite: 'strict' });
      expect(c['__Host-id']).toMatchObject({ value: 'host-v', domain: 'secure.example.test', hostOnly: true, secure: true, path: '/', sameSite: 'no_restriction' });

      const work = await cookiesIn(m.app, 'persist:profile-arc-profile-3');
      expect(work.map((x) => [x.name, x.value])).toEqual([['arc_sid', 'work-session']]);
      expect(await cookiesIn(m.app, 'persist:profile-arc-profile-9')).toEqual([]);

      // The profile Meridian didn't have yet was created, named after its Arc space.
      await expect.poll(() => m.page.evaluate(() => state.profiles.map((p) => [p.id, p.name]))).toEqual([['default', 'Default'], ['arc-profile-3', 'Work']]);

      // A page on that host gets the imported cookies (httpOnly included) in its requests.
      const id = await openTabDirect(m.page, server.url('/cookie/show'));
      const out = await inTab(m.page, id, 'document.getElementById("out").textContent');
      expect(out).toContain('arc_sid=home-session-');
      expect(out).toContain('arc_plain=plain-v');
      expect(out).not.toContain('arc_old');
      expect(out).not.toContain('work-session');

      // Imported logins survive a restart.
      await closeMeridian(m.app);
      Object.assign(m, await launchMeridian({ userDataDir, keepState: true }));
      const after = (await cookiesIn(m.app, 'persist:profile-default')).map((x) => x.name);
      expect(after).not.toContain('arc_session'); // Electron doesn't keep session cookies across restarts (documented)
      expect(after).toEqual(expect.arrayContaining(['arc_sid', 'dom', '__Host-id', 'arc_plain']));
      expect((await cookiesIn(m.app, 'persist:profile-arc-profile-3')).map((x) => x.value)).toEqual(['work-session']);
    } finally { await closeMeridian(m.app); }
  });

  test('keychain access refused: friendly message, nothing imported', async ({ userDataDir }) => {
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_ARC_DIR: arcRoot, MERIDIAN_ARC_SAFE_STORAGE: '__deny__' } });
    try {
      await setDialogResponse(m.app, 1);
      const r = await m.page.evaluate(() => api.importArcLogins());
      expect(r).toMatchObject({ ok: false, denied: true });
      expect(r.error).toMatch(/didn’t allow access/);
      const dialogs = (await e2eLog(m.app)).dialogs;
      expect(dialogs.at(-1).message).toBe('Logins weren’t imported');
      expect(dialogs.at(-1).detail).toMatch(/didn’t allow access/);
      expect(await cookiesIn(m.app, 'persist:profile-default')).toEqual([]);
      expect(await cookiesIn(m.app, 'persist:profile-arc-profile-3')).toEqual([]);
      expect(await m.page.evaluate(() => state.profiles.length)).toBe(1);
    } finally { await closeMeridian(m.app); }
  });

  test('cancelling the explanation never asks the keychain', async ({ userDataDir }) => {
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_ARC_DIR: arcRoot, MERIDIAN_ARC_SAFE_STORAGE: PASSWORD } });
    try {
      await setDialogResponse(m.app, 0); // Cancel
      expect(await m.page.evaluate(() => api.importArcLogins())).toMatchObject({ ok: false, cancelled: true });
      expect((await e2eLog(m.app)).dialogs).toHaveLength(1);
      expect(await cookiesIn(m.app, 'persist:profile-default')).toEqual([]);
    } finally { await closeMeridian(m.app); }
  });

  test('onboarding: "Also bring my logins" imports the sidebar and the logins in one go', async ({ userDataDir }) => {
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_ARC_DIR: arcRoot, MERIDIAN_ARC_SAFE_STORAGE: PASSWORD } });
    try {
      await setDialogResponse(m.app, 1);
      await m.page.evaluate(() => startOnboarding());
      await m.page.waitForFunction(() => ob.steps.includes('arc'));
      await m.page.evaluate(() => showObStep(ob.steps.indexOf('arc')));
      const box = m.page.locator('#ob-logins');
      await expect(box).toBeChecked();
      await expect(m.page.locator('.ob-step-arc .ob-fine')).toContainText('Logins (cookies) come over too');
      await m.page.locator('#ob-import').click();
      await expect(m.page.locator('.ob-step-arc .ob-ok')).toHaveText(['Imported', '6 logins']);
      expect(await m.page.evaluate(() => state.spaces.map((s) => [s.name, s.profileId]))).toEqual([['Home', 'default'], ['Work', 'arc-profile-3']]);
      expect((await cookiesIn(m.app, 'persist:profile-arc-profile-3')).map((x) => x.value)).toEqual(['work-session']);
    } finally { await closeMeridian(m.app); }
  });

  test('Settings → General has the "Import logins from Arc" row (macOS)', async ({ userDataDir }) => {
    test.skip(process.platform !== 'darwin', 'macOS only');
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_ARC_DIR: arcRoot, MERIDIAN_ARC_SAFE_STORAGE: PASSWORD } });
    try {
      const winPromise = m.app.waitForEvent('window', { predicate: (w) => w.url().startsWith('meridian://app/settings.html'), timeout: 10_000 });
      await m.page.evaluate(() => api.openSettings('general'));
      const win = await winPromise;
      const btn = win.locator('#import-logins');
      await expect(btn).toHaveText('Import…');
      await setDialogResponse(m.app, 1);
      await btn.click();
      await expect(btn).toHaveText('Import…');
      await expect.poll(async () => (await e2eLog(m.app)).dialogs.at(-1)?.message).toBe('Imported 6 logins into 2 profiles.');
      await expect.poll(() => m.page.evaluate(() => state.profiles.some((p) => p.id === 'arc-profile-3'))).toBe(true);
    } finally { await closeMeridian(m.app); }
  });
});
