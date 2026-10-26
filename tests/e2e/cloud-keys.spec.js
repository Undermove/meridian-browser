// API keys from the other big providers (cloud-keys.js): the key's provider is recognised from its shape,
// checked against a mock OpenAI-compatible API before it's saved, encrypted at rest, and then answers Ask
// in ⌘T with a sensible default model (or the one picked in Settings → AI).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, press, openTabDirect, clickIntoActivePage } = require('../fixtures/meridian');
const { startMockCloud } = require('../fixtures/mock-cloud');
const { detect, pickModel } = require('../../src/ai/cloud-keys');

test('keys are matched to their provider by shape; the default model is fast and current', () => {
  expect(detect('sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx')).toEqual(['anthropic']);
  expect(detect('sk-proj-abcdefghijklmnopqrstuvwxyz')).toEqual(['openai']);
  expect(detect('sk-or-v1-0123456789abcdef')).toEqual(['openrouter']);
  expect(detect('AIzaSyA1234567890abcdefghijklmnopqrstu')).toEqual(['gemini']);
  expect(detect('xai-abcdefghijklmnop')).toEqual(['xai']);
  expect(detect('gsk_abcdefghijklmnop')).toEqual(['groq']);
  expect(detect('sk-0123456789abcdef0123456789abcdef')).toEqual(['deepseek', 'openai']);
  expect(detect('Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4f')).toEqual(['mistral']);
  expect(detect('hello there')).toEqual([]);
  expect(pickModel('openai', ['gpt-4o-mini', 'gpt-5-mini', 'gpt-5.1-mini', 'gpt-5.1'])).toBe('gpt-5.1-mini');
  expect(pickModel('openai', ['gpt-4o-mini', 'gpt-5.1'], 'gpt-4o-mini')).toBe('gpt-4o-mini');
  expect(pickModel('openai', ['gpt-4o-mini'], 'gone-model')).toBe('gpt-4o-mini');
  expect(pickModel('gemini', ['models/gemini-2.5-flash', 'models/gemini-3-flash', 'models/gemini-3-pro'])).toBe('models/gemini-3-flash');
  expect(pickModel('openrouter', [])).toBe('openrouter/auto');
  expect(pickModel('xai', ['grok-4', 'grok-4-fast'])).toBe('grok-4-fast');
});

