// Workbench Pro: the secrets vault.
//
//  - Values are encrypted with the OS keychain (Electron safeStorage) before they touch the disk.
//    On Linux without a keyring Electron would silently use a hard-coded key: we refuse instead
//    (same rule as the assistant's API key, src/ai/assistant.js).
//  - vault.json holds only names, scopes, notes and ciphertext (chmod 600). Plaintext exists only in
//    main-process memory, in the environment of processes Meridian launches (terminals, agents,
//    sandboxes), and in the workbench page when the user clicks "Reveal".
//  - Nothing here logs values. Callers must not either.
//  - Scope: 'global' or the real path of one project folder.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');
const { NAME_RE, find: findSecrets, entropy } = require('../renderer/dev/secret-detect');

// Variables a secret may never override: they change how processes start or where they look for code.
const RESERVED = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TERM|TERM_PROGRAM|COLORTERM|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|NODE_OPTIONS|NODE_PATH|LD_[A-Z_]+|DYLD_[A-Z_]+|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|IFS|SSH_AUTH_SOCK|DISPLAY|XDG_[A-Z_]+|MERIDIAN_[A-Z_]+|ELECTRON_[A-Z_]+)$/;
const MAX_ITEMS = 500;
const MAX_VALUE = 32 * 1024;
const MAX_NOTE = 500;

// Dev/test only (never in packaged builds, see index.js): an in-memory key instead of the OS keychain,
// so automated runs never touch the user's real keychain items. Values die with the process.
function fakeKeychain() {
  const key = crypto.randomBytes(32);
  return {
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(s, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), body]); },
    decryptString: (b) => { const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); },
  };
}

class Vault {
  constructor(file, { testKeychain = false } = {}) {
    this.file = file;
    this.cache = null;
    this.keychain = testKeychain ? fakeKeychain() : null;
  }

  encrypt(s) { return (this.keychain || safeStorage).encryptString(s); }
  decrypt(b) { return (this.keychain || safeStorage).decryptString(b); }

  // null when usable, otherwise a user-facing reason.
  unavailableReason() {
    if (this.keychain) return null;
    try {
      if (!safeStorage.isEncryptionAvailable()) return 'OS keychain encryption is not available on this computer.';
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
        return 'No system keyring found (install GNOME Keyring or KWallet) — Meridian won’t store secrets without one.';
      }
    } catch (err) { return `Keychain error: ${err.message}`; }
    return null;
  }

  load() {
    if (this.cache) return this.cache;
    let items = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw.items)) items = raw.items.filter((i) => i && typeof i.id === 'string' && NAME_RE.test(i.name) && typeof i.enc === 'string' && typeof i.scope === 'string');
    } catch {}
    this.cache = items;
    return items;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: this.cache }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  static validName(name) {
    const n = String(name || '');
    if (!NAME_RE.test(n)) throw new Error('Names use A–Z, 0–9 and _ and don’t start with a digit (like OPENAI_API_KEY).');
    if (RESERVED.test(n)) throw new Error(`${n} is a system variable and can’t be stored as a secret.`);
    return n;
  }

  static validScope(scope, projectRoot) {
    if (scope === 'global') return 'global';
    if (scope === 'project' && projectRoot) return projectRoot;
    throw new Error('Choose “All projects” or open a project first.');
  }

  // Metadata only — never values.
  list(projectRoot) {
    return this.load()
      .filter((i) => i.scope === 'global' || i.scope === projectRoot)
      .map((i) => ({ id: i.id, name: i.name, scope: i.scope === 'global' ? 'global' : 'project', note: i.note || '', createdAt: i.createdAt, updatedAt: i.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name) || (a.scope === 'project' ? -1 : 1));
  }

  // { id?, name, value?, scope: 'global'|'project', note } — value may be omitted when editing metadata.
  set(item, projectRoot) {
    const why = this.unavailableReason();
    if (why) throw new Error(why);
    const name = Vault.validName(item?.name);
    const scope = Vault.validScope(item?.scope, projectRoot);
    const note = String(item?.note || '').slice(0, MAX_NOTE);
    const items = this.load();
    const existing = item?.id ? items.find((i) => i.id === item.id && (i.scope === 'global' || i.scope === projectRoot)) : null;
    if (item?.id && !existing) throw new Error('That secret no longer exists.');
    const clash = items.find((i) => i.name === name && i.scope === scope && i !== existing);
    let value = item?.value;
    if (value !== undefined && value !== null) {
      if (typeof value !== 'string' || !value.length) throw new Error('The value is empty.');
      if (value.length > MAX_VALUE) throw new Error('The value is too long.');
      if (value.includes('\0')) throw new Error('The value contains a NUL byte.');
    } else if (!existing) throw new Error('The value is empty.');
    const now = Date.now();
    const target = existing || clash || { id: crypto.randomUUID(), createdAt: now };
    if (existing && clash && clash !== existing) items.splice(items.indexOf(clash), 1); // renamed onto another: replace it
    Object.assign(target, { name, scope, note, updatedAt: now });
    if (typeof value === 'string') target.enc = this.encrypt(value).toString('base64');
    if (!items.includes(target)) {
      if (items.length >= MAX_ITEMS) throw new Error('The vault is full.');
      items.push(target);
    }
    this.save();
    return { id: target.id, name, scope: scope === 'global' ? 'global' : 'project' };
  }

  reveal(id, projectRoot) {
    const i = this.load().find((x) => x.id === id && (x.scope === 'global' || x.scope === projectRoot));
    if (!i) throw new Error('No such secret.');
    return this.decrypt(Buffer.from(i.enc, 'base64'));
  }

  remove(id, projectRoot) {
    const items = this.load();
    const idx = items.findIndex((x) => x.id === id && (x.scope === 'global' || x.scope === projectRoot));
    if (idx < 0) return false;
    items.splice(idx, 1);
    this.save();
    return true;
  }

  // NAME -> value for a process started in projectRoot (project scope wins over global).
  // Returns {} when the keychain is unavailable (never throws into a launch).
  envFor(projectRoot) {
    if (this.unavailableReason()) return {};
    const env = {};
    const items = this.load();
    for (const pass of ['global', 'project']) {
      for (const i of items) {
        if (pass === 'global' ? i.scope !== 'global' : i.scope !== projectRoot) continue;
        try { env[i.name] = this.decrypt(Buffer.from(i.enc, 'base64')); } catch { /* unreadable entry (other keychain): skip */ }
      }
    }
    return env;
  }

  namesFor(projectRoot) { return Object.keys(this.envFor(projectRoot)).sort(); }

  hasName(name, projectRoot) { return this.load().some((i) => i.name === name && (i.scope === 'global' || i.scope === projectRoot)); }
}

