// Updates as the difference from the installed version (tools/make_delta.py, update_delta.cc), against
// a stand-in GitHub: the release has Meridian-<this version>-to-<new>-mac-arm64.delta, listed in its
// signed SHA256SUMS; Meridian downloads only that, builds the new app from the installed one, and
// "Restart to update" swaps it in, the same files as the full zip. When the installed app isn't the
// one the delta was made from, or the delta is broken, it downloads the whole app instead.
//
// MERIDIAN_REAL_DELTA=<old Meridian.app>:<new Meridian.app>: the same with two real builds (slow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB, APP } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = { ready: 5, failed: 6, downloading: 4 };
const NEW = '9.9.9';
const ZIP = `Meridian-${NEW}-mac-arm64.zip`;
const KEY = crypto.generateKeyPairSync('ed25519');
const PUB = KEY.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const MAKE_DELTA = path.join(import.meta.dirname, '..', 'tools', 'make_delta.py');
// The version of the build under test (a packaged one says it in a file, a dev build in the source):
// the delta is from it.
const VERSION_FILE = path.join(path.dirname(APP), '..', 'Resources', 'meridian-version');
const CURRENT = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim()
  : fs.readFileSync(path.join(process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium'), 'src/chrome/browser/meridian/update_check.h'), 'utf8').match(/kVersion\[\] = "([^"]+)"/)?.[1];
const DELTA = `Meridian-${CURRENT}-to-${NEW}-mac-arm64.delta`;
const skip = process.platform !== 'darwin' && 'macOS only';

// A Meridian.app: the real bundle id, its version, a framework under a versioned folder (as
// Chromium's, renamed when Chromium updates), a link, an executable and a big file.
function fakeApp(dir, { version, chromium, big, extra }) {
  const app = path.join(dir, 'Meridian.app');
  const c = path.join(app, 'Contents');
  fs.mkdirSync(path.join(c, 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.meridian.browser</string></dict></plist>`);
  fs.mkdirSync(path.join(c, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(c, 'Resources', 'meridian-version'), `${version}\n`);
  fs.writeFileSync(path.join(c, 'MacOS', 'Meridian'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const fw = path.join(c, 'Frameworks', 'Meridian Framework.framework');
  fs.mkdirSync(path.join(fw, 'Versions', chromium), { recursive: true });
  fs.writeFileSync(path.join(fw, 'Versions', chromium, 'Meridian Framework'), big);
  fs.symlinkSync(chromium, path.join(fw, 'Versions', 'Current'));
  fs.writeFileSync(path.join(c, 'Resources', 'unchanged.txt'), 'the same in both\n');
  if (extra) fs.writeFileSync(path.join(c, 'Resources', 'new-in-this-version.txt'), extra);
  return app;
}

// 4 MB of noise, and the same with a few changes: a framework a little different.
const BIG = crypto.randomBytes(4 << 20);
const BIG2 = Buffer.from(BIG);
for (let i = 0; i < 40; i++) BIG2.writeUInt32LE(i * 7919, (i * 104729) % (BIG2.length - 4));

// The release: the zip, the delta (unless none), SHA256SUMS of both, signed. Requests are counted.
async function release({ oldApp, newApp, delta = true, breakDelta = false, version = NEW }) {
  const ZIP = `Meridian-${version}-mac-arm64.zip`;
  const DELTA = `Meridian-${CURRENT}-to-${version}-mac-arm64.delta`;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-update-')));
  const zip = path.join(dir, ZIP);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', newApp, zip]);
  const files = { zip };
  if (delta) {
    files.delta = path.join(dir, DELTA);
    execFileSync('python3', [MAKE_DELTA, oldApp, newApp, files.delta], { stdio: 'ignore' });
    // Broken: a patch that isn't one (the checksums still match the file).
    if (breakDelta) {
      const unz = path.join(dir, 'unz');
      execFileSync('/usr/bin/ditto', ['-x', '-k', files.delta, unz]);
      for (const f of fs.readdirSync(path.join(unz, 'files'))) fs.writeFileSync(path.join(unz, 'files', f), 'not zstd');
      fs.rmSync(files.delta);
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', unz, files.delta]);
      // ditto -c -k puts the folder's contents at the top only with the folder as source: fine.
    }
  }
  const sum = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const sums = `${sum(zip)}  ${ZIP}\n` + (files.delta ? `${sum(files.delta)}  ${DELTA}\n` : '');
  const sig = crypto.sign(null, Buffer.from(sums), KEY.privateKey).toString('base64') + '\n';
  const asked = [];
  const s = http.createServer((req, res) => {
    asked.push(req.url);
    const base = `http://127.0.0.1:${s.address().port}`;
    if (req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: `v${version}`, html_url: `${base}/page`, body: 'Notes', assets: [
        { name: ZIP, browser_download_url: `${base}/zip` },
        ...(files.delta ? [{ name: DELTA, browser_download_url: `${base}/delta` }] : []),
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/sums` },
        { name: 'SHA256SUMS.txt.sig', browser_download_url: `${base}/sig` },
      ] }));
    } else if (req.url === '/zip' || req.url === '/delta') {
      const f = files[req.url.slice(1)];
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    } else if (req.url === '/sums') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(sums);
    } else if (req.url === '/sig') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(sig);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { dir, s, asked, files, feed: `http://127.0.0.1:${s.address().port}/feed` };
}

// Every file, link and folder of an app, with the files' contents' hashes and modes.
function tree(app) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = path.relative(app, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = `${(st.mode & 0o777).toString(8)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(app);
  return out;
}

// Updates `installed` from the release and swaps it; returns the swapped app's tree.
async function update(rel, installed) {
  const b = await launch(['about:blank'], { args: [`--meridian-update-feed=${rel.feed}`, `--meridian-test-update-key=${PUB}`, `--meridian-test-update-target=${installed}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    let s;
    for (const end = Date.now() + 240000; Date.now() < end; await sleep(200)) {
      s = await b.eval('app.$.tabstrip.handler_.getUpdateState().then((r) => r.state)');
      if (s.status === S.ready || s.status === S.failed) break;
    }
    assert.equal(s.status, S.ready, `ready: ${JSON.stringify(s)}`);
    await b.eval('app.$.tabstrip.handler_.installUpdate()');
    for (let i = 0; i < 100 && b.proc.exitCode === null && b.proc.signalCode === null; i++) await sleep(150);
    for (let i = 0; i < 100 && fs.existsSync(installed + '.previous'); i++) await sleep(100);
    assert.equal(fs.existsSync(installed + '.previous'), false, 'swapped');
    return tree(installed);
  } finally { await b.close(); }
}

function apps(newOpts = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-apps-')));
  fs.mkdirSync(path.join(dir, 'old')); fs.mkdirSync(path.join(dir, 'new')); fs.mkdirSync(path.join(dir, 'installed'));
  const old = fakeApp(path.join(dir, 'old'), { version: CURRENT, chromium: '158.0.1.1', big: BIG });
  const fresh = fakeApp(path.join(dir, 'new'), { version: NEW, chromium: '158.0.2.2', big: BIG2, extra: 'hello\n', ...newOpts });
  execFileSync('/usr/bin/ditto', [old, path.join(dir, 'installed', 'Meridian.app')]);
  return { dir, old, fresh, installed: path.join(dir, 'installed', 'Meridian.app') };
}

test('Updates: only the difference from this version is downloaded; the app built from it is the new one', { skip }, async () => {
  const a = apps();
  const rel = await release({ oldApp: a.old, newApp: a.fresh });
  try {
    assert.ok(fs.statSync(rel.files.delta).size < fs.statSync(rel.files.zip).size / 4,
      `the delta (${fs.statSync(rel.files.delta).size}) is much smaller than the zip (${fs.statSync(rel.files.zip).size})`);
    const got = await update(rel, a.installed);
    assert.deepEqual(got, tree(a.fresh));
    assert.ok(rel.asked.includes('/delta'), 'the delta was downloaded');
    assert.ok(!rel.asked.includes('/zip'), `the zip wasn't: ${rel.asked}`);
  } finally { rel.s.closeAllConnections(); rel.s.close(); for (const d of [rel.dir, a.dir]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('Updates: an installed app that differs from the one the delta was made from, or a broken delta, gets the whole app', { skip }, async () => {
  // Changed since it was installed.
  let a = apps();
  fs.writeFileSync(path.join(a.installed, 'Contents', 'Resources', 'unchanged.txt'), 'edited\n');
  let rel = await release({ oldApp: a.old, newApp: a.fresh });
  try {
    assert.deepEqual(await update(rel, a.installed), tree(a.fresh));
    assert.deepEqual(rel.asked.filter((u) => u === '/delta' || u === '/zip'), ['/delta', '/zip']);
  } finally { rel.s.closeAllConnections(); rel.s.close(); for (const d of [rel.dir, a.dir]) fs.rmSync(d, { recursive: true, force: true }); }

  // A delta whose patches aren't.
  a = apps();
  rel = await release({ oldApp: a.old, newApp: a.fresh, breakDelta: true });
  try {
    assert.deepEqual(await update(rel, a.installed), tree(a.fresh));
    assert.deepEqual(rel.asked.filter((u) => u === '/delta' || u === '/zip'), ['/delta', '/zip']);
  } finally { rel.s.closeAllConnections(); rel.s.close(); for (const d of [rel.dir, a.dir]) fs.rmSync(d, { recursive: true, force: true }); }

  // No delta for this version: the zip, as before.
  a = apps();
  rel = await release({ oldApp: a.old, newApp: a.fresh, delta: false });
  try {
    assert.deepEqual(await update(rel, a.installed), tree(a.fresh));
    assert.ok(!rel.asked.includes('/delta'));
  } finally { rel.s.closeAllConnections(); rel.s.close(); for (const d of [rel.dir, a.dir]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('Updates: two real builds, by their difference', { skip: skip || (!process.env.MERIDIAN_REAL_DELTA && 'set MERIDIAN_REAL_DELTA=<old.app>:<new.app>') }, async () => {
  const [oldReal, newReal] = process.env.MERIDIAN_REAL_DELTA.split(':');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-apps-')));
  fs.mkdirSync(path.join(dir, 'old')); fs.mkdirSync(path.join(dir, 'new')); fs.mkdirSync(path.join(dir, 'installed'));
  // The delta is from this build's version to NEW: the real apps say so (their signatures aren't
  // checked for a test target).
  const old = path.join(dir, 'old', 'Meridian.app');
  const fresh = path.join(dir, 'new', 'Meridian.app');
  execFileSync('/usr/bin/ditto', [oldReal, old]);
  execFileSync('/usr/bin/ditto', [newReal, fresh]);
  fs.writeFileSync(path.join(old, 'Contents', 'Resources', 'meridian-version'), `${CURRENT}\n`);
  fs.writeFileSync(path.join(fresh, 'Contents', 'Resources', 'meridian-version'), `${NEW}\n`);
  const installed = path.join(dir, 'installed', 'Meridian.app');
  execFileSync('/usr/bin/ditto', [old, installed]);
  const rel = await release({ oldApp: old, newApp: fresh });
  try {
    console.log(`delta ${(fs.statSync(rel.files.delta).size / 1e6).toFixed(1)} MB, zip ${(fs.statSync(rel.files.zip).size / 1e6).toFixed(1)} MB`);
    assert.deepEqual(await update(rel, installed), tree(fresh));
    assert.ok(!rel.asked.includes('/zip'), `the zip wasn't downloaded: ${rel.asked}`);
  } finally { rel.s.closeAllConnections(); rel.s.close(); for (const d of [rel.dir, dir]) fs.rmSync(d, { recursive: true, force: true }); }
});

// An update ready for a restart, and a newer release meanwhile: it downloads in the background, the
// "Restart to update" pill moves to the newer version, and the restart installs that one directly.
test('Updates: a newer release while one is ready to install replaces it; a restart goes straight to the latest', { skip }, async () => {
  const a = apps();
  const newer = fakeApp(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-newer-')), { version: '9.9.10', chromium: '158.0.3.3', big: BIG2, extra: 'newer\n' });
  const first = await release({ oldApp: a.old, newApp: a.fresh });
  const second = await release({ oldApp: a.old, newApp: newer, version: '9.9.10' });
  // The feed: the first release, then the second.
  let feed = first.feed;
  const proxy = http.createServer(async (req, res) => {
    const body = await (await fetch(feed)).text();
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const b = await launch(['about:blank'], { args: [`--meridian-update-feed=http://127.0.0.1:${proxy.address().port}/feed`, `--meridian-test-update-key=${PUB}`, `--meridian-test-update-target=${a.installed}`] });
  const state = () => b.eval('app.$.tabstrip.handler_.getUpdateState().then((r) => r.state)');
  const until = async (ok, what) => {
    let s;
    for (const end = Date.now() + 60000; Date.now() < end; await sleep(200)) { s = await state(); if (ok(s)) return s; }
    assert.fail(`${what}: ${JSON.stringify(s)}`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await until((s) => s.status === S.ready && s.version === NEW, 'the first is ready');
    await b.waitFor(`${SB}.getElementById('updateBanner')?.textContent.includes('Restart to update to ${NEW}')`);
    // The newer one comes out; the next check (here: Check for Updates) finds it.
    feed = second.feed;
    await b.eval('app.$.tabstrip.handler_.checkForUpdates()');
    await until((s) => s.status === S.ready && s.version === '9.9.10', 'the newer is ready');
    await b.waitFor(`${SB}.getElementById('updateBanner')?.textContent.includes('Restart to update to 9.9.10')`);
    assert.ok(!fs.existsSync(path.join(b.profile, 'Meridian Update', `staged-${NEW}`)) || await (async () => {
      for (let i = 0; i < 30 && fs.existsSync(path.join(b.profile, 'Meridian Update', `staged-${NEW}`)); i++) await sleep(100);
      return !fs.existsSync(path.join(b.profile, 'Meridian Update', `staged-${NEW}`));
    })(), 'the older download is gone');
    await b.eval('app.$.tabstrip.handler_.installUpdate()');
    for (let i = 0; i < 100 && b.proc.exitCode === null && b.proc.signalCode === null; i++) await sleep(150);
    for (let i = 0; i < 100 && fs.existsSync(a.installed + '.previous'); i++) await sleep(100);
    assert.deepEqual(tree(a.installed), tree(newer), 'straight to the latest');
  } finally {
    await b.close(); proxy.close();
    for (const r of [first, second]) { r.s.closeAllConnections(); r.s.close(); fs.rmSync(r.dir, { recursive: true, force: true }); }
    fs.rmSync(a.dir, { recursive: true, force: true }); fs.rmSync(path.dirname(newer), { recursive: true, force: true });
  }
});
