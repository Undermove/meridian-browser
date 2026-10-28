// The updater against a stand-in GitHub: a newer release is downloaded, checked against its
// SHA256SUMS and unpacked; "Restart to update" in the sidebar quits Meridian and the app is swapped
// (a stand-in Meridian.app in a temp folder, never the build under test). A wrong checksum is
// refused, a folder it can't write to points to the release page, and the same version is up to date.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = { upToDate: 2, available: 3, ready: 5, failed: 6 };
const ZIP = 'Meridian-9.9.9-mac-arm64.zip';

// A Meridian.app with the real bundle id and a marker saying which one it is.
function fakeApp(dir, version) {
  const app = path.join(dir, 'Meridian.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.meridian.browser</string></dict></plist>`);
  fs.writeFileSync(path.join(app, 'Contents', 'version'), version);
  return app;
}

async function release({ tag = 'v9.9.9', badSum = false } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-update-')));
  fakeApp(path.join(dir, 'build'), 'new');
  const zip = path.join(dir, ZIP);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', path.join(dir, 'build', 'Meridian.app'), zip]);
  const sum = badSum ? '0'.repeat(64) : crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  const s = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${s.address().port}`;
    if (req.url === '/feed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: tag, html_url: `${base}/page`, assets: [
        { name: ZIP.replace('.zip', '.dmg'), browser_download_url: `${base}/dmg` },
        { name: ZIP, browser_download_url: `${base}/zip` },
        { name: 'SHA256SUMS.txt', browser_download_url: `${base}/sums` },
      ] }));
    } else if (req.url === '/zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(zip).size });
      res.end(fs.readFileSync(zip));
    } else if (req.url === '/sums') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${'1'.repeat(64)}  ${ZIP.replace('.zip', '.dmg')}\n${sum}  ${ZIP}\n`);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Release</title>');
    }
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { dir, s, feed: `http://127.0.0.1:${s.address().port}/feed` };
}

async function start(rel, installed, extra = []) {
  const b = await launch(['about:blank'], { args: [`--meridian-update-feed=${rel.feed}`, `--meridian-test-update-target=${installed}`, ...extra] });
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

test('Updates: a newer release is checked and unpacked; Restart to update swaps the app', async () => {
  const rel = await release();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-apps-')));
  const installed = fakeApp(home, 'old');
  const { b, waitStatus } = await start(rel, installed);
  try {
    const s = await waitStatus(S.ready);
    assert.equal(s.version, '9.9.9');
    assert.equal(s.current, '0.5.0');
    // Settings says so too.
    await b.eval(`app.$.settings.show(app.$.tabstrip.state_.spaces, 'general')`);
    await b.waitFor(`app.$.settings.shadowRoot.getElementById('updateText')?.textContent.includes('Meridian 9.9.9 is ready')`);
    assert.ok(await b.eval(`!!app.$.settings.shadowRoot.getElementById('restartUpdate')`));
    await b.eval('app.$.settings.open = false');
    // The sidebar's pill: Meridian quits and the app is swapped.
    await b.waitFor(`${SB}.getElementById('updateBanner')?.textContent.includes('Restart to update to 9.9.9')`);
    await b.click(`${SB}.getElementById('updateBanner')`);
    for (let i = 0; i < 100 && b.proc.exitCode === null && b.proc.signalCode === null; i++) await sleep(150);
    assert.ok(b.proc.exitCode !== null || b.proc.signalCode !== null, 'Meridian quit');
    for (let i = 0; i < 50 && fs.readFileSync(path.join(installed, 'Contents', 'version'), 'utf8') !== 'new'; i++) await sleep(100);
    assert.equal(fs.readFileSync(path.join(installed, 'Contents', 'version'), 'utf8'), 'new');
    assert.equal(fs.existsSync(installed + '.previous'), false);
    assert.match(fs.readFileSync(path.join(b.profile, 'Meridian Update', 'swap.log'), 'utf8'), /updated/);
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close();
    for (const d of [rel.dir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Updates: a wrong checksum is refused; a folder it can’t write to gets the release page; same version is up to date', async () => {
  // Wrong checksum: nothing to install.
  let rel = await release({ badSum: true });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-apps-')));
  const installed = fakeApp(home, 'old');
  let { b, waitStatus } = await start(rel, installed);
  try {
    const s = await waitStatus(S.failed);
    assert.match(s.error, /doesn’t match the release’s checksum/);
    assert.equal(await b.eval(`!!${SB}.getElementById('updateBanner')`), false);
    assert.equal(fs.readFileSync(path.join(installed, 'Contents', 'version'), 'utf8'), 'old');
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close(); fs.rmSync(rel.dir, { recursive: true, force: true });
  }

  // Its folder is read-only (as a disk image would be): the release page, no download.
  rel = await release();
  fs.chmodSync(home, 0o555);
  ({ b, waitStatus } = await start(rel, installed));
  try {
    await waitStatus(S.available);
    await b.eval(`app.$.settings.show(app.$.tabstrip.state_.spaces, 'general')`);
    await b.waitFor(`!!app.$.settings.shadowRoot.getElementById('releasePage')`);
    // Further down the General page.
    await b.eval(`(app.$.settings.shadowRoot.getElementById('releasePage').scrollIntoView({block: 'center'}), true)`);
    await b.click(`app.$.settings.shadowRoot.getElementById('releasePage')`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Release')`);
  } finally {
    await b.close(); fs.chmodSync(home, 0o755); rel.s.closeAllConnections(); rel.s.close(); fs.rmSync(rel.dir, { recursive: true, force: true });
  }

  // The release is this version: Check for Updates says it's up to date.
  rel = await release({ tag: 'v0.5.0' });
  ({ b, waitStatus } = await start(rel, installed));
  try {
    await waitStatus(S.upToDate);
    await b.eval(`app.$.settings.show(app.$.tabstrip.state_.spaces, 'general')`);
    await b.eval(`(app.$.settings.shadowRoot.getElementById('checkUpdates').scrollIntoView({block: 'center'}), true)`);
    await b.click(`app.$.settings.shadowRoot.getElementById('checkUpdates')`);
    await b.waitFor(`app.$.settings.shadowRoot.getElementById('updateText')?.textContent === 'Meridian is up to date.'`);
  } finally {
    await b.close(); rel.s.closeAllConnections(); rel.s.close();
    for (const d of [rel.dir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});
