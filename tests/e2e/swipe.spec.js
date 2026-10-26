// Two-finger swipe on a page (guest-preload.js → onPageSwipe): right goes back, left goes forward, back
// from the first page of a tab opened from a link returns to that tab; a page that scrolls sideways
// keeps the gesture for itself.
const { test, expect, openTabDirect, waitTabLoaded, clickInTab, inTab, activeViewBox } = require('../fixtures/meridian');

// A trackpad swipe: horizontal wheel events into the page under the pointer (DOM deltaX: < 0 = back).
async function swipe(page, dx, { steps = 8 } = {}) {
  const b = await activeViewBox(page);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(dx / steps, 0); await page.waitForTimeout(16); }
  await page.waitForTimeout(350); // the gesture ends when the wheel goes quiet
}

const activeUrl = (page) => page.evaluate(() => tabUrl(activeTab()));

test('swipe right goes back, left goes forward; a short swipe does nothing', async ({ page, server }) => {
  const id = await openTabDirect(page, server.url('/p/one'));
  await page.evaluate(([id, u]) => rt.views.get(id).loadURL(u), [id, server.url('/p/two')]);
  await waitTabLoaded(page, id, server.url('/p/two'));
  await inTab(page, id, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

  await swipe(page, -60);
  expect(await activeUrl(page)).toContain('/p/two');
  await swipe(page, -400);
  await waitTabLoaded(page, id, server.url('/p/one'));
  await expect(page.locator('#swipe-hint')).not.toHaveClass(/show/);
  await swipe(page, 400);
  await waitTabLoaded(page, id, server.url('/p/two'));
});

test('back from a tab opened from a link returns to the tab it came from', async ({ page, server }) => {
  const from = await openTabDirect(page, server.url('/links'));
  await clickInTab(page, from, '#same-blank');
  await expect.poll(() => activeUrl(page)).toContain('/p/same-site');
  const child = await page.evaluate(() => space().activeTabId);
  expect(child).not.toBe(from);
  await waitTabLoaded(page, child, server.url('/p/same-site'));
  await expect(page.locator('#topbar [data-cmd="back"], [data-cmd="back"]').first()).toBeEnabled();
  await swipe(page, -400);
  await expect.poll(() => page.evaluate(() => space().activeTabId)).toBe(from);
  expect(await page.evaluate((c) => !!locate(c), child)).toBe(false);
  expect(await page.evaluate(() => state.archive[0].url)).toContain('/p/same-site');
});

test('a page scrolled sideways keeps the swipe for itself', async ({ page, server }) => {
  const id = await openTabDirect(page, server.url('/p/wide'));
  await page.evaluate(([id, u]) => rt.views.get(id).loadURL(u), [id, server.url('/p/wide2')]);
  await waitTabLoaded(page, id, server.url('/p/wide2'));
  await inTab(page, id, `document.body.style.width = '5000px'; scrollTo(800, 0); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  await swipe(page, -400);
  expect(await activeUrl(page)).toContain('/p/wide2');
  expect(await inTab(page, id, 'scrollX')).toBeLessThan(800);
});
