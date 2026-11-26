// "Ask AI About This Page" in a page's right-click menu: a user (24.11.2026) looked for asking AI
// about the page there and found nothing. The item opens the same Ask panel as ⌘J, and only opens
// it: picked again while Ask is open, Ask stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const ASK_PAGE = 39728;  // IDC_MERIDIAN_ASK_PAGE
const AK = 'app.$.ask.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the page context menu has Ask AI About This Page, and it opens Ask as ⌘J does', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Article</title><body style="margin:0"><p>Some article text.</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/article`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-askmenu-'));
  const pick = path.join(dir, 'pick');
  fs.writeFileSync(pick, 'list');
  const b = await launch([url], { args: [`--meridian-test-context-menu-command=@${pick}`] });
  const rightClick = async (page) => {
    for (const [type, button] of [['mouseMoved', 'none'], ['mousePressed', 'right'], ['mouseReleased', 'right']]) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: 200, y: 200, button, clickCount: 1 });
    }
  };
  try {
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    // A real right click on the page: the menu lists the item.
    await rightClick(page);
    for (let i = 0; i < 50 && !fs.existsSync(pick + '.ids'); i++) await sleep(100);
    const ids = fs.readFileSync(pick + '.ids', 'utf8').split('\n').filter(Boolean).map(Number);
    assert.ok(ids.includes(ASK_PAGE), `the page menu: ${ids.join(', ')}`);
    assert.equal(await b.eval('app.$.ask.open'), false);

    // Picked: Ask opens, ready to type.
    fs.writeFileSync(pick, String(ASK_PAGE));
    await rightClick(page);
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);

    // Picked again while Ask is open: it stays open (⌘J is the one that closes it).
    await rightClick(page);
    await sleep(500);
    assert.equal(await b.eval('app.$.ask.open'), true);
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor('!app.$.ask.open');
    page.close();
  } finally { await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
