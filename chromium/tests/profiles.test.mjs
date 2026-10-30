// Spaces with their own profile: Settings > Profiles makes one, a space's menu picks it, and switching
// to that space shows that profile's window in place of the current one (cookies kept apart); switching
// back brings the first window back; closing the visible window closes the hidden one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ST = 'app.$.settings.shadowRoot';

test('Profiles: a space in its own profile has its own cookies, in a window that takes the frame', async () => {
  const server = http.createServer((req, res) => {
    const headers = { 'content-type': 'text/html' };
    if (req.url === '/set') headers['set-cookie'] = 'who=main; Path=/; Max-Age=3600';
    res.writeHead(200, headers);
    res.end(`<title>cookie: ${req.headers.cookie || 'none'}</title>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch([url('/set')], { profile });
  const state = (w = b) => w.eval('app.$.tabstrip.handler_.getState().then(({state}) => state)');
  const titles = (w = b) => w.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);
  let others = [];
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(url('/show'))})`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'cookie: who=main')`);

    // Settings > Profiles > New Profile "Work".
    await b.eval(`app.$.settings.show(app.$.tabstrip.state_.spaces, 'profiles')`);
    await b.waitFor(`!!${ST}.getElementById('newProfile')`);
    await b.click(`${ST}.getElementById('newProfile')`);
    await b.waitFor(`!!${ST}.getElementById('profileName')`);
    await b.eval(`(() => { const i = ${ST}.getElementById('profileName'); i.value = 'Work'; i.dispatchEvent(new Event('input')); return true; })()`);
    await b.click(`${ST}.getElementById('profileSave')`);
    await b.waitFor(`[...${ST}.querySelectorAll('.row.profile .row-label')].map((e) => e.textContent).join() === 'Default,Work'`);
    const work = (await state()).profiles.find((p) => p.name === 'Work');
    assert.match(work.id, /^Meridian Profile \d+$/);
    await b.eval('app.$.settings.open = false');

    // A space "Client" picks Work in its menu.
    const { spaceId } = await b.eval(`app.$.tabstrip.handler_.createSpace('Client', '', '', '')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2`);
    await b.eval(`app.$.tabstrip.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(work.id)})`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.find((s) => s.name === 'Client').profileId === ${JSON.stringify(work.id)}`);

    // Switching to it: Work's window takes the frame; the first one hides.
    await b.eval(`app.$.tabstrip.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    let w;
    for (let i = 0; i < 60 && !w; i++) {
      for (const o of others) o.close();
      others = await b.otherWindows();
      for (const o of others) {
        try { if ((await state(o)).profileId === work.id) w = o; } catch {}
      }
      if (!w) await sleep(250);
    }
    assert.ok(w, 'a window of the Work profile');
    for (let i = 0; i < 40 && (await b.eval('document.visibilityState')) !== 'hidden'; i++) await sleep(100);
    assert.equal(await b.eval('document.visibilityState'), 'hidden', 'the first window is hidden');
    assert.equal(await w.eval('document.visibilityState'), 'visible');
    assert.equal((await state(w)).activeSpaceId, spaceId);

    // Its own cookie jar: the site doesn't know it.
    await w.eval(`app.$.tabstrip.openUrl(${JSON.stringify(url('/show'))})`);
    for (let i = 0; i < 50 && !(await titles(w)).includes('cookie: none'); i++) await sleep(100);
    assert.ok((await titles(w)).includes('cookie: none'), JSON.stringify(await titles(w)));

    // Back to the first space: the first window returns with its tabs.
    const first = (await state(w)).spaces.find((s) => s.name !== 'Client').id;
    await w.eval(`app.$.tabstrip.handler_.activateSpace(${JSON.stringify(first)})`);
    for (let i = 0; i < 40 && (await b.eval('document.visibilityState')) !== 'visible'; i++) await sleep(100);
    assert.equal(await b.eval('document.visibilityState'), 'visible');
    assert.ok((await titles()).includes('cookie: who=main'));
    for (let i = 0; i < 40 && (await w.eval('document.visibilityState')) !== 'hidden'; i++) await sleep(100);
    assert.equal(await w.eval('document.visibilityState'), 'hidden');

    // The profile can't go while a space uses it.
    assert.equal((await b.eval(`app.$.tabstrip.handler_.deleteProfile(${JSON.stringify(work.id)})`)).deleted, false);

    // Closing the visible window closes the hidden one of its frame.
    for (const o of others) o.close();
    others = [];
    await b.eval(`(() => { app.$.tabstrip.tabStripService_.closeNodes(app.$.tabstrip.state_.tabs.map((t) => t.tabId)); return true; })()`);
    let left = 2;
    for (let i = 0; i < 50 && left; i++) {
      left = (await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.startsWith('chrome://webui-browser')).length;
      if (left) await sleep(200);
    }
    assert.equal(left, 0, 'both windows of the frame are gone');
  } finally {
    for (const o of others) o.close();
    await b.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('Profiles: favorites per profile; after a restart the windows are one frame again, no profile picker', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['data:text/html,<title>Main tab</title>'], { profile });
  const state = (w) => w.eval('app.$.tabstrip.handler_.getState().then(({state}) => state)');
  const windows = async () => {
    const list = [b, ...(await b.otherWindows())];
    const out = [];
    for (const w of list) {
      try { out.push({ w, s: await state(w), visible: (await w.eval('document.visibilityState')) === 'visible' }); } catch {}
    }
    return out;
  };
  let work;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { profileId } = await b.eval(`app.$.tabstrip.handler_.addProfile('Work')`);
    work = profileId;
    const { spaceId } = await b.eval(`app.$.tabstrip.handler_.createSpace('Client', '', '', '')`);
    await b.eval(`app.$.tabstrip.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(work)})`);
    await b.eval(`app.$.tabstrip.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    let w;
    for (let i = 0; i < 60 && !w; i++) {
      w = (await windows()).find((x) => x.s.profileId === work && x.visible)?.w;
      if (!w) await sleep(250);
    }
    assert.ok(w);
    // A favorite in Work's window is Work's only.
    await w.eval(`app.$.tabstrip.openUrl('data:text/html,<title>Jira</title>')`);
    let tab;
    for (let i = 0; i < 50 && !tab; i++) {
      tab = (await state(w)).tabs.find((t) => t.spaceId === spaceId && !t.itemId);
      if (!tab) await sleep(100);
    }
    await w.eval(`(() => { const t = app.$.tabstrip.state_.tabs.find((t) => t.spaceId === ${JSON.stringify(spaceId)}); app.$.tabstrip.handler_.pinTab(t.tabId, {container: 'favorites', parentId: '', index: -1}, 'Jira'); return true; })()`);
    for (let i = 0; i < 50 && !(await state(w)).favorites.length; i++) await sleep(100);
    assert.deepEqual((await state(w)).favorites.map((f) => f.title), ['Jira']);
    assert.deepEqual((await state(b)).favorites.map((f) => f.title), []);

    // Quit with Work in front, then start again.
    await b.quit();
    b = await launch([], { profile });
    let all = [];
    for (let i = 0; i < 60; i++) {
      all = await windows();
      if (all.length === 2 && all.filter((x) => x.visible).length === 1) break;
      await sleep(250);
    }
    assert.equal(all.length, 2, 'both profiles’ windows came back');
    const shown = all.filter((x) => x.visible);
    assert.equal(shown.length, 1, 'one frame: one visible window');
    assert.equal(shown[0].s.profileId, work);
    assert.deepEqual(shown[0].s.favorites.map((f) => f.title), ['Jira']);
    const targets = await (await fetch(`${b.base}/json/list`)).json();
    assert.ok(!targets.some((t) => t.url.startsWith('chrome://profile-picker')), 'no profile picker');
  } finally {
    await b.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// Switching spaces back and forth across profiles (⌃1-3, the keys people use) swaps the two
// windows in place: never a third window, and the one in front is the one with the space.
async function switchAcrossProfiles(fullscreen) {
  const b = await launch(['about:blank'], { args: ['--meridian-test-keys'] });
  const T = 'app.$.tabstrip';
  const CTRL = 1 << 18;
  const KEYS = { 1: [18, '1'], 2: [19, '2'], 3: [20, '3'] };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
    const { spaceId } = await b.eval(`${T}.handler_.createSpace('Client', '', '#e08a8a', '')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
    await b.eval(`${T}.handler_.createSpace('Home', '', '#7cc4a4', '')`);
    await b.waitFor(`${T}.state_.spaces.length === 3`);
    await b.eval(`${T}.handler_.activateSpace(${T}.state_.spaces[0].id)`);
    const first = await b.eval(`${T}.state_.spaces[0].name`);
    if (fullscreen) {
      // macOS full screen (its own Space), where hiding a window closes the Space.
      await b.eval(`${T}.handler_.testCommand(34030)`);  // IDC_FULLSCREEN
      await sleep(2500);
    }

    // Every window: whether it is shown, on the Space on screen, its place front to back (from the
    // browser itself: a page's visibility can't tell a window on another Space), and its space.
    const windows = async () => {
      const all = [{ eval: (e) => b.eval(e) }, ...(await b.otherWindows())];
      const out = [];
      for (const w of all) {
        try {
          const st = await w.eval(`${T}.handler_.testWindowState()`);
          out.push({ w, ...st, space: await w.eval(`${T}.activeSpace()?.name`), profile: await w.eval(`${T}.state_.profileId`) || 'main' });
        } catch {}
      }
      return out;
    };
    const frontOf = (ws) => ws.filter((x) => x.visible && x.onActiveSpace && x.order >= 0)
        .sort((a, c) => a.order - c.order)[0];
    const press = async (n) => {
      const front = frontOf(await windows());
      await front.w.eval(`${T}.handler_.testKeyPress(${KEYS[n][0]}, '${KEYS[n][1]}', ${CTRL})`);
    };
    const settle = async (space) => {
      let ws = [];
      for (let i = 0; i < 60 && frontOf(ws = await windows())?.space !== space; i++) await sleep(150);
      await sleep(600);  // anything that would open or move late
      ws = await windows();
      const seen = JSON.stringify(ws.map(({ visible, onActiveSpace, order, space: sp, profile }) => ({ profile, visible, onActiveSpace, order, sp })));
      assert.ok(ws.length <= 2, `at most a window per profile: ${seen}`);
      // The bug: the other profile's window showing on the Space it was made on (the desktop), not
      // over the one in front. Every shown window is on the Space on screen.
      assert.ok(ws.every((x) => !x.visible || x.onActiveSpace), `a window on another Space: ${seen}`);
      assert.equal(frontOf(ws)?.space, space, seen);
    };

    for (const [key, space] of [[2, 'Client'], [3, 'Home'], [2, 'Client'], [1, first], [2, 'Client'], [1, first]]) {
      await press(key);
      await settle(space);
    }
  } finally { await b.close(); }
}

test('Profiles: ⌃1–3 across profiles swap the two windows in place, never opening another', () => switchAcrossProfiles(false));

test('Profiles: the same in macOS full screen', () => switchAcrossProfiles(true));
