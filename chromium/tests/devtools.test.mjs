// Developer Tools dock inside the window, as in Arc and Chrome: on the right by default, with the
// page beside them; their ⋮ menu docks them to the bottom or the left or undocks them into a
// window of their own and back; ⇧⌘D toggles the last two; each tab keeps its own. They opened in a
// separate window always: the WebUI window had no place to dock them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const CMD = 1 << 20, OPT = 1 << 19;
const toggleDevtools = (b) => b.eval(`${T}.handler_.testKeyPress(34, 'i', ${CMD | OPT})`);  // ⌥⌘I
const page = (title, colour) => 'data:text/html,' + encodeURIComponent(`<title>${title}</title><body style="background:${colour}">${title}`);

// The active tab: its area, where its page lies, and whether DevTools are docked in it.
const layout = (b) => b.eval(`(() => {
  const w = app.$.contentRegion.activeWebview;
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return { devtools: w.hasAttribute('devtools'), tab: box(w), page: box(w.shadowRoot.querySelector('.content')) };
})()`);

// The same value for half a second.
async function settled(fn, ok, what, ms = 8000) {
  let last, since = 0;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = await fn();
    if (!ok(v)) { since = 0; last = v; continue; }
    if (!since) since = Date.now();
    if (Date.now() - since >= 500) return v;
    last = v;
  }
  assert.fail(`${what}: ${JSON.stringify(last)}`);
}

// The DevTools front end (its own page), driven like the page of a tab.
async function devtools(b) {
  // Moving between windows can close the connection to their page: then a new one.
  let ws = null, id = 0;
  const pending = new Map();
  const connect = async () => {
    let t;
    for (const end = Date.now() + 10000; !t && Date.now() < end; await sleep(200)) {
      t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.url.startsWith('devtools://devtools/bundled/devtools_app'));
    }
    if (!t) throw new Error('DevTools never opened');
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  };
  await connect();
  const send = async (method, params = {}) => {
    for (let attempt = 0; ; attempt++) {
      if (ws.readyState !== WebSocket.OPEN) await connect();
      const n = ++id;
      const m = await Promise.race([
        new Promise((r) => { pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); }),
        sleep(5000).then(() => null)]);
      if (m) return m;
      pending.delete(n);
      // Input is never sent twice: a click that docks or undocks them moves their page, and
      // its answer can get lost on the way.
      if (method.startsWith('Input.')) return null;
      if (attempt >= 2) throw new Error(`DevTools never answered ${method}`);
      ws.close();
    }
  };
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const DEEP = `const deep = (label) => { const out = []; const walk = (r) => { for (const el of r.querySelectorAll('*')) { if ((el.getAttribute('aria-label') || el.title) === label && el.getBoundingClientRect().width) out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out[0]; };`;
  const d = {
    ev, close: () => ws?.close(),
    // A real click on the control labelled so (deep in DevTools' shadow roots).
    async click(label) {
      let r;
      for (const end = Date.now() + 5000; !r && Date.now() < end; await sleep(100)) {
        r = await ev(`(() => { ${DEEP} const el = deep(${JSON.stringify(label)}); if (!el) return null; const x = el.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; })()`);
      }
      if (!r) throw new Error(`no "${label}" in DevTools`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
      }
    },
    // ⋮ > Dock side > `side`.
    async dock(side) {
      await d.click('Customize and control DevTools');
      await d.click(side);
    },
    // Their own shortcut (their page handles it).
    async key(key, code, keyCode, modifiers) {
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    size: () => ev('({ w: innerWidth, h: innerHeight, visible: document.visibilityState === "visible" })'),
  };
  return d;
}

const docked = (side) => (l) => {
  if (!l.devtools) return false;
  const { tab, page: p } = l;
  if (side === 'right') return p.x === tab.x && p.w < tab.w - 200 && p.h === tab.h;
  if (side === 'left') return p.x > tab.x + 200 && p.x + p.w === tab.x + tab.w && p.h === tab.h;
  if (side === 'bottom') return p.y === tab.y && p.h < tab.h - 60 && p.w === tab.w;
  return false;
};
const whole = (l) => l.page.x === l.tab.x && l.page.y === l.tab.y && l.page.w === l.tab.w && l.page.h === l.tab.h;

test('⌥⌘I docks DevTools on the right inside the window; their menu moves them to the bottom, the left, a window of their own and back', async () => {
  const b = await launch([page('Green', '#3a6')], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await settled(() => layout(b), whole, 'the page fills its tab');
    await toggleDevtools(b);
    await settled(() => layout(b), docked('right'), 'DevTools on the right, the page beside them');
    const d = await devtools(b);
    try {
      for (const [label, side] of [['Dock to bottom', 'bottom'], ['Dock to left', 'left']]) {
        await d.dock(label);
        await settled(() => layout(b), docked(side), `${label}: the page above or beside them`);
      }
      await d.dock('Undock into separate window');
      await settled(() => layout(b), (l) => whole(l), 'undocked: the page fills its tab again');
      await settled(() => d.size(), (s) => s.visible && s.w > 300 && s.h > 300, 'and DevTools show in their own window');
      await d.dock('Dock to right');
      await settled(() => layout(b), docked('right'), 'docked again on the right');
      await d.key('D', 'KeyD', 68, 4 | 8);  // ⇧⌘D: undock
      await settled(() => layout(b), whole, '⇧⌘D undocks');
      await settled(() => d.size(), (s) => s.visible && s.w > 300, 'into their window');
      await d.key('D', 'KeyD', 68, 4 | 8);  // ⇧⌘D: back
      await settled(() => layout(b), docked('right'), '⇧⌘D docks them back');
    } finally { d.close(); }
    await toggleDevtools(b);
    await settled(() => layout(b), (l) => !l.devtools && whole(l), '⌥⌘I closes them; the page fills its tab');
  } finally { await b.close(); }
});

test('each tab has its own DevTools: another tab shows none, coming back shows them again', async () => {
  const b = await launch([page('Green', '#3a6'), page('Blue', '#36a')], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
    const active = (title) => b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === ${JSON.stringify(title)}`);
    await b.click(row('Green'));
    await active('Green');
    await toggleDevtools(b);
    await settled(() => layout(b), docked('right'), 'DevTools in Green');
    await b.click(row('Blue'));
    await active('Blue');
    await settled(() => layout(b), (l) => !l.devtools && whole(l), 'Blue: no DevTools, the whole page');
    await b.click(row('Green'));
    await active('Green');
    await settled(() => layout(b), docked('right'), 'back in Green: its DevTools');
  } finally { await b.close(); }
});
