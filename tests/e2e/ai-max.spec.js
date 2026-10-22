// Arc Max-style AI features + the ⌘J assistant in Mission Control, against a mock Anthropic API
// (tests/fixtures/mock-anthropic.js, SSE). ANTHROPIC_BASE_URL points the SDK at it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, waitTabLoaded } = require('../fixtures/meridian');
const S = require('../fixtures/state');
const { startMockAnthropic } = require('../fixtures/mock-anthropic');

let mock;
test.beforeAll(async () => { mock = await startMockAnthropic(); });
test.afterAll(async () => { await mock?.close(); });
test.beforeEach(() => { mock.requests.length = 0; });

async function launch(state, env = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-ai-'));
  const m = await launchMeridian({ userDataDir, state, env: { ANTHROPIC_BASE_URL: mock.base, ANTHROPIC_API_KEY: 'test', ...env } });
  return { ...m, userDataDir, cleanup: async () => { await closeMeridian(m.app); fs.rmSync(userDataDir, { recursive: true, force: true }); } };
}

test('⌘J assistant run shows up in Mission Control with its browser tool call', async () => {
  const m = await launch(seedState({ settings: { agentAccess: 'read', aiUseTools: true } }));
  try {
    const { page } = m;
    await page.evaluate(() => { toggleAiPanel(true); });
    await expect(page.locator('#ai-tools')).toBeChecked();
    await page.evaluate(() => sendAi('What tabs do I have open?'));
    await expect(page.locator('#ai-messages .ai-msg.assistant').last()).toContainText('Mock answer', { timeout: 15_000 });
    await expect.poll(async () => (await page.evaluate(() => mc.snap)).nodes.find((n) => n.kind === 'assistant')?.status).toBe('done');
    const node = (await page.evaluate(() => mc.snap)).nodes.find((n) => n.kind === 'assistant');
    expect(node).toMatchObject({ where: 'assistant', label: '⌘J Assistant', toolCalls: 1 });
    expect(node.log.map((l) => l.name)).toEqual(['list_tabs']);
    // Same plumbing as before: model, refusal fallback, tool_result round trip.
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[0].body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default' });
    expect(mock.requests[0].headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(JSON.stringify(mock.requests[1].body.messages.at(-1))).toContain('tool_result');
    // Prompt and answer text are not kept in Mission Control.
    expect(JSON.stringify(await page.evaluate(() => mc.snap))).not.toMatch(/What tabs|Mock answer/);
  } finally { await m.cleanup(); }
});

test('Ask Claude from the command bar opens ⌘J with the question', async () => {
  const m = await launch(seedState());
  try {
    const { page } = m;
    await page.evaluate(() => openCommandBar('new'));
    await page.locator('#cmd-input').fill('how do spaces and profiles work');
    const row = page.locator('#cmd-results .cmd-row', { hasText: 'Ask Claude' });
    await expect(row).toHaveCount(1);
    await row.dispatchEvent('mousedown');
    await expect(page.locator('body')).toHaveClass(/ai-open/);
    await expect(page.locator('#ai-messages .ai-msg.user')).toHaveText('how do spaces and profiles work');
    await expect(page.locator('#ai-messages .ai-msg.assistant').last()).toContainText('Mock answer: how do spaces and profiles work', { timeout: 15_000 });
    // URLs don't offer it, and it can be turned off.
    await page.evaluate(() => openCommandBar('new'));
    await page.locator('#cmd-input').fill('example.com');
    await expect(page.locator('#cmd-results .cmd-row', { hasText: 'Ask Claude' })).toHaveCount(0);
    await page.evaluate(() => { applySettingsPatch({ aiAskFromBar: false }); openCommandBar('new'); });
    await page.locator('#cmd-input').fill('how do spaces work');
    await expect(page.locator('#cmd-results .cmd-row', { hasText: 'Ask Claude' })).toHaveCount(0);
  } finally { await m.cleanup(); }
});

test('Tidy Today: preview diff, nothing changes until Apply, partial accept', async ({ server }) => {
  const today = [S.tab(server.url('/p/alpha'), { title: 'Alpha — Fixture Site | Company' }), S.tab(server.url('/p/beta'), { title: 'Beta — Fixture Site' }), S.tab(server.url('/p/gamma'), { title: 'Gamma: a very long and noisy title (3 new notifications)' })];
  const m = await launch(seedState({ spaces: [S.space('Work', { today })] }));
  try {
    const { page } = m;
    const before = await page.evaluate(() => JSON.stringify([space().pinned, space().today.map((t) => [t.id, t.customTitle || null])]));
    // Cancel first: nothing changes.
    await page.evaluate(() => runCommand('ai-tidy'));
    await expect(page.locator('#tidy-overlay .tidy-group-head', { hasText: 'Fixture Pages' })).toHaveCount(1, { timeout: 15_000 });
    await page.locator('#tidy-overlay .tidy-foot [data-a="close"]').click();
    expect(await page.evaluate(() => JSON.stringify([space().pinned, space().today.map((t) => [t.id, t.customTitle || null])]))).toBe(before);
    // The request: tabs as untrusted data, structured output, same model + fallback.
    const body = mock.requests[0].body;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages[0].content).toContain('<untrusted_tabs>');
    expect(body.messages[0].content).toContain('Alpha — Fixture Site | Company');

    // Again: untick the rename, apply the folder only.
    await page.evaluate(() => runCommand('ai-tidy'));
    await expect(page.locator('#tidy-overlay .tidy-new')).toHaveText('Short Title', { timeout: 15_000 });
    await expect(page.locator('#tidy-overlay .tidy-old')).toHaveText(/Gamma: a very long/);
    if (process.env.MERIDIAN_MC_SHOTS) await page.screenshot({ path: path.join(process.env.MERIDIAN_MC_SHOTS, 'tidy-preview.png') });
    await page.locator('#tidy-overlay [data-rename]').uncheck();
    await page.locator('#tidy-overlay [data-a="apply"]').click();
    const after = await page.evaluate(() => ({ pinned: space().pinned.map((n) => ({ type: n.type, title: n.title, kids: (n.children || []).map((c) => c.url || c.currentUrl) })), today: space().today.map((t) => ({ url: t.url, custom: t.customTitle || null })) }));
    expect(after.pinned).toEqual([{ type: 'folder', title: 'Fixture Pages', kids: [server.url('/p/alpha'), server.url('/p/beta')] }]);
    expect(after.today).toEqual([{ url: server.url('/p/gamma'), custom: null }]);
  } finally { await m.cleanup(); }
});

