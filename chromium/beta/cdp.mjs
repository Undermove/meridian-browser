// Tiny CDP helper for headless beta shots.
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function start(app, extra = [], port = 9345) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-shots-'));
  const p = spawn(app, [`--user-data-dir=${prof}`, '--no-first-run', '--use-mock-keychain', '--headless=new', '--window-size=1440,900', '--force-device-scale-factor=2', `--remote-debugging-port=${port}`, ...extra, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(250); } }
  const browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
  const pages = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  async function attach(match) {
    let t;
    for (let i = 0; i < 60 && !t; i++) { t = (await pages()).find((x) => (x.type === 'page' || x.type === 'browser_ui') && match(x.url)); if (!t) await sleep(250); }
    if (!t) throw new Error('no page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r);
    let id = 0; const pend = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
    const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await evalJs(expr); if (v) return v; } catch {} await sleep(200); } throw new Error('timeout: ' + expr.slice(0, 120)); };
    const shot = async (file, clip) => { const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
    return { send, eval: evalJs, waitFor, shot, ws, url: t.url };
  }
  const stop = async () => { p.kill('SIGTERM'); await sleep(2500); fs.rmSync(prof, { recursive: true, force: true }); };
  return { attach, pages, stop, prof, browserWs };
}
