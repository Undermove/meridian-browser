// Playwright fixtures that launch the real Meridian Electron app with an isolated profile.
//
//  - every test gets a fresh user-data dir under the OS temp dir (MERIDIAN_USER_DATA);
//    the real profile (~/Library/Application Support/Meridian) is never touched;
//  - state.json is seeded so onboarding is skipped (state.onboarded = true);
//  - a local HTTP server (127.0.0.1, random port) serves the test pages.

const { test: base, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./server');
const { seedState } = require('./state');

const ROOT = path.resolve(__dirname, '..', '..');
const NO_FOCUS = path.join(__dirname, 'no-focus.js');

function freshUserDataDir() {
  // Keep it short: the agent socket lives in this dir and unix socket paths max out around 104 bytes.
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mer-e2e-'));
}

// The app finds agent CLIs (Claude Code, Codex, …) on the login PATH. Tests get a PATH with only the
// tools they need, so the developer's real, signed-in agents are never found (or billed). Specs that want
// an agent pass their own MERIDIAN_TEST_PATH with a fake CLI in front.
let testBin = null;
function testPathDefault() {
  if (!testBin) {
    testBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-e2e-bin-'));
    const { execFileSync } = require('child_process');
    for (const tool of ['node', 'git', 'docker']) {
      try {
        const p = tool === 'node' ? process.execPath : execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim();
        if (p) fs.symlinkSync(p, path.join(testBin, tool));
      } catch {}
    }
  }
  return [testBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
}

let emptyArc = null;
const emptyArcDir = () => (emptyArc ||= fs.mkdtempSync(path.join(os.tmpdir(), 'mer-e2e-noarc-')));

// Launch Meridian. `state` (object) is written to state.json before launch unless `keepState` is set.
async function launchMeridian({ userDataDir, state, keepState = false, env = {}, windowBounds } = {}) {
  if (!keepState) fs.writeFileSync(path.join(userDataDir, 'state.json'), JSON.stringify(state || seedState()));
  if (windowBounds || !fs.existsSync(path.join(userDataDir, 'window.json'))) {
    fs.writeFileSync(path.join(userDataDir, 'window.json'), JSON.stringify(windowBounds || { x: 40, y: 40, width: 1280, height: 820 }));
  }
  const app = await electron.launch({
    // `-r` is Electron's default_app preload flag (dev Electron only): see fixtures/no-focus.js.
    args: process.env.MERIDIAN_E2E_FOCUS === '1' ? ['.'] : ['-r', NO_FOCUS, '.'],
    cwd: ROOT,
    env: {
      ...process.env,
      MERIDIAN_USER_DATA: userDataDir,
      MERIDIAN_TEST_PATH: testPathDefault(),
      // Never the developer's real Arc data: an empty Arc folder unless a spec brings its own.
      MERIDIAN_ARC_DIR: emptyArcDir(),
      // Don't steal the user's focus (set MERIDIAN_E2E_FOCUS=1 to run with normal, focus-taking windows).
      ...(process.env.MERIDIAN_E2E_FOCUS === '1' ? {} : {
        MERIDIAN_E2E_NO_FOCUS: '1',
      }),
      ...env,
    },
    timeout: 30_000,
  });
  const logs = [];
  app.process().stdout?.on('data', (d) => logs.push(String(d)));
  app.process().stderr?.on('data', (d) => logs.push(String(d)));
  await installNativeStubs(app);
  const page = await mainWindow(app);
  page.__meridianApp = app;
  page.on('console', (m) => { if (m.type() === 'error') logs.push('[renderer] ' + m.text()); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await page.waitForFunction(() => typeof state !== 'undefined' && state && document.querySelector('#space-pages .space-header'), null, { timeout: 20_000 });
  return { app, page, logs };
}

// Native side effects are recorded instead of performed, so the suite never touches the user's
// clipboard, never opens other apps, and never blocks on a native dialog or context menu:
//   __e2e.clip      — texts written to the clipboard
//   __e2e.dialogs   — { message, detail, buttons, defaultId } of every message box (answered with
//                     __e2e.dialogResponse, or the cancel button when that is null)
//   __e2e.external  — URLs passed to shell.openExternal
//   __e2e.menus     — native popup menus (labels); answered with nothing chosen
async function installNativeStubs(app) {
  await app.evaluate(({ clipboard, dialog, shell, Menu }) => {
    const e2e = (global.__e2e = { clip: [], dialogs: [], external: [], menus: [], dialogResponse: null, menuChoice: null });
    clipboard.writeText = (t) => { e2e.clip.push(String(t)); };
    clipboard.readText = () => e2e.clip.at(-1) || '';
    const box = async (a, b) => {
      const opts = b || a || {};
      e2e.dialogs.push({ message: opts.message, detail: opts.detail, buttons: opts.buttons, defaultId: opts.defaultId, cancelId: opts.cancelId });
      const response = e2e.dialogResponse != null ? e2e.dialogResponse : (opts.cancelId ?? (opts.buttons ? opts.buttons.length - 1 : 0));
      return { response, checkboxChecked: false };
    };
    dialog.showMessageBox = box;
    dialog.showMessageBoxSync = (a, b) => { const o = b || a || {}; e2e.dialogs.push({ message: o.message, sync: true }); return o.cancelId ?? 1; };
    dialog.showErrorBox = (title, content) => { e2e.dialogs.push({ message: title, detail: content, error: true }); };
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    shell.openExternal = async (url) => { e2e.external.push(String(url)); };
    shell.showItemInFolder = () => {};
    const origPopup = Menu.prototype.popup;
    Menu.prototype.popup = function popup(opts = {}) {
      e2e.menus.push(this.items.map((i) => i.label));
      // e2e.menuChoice = ['Profile', 'New profile…'] picks that (sub)item once.
      const want = e2e.menuChoice; e2e.menuChoice = null;
      if (want) {
        let items = this.items, item = null;
        for (const label of want) { item = items.find((i) => i.label === label); items = item?.submenu?.items || []; }
        if (item) item.click();
      }
      if (typeof opts.callback === 'function') setTimeout(opts.callback, 0);
    };
    Menu.prototype.__origPopup = origPopup;
  });
}

// Choose this item (label path) in the next native popup menu.
const chooseMenu = (app, labels) => app.evaluate((_e, l) => { global.__e2e.menuChoice = l; }, labels);

const e2eLog = (app) => app.evaluate(() => global.__e2e);

// Answer the next native message boxes with this button index (null = cancel).
const setDialogResponse = (app, response) => app.evaluate((_e, r) => { global.__e2e.dialogResponse = r; }, response);

// ---------------------------------------------------------------- keyboard
// "Real" key presses: delivered through webContents.sendInputEvent() to the webContents that has
// keyboard focus (the focused <webview> guest, or the UI page). Unlike Playwright's CDP keyboard,
// these go through Electron's input pipeline and fire `before-input-event`, like a physical key.
// (Native macOS menu accelerators are NOT triggered by any synthetic input.)
const KEY_NAMES = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Return', Equal: '=', Minus: '-', Plus: 'Plus', Comma: ',', BracketLeft: '[', BracketRight: ']' };
const MODS = { Meta: 'meta', Cmd: 'meta', Control: 'control', Ctrl: 'control', Alt: 'alt', Option: 'alt', Shift: 'shift' };

async function press(meridian, combo, { target } = {}) {
  const parts = combo.split('+');
  const keyName = parts.pop() || '+';
  const modifiers = parts.map((m) => MODS[m] || m.toLowerCase());
  const keyCode = KEY_NAMES[keyName] || (keyName.length === 1 ? keyName.toUpperCase() : keyName);
  const wcId = target ?? await meridian.page.evaluate(() => {
    const ae = document.activeElement;
    if (ae && ae.tagName === 'WEBVIEW') { try { return ae.getWebContentsId(); } catch {} }
    return null;
  });
  await meridian.app.evaluate(({ webContents, BrowserWindow }, { wcId, keyCode, modifiers }) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'meridian://app/index.html');
    const wc = wcId != null ? webContents.fromId(wcId) : main.webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && !modifiers.some((m) => m === 'meta' || m === 'control')) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { wcId, keyCode, modifiers });
  await meridian.page.waitForTimeout(150);
}

// The main window is the UI page without a query (Little windows carry ?mini=1, private windows
// ?private=…, the Settings window is settings.html).
const MAIN_UI_URL = 'meridian://app/index.html';
async function mainWindow(app) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      const u = w.url();
      if (u === MAIN_UI_URL) return w;
    }
    await app.waitForEvent('window', { timeout: 2000 }).catch(() => {});
  }
  throw new Error('main window did not appear');
}