test('link preview: Shift over a link shows a Claude summary of the target page (only when enabled)', async ({ server }) => {
  // The fixture server is local; previews refuse local targets except this dev/test allowance.
  const m = await launch(seedState({ settings: { aiLinkPreview: false } }), { MERIDIAN_TEST_PREVIEW_ALLOW: new URL(server.other).host });
  try {
    const { page, app } = m;
    const id = await page.evaluate((u) => openTab(u).id, server.url('/links'));
    await waitTabLoaded(page, id, server.url('/links'));
    const hoverShift = async () => {
      const { wcId, x, y } = await page.evaluate(async (tabId) => {
        const wv = rt.views.get(tabId);
        const r = await wv.executeJavaScript(`(() => { const a = document.getElementById('ext-nav'); const b = a.getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 }; })()`);
        return { wcId: wv.getWebContentsId(), ...r };
      }, id);
      await app.evaluate(({ webContents }, { wcId, x, y }) => {
        const wc = webContents.fromId(wcId);
        wc.focus();
        wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x) + 1, y: Math.round(y) });
        wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
      }, { wcId, x, y });
      await page.waitForTimeout(400);
      await app.evaluate(({ webContents }, { wcId }) => {
        const wc = webContents.fromId(wcId);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
      }, { wcId });
    };
    await hoverShift();
    await page.waitForTimeout(800);
    await expect(page.locator('#link-preview')).toHaveCount(0);
    expect(mock.requests).toHaveLength(0);

    await page.evaluate(() => applySettingsPatch({ aiLinkPreview: true }));
    await expect.poll(() => app.evaluate(() => global.__meridianMission && true)).toBe(true);
    // settings reach main through the UI snapshot
    await page.evaluate(() => sendSnapshot());
    await page.waitForTimeout(200);
    await app.evaluate(({ webContents }) => { for (const wc of webContents.getAllWebContents()) if (wc.getType() === 'webview') wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' }); });
    await hoverShift();
    await expect(page.locator('#link-preview .lp-host')).toHaveText(new URL(server.other).host, { timeout: 10_000 });
    await expect(page.locator('#link-preview .lp-summary')).toHaveText(/A fixture page used by the Meridian tests/, { timeout: 15_000 });
    await expect(page.locator('#link-preview .lp-title')).toHaveText('navigated');
    if (process.env.MERIDIAN_MC_SHOTS) await page.screenshot({ path: path.join(process.env.MERIDIAN_MC_SHOTS, 'link-preview.png') });
    // The page was fetched in main and sent as untrusted content.
    const req = mock.requests.find((r) => /link-preview card/.test(r.body.system));
    expect(req.body.messages[0].content).toContain('<untrusted_page_content');
    expect(req.body.messages[0].content).toContain('content-navigated');
    // Cached per URL: a second preview makes no new request.
    const n = mock.requests.length;
    const again = await page.evaluate((u) => api.linkPreviewTest(u), server.other + '/p/navigated');
    expect(again.summary).toMatch(/fixture page/);
    expect(mock.requests.length).toBe(n);
    // Open in Peek from the card.
    await page.locator('#link-preview [data-a="peek"]').click();
    await expect(page.locator('#peek')).toBeVisible();
  } finally { await m.cleanup(); }
});

