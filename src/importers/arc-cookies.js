// Brings Arc's cookies (the sites you're signed in to) into Meridian's matching profile sessions.
//
// Arc is Chromium. On macOS each Arc profile folder in "User Data" ("Default", "Profile 3", …) has a
// Cookies SQLite database whose values are encrypted with a key derived from the "Arc Safe Storage"
// password in the login keychain (Chromium's os_crypt_mac.mm + sqlite_persistent_cookie_store.cc):
//   key   = PBKDF2-HMAC-SHA1(password, "saltysalt", 1003 iterations, 16 bytes)
//   value = "v10" + AES-128-CBC(key, IV = 16 spaces, PKCS#7)
//   DB meta.version >= 24: the plaintext starts with SHA256(host_key), which is checked and stripped.
// Rows without the "v10" prefix are legacy clear text; an empty encrypted_value means the plain
// `value` column holds the cookie.
//
// Nothing leaves the machine and Arc is never written to: the database is copied to a private temp
// folder (so a running Arc's lock and WAL don't get in the way), read, and the copy deleted. Cookie
// values and the password are never logged or written anywhere; buffers holding them are zeroed.
//
// macOS only. Arc for Windows uses DPAPI + AES-GCM and, in current Chromium builds, App-Bound
// Encryption ("v20"), which a third-party app can't decrypt. Arc has no Linux build.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { profileIdForDir } = require('./arc');

const CHROME_EPOCH_OFFSET_US = 11644473600000000n; // 1601-01-01 → 1970-01-01, in microseconds
const SAME_SITE = { '-1': 'unspecified', 0: 'no_restriction', 1: 'lax', 2: 'strict' };

class ArcLoginsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// "Default" and "Profile N" are real profiles; "Guest Profile" / "System Profile" are not.
function findArcProfiles(userDataDir) {
  let entries = [];
  try { entries = fs.readdirSync(userDataDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !(e.name === 'Default' || /^Profile \d+$/.test(e.name))) continue;
    const db = [path.join(userDataDir, e.name, 'Network', 'Cookies'), path.join(userDataDir, e.name, 'Cookies')].find((f) => fs.existsSync(f));
    if (db) out.push({ dir: e.name, profileId: profileIdForDir(e.name), db });
  }
  return out.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, 'en', { numeric: true })));
}

// The macOS keychain asks the user (system dialog) before handing out the password.
function keychainPassword({ service = 'Arc Safe Storage', account = 'Arc' } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', service, '-a', account],
      { timeout: 5 * 60_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          // 44 = errSecItemNotFound; anything else (128 = user cancelled, 51 = denied, timeout) is "not allowed".
          return reject(err.code === 44
            ? new ArcLoginsError('not-found', 'Arc’s key isn’t in your keychain, so its logins can’t be read.')
            : new ArcLoginsError('denied', 'You didn’t allow access to Arc’s logins, so nothing was imported.'));
        }
        const pw = String(stdout).replace(/\r?\n$/, '');
        if (!pw) return reject(new ArcLoginsError('denied', 'You didn’t allow access to Arc’s logins, so nothing was imported.'));
        resolve(pw);
      });
  });
}

const deriveKey = (password) => crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1');

// Returns the cookie value as a string, or throws if it can't be decrypted/verified.
function decryptValue(encrypted, key, hostKey, dbVersion) {
  const buf = Buffer.from(encrypted);
  if (buf.subarray(0, 3).toString('latin1') !== 'v10') return buf.toString('utf8'); // legacy clear text
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  try {
    if (dbVersion >= 24) {
      const hash = crypto.createHash('sha256').update(hostKey, 'utf8').digest();
      if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) throw new Error('domain hash mismatch');
      return plain.subarray(32).toString('utf8');
    }
    return plain.toString('utf8');
  } finally { plain.fill(0); }
}

