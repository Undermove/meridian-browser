// Command bar: opening (⌘T / ⌘L), keyboard navigation, Enter, Escape and focus handling.
const {
  test, expect, press, snapshot, openTabDirect, waitTabLoaded, clickIntoActivePage, focusInfo,
} = require('../fixtures/meridian');
const S = require('../fixtures/state');

const sel = (page) => page.locator('#cmd-results .cmd-row.sel').getAttribute('data-i').then(Number);

test.describe('command bar', () => {
  test.use({
    seed: async ({ server }, use) => use(S.seedState({
      history: Object.fromEntries(['alpha', 'alpine', 'alps'].map((n, i) => [server.url('/p/' + n), { url: server.url('/p/' + n), title: `History ${n}`, count: 3 - i, last: Date.now() - i * 1000 }])),
    })),
  });

  test('⌘T opens the command bar with focus inside a page @shortcut', async ({ meridian, page, server }) => {
    await openTabDirect(page, server.url('/p/x'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+T');
    await expect(page.locator('#cmdbar-overlay')).toBeVisible();
    await expect(page.locator('#cmd-input')).toBeFocused();
    await expect(page.locator('#cmd-input')).toHaveValue('');
  });

  test('⌘L opens it prefilled with the current URL, selected @shortcut', async ({ meridian, page, server }) => {
    await openTabDirect(page, server.url('/p/x'));
    await clickIntoActivePage(page);
    await press(meridian, 'Meta+L');
    await expect(page.locator('#cmd-input')).toHaveValue(server.url('/p/x'));
  });

  test('edit mode (runCommand) is prefilled and selected; Enter on the same URL reloads', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/x'));
    await page.evaluate(() => runCommand('edit-url'));
    await expect(page.locator('#cmd-input')).toHaveValue(server.url('/p/x'));
    const selected = await page.evaluate(() => { const i = document.querySelector('#cmd-input'); return [i.selectionStart, i.selectionEnd, i.value.length]; });
    expect(selected[0]).toBe(0);
    expect(selected[1]).toBe(selected[2]);
    await expect(page.locator('#cmd-results .cmd-row.sel .cmd-title')).toHaveText('Reload page');
    await page.evaluate((id) => { window.__loads = 0; rt.views.get(id).addEventListener('did-start-loading', () => window.__loads++); }, id);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__loads)).toBeGreaterThan(0);
    expect((await snapshot(page)).todayCount).toBe(1); // no new tab
  });

  test('edit mode + typing a different URL navigates the current tab', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/x'));
    await page.evaluate(() => runCommand('edit-url'));
    await page.keyboard.type(server.url('/p/y'));
    await page.keyboard.press('Enter');
    await waitTabLoaded(page, id, server.url('/p/y'));
    expect((await snapshot(page)).todayCount).toBe(1);
  });

  test('ArrowDown / ArrowUp / Ctrl+N / Ctrl+P move the selection and wrap', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('alp');
    const n = await page.locator('#cmd-results .cmd-row').count();
    expect(n).toBeGreaterThanOrEqual(4); // search + 3 history rows
    expect(await sel(page)).toBe(0);
    await page.keyboard.press('ArrowDown');
    expect(await sel(page)).toBe(1);
    await page.keyboard.press('Control+n');
    expect(await sel(page)).toBe(2);
    await page.keyboard.press('Control+p');
    expect(await sel(page)).toBe(1);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    expect(await sel(page)).toBe(n - 1); // wrapped to the bottom
    await page.keyboard.press('ArrowDown');
    expect(await sel(page)).toBe(0); // and back to the top
    // caret must not jump to the start/end of the input while navigating
    expect(await page.locator('#cmd-input').inputValue()).toBe('alp');
  });

  test('Enter runs the selected row (a history entry)', async ({ page, server }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('alpine');
    const row = page.locator('#cmd-results .cmd-row', { hasText: 'History alpine' });
    const idx = Number(await row.getAttribute('data-i'));
    for (let i = 0; i < idx; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).activeUrl).toBe(server.url('/p/alpine'));
  });

  test('Escape closes it and gives focus back to the page', async ({ page, server }) => {
    const id = await openTabDirect(page, server.url('/p/x'));
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('something');
    await page.keyboard.press('Escape');
    await expect(page.locator('#cmdbar-overlay')).toBeHidden();
    await expect.poll(() => focusInfo(page).then((f) => f.tabId)).toBe(id);
    // re-opening starts empty
    await page.evaluate(() => runCommand('command-bar'));
    await expect(page.locator('#cmd-input')).toHaveValue('');
  });

  test('Escape with no open tab closes it and leaves no stale overlay', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.press('Escape');
    await expect(page.locator('#cmdbar-overlay')).toBeHidden();
    await page.keyboard.press('Escape'); // second Escape is harmless
    await expect(page.locator('#modal-overlay')).toBeHidden();
  });

  test('clicking outside the bar closes it', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.mouse.click(1200, 780);
    await expect(page.locator('#cmdbar-overlay')).toBeHidden();
  });

  test('⌘W while the bar is open closes the bar, not the tab (runCommand)', async ({ page, server }) => {
    await openTabDirect(page, server.url('/p/x'));
    await page.evaluate(() => runCommand('command-bar'));
    await page.evaluate(() => runCommand('close-tab'));
    await expect(page.locator('#cmdbar-overlay')).toBeHidden();
    expect((await snapshot(page)).todayCount).toBe(1);
  });

  test('commands are offered and run from the bar', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.type('toggle side');
    const row = page.locator('#cmd-results .cmd-row', { hasText: 'Toggle Sidebar' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('body')).toHaveClass(/sidebar-hidden/);
  });

  test('typing fast and pressing Enter immediately uses what was typed', async ({ page, server }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.insertText(server.url('/p/fast'));
    await page.keyboard.press('Enter');
    expect((await snapshot(page)).activeUrl).toBe(server.url('/p/fast'));
  });

  test('Escape inside a text prompt cancels it', async ({ page }) => {
    await page.evaluate(() => { window.__r = 'pending'; askText('First', 'x').then((v) => { window.__r = v; }); });
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).toBeHidden();
    expect(await page.evaluate(() => window.__r)).toBeNull();
  });

  // BUG: Escape on a confirm box (e.g. "Delete space…", "Clear cookies") only hides #modal-overlay in the global
  // keydown handler (app.js:1563); the 'dismiss' event isn't dispatched, so the confirmBox() promise never
  // settles and the dialog's DOM stays in #modal. Same for the Settings modal (left mounted, handlers alive).
  test('Escape on a confirm box answers "no"', async ({ page }) => {
    test.fail(true, 'BUG: confirmBox promise never resolves on Escape');
    await page.evaluate(() => { window.__r2 = 'pending'; confirmBox('Sure?', 'Yes').then((v) => { window.__r2 = v; }); });
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal-overlay')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__r2), { timeout: 1500 }).toBe(false);
  });
});
