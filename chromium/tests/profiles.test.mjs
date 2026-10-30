// Spaces with their own profile, Arc's way: Settings > Profiles makes one, a space's menu picks it,
// and the space's tabs live in its profile (own cookies) in the same window as every other space's.
// Switching spaces never changes windows; the tabs' profiles survive links, ⇧⌘T and a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ST = 'app.$.settings.shadowRoot';
const T = 'app.$.tabstrip';

// A site that shows its cookie and how many times it was loaded: /main and /work set one.
function cookieSite() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    const headers = { 'content-type': 'text/html' };
    if (req.url === '/main') headers['set-cookie'] = 'who=main; Path=/; Max-Age=3600';
    if (req.url === '/work') headers['set-cookie'] = 'who=work; Path=/; Max-Age=3600';
    res.writeHead(200, headers);
    res.end(`<title>${req.headers.cookie || 'none'} ${req.url} #${++hits}</title>
      <a id="blank" href="/child" target="_blank">new tab</a> <a id="link" href="/meta">link</a>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    server, url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
  })));
}

const windowCount = async (b) => (await (await fetch(`${b.base}/json/list`)).json())
    .filter((t) => t.url.startsWith('chrome://webui-browser')).length;
const titles = (b) => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);
// Activates the tab whose title has `part`, reloads it (⌘R) and returns its title once reloaded.
async function reload(b, part) {
  await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.includes(${JSON.stringify(part)})).shadowRoot.querySelector('.row')`);
  await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title.includes(${JSON.stringify(part)})`);
  await sleep(300);
  const before = await activeTitle(b);
  await b.eval(`${T}.handler_.testCommand(33002)`);  // IDC_RELOAD
  return until(async () => { const t = await activeTitle(b); return t !== before && /#\d+$/.test(t) ? t : null; });
}
const activeTitle = (b) => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title`);
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { if ((last = await fn())) return last; await sleep(150); }
  return last;
}
// Runs `expr` in the page whose address ends with `suffix`, as a click would (a user gesture).
async function inPage(b, suffix, expr) {
  const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.endsWith(suffix));
  assert.ok(t, `a page at ${suffix}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  await new Promise((r) => { ws.onmessage = r; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, userGesture: true } })); });
  ws.close();
}

async function workSpace(b) {
  const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
  const { spaceId } = await b.eval(`${T}.handler_.createSpace('Client', '', '', '')`);
  await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
  await b.waitFor(`${T}.state_.spaces.find((s) => s.name === 'Client')?.profileId === ${JSON.stringify(profileId)}`);
  return { profileId, spaceId };
}

test('Profiles: a space in its own profile has its own cookies, in the same window', async () => {
  const { server, url } = await cookieSite();
  const b = await launch([url('/main')], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const first = await b.eval(`${T}.state_.spaces[0].id`);

    // Settings > Profiles > New Profile "Work".
    await b.eval(`app.$.settings.show(${T}.state_.spaces, 'profiles')`);
    await b.waitFor(`!!${ST}.getElementById('newProfile')`);
    await b.click(`${ST}.getElementById('newProfile')`);
    await b.waitFor(`!!${ST}.getElementById('profileName')`);
    await b.eval(`(() => { const i = ${ST}.getElementById('profileName'); i.value = 'Work'; i.dispatchEvent(new Event('input')); return true; })()`);
    await b.click(`${ST}.getElementById('profileSave')`);
    await b.waitFor(`[...${ST}.querySelectorAll('.row.profile .row-label')].map((e) => e.textContent).join() === 'Default,Work'`);
    const work = (await b.eval(`${T}.handler_.getState().then(({state}) => state)`)).profiles.find((p) => p.name === 'Work');
    assert.match(work.id, /^Meridian Profile \d+$/);
    await b.eval('app.$.settings.open = false');

    // A space "Client" picks Work in its menu; switching to it stays in this window.
    const { spaceId } = await b.eval(`${T}.handler_.createSpace('Client', '', '', '')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(work.id)})`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
    assert.equal(await b.eval(`${T}.state_.profileId`), work.id, 'the window shows Work');

    // Its own cookie jar: the site doesn't know it.
    await b.eval(`${T}.openUrl(${JSON.stringify(url('/show'))})`);
    assert.match(await until(async () => (await titles(b)).find((t) => t.includes('/show #'))), /^none \/show/);
    assert.ok(!(await titles(b)).some((t) => t.includes('/main')), 'the first space’s tab isn’t listed here');

    // A new-tab link and a ⌘-click from it open in Work too, in this space and window.
    await inPage(b, '/show', 'document.getElementById("blank").click()');
    assert.match(await until(async () => (await titles(b)).find((t) => t.includes('/child #'))), /^none \/child/);
    await inPage(b, '/show', 'document.getElementById("link").dispatchEvent(new MouseEvent("click", { metaKey: true, bubbles: true, cancelable: true }))');
    assert.match(await until(async () => (await titles(b)).find((t) => t.includes('/meta #'))), /^none \/meta/);

    // Back and forth: the same window, each space with its tabs and cookies.
    for (let i = 0; i < 3; i++) {
      await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(first)})`);
      await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(first)}`);
      assert.ok((await until(() => titles(b))).some((t) => t.startsWith('none /main')));
      await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
      await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
      assert.ok((await titles(b)).some((t) => t.includes('/show')));
    }
    // Reloaded (⌘R) it still has Work's cookies; the main space's tab has the main ones.
    assert.match(await reload(b, '/show'), /^none \/show/);
    assert.equal(await windowCount(b), 1, 'one window all along');

    // The profile can't go while a space uses it.
    assert.equal((await b.eval(`${T}.handler_.deleteProfile(${JSON.stringify(work.id)})`)).deleted, false);
  } finally {
    await b.close();
    server.close();
  }
});

test('Profiles: favorites per profile; after a restart and ⇧⌘T the tabs are back in their profile', async () => {
  const { server, url } = await cookieSite();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch([url('/main')], { profile, args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const first = await b.eval(`${T}.state_.spaces[0].id`);
    const { spaceId } = await workSpace(b);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
    await b.eval(`${T}.openUrl(${JSON.stringify(url('/work'))})`);
    assert.match(await until(async () => (await titles(b)).find((t) => t.includes('/work #'))), /^none \/work/);
    await b.eval(`${T}.openUrl('data:text/html,<title>Jira</title>')`);
    await until(async () => (await titles(b)).includes('Jira'));

    // A favorite made in Work's space is Work's only.
    const jira = await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Jira').tab.id`);
    await b.eval(`${T}.handler_.pinTab(${JSON.stringify(jira)}, {container: 'favorites', parentId: '', index: -1}, 'Jira')`);
    await b.waitFor(`${T}.state_.favorites.map((f) => f.title).join() === 'Jira'`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(first)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(first)} && ${T}.state_.favorites.length === 0`);

    // Quit with Work's space in front, then start again: one window, the tabs in their profiles.
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
    await sleep(1500);  // the session is saved
    await b.quit();
    b = await launch([], { profile, args: ['--meridian-test-keys'] });
    await b.waitFor(`${T}.state_?.activeSpaceId === ${JSON.stringify(spaceId)}`, 15000);
    await sleep(1000);
    assert.equal(await windowCount(b), 1, 'one window after the restart');
    const targets = await (await fetch(`${b.base}/json/list`)).json();
    assert.ok(!targets.some((t) => t.url.startsWith('chrome://profile-picker')), 'no profile picker');
    assert.equal(await b.eval(`${T}.state_.favorites.map((f) => f.title).join()`), 'Jira');
    assert.match(await reload(b, '/work'), /^who=work \/work/, 'the restored tab has Work’s cookie');

    // Closed and brought back with ⇧⌘T: still Work's.
    await b.eval(`${T}.handler_.testCommand(34015)`);  // IDC_CLOSE_TAB
    await until(async () => !(await titles(b)).some((t) => t.includes('/work')));
    await b.eval(`${T}.handler_.testCommand(34028)`);  // IDC_RESTORE_TAB
    assert.ok(await until(async () => (await titles(b)).some((t) => t.includes('/work'))), 'back in its space');
    assert.match(await reload(b, '/work'), /^who=work \/work/, 'the reopened tab has Work’s cookie');

    // The main profile's space still has its own.
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(first)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(first)}`);
    assert.match(await reload(b, '/main'), /^who=main \/main/);
    assert.equal(await windowCount(b), 1);
  } finally {
    await b.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Profiles: a window opened later stays its own (only the old model’s windows are gathered)', async () => {
  const b = await launch(['data:text/html,<title>A</title>']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const v = await (await fetch(`${b.base}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    await new Promise((r) => { ws.onmessage = r; ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'data:text/html,<title>B</title>', newWindow: true } })); });
    ws.close();
    assert.equal(await until(async () => (await windowCount(b)) === 2 ? 2 : 0), 2, 'a second window');
    await sleep(2000);
    assert.equal(await windowCount(b), 2, 'it stays');
    assert.equal(await b.eval('1 + 1'), 2, 'the first one too');
  } finally { await b.close(); }
});

// Switching spaces back and forth across profiles (⌃1-3, the keys people use) never opens or
// moves a window: one window, in front, on the Space on screen, showing the space.
async function switchAcrossProfiles(fullscreen) {
  const b = await launch(['about:blank'], { args: ['--meridian-test-keys'] });
  const CTRL = 1 << 18;
  const KEYS = { 1: [18, '1'], 2: [19, '2'], 3: [20, '3'] };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await workSpace(b);
    await b.eval(`${T}.handler_.createSpace('Home', '', '#7cc4a4', '')`);
    await b.waitFor(`${T}.state_.spaces.length === 3`);
    await b.eval(`${T}.handler_.activateSpace(${T}.state_.spaces[0].id)`);
    const first = await b.eval(`${T}.state_.spaces[0].name`);
    if (fullscreen) {
      await b.eval(`${T}.handler_.testCommand(34030)`);  // IDC_FULLSCREEN: macOS's own Space
      await sleep(2500);
    }
    for (const [key, space] of [[2, 'Client'], [3, 'Home'], [2, 'Client'], [1, first], [2, 'Client'], [1, first]]) {
      await b.eval(`${T}.handler_.testKeyPress(${KEYS[key][0]}, '${KEYS[key][1]}', ${CTRL})`);
      await b.waitFor(`${T}.activeSpace()?.name === ${JSON.stringify(space)}`);
      await sleep(400);  // anything that would open or move late
      const st = await b.eval(`${T}.handler_.testWindowState()`);
      assert.equal(await windowCount(b), 1, `one window (${space})`);
      assert.ok(st.visible && st.onActiveSpace, `the window is on screen (${space}): ${JSON.stringify(st)}`);
    }
  } finally { await b.close(); }
}

test('Profiles: ⌃1–3 across profiles stay in the one window', () => switchAcrossProfiles(false));

test('Profiles: the same in macOS full screen', () => switchAcrossProfiles(true));
