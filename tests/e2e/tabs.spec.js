// Tabs: command bar, close/reopen, tab shortcuts, pin/unpin, favorites, folders, drag and drop,
// pinned-tab drift, Today auto-archive and archive search.
const {
  test, expect, press, snapshot, openTabDirect, waitTabLoaded, clickIntoActivePage, clickInTab, nextFrames,
} = require('../fixtures/meridian');
const S = require('../fixtures/state');

const todayUrls = (page) => page.evaluate(() => space().today.map((t) => t.url));
const pinnedTitles = (page) => page.evaluate(() => space().pinned.map((n) => n.type === 'folder' ? `[${n.title}]` : n.url));

test.describe('command bar → new tab', () => {
  test('clicking "New Tab" and typing a URL opens it in a new Today tab', async ({ page, server }) => {
    await page.locator('#space-pages .row.new-tab').click();
    await expect(page.locator('#cmdbar-overlay')).toBeVisible();
    await expect(page.locator('#cmd-input')).toBeFocused();
    await page.keyboard.type(server.url('/p/typed'));
    await expect(page.locator('#cmd-results .cmd-row.sel .cmd-sub')).toHaveText('Open URL');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cmdbar-overlay')).toBeHidden();
    const s = await snapshot(page);
    expect(s.todayCount).toBe(1);
    await waitTabLoaded(page, s.activeTabId, server.url('/p/typed'));
    await expect(page.locator('#urlbar .host')).toHaveText(new URL(server.base).host);
  });

  test('text that is not a URL becomes a web search', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('meridian e2e query');
    await expect(page.locator('#cmd-results .cmd-row.sel .cmd-sub')).toHaveText(/^Search /);
    await page.keyboard.press('Enter');
    const s = await snapshot(page);
    expect(s.activeUrl).toBe('https://www.google.com/search?q=meridian%20e2e%20query');
    await page.evaluate(() => closeTab()); // don't keep loading the real web
  });

  test('host:port and IP inputs are treated as http URLs, single words as searches', async ({ page }) => {
    const r = await page.evaluate(() => ({
      localhost: resolveInput('localhost:3000/x'),
      ip: resolveInput('127.0.0.1:8080'),
      domain: resolveInput('example.com/path'),
      word: resolveInput('kittens'),
      js: resolveInput('javascript:alert(1)'),
    }));
    expect(r.localhost).toBe('http://localhost:3000/x');
    expect(r.ip).toBe('http://127.0.0.1:8080');
    expect(r.domain).toBe('https://example.com/path');
    expect(r.word).toContain('search?q=kittens');
    expect(r.js).toContain('search?q=javascript'); // never executed as a URL
  });
});

