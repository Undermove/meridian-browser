// Drives the built Meridian (Chromium) over the DevTools protocol. The browser's own UI is the page
// chrome://webui-browser, so tests evaluate in it and send real mouse/keyboard input to it.
import { afterEach, beforeEach } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGuard } from './isolation.mjs';
import { startSpaceWatch, screenTaken, SPACE_GUARD_MODE } from './space_guard.mjs';

// Every test file: the owner's login environment out of every process it starts, and his real AI
// configs hashed before and after (isolation.mjs); on macOS, no test may switch his Space or put
// a test browser in front (space_guard.mjs).
installGuard();
startSpaceWatch();
const testPids = new Set();
let testStarted = Date.now();
beforeEach(() => { testStarted = Date.now(); });
afterEach(async (t) => {
  await new Promise((r) => setTimeout(r, 400));  // the watcher's last look
  const taken = screenTaken(testStarted, Date.now(), testPids);
  if (!taken.length) return;
  const why = `took the screen from the person at this Mac (background mode missed a window):\n  ${taken.join('\n  ')}`;
  if (SPACE_GUARD_MODE === 'warn') console.error(`SPACE GUARD (${t.name}): ${why}`);
  else throw new Error(`SPACE GUARD: this test ${why}`);
});

const DIR = process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium');
// MERIDIAN_APP: another Meridian binary, such as an installed release (CI checks every release).
const BINARY = { darwin: 'Meridian.app/Contents/MacOS/Meridian', win32: 'chrome.exe' }[process.platform] || 'chrome';
export const APP = process.env.MERIDIAN_APP || path.join(DIR, 'src/out/Release', BINARY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method) { for (const fn of this.listeners) fn(m.method, m.params); return; }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    // The target went away (its window closed): nothing pending waits forever.
    this.ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.rej(new Error('target closed'));
      this.pending.clear();
    };
    return this;
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('target closed'));
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { this.ws?.close(); }
}

async function evalUi(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { const app = document.querySelector('webui-browser-app'); return (${expr}); })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// Invariants: what must hold after any action in any test (Arc's behaviour, and no errors), checked
// in the background half a second after each click, key, command or drag. A violation that is
// still there on a second look fails the test that caused it (afterEach below), so it can't hide
// behind a test that only looks at something else. A test that breaks one on purpose sets
// `b.invariants = false`.
const INVARIANTS = `(() => {
  const sb = app.$.tabstrip, root = sb?.shadowRoot;
  if (!root || !sb.state_) return [];
  const out = [];
  const pinned = [];
  const walk = (r) => { for (const it of r.querySelectorAll('meridian-item')) { const row = it.shadowRoot?.querySelector('.row.pinned.active'); if (row) pinned.push(row); if (it.shadowRoot) walk(it.shadowRoot); } };
  walk(root);
  const today = [...root.querySelectorAll('meridian-tab-row')].map((r) => r.shadowRoot?.querySelector('.row.active')).filter(Boolean);
  const favs = [...root.querySelectorAll('meridian-fav')].map((f) => f.shadowRoot?.querySelector('.fav.active')).filter(Boolean);
  const n = today.length + pinned.length + favs.length;
  if (n > 1) out.push(n + ' rows look active in the sidebar');
  // The active row is in the sidebar's view (Arc scrolls along), unless the sidebar is away, the
  // row is inside a closed folder, or the space was just switched to (it shows where it was left).
  const scroller = root.getElementById('spacePage');
  const row = today[0] || pinned[0];
  if (row && scroller && !sb.ghost_ && !sb.keptPlace_) {
    const v = scroller.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (v.width > 0 && v.right > 0 && r.height > 0 && (r.top < v.top - 1 || r.bottom > v.bottom + 1)) {
      out.push('the active tab is out of the sidebar\'s view');
    }
  }
  return out;
})()`;
const violations = [];
const checks = new Set();
afterEach(async () => {
  await Promise.all([...checks]);
  if (violations.length) {
    const found = [...new Set(violations.splice(0))];
    throw new Error(`invariants broken:\n  ${found.join('\n  ')}`);
  }
});
function watchInvariants(b) {
  let timer = null;
  b.invariants = true;
  b.lastAction = '';
  const look = () => evalUi(b.cdp, INVARIANTS).catch(() => []);
  b.afterAction = (what) => {
    b.lastAction = what;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const check = (async () => {
        if (b.closed || !b.invariants) return;
        const first = await look();
        if (!first.length) return;
        await sleep(700);
        if (b.closed || !b.invariants) return;
        const again = await look();
        for (const v of again) if (first.includes(v)) violations.push(`${v} (after ${b.lastAction})`);
      })();
      checks.add(check);
      check.finally(() => checks.delete(check));
    }, 500);
  };
  // Uncaught errors and rejections in the browser UI.
  const listen = (c) => {
    c.send('Runtime.enable').catch(() => {});
    c.listeners.push((method, params) => {
      if (method !== 'Runtime.exceptionThrown' || !b.invariants || b.closed) return;
      const d = params.exceptionDetails;
      violations.push(`UI error: ${(d.exception?.description || d.text || '').split('\n').slice(0, 12).join(' | ')} [${d.url || ''}:${d.lineNumber}] (after ${b.lastAction || 'start'})`);
    });
  };
  listen(b.cdp);
  b.onAttach = listen;
}

