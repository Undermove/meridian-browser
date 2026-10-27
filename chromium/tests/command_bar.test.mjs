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
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host').textContent === '127.0.0.1'`);
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
    await b.waitFor(`!${open}`);
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(open);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1000, y: 700, button: 'left', clickCount: 1 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1000, y: 700, button: 'left', clickCount: 1 });
    await b.waitFor(`!${open}`);
    assert.equal((await b.tabs()).length, 1);
  } finally { await b.close(); }
});
