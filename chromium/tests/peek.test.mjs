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

// "Open as Tab ▾": the peeked page as a tab in another space, which comes up with it.
test('Peek: Open as Tab ▾ opens it as a tab in another space', async () => {
  const site = await twoSites();
  const b = await launch([site.url]);
  try {
    await b.waitFor(today(1));
    await b.menu(`${SB}.querySelector('meridian-tab-row')`, 'Pin Tab');
    await b.waitFor(`!!${itemEl('App')}`);
    const page = (await (await fetch(`${b.base}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('/app'));
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.onopen = r);
    // One space: no ▾.
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.getElementById('out').click()`, userGesture: true } }));
    await b.waitFor(`${CR}.hasAttribute('peek')`);
    assert.equal(await b.eval(`${CR}.shadowRoot.getElementById('peekMore').hidden`), true);
    await b.click(`${CR}.shadowRoot.querySelector('#peekBar button[data-action="close"]')`);
    await b.waitFor(`!${CR}.hasAttribute('peek')`);

    await b.eval(`app.$.tabstrip.handler_.createSpace('Work', '', '#e08a8a', '#f0b5a8')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2`);
    const [first, work] = await b.eval(`app.$.tabstrip.state_.spaces.map((s) => s.id)`);
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: `document.getElementById('out').click()`, userGesture: true } }));
    await b.waitFor(`${CR}.hasAttribute('peek') && !${CR}.shadowRoot.getElementById('peekMore').hidden`);
    await b.click(`${CR}.shadowRoot.getElementById('peekMore')`);
    await b.waitFor(`!!app.shadowRoot.getElementById('peekSpaces')`);
    assert.deepEqual(await b.eval(`[...app.shadowRoot.querySelectorAll('#peekSpaces .little-space')].map((e) => e.textContent.trim())`), ['Work'], 'the other spaces');
    assert.equal(await b.eval(`app.shadowRoot.activeElement?.dataset.space`), work, 'the keyboard is in the menu');
    if (process.env.MERIDIAN_SHOTS) await b.screenshot(`${process.env.MERIDIAN_SHOTS}/peek-menu.png`);
    await b.click(`app.shadowRoot.querySelector('#peekSpaces .little-space')`);
    await b.waitFor(`app.$.tabstrip.state_.activeSpaceId === ${JSON.stringify(work)}`);
    await b.waitFor(`!${CR}.hasAttribute('peek')`);
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.title === 'Other site'`);
    assert.ok(await b.eval(`app.$.tabstrip.state_.tabs.some((t) => t.spaceId === ${JSON.stringify(work)} && !t.peek)`));
    assert.notEqual(first, work);
    ws.close();
  } finally { await b.close(); site.close(); }
});

// 27.11: a site opened with ⌘T while a pinned tab (the Workbench) was shown became a Peek over it
// once the person clicked a link inside the site and switched away. The browser makes the shown tab
// the opener of what ⌘T opens; the sidebar used to weigh that opener again on any change of the tab
// (and a tab closed before its first page kept that going). A tab the person opened is a tab.
test('a site opened with ⌘T over a pinned tab stays a tab: links inside it and switching away make no Peek', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/app')
      ? `<title>App</title><a id=blank target=_blank href="about:blank">blank</a>`
      : req.url.startsWith('/site2') ? `<title>Site inside</title><h1>inside</h1>`
      : `<title>Site</title><a id=next href="/site2">next</a>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const app = `http://127.0.0.1:${port}/app`;
  const other = `http://localhost:${port}/site`;
  const b = await launch([app]);
  try {
    await b.waitFor(today(1));
    await b.menu(`${SB}.querySelector('meridian-tab-row')`, 'Pin Tab');
    await b.waitFor(`!!${itemEl('App')}`);
    // Something opened from the pinned page and closed before it had a page (as Workbench's tabs can).
    const page = await b.page(app);
    const click = (pg, id) => pg.cdp.send('Runtime.evaluate', { expression: `document.getElementById('${id}').click()`, userGesture: true });
    await click(page, 'blank');
    page.close();
    await b.waitFor(today(1));
    await b.eval(`app.$.tabstrip.closeTab((${SB}.querySelector('meridian-tab-row')).tab.id)`);
    await b.waitFor(today(0));
    await b.click(`${itemEl('App')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`${itemEl('App')}.shadowRoot.querySelector('.row.active')`);

    // ⌘T (New Tab takes the same route into the bar), the other site typed, Return.
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`app.$.commandBar.open && app.$.commandBar.$.address.shadowRoot.querySelector('cr-searchbox-input')`);
    await b.type(other);
    await new Promise((r) => setTimeout(r, 400));
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === 'Site'`);
    // A link inside the site, then away to the pinned tab and back.
    const site = await b.page(other);
    await click(site, 'next');
    site.close();
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === 'Site inside'`,
        10000, `({ peek: ${CR}.hasAttribute('peek'), today: [...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title) })`);
    await b.click(`${itemEl('App')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`${itemEl('App')}.shadowRoot.querySelector('.row.active')`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await b.eval(`${CR}.hasAttribute('peek')`), false, 'no Peek over the pinned tab');
    await b.waitFor(today(1));
    await b.click(`${SB}.querySelector('meridian-tab-row')`);
    await b.waitFor(`${SB}.querySelector('meridian-tab-row').tab.isActive`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await b.eval(`${CR}.hasAttribute('peek')`), false, 'the site is shown as a tab');
    assert.equal((await b.tabs()).find((t) => t.active)?.title, 'Site inside');
  } finally { await b.close(); server.close(); }
});
