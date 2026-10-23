// Features merged after the suite was first written: the Settings window, private windows, Air Traffic
// Control (links from other apps) and the full-window onboarding.
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
  test, expect, press, snapshot, openTabDirect, waitTabLoaded, clickIntoActivePage, e2eLog, ROOT,
} = require('../fixtures/meridian');
const S = require('../fixtures/state');

const SETTINGS_URL = 'meridian://app/settings.html';
const isSettings = (w) => w.url().startsWith(SETTINGS_URL);
const isPrivate = (w) => /^meridian:\/\/app\/index\.html\?private=meridian-private-/.test(w.url());

const windowsInfo = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), visible: w.isVisible() })));

async function openSettingsWithShortcut(meridian, server) {
  await openTabDirect(meridian.page, server.url('/p/settings-host'));
  await clickIntoActivePage(meridian.page);
  const winPromise = meridian.app.waitForEvent('window', isSettings);
  await press(meridian, 'Meta+Comma');
  const sw = await winPromise;
  await sw.waitForSelector('#tabs .tab');
  return sw;
}

// ---------------------------------------------------------------- Settings window

test.describe('Settings window', () => {
  test('⌘, in a web page opens the Settings window (once); ⌘, again reuses it', async ({ meridian, server }) => {
    const sw = await openSettingsWithShortcut(meridian, server);
    await expect(sw.locator('#tabs .tab.on')).toHaveAttribute('data-id', 'general');
    await expect(sw.locator('#engine')).toHaveValue('google');
    await clickIntoActivePage(meridian.page);
    await press(meridian, 'Meta+Comma');
    await meridian.page.waitForTimeout(300);
    expect((await windowsInfo(meridian.app)).filter((w) => w.url.startsWith(SETTINGS_URL))).toHaveLength(1);
    // the Settings page has no access to the main UI's API, only its own
    expect(await sw.evaluate(() => [typeof window.api, typeof window.meridianSettings])).toEqual(['undefined', 'object']);
  });

  test('a change applies live in the main window and persists across a relaunch', async ({ meridian, server }) => {
    const sw = await openSettingsWithShortcut(meridian, server);
    await sw.locator('.segmented[data-name="sidebar"] .seg[data-value="right"]').click();
    await expect(meridian.page.locator('body')).toHaveClass(/sidebar-right/);
    await sw.locator('#engine').selectOption('kagi');
    await expect.poll(() => meridian.page.evaluate(() => state.settings.searchEngine)).toBe('kagi');
    expect(await meridian.page.evaluate(() => resolveInput('two words'))).toContain('kagi.com');
    await sw.locator('#unload').selectOption('15');
    await expect.poll(() => meridian.page.evaluate(() => state.settings.unloadAfterMinutes)).toBe(15);
    // the main window's state comes back to the Settings window (one writer, live everywhere)
    await meridian.page.evaluate(() => { state.settings.sidebarRight = false; render(); save(); sendSnapshot(); });
    await expect(sw.locator('.segmented[data-name="sidebar"] .seg.on')).toHaveAttribute('data-value', 'left');
    await sw.locator('.segmented[data-name="sidebar"] .seg[data-value="right"]').click();
    await expect(meridian.page.locator('body')).toHaveClass(/sidebar-right/);
    await sw.close();

    const { page: p2 } = await meridian.relaunch();
    expect(await p2.evaluate(() => state.settings)).toMatchObject({ searchEngine: 'kagi', sidebarRight: true, unloadAfterMinutes: 15 });
    await expect(p2.locator('body')).toHaveClass(/sidebar-right/);
  });

  test('main drops patches the schema does not allow', async ({ meridian, server }) => {
    const sw = await openSettingsWithShortcut(meridian, server);
    const r = await sw.evaluate(() => Promise.all([
      window.meridianSettings.set({ searchEngine: 'evil-engine' }),
      window.meridianSettings.set({ onboarded: false, history: {} }),
      window.meridianSettings.set({ archiveAfterHours: 24, bogus: 1 }),
    ]));
    expect(r).toEqual([false, false, true]);
    await expect.poll(() => meridian.page.evaluate(() => state.settings.archiveAfterHours)).toBe(24);
    expect(await meridian.page.evaluate(() => [state.settings.searchEngine, state.onboarded, 'bogus' in state.settings])).toEqual(['google', true, false]);
  });
});

// ---------------------------------------------------------------- private windows

async function openPrivate(meridian, server) {
  await openTabDirect(meridian.page, server.url('/p/normal-host'));
  await clickIntoActivePage(meridian.page);
  const winPromise = meridian.app.waitForEvent('window', isPrivate);
  await press(meridian, 'Meta+Shift+N');
  const pw = await winPromise;
  await pw.waitForFunction(() => typeof state !== 'undefined' && state && document.body.classList.contains('private'));
  return pw;
}

