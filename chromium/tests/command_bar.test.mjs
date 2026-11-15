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
    // With nothing typed the latest tab comes first and is picked (Arc): the one just left.
    const left = await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive).tab.title`);
    await b.eval(`app.$.tabstrip.activateTab([...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Gamma').tab.id)`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === 'Gamma'`);
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`${open} && ${CB}.querySelectorAll('.tab-row').length === 2`);
    const rows = `[...${CB}.querySelectorAll('.tab-row')]`;
    assert.equal(await b.eval(`${rows}[0].querySelector('.tab-title').textContent`), left);
    assert.equal(await b.eval(`${rows}.findIndex((r) => r.classList.contains('sel'))`), 0);
    // ↓ and ↑ move the pick; Return switches to it.
    await b.key('ArrowDown', 'ArrowDown', 40);
    await b.waitFor(`${rows}.findIndex((r) => r.classList.contains('sel')) === 1`);
    await b.key('ArrowUp', 'ArrowUp', 38);
    await b.waitFor(`${rows}.findIndex((r) => r.classList.contains('sel')) === 0`);
    const first = left;
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open}`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === ${JSON.stringify(first)}`);
  } finally { await b.close(); await site.close(); }
});

test('typed in the other keyboard layout: the command bar offers what was meant; ⇥ takes it', async () => {
  const b = await launch(['about:blank']);
  const CB = `${BAR}.shadowRoot`;
  const field = `${BAR}.$.address.shadowRoot.querySelector('cr-searchbox-input').shadowRoot.querySelector('input')`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(open);
    await b.type('ghbdtn');
    await b.key('ArrowRight', 'ArrowRight', 39);  // a key up: the bar reads the field
    await b.waitFor(`${CB}.getElementById('layoutFix')?.querySelector('.tab-title').textContent.trim() === 'привет'`);
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`${field}.value === 'привет'`);
    await b.waitFor(`!${CB}.getElementById('layoutFix')`);
  } finally { await b.close(); }
});

// The command bar finds Settings too, like "search everywhere" in an editor: a section, an option in
// one, a page of Chromium's settings (settings_index.ts).
test('the command bar finds Settings: "ai" opens Settings at AI, an option comes into sight, a Chromium page opens in a tab', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Alpha')]);
  const CB = `${BAR}.shadowRoot`;
  const ST = `app.$.settings.shadowRoot`;
  const rows = () => b.eval(`[...${CB}.querySelectorAll('#features .tab-row')].map((r) => (r.classList.contains('sel') ? '>' : '') + r.querySelector('.tab-title').textContent + ' | ' + (r.querySelector('.hint')?.textContent || ''))`);
  const ask = async (text) => {
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(open);
    await b.waitFor(`${BAR}.$.address.shadowRoot.querySelector('cr-searchbox-input')`);
    // The field takes the keys a moment after it shows.
    await b.waitFor(`${BAR}.$.address.matches(':focus-within')`);
    await b.type(text);
    await b.key('t', 'KeyT', 84);  // a key press, as in the test above: inserted text alone isn't "typing"
    await b.waitFor(`${BAR}.query_ === ${JSON.stringify(text)} && ${CB}.querySelectorAll('#features .tab-row').length > 0`);
  };
  try {
    await b.waitFor(today(1));
    // The section named in full is first and picked, before the features that are about AI.
    await ask('ai');
    const found = await rows();
    assert.equal(found[0], '>AI | Settings', found.join('; '));
    assert.ok(found.some((r) => r.startsWith('Chat')), found.join('; '));
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open} && app.$.settings.open && !!${ST}.getElementById('ai')`);
    // While Settings is open the command bar doesn't: it would open behind Settings and take the keys.
    await b.eval(`app.showCommandBar_(true, '')`);
    assert.equal(await b.eval(open), false, 'the command bar opened under Settings');
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.settings.open`);

    // An option: its section opens with the option marked.
    await ask('api keys');
    assert.equal((await rows())[0], '>API Keys | Settings \u203a AI');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`app.$.settings.open && ${ST}.querySelector('.found')?.textContent.trim() === 'API keys'`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.settings.open`);

    // Named by a word only, a setting is offered but not picked: Return still searches or opens.
    await ask('priv');
    const priv = await rows();
    assert.ok(priv.includes('Privacy and Security | Chromium settings'), priv.join('; '));
    assert.ok(!priv.some((r) => r.startsWith('>')), priv.join('; '));
    await b.click(`[...${CB}.querySelectorAll('#features .tab-row')].find((r) => r.querySelector('.tab-title').textContent === 'Privacy and Security')`);
    await b.waitFor(`!${open} && [...app.$.tabstrip.tabs_.values()].some((t) => t.url.startsWith('chrome://settings/privacy'))`);
  } finally { await b.close(); await site.close(); }
});

test('every Settings entry of the command bar leads somewhere: its section has that heading or option', async () => {
  const b = await launch([]);
  const ST = `app.$.settings.shadowRoot`;
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!app.$.tabstrip?.state_`);
    const missing = await b.eval(`(async () => {
      const { SETTINGS_INDEX } = await import('./meridian/settings_index.js');
      const missing = [];
      const ids = new Set();
      for (const e of SETTINGS_INDEX) {
        if (ids.has(e.id)) missing.push('twice: ' + e.id);
        ids.add(e.id);
        if (e.url) continue;
        await app.$.settings.show(app.$.tabstrip.spaces(), e.section, e.find || '');
        await app.$.settings.updateComplete;
        await new Promise((r) => setTimeout(r, 30));
        if (!${ST}.getElementById(e.section)) missing.push('no section: ' + e.id);
        else if (e.find && !${ST}.querySelector('.found')) missing.push('not found: ' + e.id + ' (' + e.find + ')');
        ${ST}.querySelectorAll('.found').forEach((x) => x.classList.remove('found'));
      }
      return missing;
    })()`);
    assert.deepEqual(missing, []);
  } finally { await b.close(); }
});
