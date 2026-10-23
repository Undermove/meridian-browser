// Settings → General's member card and Settings → AI (which once came up blank).
const { test, expect, press, openTabDirect, clickIntoActivePage } = require('../fixtures/meridian');

async function openSettings(meridian, server) {
  await openTabDirect(meridian.page, server.url('/p/settings-host'));
  await clickIntoActivePage(meridian.page);
  const winPromise = meridian.app.waitForEvent('window', (w) => w.url().startsWith('meridian://app/settings.html'));
  await press(meridian, 'Meta+Comma');
  const sw = await winPromise;
  await sw.waitForSelector('#tabs .tab');
  return sw;
}

test('Settings → AI draws its groups and then finds the coding agents', async ({ meridian, server }) => {
  const sw = await openSettings(meridian, server);
  const errors = [];
  sw.on('pageerror', (e) => errors.push(String(e)));
  await sw.locator('#tabs .tab[data-id="ai"]').click();
  await expect(sw.locator('#content .page[data-section="ai"] h1')).toHaveText('AI in Meridian');
  await expect(sw.locator('#cli-rows .row.cli')).toHaveCount(2, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('General shows the member card; its name can be changed and persists', async ({ meridian, server }) => {
  const sw = await openSettings(meridian, server);
  const card = sw.locator('#member-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.mc-since')).toContainText('Member since');
  await card.hover({ position: { x: 40, y: 30 } });
  await expect(card).toHaveClass(/tilt/);
  await sw.locator('#member-name').click();
  await sw.locator('#ask').fill('Ada Lovelace');
  await sw.locator('#ask').press('Enter');
  await expect(sw.locator('#member-name')).toHaveText('Ada Lovelace');
  await expect.poll(() => meridian.page.evaluate(() => state.settings.memberName)).toBe('Ada Lovelace');
  // main rejects junk
  expect(await sw.evaluate(() => window.meridianSettings.set({ memberName: 'x'.repeat(80) }))).toBe(false);
});
