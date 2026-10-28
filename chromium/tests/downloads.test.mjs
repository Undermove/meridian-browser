// The Downloads popover: a download shows up with its progress, can be cancelled, and once done is
// opened from the list or shown in Finder; Clear forgets the finished ones; ⇧⌘J toggles it; and
// closing what would cancel a download asks first (answered by a test switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { downloads: 18 };
const rows = `[...${SB}.querySelectorAll('#downloads .dl')].map((r) => ({ name: r.querySelector('.dl-name').textContent, status: r.querySelector('.dl-status').textContent, state: r.className.replace('dl ', '') }))`;

function server() {
  const slow = new Set();
  const s = http.createServer((req, res) => {
    if (req.url === '/report.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"', 'content-length': 2048 });
      res.end('x'.repeat(2048));
    } else if (req.url === '/big.bin') {
      // A slow one: a chunk now, the rest never (until the test ends).
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'content-length': 10 * 1024 * 1024 });
      res.write(Buffer.alloc(512 * 1024));
      slow.add(res);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Files</title><a id=a href="/report.txt">report</a><a id=b href="/big.bin">big</a>');
    }
  });
  return { s, slow };
}

function profileWithDownloads() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-dl-')));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: dir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: dir },
  }));
  return { profile, dir };
}

test('Downloads: progress, cancel, done, Clear; ⇧⌘J toggles the popover', async () => {
  const { s, slow } = server();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/`;
  const { profile, dir } = profileWithDownloads();
  const b = await launch([url], { profile });
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Files')`);
    // No downloads yet: no button.
    assert.equal(await b.eval(`!!${SB}.getElementById('downloadsButton')`), false);
    // ⇧⌘J opens the empty popover.
    await b.eval(`app.$.tabstrip.runCommand(${C.downloads}, 0)`);
    await b.waitFor(`!${SB}.getElementById('downloads').hidden`);
    assert.equal(await b.eval(`${SB}.querySelector('#downloads .dl-empty')?.textContent`), 'Nothing downloaded yet');
    await b.eval(`app.$.tabstrip.runCommand(${C.downloads}, 0)`);
    await b.waitFor(`${SB}.getElementById('downloads').hidden`);

    // A slow one: listed while it downloads, with a progress ring on the button.
    const page = await b.page(url);
    await page.eval(`document.getElementById('b').click()`);
    await b.waitFor(`!!${SB}.getElementById('downloadsButton')?.querySelector('.ring')`, 15000);
    await b.click(`${SB}.getElementById('downloadsButton')`);
    await b.waitFor(`!${SB}.getElementById('downloads').hidden`);
    await b.waitFor(`(${rows}).some((r) => r.name === 'big.bin' && r.state === 'progressing' && r.status.endsWith('of 10 MB'))`, 15000);

    // A small one finishes at once (in a tab of its own: a second download from the same page
    // needs Chromium's "multiple downloads" permission).
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(url + 'report.txt')})`);
    await b.waitFor(`(${rows})[0]?.name === 'report.txt' && (${rows})[0].state === 'completed'`, 15000);
    assert.equal((await b.eval(rows))[0].status, '2.0 KB');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'report.txt')); i++) await sleep(100);
    assert.equal(fs.readFileSync(path.join(dir, 'report.txt'), 'utf8').length, 2048);

    // Cancel the slow one.
    await b.click(`[...${SB}.querySelectorAll('#downloads .dl')].find((r) => r.querySelector('.dl-name').textContent === 'big.bin').querySelector('[data-action="cancel"]')`);
    await b.waitFor(`(${rows}).find((r) => r.name === 'big.bin')?.state === 'cancelled'`);
    assert.equal(await b.eval(`!!${SB}.getElementById('downloadsButton').querySelector('.ring')`), false);

    // Clear forgets the finished and cancelled ones; the file stays.
    await b.click(`${SB}.getElementById('clearDownloads')`);
    await b.waitFor(`(${rows}).length === 0`);
    assert.ok(fs.existsSync(path.join(dir, 'report.txt')));
    // A click outside closes it.
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`${SB}.getElementById('downloads').hidden`);
    page.close();
  } finally {
    for (const r of slow) r.destroy();
    await b.close();
    s.closeAllConnections(); s.close();
    for (const d of [profile, dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Closing the last private window cancels its downloads, so it asks (quitting asks the same way; a
// Mac keeps downloading after the last normal window closes).
for (const answer of ['Keep Downloading', 'Close Anyway']) {
  test(`Downloads: closing the private window while one downloads asks first; “${answer}”`, async () => {
    const { s, slow } = server();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}/`;
    const { profile, dir } = profileWithDownloads();
    const b = await launch([url], { profile, args: ['--incognito', `--meridian-test-dialog-answer=${answer}`] });
    const windows = async () => (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.startsWith('chrome://webui-browser')).length;
    try {
      await b.waitFor(`app.hasAttribute('private')`);
      await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Files')`);
      const page = await b.page(url);
      await page.eval(`document.getElementById('b').click()`);
      await b.waitFor(`!!${SB}.getElementById('downloadsButton')?.querySelector('.ring')`, 15000);
      page.close();
      await b.eval(`(() => { app.$.tabstrip.tabStripService_.closeNodes(app.$.tabstrip.state_.tabs.map((t) => t.tabId)); return true; })()`);
      if (answer === 'Close Anyway') {
        let left = 1;
        for (let i = 0; i < 50 && left; i++) { left = await windows(); if (left) await sleep(200); }
        assert.equal(left, 0, 'the window closed');
        return;
      }
      await sleep(2500);
      assert.equal(await windows(), 1, 'the window stays');
      assert.ok(await b.eval(`!!${SB}.getElementById('downloadsButton')?.querySelector('.ring')`), 'still downloading');
    } finally {
      for (const r of slow) r.destroy();
      await b.close();
      s.closeAllConnections(); s.close();
      for (const d of [profile, dir]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
}