test('link preview: no cookies, no local/private targets, redirects re-checked', async ({ server }) => {
  const m = await launch(seedState({ settings: { aiLinkPreview: true } }), { MERIDIAN_TEST_PREVIEW_ALLOW: new URL(server.other).host });
  try {
    const { page } = m;
    // A cookie for the (allowed) site in the profile the tab uses.
    const id = await page.evaluate((u) => openTab(u).id, server.other + '/cookie/set?v=SECRET-COOKIE-VALUE');
    await waitTabLoaded(page, id, server.other + '/cookie/set?v=SECRET-COOKIE-VALUE');
    await page.evaluate(() => sendSnapshot());
    await expect.poll(() => page.evaluate((u) => api.linkPreviewTest(u).then((r) => !!r), server.other + '/p/warm')).toBe(true);
    mock.requests.length = 0;
    const r = await page.evaluate((u) => api.linkPreviewTest(u), server.other + '/cookie/show');
    expect(r.summary).toMatch(/fixture page/);
    const sent = mock.requests.find((x) => /link-preview card/.test(x.body.system)).body.messages[0].content;
    expect(sent).toContain('cookie=[]');
    expect(sent).not.toContain('SECRET-COOKIE-VALUE');
    // Loopback (127.0.0.1 is not the allowed host), a redirect into it, and non-http redirects: refused before any model call.
    mock.requests.length = 0;
    for (const u of [server.url('/p/local'), 'http://169.254.169.254/latest/meta-data/', server.other + '/redirect-to?u=' + encodeURIComponent(server.url('/p/local')), server.other + '/redirect-file']) {
      const res = await page.evaluate((x) => api.linkPreviewTest(x), u);
      expect(res?.error, u).toBeTruthy();
    }
    expect(mock.requests).toHaveLength(0);
  } finally { await m.cleanup(); }
});
