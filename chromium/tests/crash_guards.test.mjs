// Crashes found in test builds, each pinned down so it can't come back.
//
// 1. A side panel for one tab (reading mode) and a tab switch through the tabs API: switching away
//    closed the panel as "closed" rather than "backgrounded", reading mode took its WebContents out
//    of the view the window had just cached, and switching back showed that empty view:
//    EXC_BAD_ACCESS in WebUIBrowserUI::ShowSidePanel. Also while a window is being made and closed.
// 2. testKeyPress sent a main-menu item's action straight to the window. Items the window doesn't
//    take (⌘J Jump to Selection, ⌘E Use Selection for Find, ⌘C…) threw an Objective-C exception
//    that ended the browser. Now: aimed where AppKit would aim it, or left to the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const CMD = 1 << 20, SHIFT = 1 << 17, OPT = 1 << 19;
const IDC_SHOW_READING_MODE = 40273, IDC_NEW_WINDOW = 34000, IDC_CLOSE_WINDOW = 34012;
const alive = (b) => b.proc.exitCode === null && b.proc.signalCode === null;

function site() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${req.url.slice(1)}</title><body><article><h1>An article ${req.url}</h1>
      ${'<p>Some words of an article, long enough for reading mode to have something to read. '.repeat(12)}</p>
      <input id=field value="typed text"></article>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: (p) => `http://127.0.0.1:${server.address().port}/${p}`,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

const idOf = (b, end) => b.eval(`[...${T}.tabs_.values()].find((t) => t.url.endsWith(${JSON.stringify(end)}))?.id`);
const activeUrl = (b) => b.eval(`[...${T}.tabs_.values()].find((t) => t.isActive)?.url`);