async function closeMeridian(app) {
  if (!app) return;
  const proc = app.process();
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 8000))]);
  try { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch {}
}

const test = base.extend({
  server: [async ({}, use) => {
    const s = await startServer();
    await use(s);
    await s.close();
  }, { scope: 'worker' }],

  userDataDir: async ({}, use) => {
    const dir = freshUserDataDir();
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  // Override per describe block with
  //   test.use({ seed: async ({ server }, use) => use(seedState({...})) })
  seed: async ({}, use) => { await use(seedState()); },

  meridian: async ({ userDataDir, seed, server }, use, testInfo) => {
    const state = seed || seedState();
    const launched = await launchMeridian({ userDataDir, state });
    const handle = {
      ...launched,
      userDataDir,
      // Relaunch with the same profile (settings persistence / session restore).
      async relaunch() {
        await flushState(handle.page).catch(() => {});
        await closeMeridian(handle.app);
        const next = await launchMeridian({ userDataDir, keepState: true });
        Object.assign(handle, next);
        return handle;
      },
    };
    await use(handle);
    if (testInfo.status !== testInfo.expectedStatus) {
      try { await testInfo.attach('screenshot', { body: await handle.page.screenshot(), contentType: 'image/png' }); } catch {}
      await testInfo.attach('app-log', { body: handle.logs.join(''), contentType: 'text/plain' }).catch(() => {});
    }
    await closeMeridian(handle.app);
  },

  page: async ({ meridian }, use) => { await use(meridian.page); },
});

// ---------------------------------------------------------------- unattached runs
// Playwright's CDP attach marks every webContents as "being captured" (webContents.isBeingCaptured()),
// which keeps hidden pages visible and rendering. Checks of page visibility / background throttling
// therefore launch Meridian without Playwright, through the dev screenshot-steps hook (MERIDIAN_SHOT +
// MERIDIAN_STEPS, src/main.js runScreenshotScript): each step's `js` runs in the UI page and its result
// comes back as an "[eval] <json>" line. Returns the parsed results in step order.
// `during(child)`, if given, runs while the app is up; the app is stopped once it resolves.
async function runUnattached({ userDataDir, state, steps, timeout = 60_000, during }) {
  const { spawn } = require('child_process');
  fs.writeFileSync(path.join(userDataDir, 'state.json'), JSON.stringify(state || seedState()));
  fs.writeFileSync(path.join(userDataDir, 'window.json'), JSON.stringify({ x: 40, y: 40, width: 1280, height: 820 }));
  const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electronPath, ['-r', NO_FOCUS, '.'], {
    cwd: ROOT,
    env: { ...process.env, MERIDIAN_USER_DATA: userDataDir, MERIDIAN_E2E_NO_FOCUS: '1', MERIDIAN_SHOT: path.join(userDataDir, 'unattached.png'), MERIDIAN_STEPS: JSON.stringify(steps) },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  const exited = new Promise((resolve) => {
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    child.on('exit', () => { clearTimeout(kill); resolve(); });
  });
  if (during) {
    try { await during(child); } finally { try { child.kill('SIGKILL'); } catch {} }
  }
  await exited;
  return out.split('\n').filter((l) => l.startsWith('[eval] ')).map((l) => { try { return JSON.parse(l.slice(7)); } catch { return l.slice(7); } });
}

// ---------------------------------------------------------------- helpers used by specs

// Force the debounced save to disk now.
async function flushState(page) {
  await page.evaluate(() => api.saveState(saveParts({ slow: true })));
}

// Active space / tab snapshot.
const snapshot = (page) => page.evaluate(() => {
  const sp = space();
  const t = activeTab();
  return {
    spaceIndex: state.spaces.indexOf(sp), spaceId: sp.id, spaceName: sp.name,
    activeTabId: sp.activeTabId, activeUrl: t ? tabUrl(t) : null, activeTitle: t ? titleOf(t) : null,
    todayCount: sp.today.length, spaces: state.spaces.length,
  };
});

// Open a tab programmatically (not under test) and wait for it to load.
async function openTabDirect(page, url, opts = {}) {
  const id = await page.evaluate(([u, o]) => openTab(u, o).id, [url, opts]);
  await waitTabLoaded(page, id, url);
  return id;
}

// Wait until the tab's webview finished loading (optionally a URL prefix).
async function waitTabLoaded(page, tabId, urlPrefix, timeout = 15_000) {
  await page.waitForFunction(([id, u]) => {
    const wv = rt.views.get(id);
    if (!wv) return false;
    try {
      const n = rt.nav.get(id) || {};
      const url = wv.getURL();
      return !wv.isLoading() && n.loading === false && (!u || url.startsWith(u));
    } catch { return false; }
  }, [tabId, urlPrefix || ''], { timeout });
}

// Run JS inside a tab's page (main world of the guest).
const inTab = (page, tabId, code) => page.evaluate(([id, c]) => rt.views.get(id).executeJavaScript(c), [tabId, code]);

// Bounding box of the active (visible) webview in window coordinates.
async function activeViewBox(page) {
  return page.evaluate(() => {
    const wv = rt.views.get(space().activeTabId);
    const r = wv.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

// Click inside the active web page (real mouse input routed into the <webview> guest),
// then wait until the guest actually has focus.
async function clickIntoActivePage(page, { dx = 200, dy = 300 } = {}) {
  const box = await activeViewBox(page);
  await page.evaluate(() => rt.views.get(space().activeTabId).executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))')).catch(() => {});
  await realClick(page, box.x + dx, box.y + dy);
  const tabId = await page.evaluate(() => space().activeTabId);
  await page.waitForFunction(async (id) => {
    const wv = rt.views.get(id);
    return document.activeElement === wv && (await wv.executeJavaScript('document.hasFocus()'));
  }, tabId, { timeout: 5000 }).catch(() => {});
  return tabId;
}

// Clicking into web pages. Neither synthetic path alone matches a physical click:
//  - Playwright's CDP mouse is routed into the <webview> guest (the page gets mousedown/click), but
//    keyboard focus does not move from one guest to another;
//  - webContents.sendInputEvent() on the main window moves focus to the <webview> element under the
//    pointer (like a physical click), but the event is not forwarded into the guest page.
// realClick() does both: embedder-level press first (focus), then the CDP click (page sees the click).
async function realMouse(page, events) {
  await page.__meridianApp.evaluate(({ BrowserWindow }, evs) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === 'meridian://app/index.html');
    for (const e of evs) win.webContents.sendInputEvent(e);
  }, events);
}
async function realClick(page, x, y, { button = 'left' } = {}) {
  x = Math.round(x); y = Math.round(y);
  await realMouse(page, [
    { type: 'mouseMove', x, y },
    { type: 'mouseDown', x, y, button, clickCount: 1 },
    { type: 'mouseUp', x, y, button, clickCount: 1 },
  ]);
  await page.mouse.click(x, y, { button });
  await page.waitForTimeout(50);
}
async function realMove(page, x, y, { steps = 1, from } = {}) {
  const evs = [];
  const [x0, y0] = from || [x, y];
  for (let i = 1; i <= steps; i++) evs.push({ type: 'mouseMove', x: Math.round(x0 + ((x - x0) * i) / steps), y: Math.round(y0 + ((y - y0) * i) / steps) });
  await realMouse(page, evs);
  await page.waitForTimeout(30);
}

// Real mouse click on an element inside a tab's page (the tab must be visible).
async function clickInTab(page, tabId, selector, { button = 'left', modifiers = [] } = {}) {
  // a freshly loaded guest drops input until it has presented a frame
  await inTab(page, tabId, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))) ');
  const r = await inTab(page, tabId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const box = await page.evaluate((id) => { const r = rt.views.get(id).getBoundingClientRect(); return { x: r.x, y: r.y }; }, tabId);
  if (modifiers.length) {
    for (const m of modifiers) await page.keyboard.down(m);
    await page.mouse.click(box.x + r.x, box.y + r.y, { button });
    for (const m of modifiers) await page.keyboard.up(m);
  } else {
    await realClick(page, box.x + r.x, box.y + r.y, { button });
  }
}

// Where does keyboard focus live right now?
const focusInfo = (page) => page.evaluate(async () => {
  const ae = document.activeElement;
  const info = { tag: ae?.tagName?.toLowerCase(), id: ae?.id || null, tabId: ae?.dataset?.tabId || null, hidden: ae?.classList?.contains('hidden') || false };
  if (info.tag === 'webview') { try { info.guestHasFocus = await ae.executeJavaScript('document.hasFocus()'); } catch { info.guestHasFocus = null; } }
  return info;
});

// Wait for the next two animation frames in the UI page.
const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

module.exports = {
  testPathDefault,
  test, expect, launchMeridian, runUnattached, press, e2eLog, setDialogResponse, chooseMenu, closeMeridian, flushState, snapshot, openTabDirect, waitTabLoaded, inTab,
  activeViewBox, clickIntoActivePage, clickInTab, realClick, realMove, focusInfo, nextFrames, seedState, ROOT,
};