// `profile`: reuse a profile dir (to test what survives a restart); it's then left for the caller to delete.
// Browsers still running when this test process ends (a test timed out, --test-force-exit) are
// killed with it, so a later test never reaches a leftover one.
const running = new Set();
process.on('exit', () => { for (const p of running) { try { p.kill('SIGKILL'); } catch {} } });

// `firstRun`: start like the very first launch (without --no-first-run). `app`: another binary
// for this launch (an older release, to test updating from it). `env`: variables over the test
// process's own (already without the owner's, isolation.mjs), such as a fixture's HOME.
export async function launch(urls = [], { profile: keep, args = [], firstRun = false, app = APP, env } = {}) {
  const profile = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  // Never the real Arc, Chrome or any other browser: an empty folder unless a test gives its own.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-empty-'));
  for (const sw of ['arc', 'chrome', 'brave', 'edge', 'vivaldi', 'opera', 'firefox', 'safari'].map((k) => `--meridian-${k}-dir`)) {
    if (!args.some((a) => a.startsWith(sw + '='))) args = [...args, `${sw}=${empty}`];
  }
  // No cookie banner list from the internet: an empty one unless a test gives its own.
  if (!args.some((a) => a.startsWith('--meridian-cookie-list='))) {
    const none = path.join(os.tmpdir(), 'meridian-empty-cookie-list.txt');
    if (!fs.existsSync(none)) fs.writeFileSync(none, '');
    args = [...args, `--meridian-cookie-list=${none}`];
  }
  const started = Date.now();
  const proc = spawn(app, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--use-mock-keychain',
    '--meridian-keep-keyboard-layout',
    // In the background, beside the person working on this Mac: never the active app, no windows
    // on screen, no Dock icon (input goes over the DevTools protocol). MERIDIAN_FOREGROUND=1 shows
    // them (the few tests that need a real window ask for it themselves).
    ...(process.platform === 'darwin' && !process.env.MERIDIAN_FOREGROUND && !args.includes('--meridian-test-foreground') ? ['--meridian-test-background'] : []),
    ...(firstRun ? [] : ['--no-first-run']), '--no-default-browser-check', '--window-size=1280,860',
    // Keep drawing when the window is covered or the display sleeps (input waits for frames).
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    // Frames on a timer, not the display's: with the screen locked macOS stops the display link, and
    // without frames every click waited ~5 s and animations stood still.
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    // No on-device model downloads (≈190 MB each into the temp folder).
    // MERIDIAN_TEST_DISABLE_FEATURES: more features to turn off, for where the tests run. On
    // Windows they can run on a desktop nobody sees, out of the person's way; there a window
    // would count as hidden (CalculateNativeWinOcclusion) and the sandboxed network service
    // doesn't start (NetworkServiceSandbox), so pages never load.
    '--disable-features=' + ['OptimizationGuideModelDownloading', 'OptimizationGuideOnDeviceModel',
      ...(process.env.MERIDIAN_TEST_DISABLE_FEATURES || '').split(',').filter(Boolean)].join(','),
    ...args, ...urls,
    // MERIDIAN_LOG=<file>: the browser's log there (debugging).
  ].concat(process.env.MERIDIAN_LOG ? ['--enable-logging=stderr'] : []),
  { stdio: process.env.MERIDIAN_LOG ? ['ignore', 'ignore', fs.openSync(process.env.MERIDIAN_LOG, 'a')] : 'ignore',
    ...(env ? { env: { ...process.env, ...env } } : {}) });
  running.add(proc);
  testPids.add(proc.pid);
  proc.once('exit', () => running.delete(proc));
  const base = `http://127.0.0.1:${port}`;
  let ui;
  for (let i = 0; i < 100 && !ui; i++) {
    await sleep(200);
    try { ui = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.url.startsWith('chrome://webui-browser')); } catch {}
  }
  if (!ui) { proc.kill(); throw new Error('browser UI target never appeared'); }
  const cdp = await new Cdp(ui.webSocketDebuggerUrl).open();
  const exited = () => proc.exitCode !== null || proc.signalCode !== null ?
      Promise.resolve() : new Promise((r) => proc.once('exit', r));
  const b = {
    proc, profile, base, cdp,
    // Evaluates an expression in the browser UI page; `app` is the <webui-browser-app> element.
    // If that window closed (a window gathered into another at startup), the next one's.
    async eval(expr) {
      if (b.cdp.closed) {
        const next = (await (await fetch(`${base}/json/list`)).json()).find((t) => t.url.startsWith('chrome://webui-browser'));
        if (!next) throw new Error('no browser window left');
        ui = next;
        b.cdp = await new Cdp(next.webSocketDebuggerUrl).open();
        b.onAttach?.(b.cdp);
      }
      const r = await evalUi(b.cdp, expr);
      const act = /\b(testKeyPress|testCommand|runCommand|openUrl|activateSpace|activateTab|closeNodes)\(/.exec(expr);
      if (act) b.afterAction?.(act[1]);
      return r;
    },
    // The UI pages of the other browser windows (a Little window, say), each with eval/close.
    async otherWindows() {
      const list = (await (await fetch(`${base}/json/list`)).json())
          .filter((t) => t.url.startsWith('chrome://webui-browser') && t.id !== ui.id);
      return Promise.all(list.map(async (t) => {
        const c = await new Cdp(t.webSocketDebuggerUrl).open();
        return {
          eval: (expr) => evalUi(c, expr), close: () => c.close(), send: (m, p) => c.send(m, p),
          async screenshot(file) { const { data } = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(data, 'base64')); },
        };
      }));
    },
    // A tab's page (the first target whose URL starts with `prefix`; the URL itself when `prefix`
    // ends with '$'), with eval/waitFor/cdp/close.
    async page(prefix, timeout = 15000) {
      const end = Date.now() + timeout;
      const exact = prefix.endsWith('$') ? prefix.slice(0, -1) : null;
      let t;
      while (!t && Date.now() < end) {
        try { t = (await (await fetch(`${base}/json/list`)).json()).find((x) => x.type === 'page' && (exact !== null ? x.url === exact : x.url.startsWith(prefix))); } catch {}
        if (!t) await sleep(150);
      }
      if (!t) throw new Error(`no page at ${prefix}`);
      const c = await new Cdp(t.webSocketDebuggerUrl).open();
      const p = {
        cdp: c,
        eval: (expr) => evalUi(c, expr),
        async waitFor(expr, ms = 10000) {
          const stop = Date.now() + ms; let last;
          while (Date.now() < stop) { try { last = await p.eval(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
          throw new Error(`timed out waiting for: ${expr} (last: ${JSON.stringify(last)})`);
        },
        close: () => c.close(),
      };
      return p;
    },
    // show: an expression whose value the timeout error reports (what the page had instead).
    async waitFor(expr, timeout = 10000, show = '') {
      const end = Date.now() + timeout; let last;
      // A DOM node can't be returned by value; it just means "found".
      const probe = `(() => { const v = (${expr}); return v instanceof Node ? true : v; })()`;
      while (Date.now() < end) { try { last = await b.eval(probe); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
      let shown = '';
      if (show) { try { shown = `; ${show} = ${JSON.stringify(await b.eval(show))}`; } catch (e) { shown = `; ${show}: ${e.message}`; } }
      throw new Error(`timed out waiting for: ${expr} (last: ${JSON.stringify(last)}${shown})`);
    },
    // Today tabs as the sidebar shows them, top to bottom.
    tabs() {
      return b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => ({ id: r.tab.id, title: r.tab.title, url: r.tab.url, active: r.tab.isActive }))`);
    },
    // Pinned rows of the active space (depth-first), and favorites.
    pinned() {
      return b.eval(`(() => { const out = []; const walk = (root, depth) => { for (const el of root.querySelectorAll(':scope > meridian-item')) { const row = el.shadowRoot.querySelector('.row'); out.push({ id: el.item.id, title: el.item.title, folder: el.item.isFolder, depth, loaded: !row.classList.contains('unloaded') && !el.item.isFolder, active: row.classList.contains('active') }); const kids = el.shadowRoot.querySelector('.children'); if (kids && !el.shadowRoot.querySelector('.folder-wrap.collapsed')) walk(kids, depth + 1); } }; walk(${SB}.getElementById('pinned'), 0); return out; })()`);
    },
    favorites() {
      return b.eval(`[...${SB}.querySelectorAll('meridian-fav')].map((f) => ({ id: f.item.id, title: f.item.title, active: !!f.shadowRoot.querySelector('.fav.active') }))`);
    },
    // The sidebar model as the C++ service pushed it.
    state() {
      return b.eval(`(() => { const s = app.$.tabstrip.state_; return s && { spaces: s.spaces.map((x) => ({ id: x.id, name: x.name, color: x.color, pinned: x.pinned.length })), active: s.activeSpaceId, favorites: s.favorites.length, tabs: s.tabs.map((t) => ({ space: t.spaceId, item: t.itemId })) }; })()`);
    },
    // Opens a row's context menu and picks an entry by its label.
    async menu(elExpr, label) {
      const r = await b.point(elExpr);
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      // "Move to Space > Work": a row of the submenu it opens.
      const [first, sub] = label.split(' > ');
      const row = (menu, text) => `[...${SB}.querySelector('${menu} meridian-menu').shadowRoot.querySelectorAll('.menu-item')].find((m) => m.querySelector('.menu-label').textContent.trim() === ${JSON.stringify(text)})`;
      await b.click(row('#menu', first));
      if (sub) await b.click(row('#submenu', sub));
    },
    // The + at the bottom of the sidebar (Arc's): a row of the menu it opens.
    async plus(label) {
      await b.click(`${SB}.getElementById('addSpace')`);
      await b.click(`[...${SB}.querySelector('#menu meridian-menu').shadowRoot.querySelectorAll('.menu-item')].find((m) => m.querySelector('.menu-label').textContent.trim() === ${JSON.stringify(label)})`);
    },
    // A real mouse drag from one element to a point in another (fraction fx/fy of its box), through
    // Chromium's drag and drop: intercept the drag the press-and-move starts, then replay it as drag events.
    async drag(fromExpr, toExpr, { fx = 0.5, fy = 0.5, beforeDrop } = {}) {
      const box = (expr) => b.waitFor(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; })()`);
      const a = await box(fromExpr);
      const from = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      await b.cdp.send('Input.setInterceptDrags', { enabled: true });
      const intercepted = new Promise((resolve) => {
        const on = (e) => { const m = JSON.parse(e.data); if (m.method === 'Input.dragIntercepted') { cdp.ws.removeEventListener('message', on); resolve(m.params.data); } };
        cdp.ws.addEventListener('message', on);
      });
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 3; i++) {
        await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y + i * 4, button: 'left', buttons: 1 });
      }
      const data = await Promise.race([intercepted, sleep(3000).then(() => null)]);
      if (!data) throw new Error('the drag never started');
      await b.cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: from.x, y: from.y + 12, data });
      await sleep(50);  // drop zones that open on dragstart
      const z = await box(toExpr);
      const to = { x: z.x + z.w * fx, y: z.y + z.h * fy };
      await b.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
      // What the person sees while still holding the tab. The first move over an element is its
      // dragenter; dragover comes with the next one.
      if (beforeDrop) {
        await b.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
        await beforeDrop();
        // A drop lands only right after a move the page accepted.
        await b.cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
      }
      await b.cdp.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
      await b.cdp.send('Input.setInterceptDrags', { enabled: false });
      b.afterAction?.('a drag');
    },
    // A two-finger horizontal swipe: `dx` px of wheel deltas over the element, in `steps` events
    // a frame apart; `during` runs after the last one, before the gesture goes quiet.
    async swipe(elExpr, dx, { steps = 10, during } = {}) {
      const r = await b.point(elExpr);
      for (let i = 0; i < steps; i++) {
        await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: dx / steps, deltaY: 0 });
        await sleep(16);
      }
      if (during) await during();
      b.afterAction?.('a swipe');
    },
    async type(text) {
      await b.cdp.send('Input.insertText', { text });
    },
    async key(key, code = key, keyCode = 0) {
      await b.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await b.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
      b.afterAction?.(`the ${key} key`);
    },
    // A shortcut as a person presses it (macCode: the Mac key code; mods: 1 << 20 for ⌘, Ctrl off
    // the Mac, 1 << 17 for ⇧): a real NSEvent on the Mac, where a CDP key has none; elsewhere a key
    // into the shown tab's page, which leaves a browser shortcut to the browser.
    async shortcut(macCode, ch, mods = 1 << 20) {
      if (process.platform === 'darwin') return b.eval(`app.$.tabstrip.handler_.testKeyPress(${macCode}, ${JSON.stringify(ch)}, ${mods})`);
      const url = await b.eval(`[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.url`);
      const page = await b.page(url);
      const vk = ch.toUpperCase().charCodeAt(0);
      const k = { key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (mods & (1 << 20) ? 2 : 0) | (mods & (1 << 17) ? 8 : 0) };
      // The page may close on it (Ctrl+W): its target goes away under the key.
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }).catch(() => {});
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }).catch(() => {});
      try { page.close(); } catch {}
    },
    // A real mouse click at the centre of an element found by a JS expression in the UI page.
    // The centre of an element once it has stopped moving (menus place themselves after opening).
    async point(elExpr) {
      const at = () => b.waitFor(`(() => { const el = ${elExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      let r = await at();
      for (let i = 0; i < 20; i++) {
        await sleep(50);
        const next = await at();
        if (next.x === r.x && next.y === r.y) return r;
        r = next;
      }
      return r;
    },
    async click(elExpr, { button = 'left' } = {}) {
      const r = await b.point(elExpr);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await b.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : button, clickCount: 1 });
      }
      b.afterAction?.('a click');
    },
    async screenshot(file) {
      const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    // Quits like the user does (⌘Q), so the session and the sidebar are saved.
    async quit() {
      b.closed = true;
      const done = exited();
      b.cdp.send('Browser.close').catch(() => {});  // never answers: the process exits
      await Promise.race([done, sleep(15000)]);
      b.cdp.close();
      if (proc.exitCode === null) { proc.kill(); await exited(); }
    },
    async close() {
      b.closed = true;
      b.cdp.close();
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await exited(); }
      if (!keep) fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
      // What the browser left in the temp folder (downloads in progress, sockets) when killed.
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (!name.startsWith('dev.meridian.browser.')) continue;
        const p = path.join(os.tmpdir(), name);
        try { if (fs.statSync(p).mtimeMs >= started - 1000) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
      // The app copy Chromium makes at launch (code_sign_clone) and only removes on a normal quit.
      const clones = path.join(path.dirname(os.tmpdir()), 'X', 'dev.meridian.browser.code_sign_clone');
      for (const name of fs.existsSync(clones) ? fs.readdirSync(clones) : []) {
        const p = path.join(clones, name);
        try { if (fs.statSync(p).birthtimeMs >= started - 1000) fs.rmSync(p, { recursive: true, force: true }); } catch {}
      }
    },
  };
  watchInvariants(b);
  return b;
}

// The sidebar's shadow root, and its rows.
export const SB = `app.$.tabstrip.shadowRoot`;
// Tests run in the background on macOS (no windows on screen, no focus). macOS full screen and
// picture-in-picture windows show on screen whatever the app is, so tests of those run only with
// MERIDIAN_FOREGROUND=1 (when nobody is working at the Mac): `{ skip: NEEDS_SCREEN }`.
export const FOREGROUND = process.platform !== 'darwin' || !!process.env.MERIDIAN_FOREGROUND;
export const NEEDS_SCREEN = !FOREGROUND && 'needs a window on screen: run with MERIDIAN_FOREGROUND=1';
export const tabEl = (i) => `${SB}.querySelectorAll('meridian-tab-row')[${i}]`;
export const itemEl = (title) => `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll('meridian-item')) { all.push(el); walk(el.shadowRoot); } }; walk(${SB}); return all.find((el) => el.item.title === ${JSON.stringify(title)}); })()`;
export const favEl = (i) => `${SB}.querySelectorAll('meridian-fav')[${i}]`;
