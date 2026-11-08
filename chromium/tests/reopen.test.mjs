// ⇧⌘T as in Arc: it reopens the last closed tab, with its history, in this window; never a whole
// window. It opened a second window after a restart (the window the last quit closed, which the
// session had already brought back; a tab closed before it, whose window was gone), and after a
// Little window was closed. A closed Peek comes back as a Peek; ⌘Z outside a text field does what
// ⇧⌘T does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB, itemEl } from './harness.mjs';
import { startServer } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const CR = 'app.$.contentRegion';
const CMD = 1 << 20;
const ARGS = ['--meridian-test-keys'];
const titles = (b) => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title).sort().join()`);
const windows = async (b) => (await (await fetch(`${b.base}/json/list`)).json())
    .filter((t) => t.url.startsWith('chrome://webui-browser')).length;
const closeTab = (b) => b.eval(`${T}.handler_.testKeyPress(13, 'w', ${CMD})`);  // ⌘W
// ⇧⌘T goes to the page first and comes back through the main menu, which AppKit only does for
// the key window (a test window in the background isn't): the command it runs.
const reopen = (b) => b.eval(`${T}.handler_.testCommand(34028)`);  // IDC_RESTORE_TAB
const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
// A real click on its row, and it is the active tab.
async function pick(b, title) {
  await b.click(row(title));
  await b.waitFor(`${row(title)}?.tab.isActive`);
}
const undo = (b) => b.eval(`${T}.handler_.testKeyPress(6, 'z', ${CMD})`);  // ⌘Z

async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { if ((v = await fn())) return v; await sleep(100); }
  return v;
}
// The same value for a second: nothing more is coming (a window, a tab).
async function steady(fn) {
  let last = await fn(), since = Date.now();
  for (const end = Date.now() + 8000; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (JSON.stringify(v) !== JSON.stringify(last)) { last = v; since = Date.now(); }
    if (Date.now() - since >= 1000) return v;
  }
  return last;
}
const now = async (b) => steady(async () => ({ windows: await windows(b), tabs: await titles(b) }));

test('after a restart ⇧⌘T reopens the tab closed before it, in this window, and no window', async () => {
  const site = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch([site.url('/p/A'), site.url('/p/B'), site.url('/p/C')], { profile, args: ARGS });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 3`);
    await pick(b, 'C');
    await closeTab(b);
    await until(async () => (await titles(b)) === 'A,B');
    await sleep(1500);  // the session is saved
    await b.quit();

    b = await launch([], { profile, args: ARGS });
    await b.waitFor(`!!${T}?.state_ && ${SB}.querySelectorAll('meridian-tab-row').length === 2`, 15000);
    assert.deepEqual(await now(b), { windows: 1, tabs: 'A,B' }, 'the session is back');
    await reopen(b);
    assert.deepEqual(await now(b), { windows: 1, tabs: 'A,B,C' }, 'C is back, here');
    // Nothing else was closed: the window the last quit closed doesn't come back again.
    await reopen(b);
    assert.deepEqual(await now(b), { windows: 1, tabs: 'A,B,C' }, 'no second window');
  } finally {
    await b.close();
    await site.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('a Little window closed: ⇧⌘T brings its page back as a tab of the main window', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Main')], { args: ARGS });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-open-'));
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // A link clicked in another app: a GetURL Apple event to this browser's pid (never `open -a`).
    const opener = path.join(dir, 'open_url');
    await promisify(execFile)('swiftc', ['-O', path.join(path.dirname(new URL(import.meta.url).pathname), 'tools', 'open_url.swift'), '-o', opener]);
    await promisify(execFile)(opener, [String(b.proc.pid), site.url('/p/Little')]);
    let little;
    for (let i = 0; i < 100 && !little; i++) {
      await sleep(200);
      const [w] = await b.otherWindows();
      if (w && await w.eval(`!!app?.hasAttribute('little') && app.shadowRoot.querySelector('#littleBar .host')?.textContent === '127.0.0.1'`).catch(() => false)) little = w;
      else w?.close();
    }
    assert.ok(little, 'a Little window opened');
    await little.eval(`app.$.tabstrip.handler_.testKeyPress(13, 'w', ${CMD})`).catch(() => {});  // ⌘W in it
    little.close();
    assert.equal((await now(b)).windows, 1, 'the Little window closed');

    await reopen(b);
    assert.deepEqual(await now(b), { windows: 1, tabs: 'Little,Main' }, 'its page, as a tab here');
  } finally {
    await b.close();
    await site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A pinned tab's page linking to another site (127.0.0.1 and localhost are different sites).
async function twoSites() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    const port = server.address().port;
    res.end(req.url.startsWith('/app')
      ? `<title>App</title><a id=out href="http://localhost:${port}/other">out</a>`
      : `<title>Other site</title><h1>other</h1><p>${req.url}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/app`, close: () => server.close() };
}

