// The designer toolkit (behind meridian.toolkit.enabled / --enable-meridian-toolkit, off by default):
// a portable page script in an isolated world (chrome/browser/meridian/toolkit/). Off: nothing of it
// in pages or menus. On: ⌘⇧X opens its dock, a lens click copies the colour through the browser's
// clipboard, the page menu has its items, stress text lengthens and restores the page's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const MAC = process.platform === 'darwin';
const IDS = { lens: 39730, shot: 39731, png: 39732, images: 39733 };  // IDC_MERIDIAN_TOOLKIT_*
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = `<!doctype html><meta charset="utf-8"><title>Зерно</title>
<style>body{margin:0;font:14px -apple-system,sans-serif;background:#f6eee3;color:#2d2433}
.bt{display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:20px;background:#5b3fa8;color:#fff;font-weight:600}
nav{display:flex;gap:20px;padding:20px;width:420px}</style>
<nav><a>Кофе</a><a>Обжарка</a><a>Кофейни</a><a>Доставка</a></nav>
<p id="lead" style="margin:20px">Небольшими партиями, в Москве.</p>
<span class="bt" id="btn" style="margin:20px">Выбрать зёрна</span>`;

async function serve() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/page` };
}
const rightClick = async (page, x, y) => {
  for (const [type, button] of [['mouseMoved', 'none'], ['mousePressed', 'right'], ['mouseReleased', 'right']]) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
  }
};
const menuIds = async (page, pick, x = 60, y = 60) => {
  fs.rmSync(pick + '.ids', { force: true });
  fs.writeFileSync(pick, 'list');
  await rightClick(page, x, y);
  for (let i = 0; i < 50 && !fs.existsSync(pick + '.ids'); i++) await sleep(100);
  return fs.readFileSync(pick + '.ids', 'utf8').split('\n').filter(Boolean).map(Number);
};
const key = async (page, key, code, modifiers = 0, keyCode = 0) => {
  await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode });
  await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode });
};
// The toolkit editor's <canvas> (a remote object id) once it is up, else null. Its UI is in a closed
// shadow root, which DevTools' DOM (pierce) can still walk.
async function editorCanvas(page) {
  await page.cdp.send('DOM.enable');
  const { root } = await page.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const find = (n) => n.nodeName === 'MERIDIAN-TOOLKIT' ? n : (n.children || []).map(find).find(Boolean) || null;
  const host = find(root);
  const shadow = host?.shadowRoots?.[0];
  if (!shadow) return null;
  const { nodeId } = await page.cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector: '.editor canvas' });
  if (!nodeId) return null;
  const { object } = await page.cdp.send('DOM.resolveNode', { nodeId });
  return object?.objectId || null;
}
const rect = (page, sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

test('toolkit off: no host element, no menu items', async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-toolkit-off-'));
  const pick = path.join(dir, 'pick');
  const b = await launch([url], { args: [`--meridian-test-context-menu-command=@${pick}`] });
  try {
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    await key(page, 'X', 'KeyX', MAC ? 4 | 8 : 2 | 8, 88);  // ⌘⇧X / Ctrl+Shift+X
    await sleep(800);
    assert.equal(await page.eval(`!!document.querySelector('meridian-toolkit')`), false, 'no toolkit in the page');
    const ids = await menuIds(page, pick);
    for (const id of Object.values(IDS)) assert.ok(!ids.includes(id), `no toolkit item ${id}: ${ids.join(', ')}`);
    page.close();
  } finally { await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toolkit on: dock, lens click copies the colour, menu items, stress text restores', async () => {
  const { server, url } = await serve();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-toolkit-on-'));
  const pick = path.join(dir, 'pick');
  const saved = MAC ? execFileSync('pbpaste') : null;  // the person's clipboard comes back afterwards
  const b = await launch([url], { args: ['--enable-meridian-toolkit', `--meridian-test-context-menu-command=@${pick}`] });
  try {
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    await sleep(500);  // DOMContentLoaded injection
    // ⌘⇧X: the dock (a top-layer host element; its UI is in a closed shadow root).
    await key(page, 'X', 'KeyX', MAC ? 4 | 8 : 2 | 8, 88);
    await page.waitFor(`!!document.querySelector('meridian-toolkit')`);
    // L, then a click on the button: its background goes to the clipboard through the browser.
    await key(page, 'l', 'KeyL', 0, 76);
    const btn = await rect(page, '#btn');
    for (const [type, button] of [['mouseMoved', 'none'], ['mousePressed', 'left'], ['mouseReleased', 'left']]) {
      await page.cdp.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button, clickCount: 1 });
    }
    if (MAC) {
      let got = '';
      for (let i = 0; i < 40 && got !== '#5B3FA8'; i++) { await sleep(100); got = execFileSync('pbpaste').toString(); }
      assert.equal(got, '#5B3FA8', 'the lens click copied the colour');
    }
    // The page still didn't get the click (the lens owns the pointer): no navigation, no error.
    await key(page, 'Escape', 'Escape', 0, 27); await key(page, 'Escape', 'Escape', 0, 27);
    // Stress text: the page's text gets longer, Esc brings it back exactly.
    await key(page, 't', 'KeyT', 0, 84);
    await page.waitFor(`document.getElementById('btn').textContent.length > 'Выбрать зёрна'.length`);
    await key(page, 'Escape', 'Escape', 0, 27);
    await page.waitFor(`document.getElementById('btn').textContent === 'Выбрать зёрна'`);
    // The page menu has the toolkit's items; "Images under cursor" runs in the page.
    await page.eval('getSelection().removeAllRanges(), true');
    const ids = await menuIds(page, pick, btn.x, btn.y);
    for (const id of [IDS.lens, IDS.shot, IDS.images]) assert.ok(ids.includes(id), `toolkit item ${id}: ${ids.join(', ')}`);
    // With text selected the menu is the selection's (Copy, Search for…: no page group): the items too, once.
    await page.eval(`getSelection().selectAllChildren(document.getElementById('lead')), true`);
    const lead = await rect(page, '#lead');
    const selected = await menuIds(page, pick, lead.x, lead.y);
    assert.ok(selected.includes(50150), `the selection's menu (IDC_CONTENT_CONTEXT_COPY): ${selected.join(', ')}`);
    for (const id of [IDS.lens, IDS.shot, IDS.images]) assert.equal(selected.filter((x) => x === id).length, 1, `toolkit item ${id} once with a selection: ${selected.join(', ')}`);
    await page.eval('getSelection().removeAllRanges(), true');
    fs.writeFileSync(pick, String(IDS.lens));
    await rightClick(page, btn.x, btn.y);
    await page.waitFor(`!!document.querySelector('meridian-toolkit')`);
    // Synthetic events from the page itself don't drive the toolkit (even with its dock up).
    await key(page, 'Escape', 'Escape', 0, 27); await key(page, 'Escape', 'Escape', 0, 27); await key(page, 'Escape', 'Escape', 0, 27);
    await key(page, 'X', 'KeyX', MAC ? 4 | 8 : 2 | 8, 88);
    await sleep(200);
    await page.eval(`dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true })), true`);
    await sleep(400);
    assert.equal(await page.eval(`document.getElementById('btn').textContent`), 'Выбрать зёрна', 'untrusted keys are ignored');
    page.close();
  } finally {
    if (saved) execFileSync('pbcopy', { input: saved });
    await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toolkit on: ⌘⇧2 takes the whole page; P opens the page again as a phone in a split', async () => {
  const { server, url } = await serve();
  const b = await launch([url], { args: ['--enable-meridian-toolkit'] });
  try {
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    // A sticky header (magenta) and a bar fixed at the bottom (cyan) on a page of several slices (the
    // browser takes ≤ 8000 device px a slice: 2 slices at 1×, 3 at 2×). Their styles are in a sheet, so
    // anything inline afterwards is the toolkit's.
    await page.eval(`(() => {
      document.head.insertAdjacentHTML('beforeend', '<style>#hdr{position:sticky;top:0;height:120px;background:#ff00ff;z-index:2}#bar{position:fixed;left:0;right:0;bottom:0;height:60px;background:#00ffff}#tall{height:11000px;background:linear-gradient(#f6eee3,#5b3fa8)}</style>');
      document.body.insertAdjacentHTML('afterbegin', '<header id="hdr"></header>');
      document.body.insertAdjacentHTML('beforeend', '<div id="tall"></div><div id="bar"></div>');
      return true; })()`);
    await sleep(500);
    // ⌘⇧2: lazy pass down the page and back, the capture, the editor; the page scroll comes back.
    await page.eval('scrollTo(0, 120), true');
    await key(page, '2', 'Digit2', MAC ? 4 | 8 : 2 | 8, 50);
    // The editor's picture (in the toolkit's closed shadow root: found through DevTools' DOM).
    let canvas = null;
    for (let i = 0; i < 80 && !canvas; i++) { await sleep(250); canvas = await editorCanvas(page); }
    assert.ok(canvas, 'the editor shows the whole page');
    assert.equal(await page.eval('Math.round(scrollY)'), 120, 'the scroll position is restored');
    assert.equal(await page.eval(`[...document.querySelectorAll('*')].filter(e => e.tagName !== 'MERIDIAN-TOOLKIT' && ['position', 'visibility', 'opacity'].some(k => e.style.getPropertyValue(k))).length`), 0, 'fixed/sticky changes are undone');
    // Down the picture: the header once (the first slice), the bottom bar never.
    const bands = await page.cdp.send('Runtime.callFunctionOn', { objectId: canvas, returnByValue: true, functionDeclaration: `function () {
      const d = this.getContext('2d').getImageData(Math.round(this.width * 0.3), 0, 1, this.height).data;
      const runs = (on) => { let n = 0, was = false; for (let i = 0; i < d.length; i += 4) { const is = on(d[i], d[i + 1], d[i + 2]); if (is && !was) n++; was = is; } return n; };
      return { h: this.height, header: runs((r, g, b) => r > 200 && g < 70 && b > 200), bar: runs((r, g, b) => r < 70 && g > 200 && b > 200) };
    }` });
    const got = bands.result.value;
    assert.equal(got.header, 1, `the sticky header shows once: ${JSON.stringify(got)}`);
    assert.equal(got.bar, 0, `the bottom bar doesn't show: ${JSON.stringify(got)}`);
    await key(page, 'Escape', 'Escape', 0, 27);
    // P (dock up): a second tab with the same URL, emulated as an iPhone (UA, touch, viewport).
    await key(page, 'X', 'KeyX', MAC ? 4 | 8 : 2 | 8, 88);
    await page.waitFor(`!!document.querySelector('meridian-toolkit')`);
    await key(page, 'p', 'KeyP', 0, 80);
    // Find the phone tab by its emulation: a page at the same URL with an iPhone user agent.
    const evalIn = (wsUrl, expr) => new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
      ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { ws.close(); resolve(d.result?.result?.value); } };
      ws.onerror = () => resolve(undefined);
    });
    let phone = null;
    for (let i = 0; i < 60 && !phone; i++) {
      await sleep(250);
      const list = (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.type === 'page' && t.url.startsWith(url));
      for (const t of list) {
        const info = await evalIn(t.webSocketDebuggerUrl, `JSON.stringify({ ua: navigator.userAgent, touch: navigator.maxTouchPoints, w: innerWidth })`);
        if (info && /iPhone/.test(JSON.parse(info).ua)) { phone = JSON.parse(info); break; }
      }
    }
    assert.ok(phone, 'a phone tab with an iPhone user agent');
    assert.equal(phone.touch, 5, 'touch is emulated');
    assert.equal(phone.w, 393, 'the iPhone 16 Pro viewport');
    page.close();
  } finally { await b.close(); server.close(); }
});
