// A page's process dies (the site crashed it, it ran out of memory, it was ended in Activity
// Monitor): only that tab shows "Aw, Snap!". Meridian itself stays up (Chromium's sad tab looked for
// Chrome's BrowserView, which Meridian's window hasn't got); the tab reloads with ⌘R and closes
// with ⌘W; a crashed tab in the background is no crash either when it's clicked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMD = 1 << 20;
const T = 'app.$.tabstrip';
const alive = (b) => b.proc.exitCode === null && b.proc.signalCode === null;

async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { if ((v = await fn())) return v; await sleep(100); }
  return v;
}

test('a tab whose page process dies: Meridian stays up; ⌘R reloads it, ⌘W closes it; a crashed background tab opens', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${req.url.slice(1)} #${++hits}</title><p>${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}/${p}`;
  const b = await launch([url('a'), url('b'), url('c')], { args: ['--meridian-test-keys'] });
  const press = (code, ch, mods = 0) => b.eval(`${T}.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const rows = () => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => (r.tab.isActive ? '>' : '') + r.tab.title.replace(/ #\\d+$/, ''))`);
  const active = () => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title`);
  const clickRow = (name) => b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url.endsWith('/${name}')).shadowRoot.querySelector('.row')`);
  const readPage = async () => {
    await b.click('app.$.contentRegion');
    await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 3`);
    // The tab being read crashes.
    await clickRow('a');
    assert.ok(await until(async () => /^a #/.test(await active())));
    const a = await b.page(url('a'));
    a.cdp.send('Page.crash').catch(() => {});
    await sleep(3000);
    assert.ok(alive(b), 'Meridian is running after the page it showed crashed');
    assert.equal(await b.eval('1 + 1'), 2);

    // A tab in the background crashes; clicking it shows it.
    const c = await b.page(url('c'));
    c.cdp.send('Page.crash').catch(() => {});
    await sleep(2000);
    assert.ok(alive(b), 'Meridian is running after a background page crashed');
    await clickRow('c');
    await sleep(1500);
    assert.ok(alive(b), 'Meridian is running after the crashed tab was clicked');

    // ⌘R brings the page back.
    await readPage().catch(() => {});
    await press(15, 'r', CMD);
    assert.ok(await until(async () => alive(b) && /^c #[2-9]/.test(await active()), 10000), `⌘R reloaded it: ${alive(b) && await active()}`);

    // Back to the first crashed one, ⌘W closes it.
    await clickRow('a');
    await sleep(1000);
    assert.ok(alive(b), 'Meridian is running on the crashed tab');
    await press(13, 'w', CMD);
    assert.ok(await until(async () => alive(b) && (await rows()).length === 2), `⌘W closed it: ${alive(b) && await rows()}`);
    assert.ok(alive(b), 'Meridian is running after the crashed tab closed');
  } finally { await b.close(); server.close(); }
});