async function connectMcp(userDataDir) {
  const client = new Client({ name: 'meridian-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'mcp', 'meridian-mcp.js')],
    env: { ...process.env, MERIDIAN_DATA_DIR: userDataDir }, stderr: 'pipe',
  }));
  return client;
}
const mcpText = async (client, name, args = {}) => ((await client.callTool({ name, arguments: args })).content || []).map((c) => c.text || '').join('\n');

test.describe('private windows', () => {
  test.use({ seed: async ({}, use) => use(S.seedState({ settings: { agentAccess: 'full' } })) });

  test('⇧⌘N opens a private window whose tabs use an in-memory partition', async ({ meridian, server }) => {
    const pw = await openPrivate(meridian, server);
    const partition = new URL(pw.url()).searchParams.get('private');
    expect(partition).toMatch(/^meridian-private-[\w-]+$/);
    const id = await pw.evaluate((u) => openTab(u).id, server.url('/cookie/set?v=secret-private'));
    await waitTabLoaded(pw, id);
    expect(await pw.evaluate((id) => rt.views.get(id).getAttribute('partition'), id)).toBe(partition); // no persist: prefix
    // the private session's cookie is not visible to the normal profile, and vice versa
    const normal = await openTabDirect(meridian.page, server.url('/cookie/show'));
    expect(await meridian.page.evaluate((id) => rt.views.get(id).executeJavaScript(`document.querySelector('#out').textContent`), normal)).toBe('cookie=[]');
    await openTabDirect(meridian.page, server.url('/cookie/set?v=normal'));
    const pshow = await pw.evaluate((u) => openTab(u).id, server.url('/cookie/show'));
    await waitTabLoaded(pw, pshow);
    expect(await pw.evaluate((id) => rt.views.get(id).executeJavaScript(`document.querySelector('#out').textContent`), pshow)).toBe('cookie=[meridian_test=secret-private]');
  });

  test('nothing from a private window is persisted', async ({ meridian, server }) => {
    await meridian.page.evaluate(() => api.saveState(saveParts({ slow: true })));
    const read = (f) => { try { return fs.readFileSync(path.join(meridian.userDataDir, f), 'utf8'); } catch { return ''; } };
    const pw = await openPrivate(meridian, server);
    await meridian.page.evaluate(() => api.saveState(saveParts({ slow: true })));
    const stateBefore = read('state.json');
    const id = await pw.evaluate((u) => openTab(u).id, server.url('/p/private-visit'));
    await waitTabLoaded(pw, id);
    await pw.evaluate(() => { save(); flushSave({ slow: true }); });
    // the private UI may not write state.json at all (main only accepts the main window's saves)
    await expect(pw.evaluate(() => api.saveState({ state: '{"spaces":[]}' }))).rejects.toThrow(/forbidden/);
    const closed = pw.waitForEvent('close');
    await pw.close();
    await closed;
    await meridian.page.evaluate(() => api.saveState(saveParts({ slow: true })));
    await meridian.page.waitForTimeout(300);
    for (const f of ['state.json', 'history.json']) expect(read(f)).not.toContain('private-visit');
    expect(JSON.parse(read('state.json')).spaces).toEqual(JSON.parse(stateBefore).spaces);
    expect(await meridian.page.evaluate(() => Object.keys(state.history).some((u) => u.includes('private-visit')))).toBe(false);
    // in-memory partitions never get a directory on disk
    const parts = fs.existsSync(path.join(meridian.userDataDir, 'Partitions')) ? fs.readdirSync(path.join(meridian.userDataDir, 'Partitions')) : [];
    expect(parts.some((p) => p.includes('private'))).toBe(false);
  });

  test('agents cannot see or drive private tabs', async ({ meridian, server }) => {
    const pw = await openPrivate(meridian, server);
    const id = await pw.evaluate((u) => openTab(u).id, server.url('/p/private-agent'));
    await waitTabLoaded(pw, id);
    await expect.poll(() => fs.existsSync(path.join(meridian.userDataDir, 'agent-endpoint.json'))).toBe(true);
    const mcp = await connectMcp(meridian.userDataDir);
    try {
      expect(await mcpText(mcp, 'list_tabs')).not.toContain('private-agent');
      expect(await mcpText(mcp, 'search_tabs', { query: 'private-agent' })).not.toContain('private-agent');
      expect(await mcpText(mcp, 'search_history', { query: 'private-agent' })).not.toContain('private-agent');
      const r = await mcpText(mcp, 'read_page', { tab_id: id });
      expect(r).not.toContain('content-private-agent');
      expect(r).toMatch(/no tab with id/i);
    } finally { await mcp.close().catch(() => {}); }
    // the private window's UI never answers agent RPCs (no agent wiring there)
    expect(await pw.evaluate(() => typeof initAgentRpc === 'function' && !!document.querySelector('#agent-bar'))).toBe(false);
  });
});

