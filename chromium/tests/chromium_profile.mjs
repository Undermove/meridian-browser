// Helpers that build Chromium profile files (Arc's, Chrome's: the same format) for import tests.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { APP } from './harness.mjs';

const chromeTime = (ms) => BigInt(Math.round(ms)) * 1000n + 11644473600000000n;

export function packExtension(dir, name, { popup = false } = {}) {
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
    execFileSync(APP, [`--user-data-dir=${udd}`, `--pack-extension=${src}`, `--pack-extension-key=${pem}`, '--no-message-box', ...(process.platform === 'darwin' ? ['--meridian-test-background'] : [])], { stdio: 'ignore', timeout: 60000 });
  } finally { fs.rmSync(udd, { recursive: true, force: true }); }
  return { id, crx: fs.readFileSync(`${src}.crx`) };
}

export async function store(extensions) {
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

export function writePasswords(dir, password, rows) {
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

export function writeHistory(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'History'));
  db.exec(`CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR,
    visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
    last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`);
  const insert = db.prepare('INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time) VALUES (?, ?, 5, 2, ?)');
  for (const r of rows) insert.run(r.url, r.title, chromeTime(r.at ?? Date.now() - 3600000));
  db.close();
}