test('reading mode in one tab, tabs switched fast through the tabs API: Meridian stays up and the panel comes back with its tab', async () => {
  const s = await site();
  const b = await launch([s.url('a'), s.url('b')], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`${T}.tabs_.size >= 2 && [...${T}.tabs_.values()].every((t) => !t.isLoading)`, 15000);
    const a = await idOf(b, '/a'), bb = await idOf(b, '/b');
    await b.eval(`${T}.activateTab(${JSON.stringify(a)})`);
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.id === ${JSON.stringify(a)}`);
    await b.eval(`${T}.handler_.testCommand(${IDC_SHOW_READING_MODE})`);
    await b.waitFor(`!!app.$.sidePanel.showing_`, 10000);

    // Away and back, one at a time: the panel goes with its tab and comes back with it.
    for (let i = 0; i < 3; i++) {
      await b.eval(`${T}.activateTab(${JSON.stringify(bb)})`);
      await b.waitFor(`!app.$.sidePanel.showing_`, 5000);
      await b.eval(`${T}.activateTab(${JSON.stringify(a)})`);
      await b.waitFor(`!!app.$.sidePanel.showing_`, 5000);
      assert.ok(alive(b), `Meridian crashed coming back to the tab (round ${i + 1})`);
    }

    // As fast as a script can: switches land before the panel has finished closing.
    await b.eval(`(() => { for (let i = 0; i < 40; i++) ${T}.tabStripService_.activateTab(i % 2 ? ${JSON.stringify(a)} : ${JSON.stringify(bb)}); return true; })()`);
    await sleep(1500);
    assert.ok(alive(b), 'Meridian crashed on fast tab switches with reading mode open');
    assert.equal(await b.eval('1 + 1'), 2);
    assert.ok((await activeUrl(b)).endsWith('/a'));

    // Reading mode replaced by another panel and back, then a switch: the replaced view was cached
    // without its WebContents too.
    await b.eval(`${T}.handler_.testCommand(${IDC_SHOW_READING_MODE})`);
    await sleep(500);
    await b.eval(`${T}.handler_.testCommand(${IDC_SHOW_READING_MODE})`);
    await b.eval(`${T}.activateTab(${JSON.stringify(bb)})`);
    await b.eval(`${T}.activateTab(${JSON.stringify(a)})`);
    await sleep(1000);
    assert.ok(alive(b), 'Meridian crashed after reading mode was toggled and its tab switched');
  } finally {
    await b.close();
    s.close();
  }
});

test('a new window: reading mode and tab switches while it is being made, then while it closes: Meridian stays up', async () => {
  const s = await site();
  const b = await launch([s.url('a'), s.url('b')], { args: ['--meridian-test-keys'] });
  b.invariants = false;  // windows come and go under the checks on purpose
  try {
    await b.waitFor(`${T}.tabs_.size >= 2`, 15000);
    for (let round = 0; round < 3; round++) {
      await b.eval(`${T}.handler_.testCommand(${IDC_NEW_WINDOW})`);
      let other = null;
      for (let i = 0; i < 50 && !other; i++) { other = (await b.otherWindows().catch(() => []))[0]; if (!other) await sleep(100); }
      assert.ok(other, 'a second window');
      // While its UI page is still coming up: open a tab there, reading mode, switch fast.
      await other.eval(`(async () => {
        const t = app.$.tabstrip;
        t.openUrl?.(${JSON.stringify(s.url('c'))});
        t.handler_.testCommand(${IDC_SHOW_READING_MODE});
        for (let i = 0; i < 10; i++) { const ids = [...t.tabs_.values()].map((x) => x.id); if (ids.length) t.tabStripService_.activateTab(ids[i % ids.length]); await new Promise((r) => setTimeout(r, 20)); }
        return true; })()`).catch(() => {});
      // And closing it with the panel open and switches still in flight.
      await other.eval(`(() => {
        const t = app.$.tabstrip; const ids = [...t.tabs_.values()].map((x) => x.id);
        t.handler_.testCommand(${IDC_SHOW_READING_MODE});
        for (let i = 0; i < 10; i++) if (ids.length) t.tabStripService_.activateTab(ids[i % ids.length]);
        t.handler_.testCommand(${IDC_CLOSE_WINDOW});
        for (let i = 0; i < 10; i++) if (ids.length) t.tabStripService_.activateTab(ids[i % ids.length]);
        return true; })()`).catch(() => {});
      other.close();
      await sleep(1500);
      assert.ok(alive(b), `Meridian crashed making or closing a window (round ${round + 1})`);
      assert.equal(await b.eval('1 + 1'), 2);
    }
  } finally {
    await b.close();
    s.close();
  }
});

// Main-menu items whose actions a browser window doesn't take itself, and keys no keyboard has.
const KEYS = [
  [38, 'j', CMD, '⌘J Jump to Selection'],
  [14, 'e', CMD, '⌘E Use Selection for Find'],
  [41, ';', CMD, '⌘; Check Document Now'],
  [41, ':', CMD | SHIFT, '⇧⌘: Spelling and Grammar'],
  [8, 'c', CMD, '⌘C Copy'],
  [0, 'a', CMD, '⌘A Select All'],
  [6, 'z', CMD, '⌘Z Undo'],
  [6, 'z', CMD | SHIFT, '⇧⌘Z Redo'],
  [9, 'v', CMD | SHIFT | OPT, '⌥⇧⌘V Paste and Match Style'],
  [500, 'x', CMD, 'a key code no keyboard has'],
  [0, 'a', 0xffff, 'modifier bits no keyboard has'],
];

test('testKeyPress never takes the browser down: menu items the window does not take (⌘J, ⌘E, ⌘C…), from the page, the sidebar and the Boost editor', async () => {
  const s = await site();
  const b = await launch([s.url('a')], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`${T}.tabs_.size >= 1 && [...${T}.tabs_.values()].every((t) => !t.isLoading)`, 15000);
    const page = await b.page(s.url('a'));
    const press = (code, ch, mods) => b.eval(`${T}.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
    const where = {
      'the page': async () => { await b.click('app.$.contentRegion'); await page.eval(`(() => { const f = document.getElementById('field'); f.focus(); f.select(); return true; })()`); },
      'the sidebar': async () => { await b.click(`${T}.shadowRoot.querySelector('meridian-tab-row').shadowRoot.querySelector('.row')`); },
      'the Boost editor': async () => {
        await b.click('app.$.locationIconButton');
        await b.waitFor(`app.$.siteControl.open && !!app.$.siteControl.shadowRoot.querySelector('#boostRow')`, 10000);
        await b.click(`app.$.siteControl.shadowRoot.querySelector('#boostRow')`);
        await b.waitFor(`app.$.boostEditor.open`, 10000);
      },
    };
    for (const [name, focus] of Object.entries(where)) {
      for (const [code, ch, mods, what] of KEYS) {
        await focus().catch(() => {});
        await press(code, ch, mods).catch(() => {});
        await sleep(300);
        assert.ok(alive(b), `Meridian crashed on ${what} in ${name}`);
        assert.equal(await b.eval('1 + 1'), 2, `the UI answers after ${what} in ${name}`);
        await b.eval(`(() => { for (const id of ['commandBar', 'ask', 'chat']) { const e = app.$[id]; if (e?.open) { if (e.hide) e.hide(); else e.open = false; } } return true; })()`).catch(() => {});
      }
    }
    // The whole of AppKit's way too (1 << 30: NSApp sendEvent, the main menu with no target, as a
    // real ⌘J): with the Boost editor open.
    await where['the Boost editor']().catch(() => {});
    for (const [code, ch, mods, what] of KEYS.slice(0, 4)) {
      await b.eval(`${T}.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${(mods | (1 << 30)) >>> 0})`).catch(() => {});
      await sleep(300);
      assert.ok(alive(b), `Meridian crashed on a real ${what} with the Boost editor open`);
    }
    assert.equal(await b.eval('1 + 1'), 2);
  } finally {
    await b.close();
    s.close();
  }
});
