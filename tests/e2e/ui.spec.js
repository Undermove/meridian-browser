// Split view, Peek, find in page, zoom, copy URL, sidebar toggle + hover reveal, little window,
// focus after opening a tab, settings persistence and session restore across relaunch.
const {
  test, expect, press, snapshot, openTabDirect, waitTabLoaded, clickIntoActivePage, clickInTab, focusInfo, inTab,
  e2eLog, realMove, realClick,
} = require('../fixtures/meridian');
const S = require('../fixtures/state');

const visibleViews = (page) => page.evaluate(() => [...document.querySelectorAll('#views webview')].filter((w) => !w.classList.contains('hidden')).map((w) => w.dataset.tabId));

test.describe('split view', () => {
  test('split command → pick a tab in the command bar → two pages side by side; unsplit', async ({ page, server }) => {
    const left = await openTabDirect(page, server.url('/p/left'));
    const right = await openTabDirect(page, server.url('/p/right'));
    await page.evaluate((id) => activate(id), left);
    await page.evaluate(() => runCommand('split'));
    await expect(page.locator('#cmd-input')).toHaveAttribute('placeholder', /split/i);
    await page.keyboard.type('right');
    // pick the open tab (sub = its host), not the "Search Google" row
    const row = page.locator('#cmd-results .cmd-row').filter({ has: page.locator('.cmd-sub', { hasText: new URL(server.base).host }) }).first();
    await row.waitFor();
    await row.click();
    expect(await page.evaluate(() => space().split?.ids)).toEqual([left, right]);
    expect(new Set(await visibleViews(page))).toEqual(new Set([left, right]));
    await expect(page.locator('#split-handle')).toBeVisible();
    const boxes = await page.evaluate(([l, r]) => [l, r].map((id) => rt.views.get(id).getBoundingClientRect().toJSON()), [left, right]);
    expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].left);
    expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThan(10);

    // drag the divider
    const h = await page.locator('#split-handle').boundingBox();
    await page.mouse.move(h.x + h.width / 2, h.y + 100);
    await page.mouse.down();
    await page.mouse.move(h.x - 150, h.y + 100, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => space().split.ratio)).toBeLessThan(0.45);

    await page.evaluate(() => runCommand('unsplit'));
    expect(await page.evaluate(() => space().split)).toBeNull();
    expect((await visibleViews(page)).length).toBe(1);
  });

  test('Ctrl+Shift+= opens split mode, Ctrl+Shift+- closes it @shortcut', async ({ meridian, page, server }) => {
    const a = await openTabDirect(page, server.url('/p/a'));
    const b = await openTabDirect(page, server.url('/p/b'));
    await page.evaluate(([a, b]) => { space().split = { ids: [a, b], ratio: 0.5 }; render(); }, [a, b]);
    await clickIntoActivePage(page);
    await press(meridian, 'Control+Shift+-');
    await expect.poll(() => page.evaluate(() => space().split)).toBeNull();
    await clickIntoActivePage(page);
    await press(meridian, 'Control+Shift+=');
    await expect(page.locator('#cmdbar-overlay')).toBeVisible();
  });

  test('clicking into the other split pane makes it the active tab', async ({ page, server }) => {
    const a = await openTabDirect(page, server.url('/p/a'));
    const b = await openTabDirect(page, server.url('/p/b'));
    await page.evaluate(([a, b]) => { space().split = { ids: [a, b], ratio: 0.5 }; activate(b); }, [a, b]);
    await clickInTab(page, b, '#content');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(b);
    await clickInTab(page, a, '#content');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(a);
    await expect(page.locator(`#views webview.focused[data-tab-id="${a}"]`)).toHaveCount(1);
  });
});

