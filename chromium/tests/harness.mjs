// Drives the built Meridian (Chromium) over the DevTools protocol. The browser's own UI is the page
// chrome://webui-browser, so tests evaluate in it and send real mouse/keyboard input to it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium');
export const APP = path.join(DIR, 'src/out/Release/Chromium.app/Contents/MacOS/Chromium');
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

export async function launch(urls = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
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
      while (Date.now() < end) { try { last = await b.eval(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(100); }
      throw new Error(`timed out waiting for: ${expr} (last: ${JSON.stringify(last)})`);
    },
    // Tabs as the sidebar shows them.
    tabs() {
      return b.eval(`[...app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab')].map((t) => ({ id: t.tabData.id, title: t.tabData.title, url: t.tabData.url, active: t.hasAttribute('active') }))`);
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
    async close() {
      cdp.close(); proc.kill();
      await new Promise((r) => proc.once('exit', r));
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
  return b;
}

export const tabEl = (i) => `app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab')[${i}]`;