// One Cookies row (already decrypted) → Electron's cookies.set() details, or { skip: reason }.
function toCookieDetails(row, value, nowSec = Date.now() / 1000) {
  if (row.top_frame_site_key) return { skip: 'partitioned' }; // CHIPS: Electron's cookies.set can't set a partition key
  const host = String(row.host_key || '');
  if (!host) return { skip: 'invalid' };
  const domainCookie = host.startsWith('.');
  const bare = domainCookie ? host.slice(1) : host;
  const expires = BigInt(row.expires_utc || 0);
  let expirationDate;
  if (expires > 0n && Number(row.is_persistent ?? 1)) {
    expirationDate = Number(expires - CHROME_EPOCH_OFFSET_US) / 1e6;
    if (expirationDate <= nowSec) return { skip: 'expired' };
  }
  const secure = !!Number(row.is_secure);
  const scheme = secure || Number(row.source_scheme) === 2 ? 'https' : 'http';
  const cookiePath = String(row.path || '/').startsWith('/') ? String(row.path || '/') : '/';
  const name = String(row.name || '');
  const urlHost = bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare; // IPv6
  const details = {
    url: `${scheme}://${urlHost}${cookiePath}`,
    name,
    value,
    path: cookiePath,
    secure,
    httpOnly: !!Number(row.is_httponly),
    sameSite: SAME_SITE[String(Number(row.samesite))] || 'unspecified',
  };
  // Host-only cookies get no domain attribute (that's what makes them host-only); __Host- cookies
  // must never carry one.
  if (domainCookie && !name.startsWith('__Host-')) details.domain = host;
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  return details;
}

// Copies the database (plus WAL) to a private temp folder so a running Arc is never touched.
function readCookieRows(dbFile) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  try {
    fs.chmodSync(tmp, 0o700);
    const copy = path.join(tmp, 'Cookies');
    fs.copyFileSync(dbFile, copy);
    for (const ext of ['-wal', '-journal']) if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, copy + ext);
    const db = new DatabaseSync(copy);
    try {
      const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value || 0);
      const cols = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((c) => c.name));
      const want = ['host_key', 'name', 'value', 'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly', 'samesite', 'source_scheme', 'top_frame_site_key', 'is_persistent'];
      const select = want.map((c) => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ');
      const stmt = db.prepare(`SELECT ${select} FROM cookies`);
      stmt.setReadBigInts(true); // expires_utc is past Number.MAX_SAFE_INTEGER
      return { version, rows: stmt.all() };
    } finally { db.close(); }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Import every Arc profile (or only `onlyProfileIds`) into `sessionFor(profileId)`.
//   getPassword: async () => string   (the keychain by default; injectable for tests)
// Returns { profiles: [{ profileId, dir, imported, skipped, failed, error? }], total }.
async function importArcCookies({ userDataDir, sessionFor, getPassword = keychainPassword, onlyProfileIds = null, now = Date.now() } = {}) {
  let profiles = findArcProfiles(userDataDir);
  if (onlyProfileIds) profiles = profiles.filter((p) => onlyProfileIds.has(p.profileId));
  if (!profiles.length) throw new ArcLoginsError('no-data', 'No Arc logins were found on this computer.');

  let password = await getPassword();
  if (typeof password !== 'string' || !password) throw new ArcLoginsError('denied', 'You didn’t allow access to Arc’s logins, so nothing was imported.');
  const key = deriveKey(password);
  password = null;

  const result = { profiles: [], total: 0 };
  try {
    for (const p of profiles) {
      const stats = { profileId: p.profileId, dir: p.dir, imported: 0, skipped: 0, failed: 0 };
      result.profiles.push(stats);
      let data;
      try { data = readCookieRows(p.db); } catch { stats.error = 'Couldn’t read this profile’s cookie database.'; continue; }
      const ses = sessionFor(p.profileId);
      const jobs = [];
      for (const row of data.rows) {
        let value;
        try {
          const enc = row.encrypted_value;
          value = enc && enc.length ? decryptValue(enc, key, String(row.host_key), data.version) : String(row.value ?? '');
        } catch { stats.failed++; continue; }
        const details = toCookieDetails(row, value, now / 1000);
        value = null;
        if (details.skip) { stats.skipped++; continue; }
        jobs.push(details);
      }
      data = null;
      // Electron rejects some cookies (e.g. SameSite=None without Secure); count them as failed.
      for (let i = 0; i < jobs.length; i += 200) {
        const batch = jobs.slice(i, i + 200);
        const settled = await Promise.allSettled(batch.map((d) => ses.cookies.set(d)));
        for (const s of settled) { if (s.status === 'fulfilled') stats.imported++; else stats.failed++; }
        for (const d of batch) d.value = null;
      }
      jobs.length = 0;
      try { await ses.cookies.flushStore(); } catch {}
      result.total += stats.imported;
    }
  } finally {
    key.fill(0);
  }
  return result;
}

module.exports = { importArcCookies, findArcProfiles, keychainPassword, decryptValue, deriveKey, toCookieDetails, ArcLoginsError };