test.describe('peek', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const pin = S.pinnedTab(server.url('/links'));
      return S.seedState({ spaces: [S.space('Main', { pinned: [pin], activeTabId: pin.id })] });
    })()),
  });

  test('a link from a pinned tab to another site opens in Peek; Esc closes; expand turns it into a tab', async ({ meridian, page, server }) => {
    const pin = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, pin, server.url('/links'));
    await clickInTab(page, pin, '#ext-blank');
    await expect(page.locator('#peek')).toBeVisible();
    await expect(page.locator('#peek .peek-host')).toHaveText(new URL(server.other).host);
    expect(await page.evaluate(() => space().today.length)).toBe(0);
    // peek gets focus; Esc inside the peeked page closes it
    await page.waitForFunction(() => { try { return rt.peek && rt.peek.wv.getURL().includes('/p/peeked') && !rt.peek.wv.isLoading(); } catch { return false; } });
    await page.evaluate(() => rt.peek.wv.focus());
    const peekWc = await page.evaluate(() => rt.peek.wv.getWebContentsId());
    await press(meridian, 'Escape', { target: peekWc }); // a real key in the peeked page → before-input-event → webview:escape
    await expect(page.locator('#peek')).toBeHidden();

    await clickInTab(page, pin, '#ext-blank');
    await expect(page.locator('#peek')).toBeVisible();
    await page.locator('#peek-expand').click();
    await expect(page.locator('#peek')).toBeHidden();
    const s = await snapshot(page);
    expect(s.todayCount).toBe(1);
    expect(s.activeUrl).toContain('/p/peeked');
  });

  test('a same-site target=_blank link from a pinned tab opens a normal tab, not Peek', async ({ page, server }) => {
    const pin = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, pin, server.url('/links'));
    await clickInTab(page, pin, '#same-blank');
    await expect.poll(() => page.evaluate(() => space().today.length)).toBe(1);
    await expect(page.locator('#peek')).toBeHidden();
  });

  test('Peek pages cannot reach the Meridian preload API', async ({ page, server }) => {
    const pin = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, pin, server.url('/links'));
    await clickInTab(page, pin, '#ext-blank');
    await page.waitForFunction(() => { try { return rt.peek && !rt.peek.wv.isLoading() && rt.peek.wv.getURL().includes('peeked'); } catch { return false; } });
    expect(await page.evaluate(() => rt.peek.wv.executeJavaScript('typeof window.meridian + "/" + typeof require + "/" + typeof process'))).toBe('undefined/undefined/undefined');
  });
});

