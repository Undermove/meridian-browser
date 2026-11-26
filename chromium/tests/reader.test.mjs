// Reader: the article alone, in Chromium's reading view (DOM Distiller), from the site controls and
// from the command bar ("Reader"); again takes the page back; a page with no article says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const SC = `app.$.siteControl.shadowRoot`;
const BAR = 'app.$.commandBar';
const CB = `${BAR}.shadowRoot`;
const SHOTS = process.env.MERIDIAN_SHOTS || '';
const para = (i) => `<p>Paragraph ${i} of the kiwi story. The kiwi is a flightless bird native to New Zealand, about the size of a domestic chicken, and the only bird with nostrils at the end of its long beak. It sleeps in burrows by day and hunts insects and worms by night, finding them by smell.</p>`;
const ARTICLE = `<!doctype html><html lang="en"><head><title>The Kiwi Story</title></head><body>
  <nav><a href="/">Home</a> <a href="/x">Shop</a> <a href="/y">Login</a></nav>
  <div class="ad">BUY NOW ad banner</div>
  <article><h1>The Kiwi Story</h1>${Array.from({ length: 14 }, (_, i) => para(i + 1)).join('')}</article>
  <footer>Footer links and copyright</footer></body></html>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Reader from the site controls and the command bar: the article alone, then back', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/article' ? ARTICLE : '<!doctype html><title>Empty</title><a href="/">x</a>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const b = await launch([url('/article')]);
  const active = `[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.url || ''`;
  try {
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`, 15000);
    await b.click(`app.$.locationIconButton`);
    await b.waitFor(`app.$.siteControl.open && !!${SC}.querySelector('.q[data-action="reader"]')`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await sleep(300); await b.screenshot(path.join(SHOTS, 'reader-site-control.png')); }
    await b.click(`${SC}.querySelector('.q[data-action="reader"]')`);
    await b.waitFor(`(${active}).startsWith('chrome-distiller://')`, 20000, active);
    // The reading view: the article's words, not the ad or the menu.
    const view = await b.page('chrome-distiller://', 15000);
    await view.waitFor(`document.body.innerText.includes('Paragraph 14 of the kiwi story')`, 15000);
    assert.ok(!(await view.eval(`document.body.innerText.includes('BUY NOW')`)), 'no ad');
    assert.match(await view.eval('document.title'), /Kiwi Story/);
    view.close();
    if (SHOTS) { await sleep(500); await b.screenshot(path.join(SHOTS, 'reader-view.png')); }
    // The site controls offer the way back.
    await b.click(`app.$.locationIconButton`);
    await b.waitFor(`app.$.siteControl.open && ${SC}.querySelector('.q[data-action="reader"]')?.textContent.trim() === 'Exit Reader'`);
    await b.click(`${SC}.querySelector('.q[data-action="reader"]')`);
    await b.waitFor(`(${active}) === ${JSON.stringify(url('/article'))}`, 15000, active);

    // The command bar: "Reader" and Return.
    // ⌘T's bar (the + in the sidebar).
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`${BAR}.open`);
    await b.waitFor(`${BAR}.$.address.matches(':focus-within')`);
    await b.eval(`(() => { const i = ${BAR}.$.address.shadowRoot.querySelector('cr-searchbox-input').shadowRoot.querySelector('input'); i.select(); return true; })()`);
    await b.type('reader');
    await b.key('ArrowRight', 'ArrowRight', 39);
    await b.waitFor(`[...${CB}.querySelectorAll('#features .tab-row')].some((r) => r.querySelector('.tab-title').textContent === 'Reader')`);
    await b.waitFor(`${CB}.querySelector('#features .tab-row.sel .tab-title')?.textContent === 'Reader'`);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`(${active}).startsWith('chrome-distiller://')`, 20000, active);

    // A page with nothing to read: it stays, and a toast says so.
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(url('/empty'))})`);
    await b.waitFor(`(${active}) === ${JSON.stringify(url('/empty'))}`, 15000, active);
    await b.eval(`app.$.tabstrip.handler_.toggleReader().then((r) => r.state)`).then((s) => assert.equal(s, 'none'));
  } finally { await b.close(); server.close(); }
});

// Once in a full run Exit Reader stayed in the reading view: in and out several times, each exit
// lands on the page itself (history back, else the page loaded again within a second).
test('Reader in and out again and again: every exit lands on the page', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/article' ? ARTICLE : '<!doctype html><title>Empty</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = `http://127.0.0.1:${server.address().port}/article`;
  const b = await launch([page]);
  const active = `[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.url || ''`;
  try {
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`, 15000);
    for (let i = 0; i < 4; i++) {
      assert.equal(await b.eval(`app.$.tabstrip.handler_.toggleReader().then((r) => r.state)`), 'on', `in, round ${i + 1}`);
      await b.waitFor(`(${active}).startsWith('chrome-distiller://')`, 20000, active);
      // Out at once, as a person clicking twice quickly does on some rounds.
      if (i % 2) await sleep(1500);
      assert.equal(await b.eval(`app.$.tabstrip.handler_.toggleReader().then((r) => r.state)`), 'off', `out, round ${i + 1}`);
      await b.waitFor(`(${active}) === ${JSON.stringify(page)}`, 15000, active);
    }
  } finally { await b.close(); server.close(); }
});
