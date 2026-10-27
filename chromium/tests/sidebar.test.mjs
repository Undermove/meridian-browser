// The Meridian sidebar on Chromium: layout, switching, opening and closing tabs with the mouse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, tabEl, SB } from './harness.mjs';

export const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const count = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;

test('the sidebar holds the address field and a vertical list of tabs', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(count(2));
    const rects = await b.eval(`[0, 1].map((i) => { const r = ${SB}.querySelectorAll('meridian-tab-row')[i].getBoundingClientRect(); return { x: r.x, y: r.y }; })`);
    assert.equal(rects[0].x, rects[1].x, 'tabs share a column');
    assert.ok(rects[1].y > rects[0].y, 'second tab is below the first');
    assert.equal(await b.eval(`app.shadowRoot.getElementById('sidebar').getBoundingClientRect().width`), 260);
    assert.ok(await b.eval(`app.shadowRoot.getElementById('sidebar').contains(app.$.urlPill)`), 'URL pill in the sidebar');
    // The page card has the same margin on the right as at the top and bottom.
    const m = await b.eval(`(() => { const r = app.$.contentRegion.getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, top: r.top }; })()`);
    assert.deepEqual(m, { right: 8, bottom: 8, top: 8 });
    // Today lists the newest tab first, like Arc.
    assert.deepEqual((await b.tabs()).map((t) => t.title), ['Two', 'One']);
  } finally { await b.close(); }
});

test('clicking a tab in the sidebar switches to it', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(count(2));
    const tabs = await b.tabs();
    const inactive = tabs.findIndex((t) => !t.active);
    await b.click(tabEl(inactive));
    await b.waitFor(`${tabEl(inactive)}.tab.isActive`);
    assert.equal((await b.tabs()).filter((t) => t.active).length, 1);
    const other = inactive === 0 ? 1 : 0;
    await b.click(tabEl(other));
    await b.waitFor(`${tabEl(other)}.tab.isActive`);
  } finally { await b.close(); }
});

test('the close button closes a tab', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(count(2));
    await b.click(`${tabEl(0)}.shadowRoot.querySelector('.close')`);
    await b.waitFor(count(1));
    assert.equal((await b.tabs())[0].title, 'One');
  } finally { await b.close(); }
});

test('a loading page pulses its row and runs a bar along the URL pill', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Slow</title>done'); }, 2500);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Fast</title>x');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await launch([`${base}/fast`]);
  try {
    await b.waitFor(count(1));
    await b.eval(`app.$.tabstrip.tabStripService_.createTabAt(null, ${JSON.stringify(`${base}/slow`)})`);
    await b.waitFor(`!!${tabEl(0)}.shadowRoot.querySelector('.row.loading')`);
    await b.waitFor(`app.shadowRoot.getElementById('urlPill').classList.contains('loading')`);
    await b.waitFor(`${tabEl(0)}.tab.title === 'Slow' && !${tabEl(0)}.shadowRoot.querySelector('.row.loading')`);
    await b.waitFor(`!app.shadowRoot.getElementById('urlPill').classList.contains('loading')`);
  } finally { await b.close(); server.close(); }
});

test('hovering a link shows its address at the bottom of the page', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Links</title><a href="https://example.org/some/where" style="display:block;font-size:80px;padding:60px">a link</a>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = await launch([`http://127.0.0.1:${server.address().port}/links`]);
  try {
    await b.waitFor(`${tabEl(0)}?.tab.title === 'Links'`);
    // The pointer over the page itself (the tab's own DevTools target): the
    // UI target's input never reaches guest pages.
    const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.endsWith('/links'));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.onopen = r);
    let id = 0;
    const move = (x, y) => ws.send(JSON.stringify({ id: ++id, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } }));
    const bubble = `app.shadowRoot.getElementById('statusBubble')`;
    // Keep moving until the page has laid out and reports the link.
    for (let i = 0; i < 20 && !(await b.eval(`${bubble}.textContent.includes('example.org/some/where')`)); i++) {
      move(100 + i, 100);
      await new Promise((r) => setTimeout(r, 250));
    }
    await b.waitFor(`!${bubble}.hidden && ${bubble}.textContent.includes('example.org/some/where')`);
    move(700, 550);
    await b.waitFor(`${bubble}.hidden`);
    ws.close();
  } finally { await b.close(); server.close(); }
});
