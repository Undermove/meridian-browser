// A film site's player keeps every key for itself (digits seek, arrows skip): it sits in an iframe from
// another site, has the focus after a click on it, and calls preventDefault on each keydown. Arc's tab
// and space shortcuts still work there: ⌘1-9, ⌘⌥↑/↓, ⌃Tab, ⌃1-9 and ⌘⌥←/→, also in macOS full screen
// (where Chromium hands a page every key but ⌃⌘F). The keys go into the page the way AppKit hands them
// to a focused page; the browser takes them before the player sees them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const CMD = 1 << 20, CTRL = 1 << 18;
const activeTitle = `[...${T}.tabs_.values()].find((t) => t.isActive)?.title`;
const space = `${T}.state_.spaces.findIndex((s) => s.id === ${T}.state_.activeSpaceId)`;

// The player, on its own origin: counts the keys it kept in the parent page's title.
const PLAYER = `<!doctype html><body style="margin:0;background:#222;height:100vh" tabindex=0><script>
let n = 0;
addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); parent.postMessage(++n, '*'); }, true);
</script>`;
const page = (t, player) => `<!doctype html><title>${t}</title><body style="margin:0">
<iframe id=f src="${player}" onload="document.body.dataset.ready = 1" style="border:0;width:600px;height:340px"></iframe>
<script>addEventListener('message', (e) => { document.title = '${t} kept ' + e.data; });</script>`;

async function sites() {
  let player;
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(decodeURIComponent(req.url.slice(1)), player)); });
  const cdn = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PLAYER); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  // localhost vs 127.0.0.1: another site, so the player is in its own process like a real one.
  player = `http://localhost:${cdn.address().port}/player`;
  return { url: (t) => `http://127.0.0.1:${site.address().port}/${t}`, close: () => { site.closeAllConnections(); site.close(); cdn.closeAllConnections(); cdn.close(); } };
}

// A page's own DevTools connection: keys into it, and a click that focuses the player.
async function pageTarget(b, title) {
  const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.title.startsWith(title) && x.url.startsWith('http://127.0.0.1'));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const send = (method, params) => new Promise((r) => { const my = ++id; ws.addEventListener('message', function on(m) { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', on); r(d.result); } }); ws.send(JSON.stringify({ id: my, method, params })); });
  return { send, close: () => ws.close() };
}

// macOS key codes; CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8.
const KEYS = {
  cmd2: { key: '2', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 19, text: '2', modifiers: 4 },
  cmd1: { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, nativeVirtualKeyCode: 18, text: '1', modifiers: 4 },
  cmdOptDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 125, modifiers: 1 | 4 },
  ctrlTab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 48, modifiers: 2 },
  ctrl2: { key: '2', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 19, modifiers: 2 },
  ctrl1: { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, nativeVirtualKeyCode: 18, modifiers: 2 },
};

for (const fullscreen of [false, true]) {
  test(`a player that keeps every key doesn't keep the tab and space shortcuts${fullscreen ? ', in macOS full screen' : ''}`, async () => {
    const s = await sites();
    // Full screen needs the window treated as focused (a test window behind another app isn't).
    const b = await launch([s.url('A'), s.url('B'), s.url('C')], {
      args: ['--meridian-test-keys', '--disable-features=OptimizationGuideModelDownloading,OptimizationGuideOnDeviceModel,RWHVMacHasFocusReturnsFalseForNonKeyWindow'],
    });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 3`);
      await b.eval(`${T}.handler_.createSpace('Work', '', '#e08a8a', '')`);
      await b.waitFor(`${T}.state_.spaces.length === 2`);
      const order = await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);  // C, B, A
      await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === '${order[0]}').shadowRoot.querySelector('.row')`);
      await b.waitFor(`${activeTitle} === '${order[0]}'`);
      // The page has the keys, as after clicking a row.
      await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
      if (fullscreen) {
        await b.eval(`${T}.handler_.testKeyPress(3, 'f', ${CTRL | CMD})`);  // ⌃⌘F
        await b.waitFor(`app.fullscreenMode_ === 'browser' && innerWidth === screen.width`, 15000);
        await sleep(800);
      }

      // Click into the player of the active tab, then press `key` in that page.
      const press = async (key) => {
        const title = (await b.eval(activeTitle)).split(' ')[0];
        const p = await pageTarget(b, title);
        try {
          await p.send('Runtime.evaluate', { expression: `new Promise((r) => { const t = setInterval(() => document.body.dataset.ready && (clearInterval(t), r()), 50); })`, awaitPromise: true });
          for (const type of ['mousePressed', 'mouseReleased']) await p.send('Input.dispatchMouseEvent', { type, x: 300, y: 170, button: 'left', clickCount: 1 });
          await p.send('Runtime.evaluate', { expression: `document.getElementById('f').focus()` });
          await sleep(150);
          await p.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
          await p.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        } finally { p.close(); }
      };
      // The player is there and keeps keys: a plain digit stays with it.
      await press({ key: '5', code: 'Digit5', windowsVirtualKeyCode: 53, nativeVirtualKeyCode: 23, text: '5', modifiers: 0 });
      await b.waitFor(`${activeTitle} === '${order[0]} kept 1'`);

      const at = (t) => `${activeTitle}?.startsWith('${t}')`;
      await press(KEYS.cmd2);
      await b.waitFor(at(order[1]), 3000).catch(() => {});
      assert.ok(await b.eval(at(order[1])), `⌘2: the second tab, not the player: ${await b.eval(activeTitle)}`);
      await press(KEYS.cmdOptDown);
      await b.waitFor(at(order[2]), 3000).catch(() => {});
      assert.ok(await b.eval(at(order[2])), `⌘⌥↓: the next tab: ${await b.eval(activeTitle)}`);
      await press(KEYS.ctrlTab);
      await b.waitFor(at(order[0]), 3000).catch(() => {});
      assert.ok(await b.eval(at(order[0])), `⌃Tab: round to the first: ${await b.eval(activeTitle)}`);
      await press(KEYS.ctrl2);
      await b.waitFor(`${space} === 1`, 3000).catch(() => {});
      assert.equal(await b.eval(space), 1, '⌃2: the second space');
      await b.eval(`${T}.runCommand(2, 0)`);  // back to the first space (no player in the new one)
      await b.waitFor(`${space} === 0`);
      await press(KEYS.cmd1);
      await b.waitFor(at(order[0]), 3000).catch(() => {});
      assert.ok(await b.eval(at(order[0])), `⌘1: the first tab: ${await b.eval(activeTitle)}`);
      // None of those reached the player: only the plain digit was kept.
      const kept = await b.eval(`[...${T}.tabs_.values()].map((t) => t.title).filter((t) => / kept \\d+$/.test(t))`);
      assert.deepEqual(kept, [`${order[0]} kept 1`], 'the player kept only the digit');

      if (fullscreen) {
        await b.eval(`${T}.handler_.testCommand(34030)`);  // IDC_FULLSCREEN: out again
        await b.waitFor(`app.fullscreenMode_ === ''`, 15000);
        await sleep(800);
      }
    } finally { await b.close(); s.close(); }
  });
}
