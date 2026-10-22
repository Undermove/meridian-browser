// Spaces: create, switch (dots, Ctrl+1..9, ⌘⌥←/→, commands), switching back and forth with focus
// inside a web page (the user's reported bug), and per-space profiles keeping cookies apart.
const {
  test, expect, press, snapshot, openTabDirect, waitTabLoaded, clickIntoActivePage, clickInTab, focusInfo, inTab,
} = require('../fixtures/meridian');
const S = require('../fixtures/state');

function threeSpaces(server) {
  const a = S.space('Alpha', { icon: '🅰️', today: [S.tab(server.url('/p/alpha'))] });
  a.activeTabId = a.today[0].id;
  const b = S.space('Beta', { today: [S.tab(server.url('/p/beta'))] });
  b.activeTabId = b.today[0].id;
  const c = S.space('Gamma (empty)');
  return S.seedState({ spaces: [a, b, c] });
}

const spaceIndex = (page) => snapshot(page).then((s) => s.spaceIndex);

// Exactly one visible webview, and it belongs to the active tab. Every space keeps its own sidebar
// page (keyed patching); exactly one of them is the current one, and it shows the active space.
async function expectConsistentView(page) {
  const r = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('#views webview')].filter((w) => !w.classList.contains('hidden'));
    const current = [...document.querySelectorAll('#space-pages .space-page.current')];
    return {
      visible: visible.map((w) => w.dataset.tabId), active: space().activeTabId, dot: document.querySelector('.space-dot.active')?.dataset.space, spaceId: state.activeSpaceId,
      currentPages: current.map((p) => p.dataset.space), header: current[0]?.querySelector('.space-name')?.textContent, name: space().name,
      todayZoneInCurrent: !!current[0]?.querySelector('#today'),
    };
  });
  expect(r.visible).toEqual(r.active ? [r.active] : []);
  expect(r.dot).toBe(r.spaceId);
  expect(r.currentPages).toEqual([r.spaceId]);
  expect(r.header).toBe(r.name);
  expect(r.todayZoneInCurrent).toBe(true);
}

