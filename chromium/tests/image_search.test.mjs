// "Search Image with Google" from a picture's context menu: Chromium's Lens overlay has no place in
// Meridian's window and crashed the browser (a report from a user, 17.11.2026: right click on a
// picture on habr.com, then the menu's image search). Now the search opens in a new tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

const SEARCH_LENS_FOR_IMAGE = 50127;  // IDC_CONTENT_CONTEXT_SEARCHLENSFORIMAGE
// A 40×40 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAALUlEQVR4nO3NMQkAAAwDsPo3vckolED+5JKKzioWi8VisVgsFovFYrFYLB6NH6r1OhvW1o1iAAAAAElFTkSuQmCC', 'base64');

test('Search Image with Google on a picture: no crash, the search opens in a new tab', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Article</title><body style="margin:0"><img id=pic src="/pic.png" width=200 height=200>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/article`;
  const b = await launch([url], { args: [`--meridian-test-context-menu-command=${SEARCH_LENS_FOR_IMAGE}`] });
  try {
    const page = await b.page(url);
    await page.waitFor(`document.getElementById('pic').complete && document.getElementById('pic').naturalWidth === 40`);
    // A real right click on the picture; the switch picks the menu's image search.
    for (const [type, button] of [['mouseMoved', 'none'], ['mousePressed', 'right'], ['mouseReleased', 'right']]) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: 100, y: 100, button, clickCount: 1 });
    }
    // The search, in a tab of its own; the article stays.
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].some((t) => /^https:\\/\\/(lens|www)\\.google\\./.test(t.url))`, 15000,
      `[...app.$.tabstrip.tabs_.values()].map((t) => t.url)`);
    assert.ok((await b.eval(`[...app.$.tabstrip.tabs_.values()].map((t) => t.url)`)).includes(url));
    // Still alive.
    assert.equal(await b.eval('1 + 1'), 2);
    page.close();
  } finally { await b.close(); server.close(); }
});