test.describe('close / reopen', () => {
  test('closing a Today tab archives it; reopen brings it back (runCommand)', async ({ page, server }) => {
    const a = await openTabDirect(page, server.url('/p/a'));
    const b = await openTabDirect(page, server.url('/p/b'));
    await page.evaluate(() => runCommand('close-tab'));
    let s = await snapshot(page);
    expect(s.todayCount).toBe(1);
    expect(s.activeTabId).toBe(a);
    expect(await page.evaluate(() => state.archive[0].url)).toContain('/p/b');
    await page.evaluate(() => runCommand('reopen-tab'));
    s = await snapshot(page);
    expect(s.todayCount).toBe(2);
    expect(s.activeTabId).toBe(b);
    expect(await page.evaluate(() => state.archive.filter((x) => x.url.includes('/p/b')).length)).toBe(0);
  });

  test('⌘W closes and ⇧⌘T reopens with focus inside the page @shortcut', async ({ meridian, page, server }) => {
    const a = await openTabDirect(page, server.url('/p/a'));
    const b = await openTabDirect(page, server.url('/p/b'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+W');
    await expect.poll(() => snapshot(page).then((s) => s.todayCount)).toBe(1);
    expect((await snapshot(page)).activeTabId).toBe(a);
    await press(meridian, 'Meta+Shift+T');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(b);
  });

  test('closing the last tab shows the empty state and keeps the window usable', async ({ page, server }) => {
    await openTabDirect(page, server.url('/p/only'));
    await page.locator('#today .row.tab .row-btn.close').click();
    await expect(page.locator('#empty-state')).toBeVisible();
    expect((await snapshot(page)).activeTabId).toBeNull();
  });

  test('⌘W on a pinned tab unloads it instead of deleting it', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/pinme'));
    await page.evaluate(() => togglePin());
    await page.evaluate(() => runCommand('close-tab'));
    const r = await page.evaluate((id) => ({ pinned: !!locate(id) && locate(id).zone, loaded: rt.views.has(id) }), id);
    expect(r).toEqual({ pinned: 'pinned', loaded: false });
  });
});

test.describe('tab switching', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const sp = S.space('Main', {
        pinned: [S.pinnedTab(server.url('/p/pin1')), S.pinnedTab(server.url('/p/pin2'))],
        today: [S.tab(server.url('/p/t1')), S.tab(server.url('/p/t2')), S.tab(server.url('/p/t3'))],
      });
      sp.activeTabId = sp.today[0].id;
      return S.seedState({ spaces: [sp] });
    })()),
  });

  test('tab-index / tab-step commands follow sidebar order (runCommand)', async ({ page }) => {
    const order = await page.evaluate(() => visibleTabIds());
    await page.evaluate(() => runCommand('tab-index', 0));
    expect((await snapshot(page)).activeTabId).toBe(order[0]);
    await page.evaluate(() => runCommand('tab-index', 8));
    expect((await snapshot(page)).activeTabId).toBe(order.at(-1));
    await page.evaluate(() => runCommand('tab-step', 1));
    expect((await snapshot(page)).activeTabId).toBe(order[0]); // wraps
    await page.evaluate(() => runCommand('tab-step', -1));
    expect((await snapshot(page)).activeTabId).toBe(order.at(-1));
  });

  test('⌘1..9 select tabs by position @shortcut', async ({ meridian, page }) => {
    const order = await page.evaluate(() => visibleTabIds());
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+1');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(order[0]);
    await press(meridian, 'Meta+3');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(order[2]);
    await press(meridian, 'Meta+9');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(order.at(-1));
  });

  test('Ctrl+Tab / Ctrl+Shift+Tab step through tabs @shortcut', async ({ meridian, page }) => {
    const order = await page.evaluate(() => visibleTabIds());
    const start = order.indexOf((await snapshot(page)).activeTabId);
    await clickIntoActivePage(page);
    await press(meridian, 'Control+Tab');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(order[(start + 1) % order.length]);
    await press(meridian, 'Control+Shift+Tab');
    await expect.poll(() => snapshot(page).then((s) => s.activeTabId)).toBe(order[start]);
  });

  test('clicking a sidebar row activates the tab and focuses its page', async ({ page }) => {
    const order = await page.evaluate(() => visibleTabIds());
    await page.locator(`#space-pages .row.tab[data-id="${order[1]}"]`).click();
    expect((await snapshot(page)).activeTabId).toBe(order[1]);
    await expect.poll(() => page.evaluate(() => document.activeElement?.dataset?.tabId)).toBe(order[1]);
  });
});