test.describe('spaces', () => {
  test.use({ seed: async ({ server }, use) => use(threeSpaces(server)) });

  test('create a space with the + button', async ({ page }) => {
    await page.locator('#btn-add-space').click();
    await page.locator('#ask-input').fill('Work');
    await page.keyboard.press('Enter');
    const s = await snapshot(page);
    expect(s.spaces).toBe(4);
    expect(s.spaceName).toBe('Work');
    await expect(page.locator('.space-dot.active')).toHaveAttribute('title', /Work/);
    await expectConsistentView(page);
  });

  test('clicking space dots switches spaces', async ({ page }) => {
    const dots = page.locator('#space-dots .space-dot');
    await expect(dots).toHaveCount(3);
    await dots.nth(1).click();
    expect(await spaceIndex(page)).toBe(1);
    await expectConsistentView(page);
    await dots.nth(0).click();
    expect(await spaceIndex(page)).toBe(0);
    await expectConsistentView(page);
    await dots.nth(2).click();
    expect(await spaceIndex(page)).toBe(2);
    await expectConsistentView(page);
  });

  test('space-index / space-step commands (runCommand) switch and wrap', async ({ page }) => {
    await page.evaluate(() => runCommand('space-index', 1));
    expect(await spaceIndex(page)).toBe(1);
    await page.evaluate(() => runCommand('space-step', 1));
    expect(await spaceIndex(page)).toBe(2);
    await page.evaluate(() => runCommand('space-step', 1));
    expect(await spaceIndex(page)).toBe(0); // wraps
    await page.evaluate(() => runCommand('space-step', -1));
    expect(await spaceIndex(page)).toBe(2);
    await page.evaluate(() => runCommand('space-index', 7)); // no such space: no-op
    expect(await spaceIndex(page)).toBe(2);
    await expectConsistentView(page);
  });

  test('Ctrl+1..9 switch spaces @shortcut', async ({ meridian, page }) => {
    await press(meridian, 'Control+2');
    await expect.poll(() => spaceIndex(page)).toBe(1);
    await press(meridian, 'Control+3');
    await expect.poll(() => spaceIndex(page)).toBe(2);
    await press(meridian, 'Control+1');
    await expect.poll(() => spaceIndex(page)).toBe(0);
  });

  test('⌘⌥→ / ⌘⌥← step through spaces @shortcut', async ({ meridian, page }) => {
    await press(meridian, 'Meta+Alt+ArrowRight');
    await expect.poll(() => spaceIndex(page)).toBe(1);
    await press(meridian, 'Meta+Alt+ArrowLeft');
    await expect.poll(() => spaceIndex(page)).toBe(0);
    await press(meridian, 'Meta+Alt+ArrowLeft');
    await expect.poll(() => spaceIndex(page)).toBe(2);
  });

  // The user's report: "switched to one space with hotkeys and then couldn't switch back with the arrow shortcut".
  test('Ctrl+2 then ⌘⌥← back, repeatedly, with focus inside the web page @shortcut', async ({ meridian, page }) => {
    for (let round = 0; round < 4; round++) {
      await clickIntoActivePage(page);
      await press(meridian, 'Control+2');
      await expect.poll(() => spaceIndex(page), { message: `round ${round}: Ctrl+2` }).toBe(1);
      await press(meridian, 'Meta+Alt+ArrowLeft');
      await expect.poll(() => spaceIndex(page), { message: `round ${round}: ⌘⌥← back` }).toBe(0);
      await expectConsistentView(page);
    }
  });

  test('⌘⌥→ / ⌘⌥← back and forth with focus inside the page and no clicks in between @shortcut', async ({ meridian, page }) => {
    await clickIntoActivePage(page);
    for (let i = 0; i < 6; i++) {
      await press(meridian, i % 2 ? 'Meta+Alt+ArrowLeft' : 'Meta+Alt+ArrowRight');
      await expect.poll(() => spaceIndex(page), { message: `step ${i}` }).toBe(i % 2 ? 0 : 1);
    }
  });

  // Pages can swallow shortcuts today: menu accelerators only see keys the page didn't preventDefault()
  // (Electron has no "reserved" browser shortcuts like Chrome's ⌘W/⌘T/Ctrl+Tab). A page with a greedy
  // keydown handler (editors, games, Google Docs…) must not be able to block space switching.
  test('space shortcuts still work when the page preventDefault()s every key @shortcut', async ({ meridian, page, server }) => {
    const alpha = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, alpha); // loadURL() while the start-up load is still running rejects with ERR_ABORTED
    await page.evaluate(([id, u]) => rt.views.get(id).loadURL(u), [alpha, server.url('/greedy')]);
    await waitTabLoaded(page, alpha, server.url('/greedy'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+Alt+ArrowRight');
    await expect.poll(() => spaceIndex(page)).toBe(1);
    await page.evaluate(() => runCommand('space-index', 0));
    await clickIntoActivePage(page);
    await press(meridian, 'Control+2');
    await expect.poll(() => spaceIndex(page)).toBe(1);
  });

  // Same journey through the command layer, to tell "shortcut plumbing" apart from "space switching".
  test('switching back and forth (runCommand) keeps keyboard focus in the visible page', async ({ page }) => {
    // load Beta's tab once (see the next test for the first, unloaded switch)
    await page.evaluate(() => runCommand('space-index', 1));
    await waitTabLoaded(page, await page.evaluate(() => space().activeTabId));
    await page.evaluate(() => runCommand('space-index', 0));
    for (let round = 0; round < 4; round++) {
      await clickIntoActivePage(page);
      await page.evaluate(() => runCommand('space-index', 1));
      await expect.poll(() => focusInfo(page).then((f) => f.tabId), { message: `round ${round}: focus after switch to Beta` })
        .toBe(await page.evaluate(() => space().activeTabId));
      await page.evaluate(() => runCommand('space-step', -1));
      await expect.poll(() => focusInfo(page).then((f) => f.tabId), { message: `round ${round}: focus after switch back` })
        .toBe(await page.evaluate(() => space().activeTabId));
      await expectConsistentView(page);
    }
  });

  // Regression: the first switch into a space whose active tab isn't loaded yet used to leave focus on
  // the UI <body> (wv.focus() ran before the guest was attached and nothing re-focused it).
  test('first switch into a space with an unloaded tab focuses that page once it loads', async ({ page }) => {
    // no synthetic clicks: Alpha's page has focus from start-up (activate() at boot)
    await waitTabLoaded(page, await page.evaluate(() => space().activeTabId));
    await expect.poll(() => focusInfo(page).then((f) => f.tag)).toBe('webview');
    await page.evaluate(() => runCommand('space-index', 1));
    const beta = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, beta);
    await expect.poll(() => focusInfo(page).then((f) => f.tabId), { timeout: 3000 }).toBe(beta);
  });

  // Regression: switching to a space with no open tab used to leave keyboard focus in the previous
  // space's now-hidden <webview>, so keystrokes went into an invisible page.
  test('switching to an empty space does not leave focus in the hidden page', async ({ meridian, page }) => {
    const alphaTab = await page.evaluate(() => space().activeTabId);
    await waitTabLoaded(page, alphaTab);
    await page.evaluate((id) => rt.views.get(id).focus(), alphaTab);
    await inTab(page, alphaTab, `document.querySelector('#field').focus(); 1`);
    // precondition: the same key path does reach the field while its page is shown and focused
    await press(meridian, 'z', { target: await page.evaluate((id) => rt.views.get(id).getWebContentsId(), alphaTab) });
    await expect.poll(() => inTab(page, alphaTab, `document.querySelector('#field').value`)).toBe('z');
    await inTab(page, alphaTab, `document.querySelector('#field').value = ''; 1`);
    await page.evaluate(() => runCommand('space-index', 2));
    expect(await spaceIndex(page)).toBe(2);
    const f = await focusInfo(page);
    test.info().annotations.push({ type: 'focus after switching to empty space', description: JSON.stringify(f) });
    expect(f.hidden, 'focus is inside a hidden webview').toBe(false);
    expect(f.tag).not.toBe('webview');
    // typing (real key events into the window) can't reach the hidden page's form
    await press(meridian, 'q');
    await press(meridian, 'w');
    expect(await inTab(page, alphaTab, `document.querySelector('#field').value`)).toBe('');
  });

  test('rapid alternating switches end in a consistent state', async ({ page }) => {
    await page.evaluate(() => { for (let i = 0; i < 25; i++) runCommand('space-step', i % 2 ? -1 : 1); });
    expect(await spaceIndex(page)).toBe(1);
    await expectConsistentView(page);
  });

  test('command bar "Switch to tab" jumps to a tab in another space', async ({ page }) => {
    await page.evaluate(() => runCommand('space-index', 1)); // load Beta's tab
    await page.evaluate(() => runCommand('space-index', 0));
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('beta');
    const row = page.locator('#cmd-results .cmd-row', { hasText: 'Beta ·' }).first();
    await expect(row).toBeVisible();
    await row.click();
    expect((await snapshot(page)).spaceName).toBe('Beta');
    await expectConsistentView(page);
  });
});

