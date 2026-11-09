// macOS full screen: the "exit full screen" hint shows at the top and goes away after a few
// seconds, as in Chrome. It stayed for as long as full screen lasted: the hide timer waited for
// presentation feedback that the WebUI window's full screen never sends.
// Arc in full screen: the sidebar stays as the person left it (shown, or hidden with ⌘S and sliding
// over the page from the left edge); a video (the page's own full screen) covers the whole screen,
// also when the window already is full screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const CMD = 1 << 20, CTRL = 1 << 18;
const toggleFullscreen = (b) => b.eval(`${T}.handler_.testKeyPress(3, 'f', ${CTRL | CMD})`);  // ⌃⌘F
const esc = (b) => b.eval(`${T}.handler_.testKeyPress(53, '\\u001b', 0)`);

// Where the sidebar and the page are, in the browser window.
const layout = (b) => b.eval(`(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width) }; };
  const sb = app.shadowRoot.getElementById('sidebar');
  const st = getComputedStyle(sb);
  return {
    mode: app.fullscreenMode_, win: innerWidth, screen: screen.width,
    // The sidebar is seen: laid out, opaque and inside the window.
    sidebarSeen: st.display !== 'none' && Number(st.opacity) > 0.5 && box(sb).w > 0 && box(sb).x >= 0,
    sidebar: box(sb), page: box(app.shadowRoot.querySelector('content-region')),
  };
})()`);

// A page goes full screen only from a focused view, and Chromium counts a view in a window that
// isn't the key window as unfocused; a test window usually isn't (another app is in front), a
// person's window always is. The harness's own --disable-features list comes first: this one wins.
const ARGS = ['--meridian-test-keys', '--disable-features=OptimizationGuideModelDownloading,' +
    'OptimizationGuideOnDeviceModel,RWHVMacHasFocusReturnsFalseForNonKeyWindow'];

// A page with a "video" and a button that puts it full screen (a click: a user gesture).
const VIDEO = 'data:text/html,' + encodeURIComponent('<title>Video</title><body style="margin:0">' +
    '<div id=v style="background:#c33;width:320px;height:180px"></div>' +
    '<button id=go style="position:fixed;left:300px;top:260px;width:200px;height:80px" onclick="v.requestFullscreen()">play</button>');
async function videoFullscreen(b, page) {
  // Loaded, and laid out at the page card's size (a click before that misses).
  await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('go')`);
  const card = (await layout(b)).page.w;
  await page.waitFor(`innerWidth === ${card}`);
  const r = await page.eval(`(() => { const x = go.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}
// The same value for half a second.
async function settled(b, fn, ok, what, ms = 8000) {
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

test('full screen: the exit hint shows, then goes away by itself', async () => {
  const b = await launch(['data:text/html,<title>P</title>page'], { args: ['--meridian-test-keys', '--meridian-test-bubbles'] });
  const hint = async () => (await b.eval(`${T}.handler_.testBubbles('').then((r) => r.bubbles)`))
      .includes('SubtleNotificationView');
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`${T}.handler_.testCommand(34030)`);  // IDC_FULLSCREEN: macOS's own Space
    let shown = false;
    for (const end = Date.now() + 3000; Date.now() < end && !shown; await sleep(200)) shown = await hint();
    assert.ok(shown, 'the hint shows');
    let gone = false;
    for (const end = Date.now() + 10000; Date.now() < end && !gone; await sleep(250)) gone = !(await hint());
    assert.ok(gone, 'and goes away within 10 s');
    await b.eval(`${T}.handler_.testCommand(34030)`);
    await sleep(1500);
  } finally { await b.close(); }
});

const sidebarKey = (b) => b.eval(`${T}.handler_.testKeyPress(1, 's', ${CMD})`);  // ⌘S

test('full screen keeps the sidebar where it was: shown stays shown beside the page, ⌘S still hides it', async () => {
  const b = await launch([VIDEO], { args: ARGS });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const windowed = await layout(b);
    assert.ok(windowed.sidebarSeen && windowed.page.x > 200, `windowed: the sidebar beside the page: ${JSON.stringify(windowed)}`);

    await toggleFullscreen(b);
    await settled(b, () => layout(b), (l) => l.mode === 'browser' && l.win === l.screen && l.sidebarSeen && l.page.x > 200,
        'full screen: the sidebar still beside the page');

    await sidebarKey(b);
    await settled(b, () => layout(b), (l) => l.mode === 'browser' && !l.sidebarSeen && l.page.x < 20, '⌘S in full screen hides it');
    await sidebarKey(b);
    await settled(b, () => layout(b), (l) => l.mode === 'browser' && l.sidebarSeen && l.page.x > 200, 'and ⌘S brings it back');

    await toggleFullscreen(b);
    const back = await settled(b, () => layout(b), (l) => l.mode === '' && l.sidebarSeen && l.page.x > 200,
        'out of full screen: the sidebar in its place');
    assert.equal(back.win, windowed.win);
  } finally { await b.close(); }
});

