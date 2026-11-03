// Updating from 0.5.4 (the last Latest before the one-window profiles): a profile made there, with
// two spaces, a pinned tab, a favorite and a space in a Work profile (its own window in 0.5.4),
// opens in this build as one window with every space, tab and cookie where it was.
// Needs the 0.5.4 app: MERIDIAN_OLD_APP, or the copy in Meridian Backups; skipped without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const OLD = process.env.MERIDIAN_OLD_APP ||
    path.join(os.homedir(), 'Library/Application Support/Meridian Backups/Meridian-0.5.4.app/Contents/MacOS/Meridian');

// Pages that show their cookie; /main and /work set one.
function cookieSite() {
  const server = http.createServer((req, res) => {
    const headers = { 'content-type': 'text/html' };
    if (req.url === '/main') headers['set-cookie'] = 'who=main; Path=/; Max-Age=3600';
    if (req.url === '/work') headers['set-cookie'] = 'who=work; Path=/; Max-Age=3600';
    res.writeHead(200, headers);
    res.end(`<title>${req.url.slice(1)} ${req.headers.cookie || 'none'}</title>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
    close: () => { server.closeAllConnections(); server.close(); },
  })));
}

// Evaluates `expr` (with `app`) in every browser window's UI page.
async function inWindows(b, expr) {
  const targets = (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.startsWith('chrome://webui-browser'));
  const out = [];
  for (const t of targets) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    const reply = await new Promise((r) => {
      ws.onmessage = (m) => r(JSON.parse(m.data));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { const app = document.querySelector('webui-browser-app'); return (${expr}); })()`, awaitPromise: true, returnByValue: true } }));
    });
    ws.close();
    out.push(reply.result?.result?.value);
  }
  return out;
}

test('updating from 0.5.4: one window with every space, the pinned tab, the favorite and the Work cookies', { skip: !fs.existsSync(OLD) && 'no 0.5.4 app' }, async () => {
  const s = await cookieSite();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-upgrade-'));
  try {
    // 0.5.4: the main space with a pinned tab and a favorite, a second space, a Work space.
    let b = await launch([s.url('/main'), s.url('/fav')], { app: OLD, profile });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
      await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'main who=main' || r.tab.title === 'main none')`);
      const tabId = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith(${JSON.stringify(title)})).tab.id`;
      await b.eval(`${T}.handler_.pinTab(${tabId('main')}, { container: ${T}.state_.activeSpaceId, parentId: '', index: 0 }, '')`);
      await b.waitFor(`${T}.state_.spaces[0].pinned.length === 1`);
      await b.eval(`${T}.handler_.pinTab(${tabId('fav')}, { container: 'favorites', parentId: '', index: -1 }, '')`);
      await b.waitFor(`${T}.state_.favorites.length === 1`);
      const { spaceId: two } = await b.eval(`${T}.handler_.createSpace('Two', '', '', '')`);
      await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(two)})`);
      await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(two)}`);
      await b.eval(`${T}.openUrl(${JSON.stringify(s.url('/two'))})`);
      await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title.startsWith('two'))`);
      const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
      const { spaceId: client } = await b.eval(`${T}.handler_.createSpace('Client', '', '', '')`);
      await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(client)}, ${JSON.stringify(profileId)})`);
      await b.waitFor(`${T}.state_.spaces.find((x) => x.id === ${JSON.stringify(client)})?.profileId === ${JSON.stringify(profileId)}`);
      await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(client)})`);
      // 0.5.4 shows that space in a window of the Work profile: open the page there.
      let opened = false;
      for (const end = Date.now() + 10000; Date.now() < end && !opened; await sleep(300)) {
        const states = await inWindows(b, `app.$.tabstrip.state_?.profileId === ${JSON.stringify(profileId)} && app.$.tabstrip.state_.activeSpaceId === ${JSON.stringify(client)}`);
        if (states.includes(true)) {
          await inWindows(b, `app.$.tabstrip.state_?.profileId === ${JSON.stringify(profileId)} ? (app.$.tabstrip.openUrl(${JSON.stringify(s.url('/work'))}), true) : false`);
          opened = true;
        }
      }
      assert.ok(opened, 'the Work space came up in 0.5.4');
      await sleep(12000);  // 0.5.4 writes its sidebar 10 s after a change
      // Quit like ⌘Q (cookies and the session are written on the way out).
      await b.quit();
    } finally { await b.close(); }

    // This build, same profile, nothing on the command line: the session comes back.
    b = await launch([], { profile });
    try {
      // 0.5.4's Work window is gathered into the main one and closes (the harness may have picked
      // either), so ask every window, once they're down to one.
      let st;
      for (const end = Date.now() + 20000; Date.now() < end; await sleep(500)) {
        const all = await inWindows(b, `JSON.stringify(app.$.tabstrip.state_ && { spaces: app.$.tabstrip.state_.spaces.map((x) => [x.name, x.pinned.length]), favorites: app.$.tabstrip.state_.favorites.length, tabs: app.$.tabstrip.state_.tabs.length })`);
        if (all.length === 1 && all[0] && JSON.parse(all[0]).spaces.length === 3) { st = JSON.parse(all[0]); break; }
      }
      assert.ok(st, 'one window with the three spaces');
      await sleep(2000);
      const windows = (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.startsWith('chrome://webui-browser'));
      assert.equal(windows.length, 1, 'one window');
      assert.deepEqual(st.spaces.slice(1).map((x) => x[0]), ['Two', 'Client'], 'the spaces');
      assert.equal(st.spaces[0][1], 1, 'the pinned tab');
      // Favorites belong to a profile (Arc): the main one's, from its space.
      await inWindows(b, `app.$.tabstrip.handler_.activateSpace(app.$.tabstrip.state_.spaces[0].id)`);
      let favorites = 0;
      for (const end = Date.now() + 5000; Date.now() < end && favorites !== 1; await sleep(300)) {
        [favorites] = await inWindows(b, `app.$.tabstrip.state_.favorites.length`);
      }
      assert.equal(favorites, 1, 'the favorite');
      // Every page is in the one window, each still in its own profile (that profile's cookie jar).
      const cookieOf = async (pathname) => {
        const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url === s.url(pathname));
        assert.ok(t, `a tab at ${pathname}`);
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        const reply = await new Promise((r) => {
          ws.onmessage = (m) => r(JSON.parse(m.data));
          ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [s.url('/')] } }));
        });
        ws.close();
        return reply.result.cookies.find((c) => c.name === 'who')?.value;
      };
      assert.equal(await cookieOf('/work'), 'work', "the Work tab keeps Work's cookies");
      assert.equal(await cookieOf('/two'), 'main', "the second space's tab is the main profile's");
      assert.equal(await cookieOf('/main'), 'main', 'the pinned tab too');
    } finally { await b.close(); }
  } finally {
    s.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