test.describe('profiles', () => {
  test.use({
    seed: async ({ server }, use) => use((() => {
      const p = S.space('Personal');
      const w = S.space('Work', { profileId: 'work' });
      const p2 = S.space('Personal 2');
      return S.seedState({ spaces: [p, w, p2], profiles: [{ id: 'default', name: 'Default' }, { id: 'work', name: 'Work' }], favorites: { default: [], work: [] } });
    })()),
  });

  test('spaces with different profiles keep cookies separate; same profile shares them', async ({ page, server }) => {
    await openTabDirect(page, server.url('/cookie/set?v=personal'));
    await page.evaluate(() => runCommand('space-index', 1));
    const w = await openTabDirect(page, server.url('/cookie/show'));
    expect(await inTab(page, w, `document.querySelector('#out').textContent`)).toBe('cookie=[]');
    await page.evaluate(() => runCommand('space-index', 2));
    const p2 = await openTabDirect(page, server.url('/cookie/show'));
    expect(await inTab(page, p2, `document.querySelector('#out').textContent`)).toContain('meridian_test=personal');
    const partitions = await page.evaluate(() => [...document.querySelectorAll('#views webview')].map((v) => v.getAttribute('partition')));
    expect(new Set(partitions)).toEqual(new Set(['persist:profile-default', 'persist:profile-work']));
  });
});