test.describe('pin / favorites', () => {
  test('toggle-pin moves a Today tab to Pinned and back (runCommand)', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/pin'));
    await page.evaluate(() => runCommand('toggle-pin'));
    expect(await page.evaluate((id) => locate(id).zone, id)).toBe('pinned');
    await expect(page.locator(`#pinned .row.tab[data-id="${id}"]`)).toBeVisible();
    await page.evaluate(() => runCommand('toggle-pin'));
    expect(await page.evaluate((id) => locate(id).zone, id)).toBe('today');
    await expect(page.locator(`#today .row.tab[data-id="${id}"]`)).toBeVisible();
  });

  test('⌘D pins and unpins @shortcut', async ({ meridian, page, server }) => {
    const id = await openTabDirect(page, server.url('/p/pin'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+D');
    await expect.poll(() => page.evaluate((id) => locate(id).zone, id)).toBe('pinned');
    await press(meridian, 'Meta+D');
    await expect.poll(() => page.evaluate((id) => locate(id).zone, id)).toBe('today');
  });

  test('add to favorites shows it in the grid; clicking the favorite activates it', async ({ page, server }) => {
    const fav = await openTabDirect(page, server.url('/p/fav'));
    await page.evaluate(() => runCommand('favorite'));
    await openTabDirect(page, server.url('/p/other'));
    const favEl = page.locator(`#favorites .fav[data-id="${fav}"]`);
    await expect(favEl).toBeVisible();
    await favEl.click();
    expect((await snapshot(page)).activeTabId).toBe(fav);
    expect(await page.evaluate(() => favs().length)).toBe(1);
  });
});

test.describe('folders', () => {
  test('create (named via the prompt), move a tab in, collapse by click', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/inside'));
    await page.evaluate(() => runCommand('new-folder'));
    await expect(page.locator('#ask-input')).toBeFocused();
    await page.locator('#ask-input').fill('Research');
    await page.keyboard.press('Enter');
    await expect(page.locator('#pinned .row.folder .title')).toHaveText('Research');
    const folderId = await page.evaluate(() => space().pinned[0].id);
    await page.evaluate(([id, f]) => moveNode(id, 'pinned', { parentId: f, index: 0 }), [id, folderId]);
    await expect(page.locator(`.folder-wrap .children .row.tab[data-id="${id}"]`)).toBeVisible();
    await page.evaluate(() => activate(openTab('about:blank', { background: true }).id)); // make another tab active

    await page.locator('#pinned .row.folder').click();
    expect(await page.evaluate((f) => locate(f).node.collapsed, folderId)).toBe(true);
    await expect(page.locator(`.folder-wrap .children .row.tab[data-id="${id}"]`)).toBeHidden();
    expect(await page.evaluate((id) => visibleTabIds().includes(id), id)).toBe(false); // skipped by ⌘1..9 / Ctrl+Tab
    await page.locator('#pinned .row.folder').click();
    await expect(page.locator(`.folder-wrap .children .row.tab[data-id="${id}"]`)).toBeVisible();
  });

  test('rename a folder from its context menu', async ({ meridian, page }) => {
    await page.evaluate(() => { space().pinned.unshift({ id: 'f1', type: 'folder', title: 'F', collapsed: false, children: [] }); render(); });
    await require('../fixtures/meridian').chooseMenu(meridian.app, ['Rename…']);
    await page.locator('#pinned .row.folder').click({ button: 'right' });
    await page.locator('#ask-input').fill('Renamed');
    await page.keyboard.press('Enter');
    await expect(page.locator('#pinned .row.folder .title')).toHaveText('Renamed');
  });

  // BUG: double-click to rename never fires. Each click re-renders the whole sidebar
  // (click → collapse toggle / activate → render() → innerHTML), so the two clicks land on different
  // DOM nodes and Chromium never dispatches `dblclick` (src/renderer/app.js:805 + 822).
  // Also the folder gets collapsed+expanded on the way.
  test('double-clicking a folder or pinned tab opens the rename prompt', async ({ page, server }) => {
    test.fail(true, 'BUG: dblclick rename broken by full sidebar re-render on click');
    await page.evaluate((u) => { space().pinned.unshift({ id: 'f1', type: 'folder', title: 'F', collapsed: false, children: [] }); render(); }, server.url('/'));
    await page.locator('#pinned .row.folder').dblclick();
    await expect(page.locator('#ask-input')).toBeVisible({ timeout: 2000 });
  });
});

test.describe('drag and drop', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const sp = S.space('Main', { today: [S.tab(server.url('/p/d1')), S.tab(server.url('/p/d2')), S.tab(server.url('/p/d3'))] });
      return S.seedState({ spaces: [sp] });
    })()),
  });

  test('dragging a Today tab onto the Pinned zone pins it', async ({ page, server }) => {
    const row = page.locator('#today .row.tab').nth(2);
    const id = await row.getAttribute('data-id');
    await row.dragTo(page.locator('#pinned'));
    expect(await page.evaluate((id) => locate(id)?.zone, id)).toBe('pinned');
    expect(await pinnedTitles(page)).toEqual([server.url('/p/d3')]);
  });

  test('dragging within Today reorders tabs', async ({ page, server }) => {
    const rows = page.locator('#today .row.tab');
    await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 20, y: 2 } });
    expect(await todayUrls(page)).toEqual([server.url('/p/d3'), server.url('/p/d1'), server.url('/p/d2')]);
  });

  // BUG: with no favorites yet, #favorites has 0px height (styles.css:109 `.empty { min-height: 0 }`),
  // so there is nothing to drop onto — the first favorite can't be created by drag and drop.
  test('dragging a tab onto the (empty) favorites strip favorites it', async ({ page }) => {
    test.fail(true, 'BUG: empty favorites strip has no drop area');
    const row = page.locator('#today .row.tab').first();
    const id = await row.getAttribute('data-id');
    const fav = await page.evaluate(() => { const r = document.querySelector('#favorites').getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2, h: r.height }; });
    const rb = await row.boundingBox();
    await page.mouse.move(rb.x + 20, rb.y + rb.height / 2);
    await page.mouse.down();
    await page.mouse.move(fav.x, fav.y, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate((id) => locate(id)?.zone, id)).toBe('fav');
  });

  test('dragging a tab next to an existing favorite favorites it', async ({ page, server }) => {
    const first = await page.locator('#today .row.tab').first().getAttribute('data-id');
    await page.evaluate((id) => addFavorite(id), first);
    const row = page.locator('#today .row.tab').first();
    const id = await row.getAttribute('data-id');
    await row.dragTo(page.locator('#favorites .fav').first(), { targetPosition: { x: 40, y: 10 } });
    expect(await page.evaluate(() => favs().map((t) => t.url))).toEqual([server.url('/p/d1'), server.url('/p/d2')]);
    expect(await page.evaluate((id) => locate(id)?.zone, id)).toBe('fav');
  });
});

