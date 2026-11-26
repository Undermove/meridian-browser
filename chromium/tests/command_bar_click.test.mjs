// The command bar's suggestions with the mouse, as a person clicks them: a real press and release
// at the row's centre (CDP Input.dispatchMouseEvent). A click on a row does what Return on it
// does: a page from history, a search, the other layout's reading and then a row; "Search Bing"
// on a row enters that site's search (as "bing.com ⇥" does); a middle click or ⌘-click opens the
// row in a background tab and leaves the bar open, like Arc. The bar shows the suggestions in
// Arc's order, not the browser's: a click used to name the row by its place in the shown list,
// the browser found another match there (or none) and nothing happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAR = 'app.$.commandBar';
const CB = `${BAR}.shadowRoot`;
const BOX = `${BAR}.shadowRoot.getElementById('address')`;
const DD = `${BOX}.shadowRoot.querySelector('cr-searchbox-dropdown')`;
const ROWS = `[...${DD}.shadowRoot.querySelectorAll('cr-searchbox-match')]`;
const FIELD = `${BOX}.shadowRoot.querySelector('cr-searchbox-input').shadowRoot.querySelector('input')`;
// Nothing leaves the machine: a search opens its results page, which doesn't load.
const OFFLINE = '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1';

// A real press and release at the centre of an element (no move first: a click is just that).
async function press(b, elExpr, { button = 'left', modifiers = 0 } = {}) {
  const r = await b.point(elExpr);
  const buttons = { left: 1, right: 2, middle: 4 }[button];
  await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button, buttons, clickCount: 1, modifiers });
  await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button, buttons: 0, clickCount: 1, modifiers });
}

async function openBar(b) {
  await b.click(`${SB}.getElementById('newTabButton')`);
  await b.waitFor(`${BAR}.open && ${BOX}.matches(':focus-within')`);
}

// Typed into the field (the suggestions follow the text). `keyUp`: a key let go after it, for
// what the bar reads on keyup (the other layout's reading); a key pressed right after the text
// would come before the suggestions and stop them.
async function typeInBar(b, text, { keyUp = false } = {}) {
  await b.type(text);
  if (keyUp) await b.key('ArrowRight', 'ArrowRight', 39);
}

// The suggestions once they stopped changing (the same for half a second), as the browser
// sent them and as the bar shows them.
async function settled(b, ready) {
  let seen = '', since = Date.now(), st;
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(100)) {
    st = await b.eval(`(() => { const dd = ${DD}; return {
      shown: dd && !dd.hidden ? ${ROWS}.map((m) => ({ url: m.match.destinationUrl, search: m.match.isSearchType, keyword: m.match.keywordModel?.keyword ?? '', chip: !!m.shadowRoot.getElementById('keyword') })) : [],
      browser: (${BOX}.browserResult_?.matches ?? []).map((m) => m.destinationUrl),
      lines: ${BOX}.lines_,
    }; })()`);
    const now = JSON.stringify(st);
    if (now !== seen) { seen = now; since = Date.now(); } else if (Date.now() - since > 500 && ready(st)) return st;
  }
  throw new Error(`the suggestions never settled: ${JSON.stringify(st)}`);
}

const activeTab = async (b) => (await b.tabs()).find((t) => t.active);