// ---------------------------------------------------------------- Air Traffic Control

test.describe('Air Traffic Control', () => {
  test.use({
    seed: async ({}, use) => {
      const a = S.space('Home');
      const b = S.space('Work');
      use(S.seedState({ spaces: [a, b] }));
    },
  });

  // The same code paths main uses for links from other apps: app 'open-url' (macOS) and 'second-instance'.
  const openUrl = (app, url) => app.evaluate(({ app: a }, u) => a.emit('open-url', { preventDefault() {} }, u), url);
  const secondInstance = (app, url) => app.evaluate(({ app: a }, u) => a.emit('second-instance', {}, ['/Applications/Meridian.app/Contents/MacOS/Meridian', u], process.cwd()), url);

  test('rules set in Settings → Links route links to a space, the current space or the Little window', async ({ meridian, server }) => {
    const { page } = meridian;
    const work = await page.evaluate(() => state.spaces[1].id);
    // main routes with the UI's latest snapshot (sent debounced after every change): observe what main got
    await meridian.app.evaluate(({ ipcMain }) => { global.__atc = null; ipcMain.on('ui:snapshot', (_e, snap) => { global.__atc = snap?.settings?.atc || null; }); });
    const mainAtc = () => meridian.app.evaluate(() => JSON.stringify(global.__atc));
    const sw = await openSettingsWithShortcut(meridian, server);
    await sw.locator('#tabs .tab[data-id="links"]').click();
    await sw.locator('#add-rule').click();
    const rule = sw.locator('.rule').last();
    await rule.locator('.rule-pattern').fill('localhost');
    await rule.locator('.rule-pattern').press('Tab');
    await rule.locator('.rule-target').selectOption(`space:${work}`);
    await expect.poll(() => page.evaluate(() => JSON.stringify(state.settings.atc?.rules || []))).toContain(`space:${work}`);
    await expect.poll(mainAtc).toContain(`space:${work}`);
    // "Try it" in Settings uses main's router with the same rules
    await sw.locator('#test-url').fill(server.other + '/p/x');
    await expect(sw.locator('#test-result')).toContainText('Work');
    await expect(sw.locator('#test-result')).toContainText('localhost');

    // 1. a matching link → a new tab in the Work space (and the main window switches to it)
    await openUrl(meridian.app, server.other + '/p/to-work');
    await expect.poll(() => snapshot(page).then((s) => [s.spaceName, s.activeUrl])).toEqual(['Work', server.other + '/p/to-work']);
    // 2. no rule matches → the Little window (the default fallback)
    const mini = meridian.app.waitForEvent('window', (w) => w.url().includes('mini=1'));
    await secondInstance(meridian.app, server.url('/p/to-little'));
    const mw = await mini;
    expect(new URL(mw.url()).searchParams.get('url')).toBe(server.url('/p/to-little'));
    await mw.close();
    // 3. fallback switched to "Current Space" → a tab in whatever space is active
    await page.evaluate(() => runCommand('space-index', 0));
    await sw.locator('#fallback').selectOption('main');
    await expect.poll(() => page.evaluate(() => state.settings.atc?.fallback)).toBe('main');
    await expect.poll(mainAtc).toContain('"fallback":"main"');
    await secondInstance(meridian.app, server.url('/p/to-current'));
    await expect.poll(() => snapshot(page).then((s) => [s.spaceName, s.activeUrl])).toEqual(['Home', server.url('/p/to-current')]);
    // 4. the rule still wins over the fallback
    await openUrl(meridian.app, server.other + '/p/to-work-2');
    await expect.poll(() => snapshot(page).then((s) => [s.spaceName, s.activeUrl])).toEqual(['Work', server.other + '/p/to-work-2']);
    expect((await windowsInfo(meridian.app)).filter((w) => w.url.includes('mini=1'))).toHaveLength(0);
  });

  test('non-web URLs from other apps are ignored', async ({ meridian }) => {
    const before = await snapshot(meridian.page);
    await openUrl(meridian.app, 'file:///etc/hosts');
    await openUrl(meridian.app, 'javascript:alert(1)');
    await secondInstance(meridian.app, 'meridian://app/settings.html');
    await meridian.page.waitForTimeout(500);
    const after = await snapshot(meridian.page);
    expect(after.todayCount).toBe(before.todayCount);
    expect((await windowsInfo(meridian.app)).map((w) => w.url).filter((u) => u.includes('mini=1') || u.startsWith('file:'))).toEqual([]);
  });
});

// ---------------------------------------------------------------- onboarding

