// The command bar: ⌘T and New Tab open it for a new tab, ⌘L for the current one; Escape closes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const BAR = `app.$.commandBar`;
const open = `${BAR}.open`;
const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;

async function typeInBar(b, text) {
  await b.waitFor(`${BAR}.$.address.shadowRoot.querySelector('cr-searchbox-input')`);
  await b.type(text);
  // Let autocomplete settle so Enter takes what was typed.
  await new Promise((r) => setTimeout(r, 400));
  await b.key('Enter', 'Enter', 13);
}

// ⌘T itself goes through the macOS menu (IDC_NEW_TAB -> SidebarHandler::ShowCommandBar), which synthetic
// DevTools key events never reach; New Tab takes the same route into the bar from the page side.
test('the command bar for a new tab opens the picked site in a new tab at the top of Today', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/First')]);
  try {
    await b.waitFor(today(1));
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(open);
    assert.equal((await b.tabs()).length, 1, 'no tab until something is picked');
    await typeInBar(b, site.url('/p/Second'));
    await b.waitFor(`!${open}`);
    await b.waitFor(today(2));
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row')[0].tab.title === 'Second'`);
    assert.ok((await b.tabs())[0].active);
  } finally { await b.close(); await site.close(); }
});

test('the URL pill and ⌘L edit the current tab\'s address in place', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Start')]);
  try {
    await b.waitFor(today(1));
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host').textContent === '127.0.0.1'`, 10000,
        `[app.url_, app.activeTabId_, [...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab)]`);
    await b.click(`app.shadowRoot.querySelector('#urlPill .host')`);
    await b.waitFor(open);
    assert.equal(await b.eval(`${BAR}.newTab`), false);
    // The field starts with the current URL, selected: typing replaces it.
    await typeInBar(b, site.url('/p/Elsewhere'));
    await b.waitFor(`!${open}`);
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row')[0].tab.title === 'Elsewhere'`);
    assert.equal((await b.tabs()).length, 1, 'same tab, no new one');
  } finally { await b.close(); await site.close(); }
});

test('New Tab opens the command bar; Escape and a click outside close it without a tab', async () => {
  const b = await launch(['data:text/html,<title>Only</title>x']);
  try {
    await b.waitFor(today(1));
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(open);
    assert.equal(await b.eval(`${BAR}.newTab`), true);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!${open}`, 10000, `[document.hasFocus(), app.shadowRoot.activeElement?.id, ${BAR}.shadowRoot?.activeElement?.id]`);
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(open);
    // Near the window's bottom right, whatever size the screen lets it be.
    const [w, h] = await b.eval(`[innerWidth, innerHeight]`);
    const at = { x: w - 60, y: h - 60, button: 'left', clickCount: 1 };
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    await b.waitFor(`!${open}`, 10000, `[innerWidth, innerHeight, document.elementFromPoint(${w - 60}, ${h - 60})?.id]`);
    assert.equal((await b.tabs()).length, 1);
  } finally { await b.close(); }
});

test('⌘T lists the open tabs (Switch to Tab), filters them as you type, and switches with a click or the arrows', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Alpha'), site.url('/p/Beta'), site.url('/p/Gamma')]);
  const CB = `${BAR}.shadowRoot`;
  try {
    await b.waitFor(today(3));
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`${open} && ${CB}.querySelectorAll('.tab-row').length === 2`);
    // The field keeps its hint while focused.
    assert.equal(await b.eval(`${BAR}.$.address.placeholderText`), 'Search or Enter URL…');
    // Typing filters the list.
    // The active tab isn't offered; typing narrows the rest.
    await b.type('bet');
    await b.key('t', 'KeyT', 84);
    await b.waitFor(`[...${CB}.querySelectorAll('.tab-row .tab-title')].map((e) => e.textContent).join() === 'Beta'`);
    await b.click(`${CB}.querySelector('.tab-row')`);
    await b.waitFor(`!${open}`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === 'Beta'`);
    // With nothing typed, ↓ and Return pick a tab.
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`${open} && ${CB}.querySelectorAll('.tab-row').length === 2`);
    const first = await b.eval(`${CB}.querySelector('.tab-row .tab-title').textContent`);
    await b.key('ArrowDown', 'ArrowDown', 40);
    await b.waitFor(`${CB}.querySelector('.tab-row.sel')`);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open}`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === ${JSON.stringify(first)}`);
  } finally { await b.close(); await site.close(); }
});