test.describe('find in page', () => {
  test('find counts matches, Enter steps, Esc closes', async ({ page, server }) => {
    await openTabDirect(page, server.url('/find'));
    await page.evaluate(() => runCommand('find'));
    await expect(page.locator('#find-input')).toBeFocused();
    await page.keyboard.type('needle');
    await expect(page.locator('#find-count')).toHaveText('1/3');
    await page.keyboard.press('Enter');
    await expect(page.locator('#find-count')).toHaveText('2/3');
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#find-count')).toHaveText('1/3');
    await page.keyboard.press('Escape');
    await expect(page.locator('#findbar')).toBeHidden();
  });

  test('⌘F opens find with focus inside the page @shortcut', async ({ meridian, page, server }) => {
    await openTabDirect(page, server.url('/find'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+F');
    await expect(page.locator('#findbar')).toBeVisible();
    await expect(page.locator('#find-input')).toBeFocused();
  });

  // BUG: the find bar stays open with the old page's "1/3" after switching tabs; Enter then searches
  // the new page while the count still describes the old one (no find handling in activate(), app.js:261).
  test('find bar closes or follows when switching tabs', async ({ page, server }) => {
    test.fail(true, 'BUG: stale find bar after tab switch');
    const a = await openTabDirect(page, server.url('/find'));
    await openTabDirect(page, server.url('/p/other'));
    await page.evaluate((id) => activate(id), a);
    await page.evaluate(() => runCommand('find'));
    await page.keyboard.type('needle');
    await expect(page.locator('#find-count')).toHaveText('1/3');
    await page.evaluate(() => runCommand('tab-step', -1));
    // the count must not describe a different page than the one shown
    const r = await page.evaluate(() => ({ open: !document.querySelector('#findbar').hidden, count: document.querySelector('#find-count').textContent }));
    test.info().annotations.push({ type: 'find bar after tab switch', description: JSON.stringify(r) });
    expect(r.open && r.count === '1/3').toBe(false);
  });
});

test.describe('zoom / copy URL', () => {
  test('zoom in / out / reset (runCommand)', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/zoom'));
    await page.evaluate(() => runCommand('zoom', 1));
    expect(await page.evaluate((id) => rt.views.get(id).getZoomLevel(), id)).toBe(0.5);
    await page.evaluate(() => runCommand('zoom', 1));
    expect(await page.evaluate((id) => rt.views.get(id).getZoomLevel(), id)).toBe(1);
    await page.evaluate(() => runCommand('zoom', -1));
    expect(await page.evaluate((id) => rt.views.get(id).getZoomLevel(), id)).toBe(0.5);
    await page.evaluate(() => runCommand('zoom', 0));
    expect(await page.evaluate((id) => rt.views.get(id).getZoomLevel(), id)).toBe(0);
  });

  test('⌘= / ⌘0 zoom with focus inside the page @shortcut', async ({ meridian, page, server }) => {
    const id = await openTabDirect(page, server.url('/p/zoom'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+=');
    await expect.poll(() => page.evaluate((id) => rt.views.get(id).getZoomLevel(), id)).toBeGreaterThan(0);
    await press(meridian, 'Meta+0');
    await expect.poll(() => page.evaluate((id) => rt.views.get(id).getZoomLevel(), id)).toBe(0);
  });

  test('copy URL writes the current page URL to the clipboard', async ({ meridian, page, server }) => {
    await openTabDirect(page, server.url('/p/copyme'));
    await page.evaluate(() => runCommand('copy-url'));
    await expect.poll(async () => (await e2eLog(meridian.app)).clip.at(-1)).toBe(server.url('/p/copyme'));
    await expect(page.locator('.toast', { hasText: 'Copied URL' })).toBeVisible();
  });

  test('⇧⌘C copies the URL @shortcut', async ({ meridian, page, server }) => {
    await openTabDirect(page, server.url('/p/copyme'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+Shift+C');
    await expect.poll(async () => (await e2eLog(meridian.app)).clip.at(-1)).toBe(server.url('/p/copyme'));
  });
});

test.describe('sidebar', () => {
  test('toggle hides the sidebar; hovering the window edge reveals it', async ({ page, server }) => {
    await openTabDirect(page, server.url('/p/x'));
    await page.evaluate(() => runCommand('toggle-sidebar'));
    await expect(page.locator('body')).toHaveClass(/sidebar-hidden/);
    const before = await page.evaluate(() => rt.views.get(space().activeTabId).getBoundingClientRect().width);
    expect(before).toBeGreaterThan(1100); // page uses the freed space
    await page.waitForTimeout(400); // let the slide-out transition finish (the sliding sidebar covers the hot zone)
    await page.mouse.move(600, 400);
    await page.mouse.move(2, 400, { steps: 4 });
    await expect(page.locator('body')).toHaveClass(/sidebar-peek/);
    await page.mouse.move(150, 300, { steps: 3 });
    await page.waitForTimeout(250);
    await expect(page.locator('body')).toHaveClass(/sidebar-peek/); // still over the sidebar
    await page.evaluate(() => runCommand('toggle-sidebar'));
    await expect(page.locator('body')).not.toHaveClass(/sidebar-hidden/);
  });

  // PROBABLE BUG: the hover-revealed sidebar only hides on the sidebar's `mouseleave` (app.js:879). With
  // input routed like hardware input (Playwright CDP → Chromium's input router → <webview> guest), moving
  // from the sidebar straight into the page never produces mouseout/mouseleave in the UI document, so the
  // sidebar stays open over the page. (With webContents.sendInputEvent — which bypasses the router — leave
  // fires, so please confirm by hand: reveal the sidebar, then move quickly into the page.)
  test('the revealed sidebar hides when the pointer moves into the page', async ({ page, server }) => {
    test.fail(true, 'PROBABLE BUG: no mouseleave when moving from the sidebar into a <webview>');
    await openTabDirect(page, server.url('/p/x'));
    await page.evaluate(() => runCommand('toggle-sidebar'));
    await page.waitForTimeout(400);
    await page.mouse.move(600, 400);
    await page.mouse.move(2, 400, { steps: 4 });
    await expect(page.locator('body')).toHaveClass(/sidebar-peek/);
    await page.mouse.move(150, 300, { steps: 3 });
    await page.waitForTimeout(250);
    await page.mouse.move(900, 400, { steps: 6 });
    await expect(page.locator('body')).not.toHaveClass(/sidebar-peek/, { timeout: 2000 });
  });

  test('⌘S toggles the sidebar with focus inside the page @shortcut', async ({ meridian, page, server }) => {
    await openTabDirect(page, server.url('/p/x'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+S');
    await expect(page.locator('body')).toHaveClass(/sidebar-hidden/);
  });

  test('hover reveal also works when the sidebar is on the right', async ({ page }) => {
    await page.evaluate(() => { state.settings.sidebarRight = true; runCommand('toggle-sidebar'); });
    await page.waitForTimeout(400);
    const w = await page.evaluate(() => innerWidth);
    await page.mouse.move(w - 300, 400);
    await page.mouse.move(w - 2, 400, { steps: 4 });
    await expect(page.locator('body')).toHaveClass(/sidebar-peek/);
  });
});

test.describe('focus after opening a tab', () => {
  test('a new tab opened from the command bar receives keyboard focus', async ({ page, server }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type(server.url('/p/focusme'));
    await page.keyboard.press('Enter');
    const id = (await snapshot(page)).activeTabId;
    await waitTabLoaded(page, id);
    await expect.poll(() => focusInfo(page).then((f) => f.tabId), { timeout: 3000 }).toBe(id);
  });
});

test.describe('little window', () => {
  test('a link from another app opens a Little window; "Open in Meridian" moves it into the main window', async ({ meridian, page, server }) => {
    const url = server.url('/p/little');
    const winPromise = meridian.app.waitForEvent('window', (w) => w.url().includes('mini=1'));
    await meridian.app.evaluate(({ app }, u) => app.emit('open-url', { preventDefault() {} }, u), url);
    const mini = await winPromise;
    await mini.waitForFunction(() => typeof state !== 'undefined' && state && activeTab());
    await expect(mini.locator('.mini-host')).toHaveText(new URL(url).host);
    await expect(mini.locator('#sidebar')).toBeHidden();
    const closed = mini.waitForEvent('close');
    await mini.locator('#mini-promote').click();
    await closed;
    await expect.poll(() => snapshot(page).then((s) => s.activeUrl)).toBe(url);
  });

  test('⌘⌥N opens an empty Little window with the address field focused @shortcut', async ({ meridian, page }) => {
    const winPromise = meridian.app.waitForEvent('window', { predicate: (w) => w.url().includes('mini=1'), timeout: 5000 });
    await press(meridian, 'Meta+Alt+N');
    const mini = await winPromise;
    await expect(mini.locator('#cmdbar-overlay')).toBeVisible();
  });

  test('the Little window never writes state.json', async ({ meridian, page, server }) => {
    const fs = require('fs');
    const path = require('path');
    await page.evaluate(() => api.saveState(serialize()));
    const before = fs.readFileSync(path.join(meridian.userDataDir, 'state.json'), 'utf8');
    const winPromise = meridian.app.waitForEvent('window', (w) => w.url().includes('mini=1'));
    await meridian.app.evaluate(({ app }, u) => app.emit('open-url', { preventDefault() {} }, u), server.url('/p/little2'));
    const mini = await winPromise;
    await mini.waitForFunction(() => typeof state !== 'undefined' && state && activeTab());
    await mini.close();
    await page.waitForTimeout(800);
    expect(fs.readFileSync(path.join(meridian.userDataDir, 'state.json'), 'utf8')).toBe(before);
  });
});

test.describe('persistence', () => {
  test('settings changed in the Settings dialog survive a restart', async ({ meridian, page }) => {
    await page.evaluate(() => runCommand('settings'));
    await page.locator('#set-engine').selectOption('duckduckgo');
    await page.locator('#set-archive').selectOption('168');
    await page.locator('#set-right').check();
    await page.locator('#set-adblock').uncheck();
    await page.locator('[data-a="close"]').click();
    await expect(page.locator('body')).toHaveClass(/sidebar-right/);

    const { page: p2 } = await meridian.relaunch();
    const s = await p2.evaluate(() => state.settings);
    expect(s).toMatchObject({ searchEngine: 'duckduckgo', archiveAfterHours: 168, sidebarRight: true, adblock: false });
    await expect(p2.locator('body')).toHaveClass(/sidebar-right/);
    expect(await p2.evaluate(() => resolveInput('two words'))).toContain('duckduckgo.com');
  });

  test('settings changed right before quitting are not lost', async ({ meridian, page }) => {
    // the debounced save (600 ms) must be flushed on quit — beforeunload → saveStateSync
    await page.evaluate(() => { state.settings.searchEngine = 'kagi'; save(); });
    const { closeMeridian, launchMeridian } = require('../fixtures/meridian');
    await closeMeridian(meridian.app);
    const next = await launchMeridian({ userDataDir: meridian.userDataDir, keepState: true });
    Object.assign(meridian, next);
    expect(await next.page.evaluate(() => state.settings.searchEngine)).toBe('kagi');
  });

  test('session restore: spaces, pinned and Today tabs, active tab and space come back', async ({ meridian, page, server }) => {
    const t1 = await openTabDirect(page, server.url('/p/restore-1'));
    const t2 = await openTabDirect(page, server.url('/p/restore-2'));
    await page.evaluate((id) => togglePin(id), t1);
    await page.evaluate(() => { const sp = newSpace('Second', null, '#e08a9b', 'default'); state.spaces.push(sp); switchSpace(sp.id, 1); });
    const t3 = await openTabDirect(page, server.url('/p/restore-3'));
    await page.evaluate(() => runCommand('space-index', 0));
    await page.evaluate((id) => activate(id), t2);

    const { page: p2 } = await meridian.relaunch();
    const r = await p2.evaluate(() => ({
      spaces: state.spaces.map((s) => s.name), active: space().name, activeTab: space().activeTabId,
      pinned: space().pinned.map((n) => n.url), today: space().today.map((t) => t.url), second: state.spaces[1].today.map((t) => t.url),
    }));
    expect(r.spaces).toEqual(['Personal', 'Second']);
    expect(r.active).toBe('Personal');
    expect(r.activeTab).toBe(t2);
    expect(r.pinned).toEqual([server.url('/p/restore-1')]);
    expect(r.today).toEqual([server.url('/p/restore-2')]);
    expect(r.second).toEqual([server.url('/p/restore-3')]);
    await waitTabLoaded(p2, t2, server.url('/p/restore-2'));
    // only the active tab is loaded eagerly
    expect(await p2.evaluate(() => rt.views.size)).toBe(1);
    void t3;
  });
});