test.describe('onboarding', () => {
  test.use({ seed: async ({}, use) => { const s = S.seedState(); s.onboarded = false; use(s); } });

  test('a fresh profile gets the tour (no Arc → a local suggestion, then links); no AI in it; saves onboarded', async ({ meridian }) => {
    const { page } = meridian;
    await expect(page.locator('#onboarding')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/onboarding/);
    await expect(page.locator('#onboarding .ob-hello-word')).toBeVisible();
    expect(await page.evaluate(() => ob.steps)).toEqual(['hello', 'tailor', 'preview', 'default', 'done']);
    const next = page.locator('#onboarding [data-ob="next"]');
    await next.click();
    await expect(page.locator('.ob-step-tailor h2')).toBeVisible();
    await expect(page.locator('.ob-step-tailor')).toContainText('nothing is sent anywhere');
    await next.click();
    await expect(page.locator('.ob-step-preview h2')).toHaveText('Here’s your Meridian', { timeout: 20_000 });
    const proposal = await page.evaluate(() => ob.proposal);
    expect(proposal.source).toBe('rules');
    await page.locator('.ob-pv-fav').first().click(); // leave the first favorite out
    await next.click();
    await expect(page.locator('.ob-step-default h2')).toHaveText('Open your links in Meridian?');
    await expect(next).toHaveText('Not now');
    await next.click();
    await expect(page.locator('.ob-step-done h1')).toHaveText('You’re all set');
    await next.click();
    await expect(page.locator('#onboarding')).toHaveCount(0);
    const st = await page.evaluate(() => ({ onboarded: state.onboarded, at: state.onboardedAt, mode: state.settings.mode, favs: state.favorites.default.map((t) => t.url), name: state.spaces[0].name }));
    expect(st.onboarded).toBe(true);
    expect(st.at).toBeGreaterThan(0);
    expect(st.mode).toBe(proposal.mode);
    expect(st.favs).toEqual(proposal.favorites.slice(1).map((f) => f.url));
    expect(st.name).toBe(proposal.spaces[0].name);
    const { page: p2 } = await meridian.relaunch();
    await p2.waitForTimeout(500);
    await expect(p2.locator('#onboarding')).toHaveCount(0);
  });

  test('AI is offered once, a couple of days after moving in — not during the tour', async ({ meridian }) => {
    const { page } = meridian;
    await page.locator('#onboarding [data-ob="skip"]').click();
    await page.evaluate(() => maybeOfferAi());
    await expect(page.locator('.ai-offer')).toHaveCount(0); // just moved in
    await page.evaluate(() => { state.onboardedAt = Date.now() - 3 * 24 * 3600 * 1000; maybeOfferAi(); });
    await expect(page.locator('.ai-offer h3')).toHaveText('Meridian can also answer your questions');
    await page.locator('.ai-offer [data-a="later"]').click();
    await page.evaluate(() => maybeOfferAi());
    await expect(page.locator('.ai-offer')).toHaveCount(0); // only once
  });

  test('the tour can be skipped, and comes back from Help → Welcome Tour', async ({ meridian }) => {
    const { page } = meridian;
    await expect(page.locator('#onboarding')).toBeVisible();
    await page.locator('#onboarding [data-ob="skip"]').click();
    await expect(page.locator('#onboarding')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => state.onboarded)).toBe(true);
    // Help → Welcome Tour… (the real menu item)
    await meridian.app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu().items.find((m) => m.role === 'help' || m.label === 'Help');
      help.submenu.items.find((i) => i.label === 'Welcome Tour…').click();
    });
    await expect(page.locator('#onboarding')).toBeVisible();
    await expect(page.locator('#onboarding .ob-hello-word')).toBeVisible();
  });

  // Synthetic clicks ignore window drag regions, so this checks the CSS instead: a drag region over the
  // tour (or its full-size ::after layer) swallowed every real click on Continue in 0.2.0/0.2.1.
  test('the tour only drags the window by its top strip, so real clicks reach the buttons', async ({ meridian }) => {
    const { page } = meridian;
    await expect(page.locator('#onboarding')).toBeVisible();
    const regions = await page.evaluate(() => {
      const r = (el, pseudo) => getComputedStyle(el, pseudo).webkitAppRegion;
      const ob = document.querySelector('#onboarding');
      return { root: r(ob), after: r(ob, '::after'), stage: r(document.querySelector('.ob-stage')), foot: r(document.querySelector('.ob-foot')), next: r(document.querySelector('[data-ob="next"]')), top: r(document.querySelector('.ob-top')) };
    });
    expect(regions).toEqual({ root: 'no-drag', after: 'no-drag', stage: 'no-drag', foot: 'no-drag', next: 'no-drag', top: 'drag' });
  });

  test('app shortcuts don\'t act behind the open tour', async ({ meridian }) => {
    const { page } = meridian;
    await expect(page.locator('#onboarding')).toBeVisible();
    await press(meridian, 'Meta+S');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => state.settings.sidebarHidden)).toBe(false);
    void e2eLog;
  });
});
