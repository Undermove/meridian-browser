// The command bar with the keyboard only, the way people use it: real key presses (an NSEvent
// through AppKit, --meridian-test-keys), starting from a page that has the focus. ⌘T takes the
// keys from the page and Esc gives them back; the arrows go through one list (the suggestions,
// then the open tabs; just the tabs with nothing typed) and Return opens what is picked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMD = 1 << 20;
const KEY = {
  t: [17, 't'], a: [0, 'a'], l: [37, 'l'], p: [35, 'p'], h: [4, 'h'], x: [7, 'x'],
  down: [125, ''], up: [126, ''], enter: [36, '\r'], esc: [53, '\u001b'],
};
const CB = 'app.$.commandBar.shadowRoot';
const INPUT = `${CB}.getElementById('address').shadowRoot.querySelector('cr-searchbox-input').shadowRoot.querySelector('input')`;

// Pages titled by their path; /slow never finishes loading.
function site() {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<title>Slow</title>'); return; }
    const name = decodeURIComponent(req.url.slice(1));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${name}</title><input id="i">`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: (p) => `http://127.0.0.1:${server.address().port}/${encodeURIComponent(p).replace('%2F', '/')}`,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

async function start(names) {
  const s = await site();
  const b = await launch(names.map((n) => s.url(n)), { args: ['--meridian-test-keys'] });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === ${names.length}`);
  const press = ([code, ch], mods = 0) => b.eval(`app.$.tabstrip.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const state = () => b.eval(`(() => {
    const dd = ${CB}.getElementById('address').shadowRoot.querySelector('cr-searchbox-dropdown');
    const visible = dd && !dd.hidden;
    return {
      open: app.$.commandBar.open,
      input: ${INPUT}.value,
      tabs: [...${CB}.querySelectorAll('#tabs .tab-row')].map((r) => (r.classList.contains('sel') ? '>' : '') + r.querySelector('.tab-title').textContent),
      matches: visible ? [...dd.shadowRoot.querySelectorAll('cr-searchbox-match')].map((m) => (m.hasAttribute('selected') ? '>' : '') + (m.match?.destinationUrl?.url || '')) : [],
      active: [...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title,
      pageFocused: app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content') ?? false,
    };
  })()`);
  // Every tab looked at (the bar lists the latest first), then the page focused, like someone reading it.
  for (const n of names) {
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(n)}).shadowRoot.querySelector('.row')`);
    await sleep(150);
  }
  await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
  return { b, s, press, state };
}

const until = async (fn, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn())) return v; await sleep(100); } return v; };

test('⌘T takes the keys from the page, Esc gives them back; with nothing typed the arrows walk the tabs only', async () => {
  const { b, s, press, state } = await start(['One', 'Two', 'Three', 'Four']);
  try {
    await press(KEY.t, CMD);
    await b.waitFor(`app.$.commandBar.open`);
    let st = await state();
    assert.deepEqual(st.tabs, ['>Three', 'Two', 'One'], 'the latest tabs, the first picked');
    // ↓↓: through the tabs; no suggestions fetched for an empty field (they took the selection).
    await press(KEY.down);
    await press(KEY.down);
    st = await state();
    assert.deepEqual(st.tabs, ['Three', 'Two', '>One']);
    assert.deepEqual(st.matches, [], JSON.stringify(st));
    assert.equal(st.input, '');
    await press(KEY.up);
    assert.deepEqual((await state()).tabs, ['Three', '>Two', 'One']);
    // Return: that tab, and the keys go back to its page.
    await press(KEY.enter);
    await until(async () => (await state()).active === 'Two');
    st = await state();
    assert.equal(st.open, false);
    assert.equal(st.active, 'Two');
    assert.ok(await until(async () => (await state()).pageFocused), 'the page has the keys again');

    // Typing reaches the field; Esc closes.
    await press(KEY.t, CMD);
    await b.waitFor(`app.$.commandBar.open`);
    await press(KEY.x);
    assert.equal(await until(async () => (await state()).input), 'x');
    await press(KEY.esc);
    st = await until(async () => { const v = await state(); return v.open ? null : v; });
    assert.ok(st && !st.open, 'Esc closed it');
    assert.ok(await until(async () => (await state()).pageFocused));
  } finally { await b.close(); s.close(); }
});

test('typed: the arrows go down the suggestions and on to the matching tabs; Return opens the picked one', async () => {
  const { b, s, press, state } = await start(['Alpha docs', 'Alpha news', 'Beta']);
  try {
    await press(KEY.t, CMD);
    await b.waitFor(`app.$.commandBar.open`);
    for (const k of [KEY.a, KEY.l, KEY.p, KEY.h]) await press(k);
    // The suggestions settled: the same ones for half a second.
    let st, seen = '', since = Date.now();
    for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) {
      st = await state();
      const now = JSON.stringify(st.matches);
      if (now !== seen) { seen = now; since = Date.now(); } else if (Date.now() - since > 500 && st.matches.length >= 2 && st.matches[0].startsWith('>')) break;
    }
    assert.ok(st, 'suggestions for "alph"');
    const n = st.matches.length;
    assert.ok(st.matches[0].startsWith('>'), `the first suggestion is picked: ${JSON.stringify(st)}`);
    assert.deepEqual(st.tabs, ['Alpha news', 'Alpha docs'], 'the matching tabs, below');
    // Down to the end of the suggestions, then into the tabs; the tabs stay (a picked suggestion
    // fills the field, which isn't what was typed).
    for (let i = 1; i < n; i++) await press(KEY.down);
    st = await state();
    assert.ok(st.matches[n - 1].startsWith('>'), JSON.stringify(st));
    assert.deepEqual(st.tabs, ['Alpha news', 'Alpha docs']);
    await press(KEY.down);
    st = await state();
    assert.deepEqual(st.tabs, ['>Alpha news', 'Alpha docs'], JSON.stringify(st));
    assert.ok(!st.matches.some((m) => m.startsWith('>')), 'no suggestion picked meanwhile');
    assert.match(st.input, /^alph/i, 'the field shows what was typed again');
    await press(KEY.down);
    assert.deepEqual((await state()).tabs, ['Alpha news', '>Alpha docs']);
    await press(KEY.up);
    await press(KEY.up);
    st = await state();
    assert.ok(st.matches[n - 1].startsWith('>'), 'back up into the suggestions');
    await press(KEY.down);
    await press(KEY.down);
    await press(KEY.enter);
    await until(async () => (await state()).active === 'Alpha docs');
    assert.equal((await state()).active, 'Alpha docs');
    assert.equal((await state()).open, false);
  } finally { await b.close(); s.close(); }
});

test('Esc closes the bar while the tab is still loading (it used to stop the load instead)', async () => {
  const { b, s, press, state } = await start(['Done', 'Other']);
  try {
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(s.url('slow'))})`);
    await sleep(800);
    await press(KEY.t, CMD);
    await b.waitFor(`app.$.commandBar.open`);
    await press(KEY.x);
    assert.equal(await until(async () => (await state()).input), 'x');
    await press(KEY.esc);
    assert.ok(await until(async () => !(await state()).open), 'closed');
  } finally { await b.close(); s.close(); }
});