test('a sidebar hidden with ⌘S stays hidden in full screen; the left edge slides it over the page; it stays hidden after', async () => {
  const b = await launch([VIDEO], { args: ARGS });
  const move = (x, y) => b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const windowed = await layout(b);
    await move(windowed.win / 2, 300);  // the pointer over the page, not at the edge
    await sidebarKey(b);
    await settled(b, () => layout(b), (l) => l.mode === '' && !l.sidebarSeen && l.page.x < 20, '⌘S hides the sidebar');

    await toggleFullscreen(b);
    const full = await settled(b, () => layout(b), (l) => l.mode === 'browser' && l.win === l.screen && !l.sidebarSeen && l.page.x < 20,
        'full screen: still hidden, the page from the left edge');
    assert.ok(full.page.w > full.win - 40, `the page across the screen: ${JSON.stringify(full)}`);

    await move(2, 300);
    const peek = await settled(b, () => layout(b), (l) => l.sidebarSeen, 'the left edge brings the sidebar');
    assert.ok(peek.page.x < 20 && peek.page.w > peek.win - 40, `over the page, which stays put: ${JSON.stringify(peek)}`);
    await move(peek.win / 2, 300);
    await settled(b, () => layout(b), (l) => !l.sidebarSeen, 'away from it, it goes');

    await toggleFullscreen(b);
    await settled(b, () => layout(b), (l) => l.mode === '' && !l.sidebarSeen && l.page.x < 20, 'out of full screen: still hidden');
    assert.equal(await b.eval(`localStorage.getItem('meridian.sidebarHidden')`), '1');
  } finally { await b.close(); }
});

for (const fromFullscreen of [false, true]) {
  test(`a video full screen covers the whole screen${fromFullscreen ? ' from macOS full screen too' : ''}; Esc goes back`, async () => {
    const b = await launch([VIDEO], { args: ARGS });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      const page = await b.page('data:text/html');
      if (fromFullscreen) {
        await toggleFullscreen(b);
        await settled(b, () => layout(b), (l) => l.mode === 'browser' && l.win === l.screen, 'macOS full screen');
      }
      await videoFullscreen(b, page);
      const video = await settled(b, () => layout(b), (l) => l.mode === 'tab' && l.win === l.screen && !l.sidebarSeen && l.page.x === 0 && l.page.w === l.win,
          'the video: only the page, edge to edge');
      assert.equal(await page.eval('innerWidth'), video.win, 'the page is as wide as the screen');
      assert.ok(await page.eval('!!document.fullscreenElement'));

      await esc(b);
      await page.waitFor('!document.fullscreenElement');
      if (fromFullscreen) {
        const l = await settled(b, () => layout(b), (x) => x.mode === 'browser' && x.win === x.screen && x.sidebarSeen && x.page.x > 200,
            'Esc: back to full screen, the sidebar beside the page');
        assert.ok(l.page.x + l.page.w > l.win - 40);
        await toggleFullscreen(b);
      }
      await settled(b, () => layout(b), (l) => l.mode === '' && l.sidebarSeen && l.page.x > 200, 'and to the window with its sidebar');
    } finally { await b.close(); }
  });
}
