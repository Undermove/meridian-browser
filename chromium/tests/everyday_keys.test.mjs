// The everyday shortcuts, pressed for real (an NSEvent through AppKit and the main menu,
// --meridian-test-keys) while reading a page: ⌘L and Return, ⌘[ / ⌘], ⌘R, ⌃⇥, ⌘W (and ⇧⌘T).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMD = 1 << 20, SHIFT = 1 << 17, CTRL = 1 << 18;
const T = 'app.$.tabstrip';

// Pages titled by their path and how many times they were loaded.
function site() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${req.url.slice(1)} #${++hits}</title><p>text`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    port: () => server.address().port,
    url: (p) => `http://127.0.0.1:${server.address().port}/${p}`,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { if ((v = await fn())) return v; await sleep(100); }
  return v;
}

test('everyday keys from a focused page: ⌘L, ⌘[ ⌘], ⌘R, ⌃⇥, ⌘W, ⇧⌘T', async () => {
  const s = await site();
  const b = await launch([s.url('a'), s.url('b')], { args: ['--meridian-test-keys'] });
  const press = (code, ch, mods = 0) => b.eval(`${T}.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const rows = () => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => (r.tab.isActive ? '>' : '') + r.tab.title.replace(/ #\\d+$/, ''))`);
  const active = () => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title`);
  const readPage = async () => {
    await b.click('app.$.contentRegion');
    await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith('a ')).shadowRoot.querySelector('.row')`);
    await readPage();

    // ⌘L, a new address, Return: this tab goes there.
    await press(37, 'l', CMD);
    await b.waitFor(`app.$.commandBar.open`);
    const typed = `127.0.0.1:${s.port()}/c`;
    const codes = { 1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25, 0: 29, '.': 47, ':': 41, '/': 44, c: 8 };
    for (const ch of typed) await press(codes[ch], ch, ch === ':' ? SHIFT : 0);
    // Return right away, before the suggestions arrive (it used to get lost).
    await press(36, '\r');
    assert.match(await until(async () => /^c #/.test(await active()) && await active()), /^c #/, 'went to /c in this tab');
    assert.equal((await rows()).length, 2, 'no new tab');

    // ⌘[ back to /a, ⌘] forward to /c.
    await readPage();
    await press(33, '[', CMD);
    assert.ok(await until(async () => /^a #/.test(await active())), `⌘[ went back: ${await active()}`);
    await press(30, ']', CMD);
    assert.ok(await until(async () => /^c #/.test(await active())), `⌘] went forward: ${await active()}`);

    // ⌘R loads it again.
    const before = await active();
    await press(15, 'r', CMD);
    assert.ok(await until(async () => { const t = await active(); return /^c #/.test(t) && t !== before; }), `⌘R reloaded: ${await active()}`);

    // ⌃⇥ to the other tab.
    await press(48, '\t', CTRL);
    assert.ok(await until(async () => /^b #/.test(await active())), `⌃⇥ switched: ${await active()}`);

    // ⌘W closes it, ⇧⌘T brings it back.
    await readPage();
    await press(13, 'w', CMD);
    assert.ok(await until(async () => (await rows()).length === 1), `⌘W closed it: ${await rows()}`);
    // ⇧⌘T goes to the page first and comes back through the main menu, which AppKit only does
    // for the key window; a test window in the background never is, so run its command.
    await b.eval(`${T}.handler_.testCommand(34028)`);  // IDC_RESTORE_TAB
    assert.ok(await until(async () => (await rows()).some((r) => r.endsWith('b'))), `⇧⌘T brought it back: ${await rows()}`);
  } finally { await b.close(); s.close(); }
});
