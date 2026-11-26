// Arc: the space's header (its name and chevron, under the favorites) folds the whole pinned section
// away and back; Today stays. Each space keeps it across restarts, and the active pinned tab stays
// under the folded header as one row. And the site controls: they close by themselves only with the
// floating (peek) sidebar, not when the pointer leaves a sidebar that stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const T = 'app.$.tabstrip';
const HEADER = `${SB}.querySelector('#spacePage > .space-header')`;
const collapsed = `${SB}.getElementById('pinned').classList.contains('collapsed')`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the space header folds the pinned section away and back (click, keys), the active pinned tab stays as one row, and it survives a restart', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}/${p}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-collapse-'));
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const tabId = (b, title) => b.eval(`[...${T}.tabs_.values()].find((t) => t.title === ${JSON.stringify(title)}).id`);
  const titles = async (b) => (await b.pinned()).map((p) => p.title);
  try {
    let b = await launch(['A', 'B', 'C', 'Today'].map(url), { profile });
    let spaceId;
    try {
      for (const t of ['A', 'B', 'C', 'Today']) await b.waitFor(`!!${row(t)}`, 15000);
      spaceId = await b.eval(`${T}.state_.activeSpaceId`);
      const at = (parentId) => `{container: ${JSON.stringify(spaceId)}, parentId: ${JSON.stringify(parentId)}, index: -1}`;
      // A and B pinned, C inside a folder "Box".
      for (const t of ['A', 'B']) await b.eval(`${T}.handler_.pinTab(${JSON.stringify(await tabId(b, t))}, ${at('')}, '')`);
      const box = await b.eval(`${T}.handler_.addFolder(${at('')}, 'Box').then((r) => r.itemId)`);
      await b.waitFor(`${T}.state_.spaces.find((s) => s.id === ${JSON.stringify(spaceId)}).pinned.length === 3`);
      await b.eval(`${T}.handler_.pinTab(${JSON.stringify(await tabId(b, 'C'))}, ${at(box)}, '')`);
      await b.waitFor(`${T}.state_.spaces.find((s) => s.id === ${JSON.stringify(spaceId)}).pinned.find((i) => i.isFolder)?.children.length === 1`);
      // The folder open, so all of them show.
      await b.eval(`(() => { const f = ${T}.state_.spaces.find((s) => s.id === ${JSON.stringify(spaceId)}).pinned.find((i) => i.isFolder); if (!f.open) ${T}.handler_.setFolderOpen(f.id, true); return true; })()`);
      await b.waitFor(`${T}.state_.spaces.find((s) => s.id === ${JSON.stringify(spaceId)}).pinned.find((i) => i.isFolder).open`);
      await b.click(row('Today'));
      await b.waitFor(`${row('Today')}?.tab.isActive`);
      const shown = `JSON.stringify((() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll(':scope > meridian-item')) { out.push(el.item.title); const kids = el.shadowRoot.querySelector('.children'); if (kids) walk(kids); } }; walk(${SB}.getElementById('pinned')); return out; })())`;
      await b.waitFor(`${JSON.stringify(JSON.stringify(['A', 'B', 'Box', 'C']))} === ${shown}`, 10000, shown);
      assert.equal(await b.eval(`${HEADER}.getAttribute('aria-expanded')`), 'true');

      // A click on the name: the pinned section goes, the chevron turns, Today stays.
      await b.click(`${HEADER}.querySelector('.space-name')`);
      await b.waitFor(collapsed);
      assert.deepEqual(await titles(b), []);
      assert.equal(await b.eval(`${HEADER}.getAttribute('aria-expanded')`), 'false');
      assert.equal(await b.eval(`${HEADER}.classList.contains('collapsed') && getComputedStyle(${HEADER}.querySelector('.space-chevron')).transform !== 'none'`), true);
      assert.deepEqual((await b.tabs()).map((t) => t.title), ['Today']);

      // The active pinned tab, even inside the folder, stays under the header as one row.
      await b.eval(`${T}.activateTab(${JSON.stringify(await tabId(b, 'C'))})`);
      await b.waitFor(`(() => { const items = [...${SB}.getElementById('pinned').querySelectorAll(':scope > meridian-item')]; return items.length === 1 && items[0].item.title === 'C' && !!items[0].shadowRoot.querySelector('.row.pinned.active'); })()`, 5000);
      assert.equal((await b.pinned())[0].depth, 0);
      // It goes with it once another tab is active.
      await b.click(row('Today'));
      await b.waitFor(`${SB}.getElementById('pinned').querySelectorAll('meridian-item').length === 0`);
      await b.eval(`${T}.activateTab(${JSON.stringify(await tabId(b, 'A'))})`);
      await b.waitFor(`(() => { const items = [...${SB}.getElementById('pinned').querySelectorAll(':scope > meridian-item')]; return items.length === 1 && items[0].item.title === 'A'; })()`, 5000);
      // In sight in the sidebar, as every active tab (the harness's invariants look too).
      assert.ok(await b.eval(`(() => { const items = [...${SB}.getElementById('pinned').querySelectorAll('meridian-item')]; const r = items[0].shadowRoot.querySelector('.row').getBoundingClientRect(); const v = ${SB}.getElementById('spacePage').getBoundingClientRect(); return r.height > 0 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1; })()`));

      // From the keyboard: Enter on the focused header opens it, Space folds it again.
      await b.eval(`(${HEADER}.focus(), true)`);
      await b.key('Enter', 'Enter', 13);
      await b.waitFor(`!${collapsed}`);
      assert.deepEqual(await titles(b), ['A', 'B', 'Box', 'C']);
      await b.eval(`(${HEADER}.focus(), true)`);
      await b.key(' ', 'Space', 32);
      await b.waitFor(collapsed);
      // A second click opens it; a third folds it, and it is kept that way.
      await b.click(`${HEADER}.querySelector('.space-name')`);
      await b.waitFor(`!${collapsed}`);
      await b.click(`${HEADER}.querySelector('.space-chevron')`);
      await b.waitFor(collapsed);
      await b.click(row('Today'));
      await b.waitFor(`${SB}.getElementById('pinned').querySelectorAll('meridian-item').length === 0`);
      await b.quit();
    } catch (e) { await b.close(); throw e; }

    // After a restart the space's pinned section is still folded; the header opens it.
    b = await launch([], { profile });
    try {
      await b.waitFor(`${T}.state_?.activeSpaceId === ${JSON.stringify(spaceId)} && !!${HEADER}`, 15000);
      await b.waitFor(collapsed, 5000);
      assert.equal(await b.eval(`${HEADER}.getAttribute('aria-expanded')`), 'false');
      assert.ok((await b.pinned()).length <= 1, 'at most the active pinned tab shows');
      await b.click(`${HEADER}.querySelector('.space-name')`);
      await b.waitFor(`!${collapsed}`);
      await b.waitFor(`${SB}.getElementById('pinned').querySelectorAll(':scope > meridian-item').length === 3`);
      assert.deepEqual((await titles(b)).slice(0, 3), ['A', 'B', 'Box']);
    } finally { await b.close(); }
  } finally { server.closeAllConnections(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('each space folds its own pinned section; the space menu folds it too', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`!!${HEADER} && ${T}.state_?.spaces.length >= 1`);
    const first = await b.eval(`${T}.state_.activeSpaceId`);
    await b.menu(HEADER, 'Collapse Pinned Tabs');
    await b.waitFor(collapsed);
    // Another space: open.
    const { spaceId: other } = await b.eval(`${T}.handler_.createSpace('Second', '', '', '')`);
    await b.eval(`(${T}.handler_.activateSpace(${JSON.stringify(other)}), true)`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(other)} && ${HEADER}?.dataset.space === ${JSON.stringify(other)}`);
    await b.waitFor(`!${collapsed}`);
    // Back: still folded; the menu opens it.
    await b.eval(`(${T}.handler_.activateSpace(${JSON.stringify(first)}), true)`);
    await b.waitFor(`${HEADER}?.dataset.space === ${JSON.stringify(first)}`);
    await b.waitFor(collapsed);
    await b.menu(HEADER, 'Expand Pinned Tabs');
    await b.waitFor(`!${collapsed}`);
  } finally { await b.close(); }
});

test('site controls stay open when the pointer leaves a sidebar that stays; with the floating sidebar they go with it', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Shop')]);
  try {
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host').textContent === '127.0.0.1'`);
    await b.click(`app.$.locationIconButton`);
    await b.waitFor(`app.$.siteControl.open`);
    // The pointer goes over to the page (a real move, and the leave the sidebar hears), and stays there.
    const corner = await b.eval(`(() => { const r = app.$.contentRegion.getBoundingClientRect(); return { x: r.right - 30, y: r.bottom - 30 }; })()`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.x, y: corner.y, button: 'none' });
    await b.eval(`(app.onSidebarMouseleave_(), app.onPeekShieldMouseenter_(), true)`);
    await sleep(1200);
    assert.equal(await b.eval(`app.$.siteControl.open`), true, 'still open over the page');
    assert.equal(await b.eval(`app.sidebarHidden_ || app.sidebarPeek_`), false);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.siteControl.open`);

    // The floating sidebar (hidden with ⌘S, out from the left edge): the controls open in it, and
    // when the pointer leaves, both go.
    if (process.platform === 'win32') {
      // Windows: the button is in the top bar, not in the sidebar, and the controls belong to it.
      // The sidebar hidden (not floating): they open in sight and take the pointer, over the page
      // (they used to open unseen behind it, inside the hidden sidebar); a floating sidebar that
      // goes doesn't take them.
      await b.eval(`(() => { app.onMeridianToggleSidebar_(); app.$.tabstrip.pointerOverWindowControls = async () => false; return true; })()`);
      await b.waitFor(`app.sidebarHidden_ && !app.sidebarPeek_`);
      await sleep(400);
      await b.click(`app.$.locationIconButton`);
      await b.waitFor(`app.$.siteControl.open`);
      await sleep(600);
      assert.equal(await b.eval(`(() => { const r = app.$.siteControl.shadowRoot.querySelector('#boostRow, .boost-row').getBoundingClientRect(); const hit = app.shadowRoot.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === app.$.siteControl; })()`), true, 'on top of the page');
      await b.eval(`(app.onEdgeHotzoneMouseenter_(), true)`);
      await b.waitFor(`app.sidebarPeek_`);
      await b.eval(`(app.onSidebarMouseleave_(), true)`);
      await b.waitFor(`!app.sidebarPeek_`, 3000);
      await sleep(600);
      assert.equal(await b.eval(`app.$.siteControl.open`), true, 'the top bar’s controls stay');
      await b.key('Escape', 'Escape', 27);
      await b.waitFor(`!app.$.siteControl.open`);
    } else {
      await b.eval(`(() => { app.onMeridianToggleSidebar_(); app.onEdgeHotzoneMouseenter_(); app.$.tabstrip.pointerOverWindowControls = async () => false; return true; })()`);
      await b.waitFor(`app.sidebarHidden_ && app.sidebarPeek_`);
      await b.click(`app.$.locationIconButton`);
      await b.waitFor(`app.$.siteControl.open`);
      await b.eval(`(app.onSidebarMouseleave_(), true)`);
      await b.waitFor(`!app.$.siteControl.open && !app.sidebarPeek_`, 3000);
    }

    // Floating, left, then shown again (⌘S) before it went: the controls opened then stay.
    await b.eval(`(app.onEdgeHotzoneMouseenter_(), true)`);
    await b.waitFor(`app.sidebarPeek_`);
    await b.eval(`(() => { app.onSidebarMouseleave_(); app.onMeridianToggleSidebar_(); return true; })()`);
    await b.waitFor(`!app.sidebarHidden_ && !app.sidebarPeek_`);
    await b.click(`app.$.locationIconButton`);
    await b.waitFor(`app.$.siteControl.open`);
    await sleep(1000);
    assert.equal(await b.eval(`app.$.siteControl.open`), true, 'a pending close of the floating sidebar does not take them');
  } finally { await b.close(); await site.close(); }
});