test('a closed Peek: ⇧⌘T opens it again as a Peek over its pinned tab', async () => {
  const site = await twoSites();
  const b = await launch([site.url], { args: ARGS });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.menu(`${SB}.querySelector('meridian-tab-row')`, 'Pin Tab');
    await b.waitFor(`!!${itemEl('App')}`);
    // A real ⇧-click on the link in the pinned page.
    const page = await b.page(site.url);
    await page.waitFor(`!!document.getElementById('out')`);
    const r = await page.eval(`(() => { const e = document.getElementById('out').getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, modifiers: 8 });
    }
    page.close();
    await b.waitFor(`${CR}.hasAttribute('peek')`);
    await b.click(`${CR}.shadowRoot.querySelector('#peekBar button[data-action="close"]')`);
    await b.waitFor(`!${CR}.hasAttribute('peek')`);
    await b.waitFor(`${itemEl('App')}.shadowRoot.querySelector('.row.active')`);

    await reopen(b);
    await b.waitFor(`${CR}.hasAttribute('peek')`, 6000).catch(() => {});
    const state = await steady(() => b.eval(`({ peek: ${CR}.hasAttribute('peek'), today: ${SB}.querySelectorAll('meridian-tab-row').length,
        over: !!${CR}.shadowRoot.querySelector('.peek-under'), windows: 0 })`));
    assert.deepEqual(state, { peek: true, today: 0, over: true, windows: 0 }, 'a Peek again, over the pinned tab, not in Today');
    assert.equal(await windows(b), 1);
  } finally { await b.close(); site.close(); }
});

test('⌘Z outside a text field reopens the last closed tab; in one it undoes the typing', async () => {
  const FORM = 'data:text/html,' + encodeURIComponent('<title>Form</title><input id=q style="position:fixed;left:40px;top:40px;width:300px;height:40px"><p style="margin-top:200px">text');
  const b = await launch([FORM, 'data:text/html,<title>Gone</title>gone'], { args: ARGS });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    await pick(b, 'Gone');
    await closeTab(b);
    await until(async () => (await titles(b)) === 'Form');
    assert.equal(await titles(b), 'Form');

    // Typing in the page's field, then ⌘Z: the typing is undone, no tab comes back.
    const page = await b.page('data:text/html,');
    await page.waitFor(`!!document.getElementById('q')`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: 100, y: 60, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    }
    await page.waitFor(`document.activeElement?.id === 'q'`);
    for (const [code, ch] of [[0, 'a'], [11, 'b'], [8, 'c']]) await b.eval(`${T}.handler_.testKeyPress(${code}, '${ch}', 0)`);
    await page.waitFor(`q.value === 'abc'`);
    await undo(b);
    await page.waitFor(`q.value === ''`);
    assert.deepEqual(await now(b), { windows: 1, tabs: 'Form' }, 'in a field ⌘Z undid the typing only');

    // Out of the field (a click on the text): ⌘Z reopens the closed tab.
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: 100, y: 300, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    }
    await page.waitFor(`document.activeElement === document.body`);
    page.close();
    await undo(b);
    assert.deepEqual(await now(b), { windows: 1, tabs: 'Form,Gone' }, '⌘Z brought Gone back');
  } finally { await b.close(); }
});
