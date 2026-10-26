// The home page (home.js): what Meridian can do, "Set up for me" presets, the AI power-up ceremony
// (key checked against a mock Anthropic API before it's saved), the command bar's key hints and
// ⇧↵ split, and shortcut tips after switching tabs with the mouse.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, snapshot, waitTabLoaded } = require('../fixtures/meridian');
const S = require('../fixtures/state');
const { startMockAnthropic } = require('../fixtures/mock-anthropic');

test('home: greeting, four cards, the search field opens ⌘T, "Show less" sticks', async ({ page }) => {
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('.home-greet')).toHaveText(/^Good (night|morning|afternoon|evening)$/);
  await expect(page.locator('.home-card')).toHaveCount(4);
  await expect(page.locator('.home-card .hc-title')).toHaveText(['For every day', 'For designers', 'For managers', 'For developers']);
  await expect(page.locator('#home-power')).toBeVisible(); // no AI connected yet
  await expect(page.locator('#home-tip')).toContainText('Tip');
  await page.locator('#home-search').click();
  await expect(page.locator('#cmdbar-overlay')).toBeVisible();
  await expect(page.locator('#cmd-foot')).toContainText('Type a site');
  await page.keyboard.press('Escape');
  await page.locator('#home-compact').click();
  await expect(page.locator('.home-card').first()).toBeHidden();
  expect(await page.evaluate(() => state.home.compact)).toBe(true);
  await page.locator('#home-expand').click();
  await expect(page.locator('.home-card').first()).toBeVisible();
});

test('"Set up for me" (designers): pick what to add, nothing is removed', async ({ page }) => {
  const before = await page.evaluate(() => state.spaces.length);
  await page.locator('.home-card[data-card="designer"] [data-preset]').click();
  const modal = page.locator('#modal .preset');
  await expect(modal).toContainText('Set up Meridian for designers');
  await expect(modal.locator('.preset-chip')).not.toHaveCount(0);
  await modal.locator('.preset-chip', { hasText: 'Pinterest' }).locator('input').uncheck();
  await modal.locator('[data-a="ok"]').click();
  await expect(page.locator('#modal-overlay')).toBeHidden();
  const s = await page.evaluate(() => ({ mode: state.settings.mode, spaces: state.spaces.map((x) => x.name), favs: (state.favorites.default || []).map((f) => f.title) }));
  expect(s.mode).toBe('creative');
  expect(s.spaces).toEqual(expect.arrayContaining(['Projects', 'Inspiration']));
  expect(s.spaces.length).toBeGreaterThanOrEqual(before);
  expect(s.favs).toEqual(expect.arrayContaining(['Figma', 'Dribbble']));
  expect(s.favs).not.toContain('Pinterest');
  // Running it again doesn't duplicate anything.
  await page.locator('.home-card[data-card="designer"] [data-preset]').click();
  await page.locator('#modal .preset [data-a="ok"]').click();
  const again = await page.evaluate(() => ({ spaces: state.spaces.length, favs: state.favorites.default.length }));
  expect(again.spaces).toBe(s.spaces.length);
  expect(again.favs).toBe(s.favs.length + 1); // only Pinterest, unchecked the first time
});

test.describe('AI power-up', () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockAnthropic(); });
  test.afterAll(async () => { await mock?.close(); });

  test('a rejected key cracks the gem; an accepted one is saved, selected and unlocks the powers', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-power-'));
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { ANTHROPIC_BASE_URL: mock.base } });
    try {
      const { page } = m;
      await page.locator('#hp-insert').click();
      await expect(page.locator('#power')).toBeVisible();
      await page.locator('#pw-key').fill('not a key');
      await page.locator('#pw-go').click();
      await expect(page.locator('#pw-error')).toContainText('doesn’t look like an API key');
      await page.locator('#pw-key').fill('sk-ant-api03-badbadbadbadbadbadbadbadbad');
      await page.locator('#pw-go').click();
      await expect(page.locator('#pw-error')).toContainText('didn’t accept this key');
      await expect(page.locator('#power')).toHaveClass(/cracked/);
      expect(await page.evaluate(() => api.aiHasKey())).toBe(false);
      await page.locator('#pw-key').fill('sk-ant-api03-goodgoodgoodgoodgoodgoodgood');
      await page.locator('#pw-go').click();
      await expect(page.locator('#pw-title')).toHaveText('Meridian is powered up', { timeout: 15_000 });
      await expect(page.locator('#power')).toHaveClass(/powered/);
      await expect(page.locator('.pw-power')).toHaveCount(4);
      await expect(page.locator('#pw-socket .pw-set')).toBeVisible();
      expect(await page.evaluate(() => api.aiHasKey())).toBe(true);
      expect(await page.evaluate(() => state.settings.aiProvider)).toBe('api');
      // The check was one tiny request with the candidate key.
      const checks = mock.requests.filter((r) => r.body.max_tokens === 1);
      expect(checks.map((r) => (r.headers['x-api-key'] || r.headers.authorization || '').replace(/^Bearer /, ''))).toEqual(['sk-ant-api03-badbadbadbadbadbadbadbadbad', 'sk-ant-api03-goodgoodgoodgoodgoodgoodgood']);
      expect(checks[1].body.model).toBe('claude-haiku-5-5');
      await page.locator('#power [data-a="close"]').first().click();
      await expect(page.locator('#power')).toHaveCount(0);
      await expect(page.locator('#home-power')).toBeHidden();
    } finally { await closeMeridian(m.app); fs.rmSync(userDataDir, { recursive: true, force: true }); }
  });
});

