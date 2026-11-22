// Peek: a link from a pinned tab into another site opens as a card over it, not in Today; it expands into
// a tab or closes back to the pinned tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB, itemEl } from './harness.mjs';

const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const CR = `app.$.contentRegion`;

async function twoSites() {
  // 127.0.0.1 and localhost are different sites to the browser.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const port = server.address().port;
    res.end(req.url.startsWith('/app')
      ? `<title>App</title><a id=out target=_blank href="http://localhost:${port}/other">out</a>`
      : `<title>Other site</title><h1>other</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/app`, close: () => server.close() };
}

test('a link out of a pinned tab opens in Peek; Open as Tab moves it to Today; Close goes back', async () => {
  const site = await twoSites();
  const b = await launch([site.url]);
  try {
    await b.waitFor(today(1));
    const space = (await b.state()).spaces[0].name;
    await b.menu(`${SB}.querySelector('meridian-tab-row')`, 'Pin Tab');
    await b.waitFor(`!!${itemEl('App')}`);
    // Click the link inside the pinned page.
    const page = (await (await fetch(`${b.base}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('/app'));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.onopen = r);
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.getElementById('out').click()`, userGesture: true } }));
    await b.waitFor(`${CR}.hasAttribute('peek')`);
    assert.equal((await b.tabs()).length, 0, 'not in Today');
    await b.waitFor(`${CR}.shadowRoot.querySelector('.peek-card') && ${CR}.shadowRoot.querySelector('.peek-under')`);

    // Close: back to the pinned tab, no Peek.
    await b.click(`${CR}.shadowRoot.querySelector('#peekBar button[data-action="close"]')`);
    await b.waitFor(`!${CR}.hasAttribute('peek')`);
    await b.waitFor(`${itemEl('App')}.shadowRoot.querySelector('.row.active')`);

    // Again, and Open as Tab: it becomes a Today tab.
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: `document.getElementById('out').click()`, userGesture: true } }));
    await b.waitFor(`${CR}.hasAttribute('peek')`);
    await b.click(`${CR}.shadowRoot.querySelector('#peekBar button[data-action="expand"]')`);
    await b.waitFor(`!${CR}.hasAttribute('peek')`);
    await b.waitFor(today(1));
    assert.equal((await b.tabs())[0].title, 'Other site');
    ws.close();
  } finally { await b.close(); site.close(); }
});

test('a ⇧-clicked link opens in Peek over the page, not in a new window (Arc)', async () => {
  const site = await twoSites();
  const b = await launch([site.url]);
  try {
    await b.waitFor(today(1));
    const page = await b.page(site.url);
    await page.waitFor(`!!document.getElementById('out')`);
    const r = await page.eval(`(() => { const e = document.getElementById('out').getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; })()`);
    // A real mouse click with Shift held, in the page.
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, modifiers: 8 });
    }
    page.close();
    await b.waitFor(`${CR}.hasAttribute('peek')`);
    const windows = (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.startsWith('chrome://webui-browser'));
    assert.equal(windows.length, 1, 'no new window');
    assert.equal((await b.tabs()).length, 1, 'not in Today');
    await b.click(`${CR}.shadowRoot.querySelector('#peekBar button[data-action="close"]')`);
    await b.waitFor(`!${CR}.hasAttribute('peek')`);
  } finally { await b.close(); site.close(); }
});

// Arc: a pinned tab clicked in the sidebar just opens, even while a pinned tab of another site is
// shown (the browser makes the active tab the new one's opener; that isn't a link out of it).
test('a pinned tab of another site opened from the sidebar is a tab, not a Peek', async () => {
  const site = await twoSites();
  const other = site.url.replace('127.0.0.1', 'localhost').replace('/app', '/other');
  const b = await launch([site.url, other]);
  try {
    await b.waitFor(today(2));
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title).sort().join() === 'App,Other site'`);
    for (const title of ['App', 'Other site']) {
      await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === '${title}')`, 'Pin Tab');
      await b.waitFor(`!!${itemEl(title)}`);
    }
    // Unload the Other site's pinned tab, show App's, then click Other site's row.
    await b.eval(`app.$.tabstrip.closeTab([...app.$.tabstrip.tabs_.values()].find((t) => t.title === 'Other site').id)`);
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].length === 1`);
    await b.click(`${itemEl('App')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`${itemEl('App')}.shadowRoot.querySelector('.row.active')`);
    await b.click(`${itemEl('Other site')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.title === 'Other site'`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await b.eval(`${CR}.hasAttribute('peek')`), false, 'no Peek');
    await b.waitFor(`${itemEl('Other site')}.shadowRoot.querySelector('.row.active')`);
  } finally { await b.close(); site.close(); }
});