// ---------- secret files in a project ----------

// Files agents shouldn't read (values end up in the model context and the transcript).
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?|\.envrc|([\w.-]*[-_.])?credentials(\.(json|ya?ml|toml|ini))?|service[-_]account[\w.-]*\.json|[^/]*\.pem|[^/]*\.p12|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|secrets?\.(json|ya?ml|toml))$/i;
const DOTENV_FILE = /(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.cache']);

function isSecretFile(rel) { return SECRET_FILE.test(String(rel).split(path.sep).join('/')); }

// Does a dotenv entry hold a credential? (PORT=3000 or NODE_ENV=dev stay in the file.)
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSW(OR)?D|PWD|PASS|AUTH|CREDENTIAL|PRIVATE|DSN|SIGNING|SALT|WEBHOOK|COOKIE|SESSION)/i;
const SECRET_URL_NAME = /((DATABASE|DB|REDIS|MONGO(DB)?|POSTGRES(QL)?|PG|MYSQL|AMQP|RABBIT(MQ)?|SMTP)_?URL|URI|CONNECTION_?STRING)$/i;
function isSecretEntry(name, value) {
  if (SECRET_NAME.test(name)) return true;
  if (SECRET_URL_NAME.test(name) && /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value)) return true; // URL with user:password@
  if (findSecrets(value).length) return true;
  return value.length >= 24 && entropy(value) >= 4 && /\d/.test(value) && /[A-Za-z]/.test(value) && !/[\s/]/.test(value);
}

// KEY=VALUE lines of a dotenv file -> [{ name, value, line }] (values only for main-side use).
function parseDotenv(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) return;
    let v = m[2].trim();
    if (/^["']/.test(v) && (v.length < 2 || v[v.length - 1] !== v[0])) return; // multi-line value: left alone
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const dq = v[0] === '"';
      v = v.slice(1, -1);
      if (dq) v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else v = v.replace(/\s+#.*$/, '');
    if (v) out.push({ name: m[1], value: v, line, secret: isSecretEntry(m[1], v) });
  });
  return out;
}

// Walk the project (bounded) and report secret-looking files. No values leave this function except
// key counts / names for dotenv files.
async function scanProject(root, { maxEntries = 20000, maxDepth = 6 } = {}) {
  const found = [];
  let seen = 0;
  const walk = async (dir, depth) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (++seen > maxEntries) return;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name)) await walk(abs, depth + 1); continue; }
      if (!d.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!isSecretFile(rel)) continue;
      const item = { path: rel, dotenv: DOTENV_FILE.test(rel), keys: [] };
      if (item.dotenv) {
        try {
          const st = await fs.promises.stat(abs);
          if (st.size < 256 * 1024) item.keys = parseDotenv(await fs.promises.readFile(abs, 'utf8')).filter((k) => k.secret).map((k) => k.name);
        } catch {}
        if (!item.keys.length) continue; // only a template / non-secret settings: nothing to protect
      }
      found.push(item);
      if (found.length >= 50) return;
    }
  };
  await walk(root, 0);
  return found;
}

module.exports = { Vault, isSecretFile, parseDotenv, scanProject, DOTENV_FILE, RESERVED };
