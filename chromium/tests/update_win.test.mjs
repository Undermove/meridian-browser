// The updater on Windows against a stand-in GitHub (update.test.mjs is the macOS one): a newer
// release's installer is downloaded and checked against SHA256SUMS-win.txt, signed with a release
// key this test makes; "Restart to update" quits Meridian and hands the installer over. The test
// never runs an installer: with --meridian-test-update-target a copy of what was downloaded lands
// in a temp folder instead. A wrong checksum and checksums not signed with the release key are
// refused, and the same version is up to date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const WINDOWS = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = { upToDate: 2, available: 3, ready: 5, failed: 6 };
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const SETUP = `Meridian-9.9.9-win-${ARCH}-setup.exe`;
// The stand-in release key; Meridian gets its public half (raw, base64).
const KEY = crypto.generateKeyPairSync('ed25519');
const PUB = KEY.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
// What stands in for the installer: never run, only handed over.
const NEW = Buffer.from('the new installer\n'.repeat(4000));

// badSig: the checksums signed with another key.
async function release({ tag = 'v9.9.9', badSum = false, badSig = false } = {}) {
  const sum = badSum ? '0'.repeat(64) : crypto.createHash('sha256').update(NEW).digest('hex');
  const sums = `${sum}  ${SETUP}\n`;
  const signer = badSig ? crypto.generateKeyPairSync('ed25519').privateKey : KEY.privateKey;
  const sig = crypto.sign(null, Buffer.from(sums), signer).toString('base64') + '\n';
  const asked = [];
  const s = http.createServer((req, res) => {
    asked.push(req.url);
    const base = `http://127.0.0.1:${s.address().port}`;
    if (req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: tag, html_url: `${base}/page`, assets: [
        // The Mac's files are there too, and aren't this system's.
        { name: 'Meridian-9.9.9-mac-arm64.zip', browser_download_url: `${base}/zip` },
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/mac-sums` },
        { name: SETUP.replace('9.9.9', tag.replace(/^v/, '')), browser_download_url: `${base}/setup` },
        { name: 'SHA256SUMS-win.txt', browser_download_url: `${base}/sums` },
        { name: 'SHA256SUMS-win.txt.sig', browser_download_url: `${base}/sig` },
      ] }));
    } else if (req.url === '/setup') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': NEW.length });
      res.end(NEW);
    } else if (req.url === '/sums') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(sums);
    } else if (req.url === '/sig') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(sig);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Release</title>');
    }
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, asked, feed: `http://127.0.0.1:${s.address().port}/feed` };
}

async function start(rel, target, extra = []) {
  const b = await launch(['about:blank'], { args: [`--meridian-update-feed=${rel.feed}`, `--meridian-test-update-key=${PUB}`, `--meridian-test-update-target=${target}`, ...extra] });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  const state = () => b.eval('app.$.tabstrip.handler_.getUpdateState().then((r) => r.state)');
  const waitStatus = async (status, ms = 15000) => {
    let s;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
      s = await state();
      if (s.status === status) return s;
    }
    assert.fail(`update status ${status}, got ${JSON.stringify(s)}`);
  };
  return { b, state, waitStatus };
}

test('Updates on Windows: a newer release’s installer is downloaded and checked; Restart to update quits and hands it over', { skip: !WINDOWS && 'Windows only' }, async () => {
  const rel = await release();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-apps-')));
  const target = path.join(home, 'handed-over.exe');
  const { b, waitStatus } = await start(rel, target);
  try {
    const s = await waitStatus(S.ready);
    assert.equal(s.version, '9.9.9');
    assert.match(s.current, /^\d+\.\d+\.\d+$/);
    assert.ok(!rel.asked.includes('/mac-sums') && !rel.asked.includes('/zip'), `only Windows's files: ${rel.asked.join(' ')}`);
    // Settings says so too.
    await b.eval(`app.$.settings.show(app.$.tabstrip.state_.spaces, 'general')`);
    await b.waitFor(`app.$.settings.shadowRoot.getElementById('updateText')?.textContent.includes('Meridian 9.9.9 is ready')`);
    assert.ok(await b.eval(`!!app.$.settings.shadowRoot.getElementById('restartUpdate')`));
    await b.eval('app.$.settings.open = false');
    // The sidebar's pill: Meridian quits, then the installer is handed over.
    await b.waitFor(`${SB}.getElementById('updateBanner')?.textContent.includes('Restart to update to 9.9.9')`);
    assert.equal(fs.existsSync(target), false, 'nothing is handed over before the restart');
    await b.click(`${SB}.getElementById('updateBanner')`);
    // It asks first (what's new): Restart now.
    await b.waitFor(`app.$.updateSheet.open`);
    await b.click(`app.$.updateSheet.shadowRoot.getElementById('restart')`);
    for (let i = 0; i < 100 && b.proc.exitCode === null && b.proc.signalCode === null; i++) await sleep(150);
    assert.ok(b.proc.exitCode !== null || b.proc.signalCode !== null, 'Meridian quit');
    for (let i = 0; i < 100 && !fs.existsSync(target); i++) await sleep(100);
    assert.ok(fs.existsSync(target), 'the installer was handed over');
    assert.ok(fs.readFileSync(target).equals(NEW), 'and it is the release’s');
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Updates on Windows: a wrong checksum or unsigned checksums are refused; the same version is up to date', { skip: !WINDOWS && 'Windows only' }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-apps-')));
  const target = path.join(home, 'handed-over.exe');
  // Wrong checksum: nothing to install.
  let rel = await release({ badSum: true });
  let { b, waitStatus } = await start(rel, target);
  let current;
  try {
    const s = await waitStatus(S.failed);
    current = s.current;
    assert.match(s.error, /doesn’t match the release’s checksum/);
    assert.equal(await b.eval(`!!${SB}.getElementById('updateBanner')`), false);
    assert.equal(fs.existsSync(path.join(b.profile, 'Meridian Update', SETUP)), false, 'the download is gone');
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close();
  }

  // Checksums signed with another key: not trusted.
  rel = await release({ badSig: true });
  ({ b, waitStatus } = await start(rel, target));
  try {
    const s = await waitStatus(S.failed);
    assert.match(s.error, /checksums aren’t signed by Meridian/);
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close();
  }

  // The same version: up to date, nothing downloaded.
  rel = await release({ tag: `v${current}` });
  ({ b, waitStatus } = await start(rel, target));
  try {
    await waitStatus(S.upToDate);
    assert.ok(!rel.asked.includes('/setup'), 'nothing downloaded');
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(target), false, 'nothing was handed over');
});