test.describe('pinned tab drift', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const pin = S.pinnedTab(server.url('/p/home'));
      return S.seedState({ spaces: [S.space('Main', { pinned: [pin], activeTabId: pin.id })] });
    })()),
  });

  test('navigating away from a pinned URL shows the reset button; clicking it goes home', async ({ page, server }) => {
    const id = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, id, server.url('/p/home'));
    await clickInTab(page, id, '#same');
    await waitTabLoaded(page, id, server.url('/p/home-next'));
    const reset = page.locator(`#pinned .row.tab[data-id="${id}"] .row-btn.reset`);
    await expect(reset).toBeVisible();
    await reset.click();
    await waitTabLoaded(page, id, server.url('/p/home'));
    await expect.poll(() => page.evaluate((id) => rt.views.get(id).getURL(), id)).toBe(server.url('/p/home'));
    await expect(reset).toHaveCount(0);
    expect(await page.evaluate((id) => locate(id).node.url, id)).toBe(server.url('/p/home'));
  });
});

test.describe('Today auto-archive', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const fresh = S.tab(server.url('/p/fresh'));
      const stale = S.tab(server.url('/p/stale'), { title: 'Stale tab', lastActive: Date.now() - 13 * 3600e3 });
      const staleActive = S.tab(server.url('/p/stale-active'), { lastActive: Date.now() - 13 * 3600e3 });
      const sp = S.space('Main', { today: [fresh, stale, staleActive], activeTabId: staleActive.id });
      return S.seedState({ spaces: [sp] });
    })()),
  });

  test('tabs idle longer than the limit are archived on start; the active one is kept', async ({ page, server }) => {
    const urls = await todayUrls(page);
    expect(urls).toContain(server.url('/p/fresh'));
    expect(urls).toContain(server.url('/p/stale-active'));
    expect(urls).not.toContain(server.url('/p/stale'));
    expect(await page.evaluate(() => state.archive.map((a) => a.title))).toContain('Stale tab');
  });

  test('runtime auto-archive respects the setting (Never keeps everything)', async ({ page }) => {
    await page.evaluate(() => { for (const t of space().today) if (t.id !== space().activeTabId) t.lastActive = Date.now() - 100 * 3600e3; state.settings.archiveAfterHours = 0; autoArchive(); });
    expect(await page.evaluate(() => space().today.length)).toBe(2);
    await page.evaluate(() => { state.settings.archiveAfterHours = 24; autoArchive(); });
    expect(await page.evaluate(() => space().today.length)).toBe(1);
  });
});

test.describe('archive search', () => {
  test.use({
    seed: async ({ server }, use) => use(S.seedState({
      archive: [{ url: server.url('/p/archived-zebra'), title: 'Zebra research notes', closedAt: Date.now() - 86400e3, spaceId: 'x' }],
    })),
  });

  test('archived tabs are found in the command bar and reopen from it', async ({ page, server }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('zebra');
    const row = page.locator('#cmd-results .cmd-row', { hasText: 'Zebra research notes' });
    await expect(row).toBeVisible();
    await expect(row.locator('.cmd-sub')).toContainText('Archived');
    const idx = Number(await row.getAttribute('data-i'));
    for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown');
    await expect(page.locator('#cmd-results .cmd-row.sel')).toHaveAttribute('data-i', String(idx));
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).activeUrl).toBe(server.url('/p/archived-zebra'));
  });

  test('typing "archive" lists archived tabs', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('archive');
    await expect(page.locator('#cmd-results .cmd-row', { hasText: 'Zebra research notes' })).toBeVisible();
  });
});