test('a click on a suggestion opens it: a page from history, a search, after the other layout\'s reading', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Kiwi Orchard')], { args: [OFFLINE] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1 && ${SB}.querySelector('meridian-tab-row').tab.title === 'Kiwi Orchard'`);
    // The site's address typed: its pages from history first, the search last (Arc's order; the
    // browser has the search second). The page, clicked.
    const host = '127.0.0.1';
    const both = (s) => s.shown.some((m) => m.url.includes('/p/Kiwi')) && s.shown.some((m) => m.search);
    await openBar(b);
    await typeInBar(b, host);
    let st = await settled(b, both);
    const page = st.shown.findIndex((m) => m.url.includes('/p/Kiwi'));
    assert.notDeepEqual(st.lines, st.lines.map((_, i) => i), `shown in the browser's order: ${JSON.stringify(st)}`);
    await press(b, `${ROWS}[${page}]`);
    await b.waitFor(`!${BAR}.open`, 10000, `${ROWS}.map((m) => m.match.destinationUrl)`);
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    let tab = await activeTab(b);
    assert.match(tab.url, /\/p\/Kiwi%20Orchard$/, 'the page, in a new tab (⌘T)');

    // The search, clicked.
    await openBar(b);
    await typeInBar(b, host);
    st = await settled(b, both);
    const search = st.shown.findIndex((m) => m.search);
    assert.notEqual(st.lines[search], search, JSON.stringify(st));
    await press(b, `${ROWS}[${search}]`);
    await b.waitFor(`!${BAR}.open`);
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 3`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.url.includes('q=127.0.0.1')`,
        10000, `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.url)`);

    // Typed in the Russian layout: the reading, clicked, fills the field; then its page, clicked.
    await openBar(b);
    await typeInBar(b, 'лшцш щксрфкв', { keyUp: true });
    await b.waitFor(`${CB}.getElementById('layoutFix')?.querySelector('.tab-title').textContent.trim() === 'kiwi orchard'`);
    await press(b, `${CB}.getElementById('layoutFix')`);
    await b.waitFor(`${FIELD}.value === 'kiwi orchard'`);
    assert.equal(await b.eval(`${BAR}.open`), true);
    st = await settled(b, (s) => s.shown.some((m) => m.url.includes('/p/Kiwi')));
    await press(b, `${ROWS}[${st.shown.findIndex((m) => m.url.includes('/p/Kiwi'))}]`);
    await b.waitFor(`!${BAR}.open`);
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 4`);
    assert.match((await activeTab(b)).url, /\/p\/Kiwi%20Orchard$/);
  } finally { await b.close(); await site.close(); }
});

test('"Search Bing" on a suggestion enters that site\'s search; a middle click and ⌘-click open in the background', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Kiwi Orchard')], { args: [OFFLINE] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1 && ${SB}.querySelector('meridian-tab-row').tab.title === 'Kiwi Orchard'`);

    // The site's button on its row: Bing's search, the way "bing.com ⇥" enters it.
    await openBar(b);
    await b.waitFor(`${BAR}.keywords_.size > 0`);
    await typeInBar(b, 'bing.com');
    const st = await settled(b, (s) => s.shown.some((m) => m.chip));
    const row = st.shown.findIndex((m) => m.chip);
    await press(b, `${ROWS}[${row}].shadowRoot.getElementById('keyword')`);
    await b.waitFor(`${BAR}.open && ${BAR}.mode_?.keyword === ${JSON.stringify(st.shown[row].keyword)}`, 10000, `[${BAR}.mode_, ${FIELD}.value]`);
    assert.equal(await b.eval(`${FIELD}.value`), '', 'the field waits for what to find');
    await typeInBar(b, 'kiwi');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${BAR}.open`);
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.url.includes('bing.com/search?q=kiwi')`,
        10000, `${SB}.querySelectorAll('meridian-tab-row')[0].tab.url`);

    // A middle click: the page in a background tab, the bar still open with what was typed.
    const before = (await activeTab(b)).id;
    await openBar(b);
    await typeInBar(b, 'kiwi orch');
    let s = await settled(b, (x) => x.shown.some((m) => m.url.includes('/p/Kiwi')));
    await press(b, `${ROWS}[${s.shown.findIndex((m) => m.url.includes('/p/Kiwi'))}]`, { button: 'middle' });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 3`);
    await sleep(300);
    assert.equal(await b.eval(`${BAR}.open`), true, 'the bar stays open');
    assert.equal((await activeTab(b)).id, before, 'opened behind');
    assert.equal(await b.eval(`${FIELD}.value`), 'kiwi orch');
    // ⌘-click (Ctrl off the Mac): one more.
    s = await settled(b, (x) => x.shown.some((m) => m.url.includes('/p/Kiwi')));
    await press(b, `${ROWS}[${s.shown.findIndex((m) => m.url.includes('/p/Kiwi'))}]`,
        { modifiers: process.platform === 'darwin' ? 4 : 2 });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 4`);
    await sleep(300);
    assert.equal(await b.eval(`${BAR}.open`), true);
    assert.equal((await activeTab(b)).id, before);
    const kiwis = (await b.tabs()).filter((t) => /\/p\/Kiwi%20Orchard$/.test(t.url));
    assert.equal(kiwis.length, 3, JSON.stringify(await b.tabs()));
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!${BAR}.open`);
  } finally { await b.close(); await site.close(); }
});
