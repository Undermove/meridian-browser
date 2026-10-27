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
    await b.menu(`${SB}.querySelector('meridian-tab-row')`, `Pin to ${space}`);
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
