// Drives the built Meridian (Chromium) over the DevTools protocol. The browser's own UI is the page
// chrome://webui-browser, so tests evaluate in it and send real mouse/keyboard input to it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium');
export const APP = path.join(DIR, 'src/out/Release/Meridian.app/Contents/MacOS/Meridian');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { this.ws?.close(); }
}

// `profile`: reuse a profile dir (to test what survives a restart); it's then left for the caller to delete.
export async function launch(urls = [], { profile: keep } = {}) {
  const profile = keep || fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  const proc = spawn(APP, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--use-mock-keychain',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', ...urls,
  ], { stdio: 'ignore' });
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
    async eval(expr) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(async () => { const app = document.querySelector('webui-browser-app'); return (${expr}); })()`,
        awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 10000) {
      const end = Date.now() + timeout; let last;
      // A DOM node can't be returned by value; it just means "found".
      const probe = `(() => { const v = (${expr}); return v instanceof Node ? true : v; })()`;
      while (Date.now() < end) { try { last = await b.eval(probe); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
      throw new Error(`timed out waiting for: ${expr} (last: ${JSON.stringify(last)})`);
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
      const r = await b.waitFor(`(() => { const el = ${elExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      await b.click(`[...${SB}.querySelectorAll('#menu .menu-item')].find((m) => m.textContent.trim() === ${JSON.stringify(label)})`);
    },
    async type(text) {
      await cdp.send('Input.insertText', { text });
    },
    async key(key, code = key, keyCode = 0) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    },
    // A real mouse click at the centre of an element found by a JS expression in the UI page.
    async click(elExpr, { button = 'left' } = {}) {
      const r = await b.waitFor(`(() => { const el = ${elExpr}; if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : button, clickCount: 1 });
      }
    },
    async screenshot(file) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    // Quits like the user does (⌘Q), so the session and the sidebar are saved.
    async quit() {
      const done = exited();
      cdp.send('Browser.close').catch(() => {});  // never answers: the process exits
      await Promise.race([done, sleep(15000)]);
      cdp.close();
      if (proc.exitCode === null) { proc.kill(); await exited(); }
    },
    async close() {
      cdp.close();
      if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await exited(); }
      if (!keep) fs.rmSync(profile, { recursive: true, force: true });
    },
  };
  return b;
}

// The sidebar's shadow root, and its rows.
export const SB = `app.$.tabstrip.shadowRoot`;
export const tabEl = (i) => `${SB}.querySelectorAll('meridian-tab-row')[${i}]`;
export const itemEl = (title) => `(() => { const all = []; const walk = (root) => { for (const el of root.querySelectorAll('meridian-item')) { all.push(el); walk(el.shadowRoot); } }; walk(${SB}); return all.find((el) => el.item.title === ${JSON.stringify(title)}); })()`;
export const favEl = (i) => `${SB}.querySelectorAll('meridian-fav')[${i}]`;