test.describe('with a mock provider API', () => {
  let mock;
  test.beforeAll(async () => { mock = await startMockCloud(); });
  test.afterAll(async () => { await mock?.close(); });

  test('an OpenAI key sets the gem: rejected keys crack it, a good one is saved encrypted and answers in ⌘T', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-cloud-'));
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_CLOUD_BASE: mock.base } });
    try {
      const { page } = m;
      await page.locator('#hp-insert').click();
      await page.locator('#pw-key').fill('sk-proj-badbadbadbadbadbadbadbad');
      await page.locator('#pw-go').click();
      await expect(page.locator('#pw-error')).toContainText('OpenAI didn’t accept this key');
      await expect(page.locator('#power')).toHaveClass(/cracked/);
      const good = 'sk-proj-goodgoodgoodgoodgoodgood';
      await page.locator('#pw-key').fill(good);
      await page.locator('#pw-go').click();
      await expect(page.locator('#pw-title')).toHaveText('Meridian is powered up', { timeout: 15_000 });
      await expect(page.locator('#pw-lead')).toContainText('OpenAI is set in');
      await expect(page.locator('.pw-power')).toHaveCount(2);
      await expect(page.locator('.pw-note')).toContainText('need a Claude key');
      expect(await page.evaluate(() => state.settings.aiProvider)).toBe('openai');
      // Encrypted at rest: the key itself is nowhere in the file.
      const stored = fs.readFileSync(path.join(userDataDir, 'ai-keys.json'), 'utf8');
      expect(JSON.parse(stored)).toHaveProperty('openai');
      expect(stored).not.toContain('goodgood');
      expect(mock.requests.filter((r) => r.path === '/models').map((r) => r.auth)).toEqual(['sk-proj-badbadbadbadbadbadbadbad', good]);
      await page.locator('#power [data-a="close"]').first().click();
      await expect(page.locator('#home-power')).toBeHidden();

      // Ask from the command bar: streamed by OpenAI's chat-completions API with the default model.
      await page.evaluate(() => openCommandBar('new'));
      await page.locator('#cmd-input').fill('what is a gem?');
      await expect(page.locator('#cmd-results .cmd-row[data-kind="ask"]')).toContainText('Ask ChatGPT');
      await page.locator('#cmd-results .cmd-row[data-kind="ask"]').click();
      await expect(page.locator('#cmd-answer')).toContainText('Mock openai (gpt-5.1-mini): what is a gem?', { timeout: 15_000 });
      const chat = mock.requests.find((r) => r.path === '/chat/completions');
      expect(chat.auth).toBe(good);
      expect(chat.body.stream).toBe(true);
      expect(chat.body.messages[0].role).toBe('system');
    } finally { await closeMeridian(m.app); fs.rmSync(userDataDir, { recursive: true, force: true }); }
  });

  test('new to keys: a step-by-step guide, and the key copied on the provider’s site is picked up by itself', async ({}, testInfo) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-cloud-'));
    const { startServer } = require('../fixtures/server');
    const server = await startServer();
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_CLOUD_BASE: mock.base } });
    try {
      const { page, app } = m;
      await page.locator('#hp-insert').click();
      await page.locator('.pw-faq summary').click();
      await expect(page.locator('.pw-faq')).toContainText('Is it safe?');
      await expect(page.locator('.pw-faq')).toContainText('never to us, never to websites');
      await page.evaluate((u) => { KEY_GUIDES[0].url = u; }, server.url('/p/aistudio'));
      await page.locator('.pw-chip', { hasText: 'Gemini' }).click();
      await expect(page.locator('#pw-guide li')).toHaveCount(3);
      await expect(page.locator('#pw-guide')).toContainText('Create API key');
      await page.locator('#pw-guide [data-a="go"]').click();
      await expect(page.locator('#power')).toHaveClass(/away/);
      await expect(page.locator('.pw-wait')).toContainText('Waiting for your Gemini key');
      await expect.poll(() => page.evaluate(() => tabUrl(activeTab()))).toContain('/p/aistudio');
      // Not a key: ignored. Then the real key is copied.
      await app.evaluate(() => { global.__e2e.clip.push('just some text'); });
      await page.waitForTimeout(1500);
      await expect(page.locator('.pw-wait')).toBeVisible();
      await app.evaluate(() => { global.__e2e.clip.push('AIzaSyA1234567890abcdefghijklmnopqrstu'); });
      await expect(page.locator('#pw-title')).toHaveText('Meridian is powered up', { timeout: 15_000 });
      await expect(page.locator('#pw-lead')).toContainText('Google Gemini is set in');
      await expect(page.locator('.pw-wait')).toHaveCount(0);
      expect(await page.evaluate(() => state.settings.aiProvider)).toBe('gemini');
      // The key itself never reached the page.
      expect(await page.evaluate(() => document.body.innerHTML.includes('abcdefghijklmnopqrstu'))).toBe(false);
    } finally { await closeMeridian(m.app); await server.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); }
  });

  test('Settings → AI: add a Gemini key, pick its model, remove it', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-cloud-'));
    const m = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_CLOUD_BASE: mock.base } });
    try {
      const { startServer } = require('../fixtures/server');
      const server = await startServer();
      await openTabDirect(m.page, server.url('/p/settings-host'));
      await clickIntoActivePage(m.page);
      const winPromise = m.app.waitForEvent('window', (w) => w.url().startsWith('meridian://app/settings.html'));
      await press(m, 'Meta+Comma');
      const sw = await winPromise;
      await sw.waitForSelector('#tabs .tab');
      await sw.locator('#tabs .tab[data-id="ai"]').click();
      await sw.locator('#ai-key').fill('AIzaSyA1234567890abcdefghijklmnopqrstu');
      await sw.locator('#ai-key-save').click();
      await expect(sw.locator('#cloud-key-rows')).toContainText('Google Gemini', { timeout: 10_000 });
      await expect.poll(() => m.page.evaluate(() => state.settings.aiProvider)).toBe('gemini');
      const row = sw.locator('.row.radio.agent', { has: sw.locator('input[value="gemini"]') });
      await expect(row).toHaveClass(/on/);
      const pickr = row.locator('select[data-model="gemini"]');
      await expect(pickr.locator('option')).toHaveCount(4, { timeout: 10_000 }); // Default + 3 chat models (no embeddings)
      await pickr.selectOption('models/gemini-3-pro');
      await expect.poll(() => m.page.evaluate(() => state.settings.aiModels?.gemini)).toBe('models/gemini-3-pro');
      // That model answers now.
      await m.page.evaluate(() => { openCommandBar('new'); });
      await m.page.locator('#cmd-input').fill('which model?');
      await m.page.locator('#cmd-results .cmd-row[data-kind="ask"]').click();
      await expect(m.page.locator('#cmd-answer')).toContainText('Mock gemini (models/gemini-3-pro)', { timeout: 15_000 });
      await m.page.keyboard.press('Escape');
      // Remove it.
      await sw.locator('[data-key-remove="gemini"]').click();
      await sw.locator('#dialog-overlay [data-a="ok"]').click();
      await expect(sw.locator('#cloud-key-rows')).not.toContainText('Google Gemini', { timeout: 10_000 });
      expect(JSON.parse(fs.readFileSync(path.join(userDataDir, 'ai-keys.json'), 'utf8'))).toEqual({});
      await server.close();
    } finally { await closeMeridian(m.app); fs.rmSync(userDataDir, { recursive: true, force: true }); }
  });
});