test.describe('command bar', () => {
  test.use({ seed: async ({ server }, use) => {
    const a = S.tab(server.url('/p/alpha'), { title: 'Alpha page' });
    const b = S.tab(server.url('/p/beta'), { title: 'Beta page' });
    await use(S.seedState({ spaces: [S.space('Main', { today: [a, b], activeTabId: a.id })] }));
  } });

  test('groups, a gliding highlight, key hints that follow the selection, ⇧↵ opens in split view', async ({ page, server }) => {
    await waitTabLoaded(page, await page.evaluate(() => space().activeTabId));
    await page.evaluate(() => openCommandBar('new'));
    await page.locator('#cmd-input').fill('split');
    await expect(page.locator('#cmd-results .cmd-group', { hasText: 'Commands' })).toBeVisible();
    await expect(page.locator('#cmd-foot')).toContainText('Open in split view'); // the first row is a search
    const y0 = await page.locator('.cmd-hl').evaluate((el) => el.style.transform);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.locator('.cmd-hl').evaluate((el) => el.style.transform)).not.toBe(y0);
    await expect(page.locator('#cmd-results .cmd-row.sel')).toHaveAttribute('data-kind', 'cmd');
    await expect(page.locator('#cmd-foot')).toContainText('Run');
    await expect(page.locator('#cmd-foot')).toContainText('Next time');
    // A site, opened with ⇧↵, lands next to the current page.
    await page.locator('#cmd-input').fill(server.url('/p/gamma'));
    await page.keyboard.press('Shift+Enter');
    await expect(page.locator('#cmdbar-overlay')).toBeHidden();
    await expect.poll(() => page.evaluate(() => space().split?.ids.length || 0)).toBe(2);
    expect(await page.evaluate(() => space().today.map((t) => t.url))).toContain(server.url('/p/gamma'));
  });

  test('the empty bar suggests frequent sites and things to try', async ({ page, server }) => {
    await waitTabLoaded(page, await page.evaluate(() => space().activeTabId));
    await page.evaluate((u) => { state.history[u] = { url: u, title: 'Gamma docs', count: 5, last: Date.now() }; }, server.url('/p/gamma').replace('127.0.0.1', 'localhost'));
    await page.evaluate(() => openCommandBar('new'));
    await expect(page.locator('#cmd-results .cmd-group', { hasText: 'Frequent sites' })).toBeVisible();
    await expect(page.locator('#cmd-results .cmd-row[data-kind="history"]')).toContainText(['Gamma docs']);
    await expect(page.locator('#cmd-results .cmd-group', { hasText: 'Try' })).toBeVisible();
    await expect(page.locator('#cmd-results .cmd-row[data-kind="cmd"]').first()).toContainText('Split View');
    await expect(page.locator('#cmd-results')).toContainText('Two pages side by side');
    await expect(page.locator('#cmd-foot')).toContainText('Type a site');
    await page.locator('#cmd-input').fill('x');
    await expect(page.locator('#cmd-results .cmd-group', { hasText: 'Try' })).toHaveCount(0);
  });

  test('switching tabs with the mouse a few times earns a keyboard tip, once', async ({ page }) => {
    await waitTabLoaded(page, await page.evaluate(() => space().activeTabId));
    const rows = page.locator('#space-pages .row.tab');
    for (let i = 0; i < 4; i++) await rows.nth(i % 2 ? 0 : 1).click();
    await expect(page.locator('.tip-toast')).toContainText('next tab');
    expect(await page.evaluate(() => state.tips['tab-switch'])).toBe(1);
    for (let i = 0; i < 4; i++) await rows.nth(i % 2 ? 0 : 1).click();
    await expect(page.locator('.tip-toast')).toHaveCount(1);
  });
});
