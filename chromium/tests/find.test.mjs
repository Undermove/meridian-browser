// Find in page with the keyboard only: ⌘F from a focused page opens the find bar over the page (top
// right, like Arc; Chrome put it under the URL pill, which lives in the sidebar), typing searches,
// Esc closes it and leaves the match selected. The same in a space of another profile and with the
// sidebar hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CMD = 1 << 20;
const T = 'app.$.tabstrip';
const KEY = { f: [3, 'f'], n: [45, 'n'], e: [14, 'e'], d: [2, 'd'], l: [37, 'l'], s: [1, 's'], esc: [53, '\u001b'] };

function site() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${req.url.slice(1)}</title><p>hay hay hay needle hay</p>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: (p) => `http://127.0.0.1:${server.address().port}/${p}`,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { if ((v = await fn())) return v; await sleep(100); }
  return v;
}

// The selection in the page at `suffix`.
async function selection(b, suffix) {
  const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.endsWith(suffix));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const reply = await new Promise((r) => {
    ws.onmessage = (m) => r(JSON.parse(m.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'String(getSelection())', returnByValue: true } }));
  });
  ws.close();
  return reply.result.result.value;
}

async function findBar(b) {
  const { bubbles } = await b.eval(`${T}.handler_.testBubbles('bounds')`);
  // The find bar's widget shows a plain View (its clip view); not the full screen hint.
  const m = bubbles.map((s) => s.match(/^View (-?\d+),(-?\d+) (\d+)x(\d+)$/)).find(Boolean);
  return m && { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
}

// ⌘F, "needle", Esc on the page at `suffix`: the bar shows over the page and the match is selected.
async function findNeedle(b, press, suffix, { clickSidebar = false } = {}) {
  await b.click('app.$.contentRegion');  // reading the page
  await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
  await press(KEY.f, CMD);
  const bar = await until(() => findBar(b));
  assert.ok(bar, 'the find bar is shown');
  const page = await b.eval(`(() => { const r = app.$.contentRegion.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; })()`);
  // The widget has a shadow around it, so allow a little past the page's edges.
  assert.ok(bar.x >= page.left && bar.x + bar.w <= page.right + 24, `over the page: ${JSON.stringify({ bar, page })}`);
  assert.ok(bar.x + bar.w / 2 > (page.left + page.right) / 2, 'on the right');
  assert.ok(bar.y < page.top + 40, 'at the top');
  for (const k of [KEY.n, KEY.e, KEY.e, KEY.d, KEY.l, KEY.e]) await press(k);
  await sleep(300);
  // Clicked into the sidebar meanwhile: Esc still closes the find bar first.
  if (clickSidebar) await b.click('app.$.tabstrip');
  await press(KEY.esc);
  assert.equal(await until(async () => (await findBar(b)) ? null : 'closed'), 'closed', 'Esc closed it');
  assert.equal(await until(() => selection(b, suffix).then((s) => s || null)), 'needle', 'the match is selected');
}

test('⌘F finds on the page, over the page, in any profile and with the sidebar hidden', async () => {
  const s = await site();
  const b = await launch([s.url('one')], { args: ['--meridian-test-keys', '--meridian-test-bubbles'] });
  const press = ([code, ch], mods = 0) => b.eval(`${T}.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await findNeedle(b, press, '/one');
    // Again, the second time.
    await b.eval(`${T}.openUrl(${JSON.stringify(s.url('two'))})`);
    await findNeedle(b, press, '/two', { clickSidebar: true });

    // A space of another profile.
    const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
    const { spaceId } = await b.eval(`${T}.handler_.createSpace('Client', '', '', '')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
    await b.waitFor(`${T}.state_.spaces.find((s) => s.name === 'Client')?.profileId === ${JSON.stringify(profileId)}`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    await sleep(500);
    await b.eval(`${T}.openUrl(${JSON.stringify(s.url('work'))})`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === 'work'`);
    await findNeedle(b, press, '/work');

    // The sidebar hidden (⌘S): the bar still sits over the page.
    await press(KEY.s, CMD);
    await b.waitFor(`app.$.contentRegion.getBoundingClientRect().left < 40`);
    await findNeedle(b, press, '/work');

    // macOS full screen (its own Space).
    await press(KEY.s, CMD);
    await b.eval(`${T}.handler_.testCommand(34030)`);  // IDC_FULLSCREEN
    await sleep(2500);
    await findNeedle(b, press, '/work');
  } finally { await b.close(); s.close(); }
});
