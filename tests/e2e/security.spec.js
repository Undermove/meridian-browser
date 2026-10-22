// Security regressions: pages must not reach file://, run privileged schemes, open external apps
// silently, or see the preload API (window.meridian).
const { test, expect, openTabDirect, waitTabLoaded, clickInTab, inTab, e2eLog, setDialogResponse, snapshot } = require('../fixtures/meridian');

async function securityTab(page, server) {
  return openTabDirect(page, server.url('/security'));
}
const allUrls = (app) => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()));

test.describe('web content isolation', () => {
  test('pages cannot reach window.meridian, require or process', async ({ page, server }) => {
    const id = await securityTab(page, server);
    expect(await inTab(page, id, 'window.__probe')).toEqual({ meridian: 'undefined', require: 'undefined', process: 'undefined', electron: 'undefined' });
    expect(await inTab(page, id, 'typeof window.meridian')).toBe('undefined');
  });

  test('a page-opened popup window gets no preload either', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    const popupPromise = meridian.app.waitForEvent('window', (w) => w.url().includes('/p/popup'));
    await inTab(page, id, `window.open(${JSON.stringify(server.url('/p/popup'))}, 'pop', 'width=400,height=400'); 1`);
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => [typeof window.meridian, typeof require, typeof process].join('/'))).toBe('undefined/undefined/undefined');
    await popup.close();
  });

  test('the UI page refuses to navigate away', async ({ meridian, page, server }) => {
    await page.evaluate((u) => { location.href = u; }, server.url('/p/hijack')).catch(() => {});
    await page.waitForTimeout(500);
    expect(page.url()).toContain('renderer/index.html');
    expect(await page.evaluate(() => typeof state)).toBe('object');
    void meridian;
  });
});

test.describe('file:// and privileged schemes', () => {
  test('window.open(file://) is denied: no window, no tab', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    const before = (await snapshot(page)).todayCount;
    await clickInTab(page, id, '#open-file');
    await page.waitForTimeout(700);
    expect(await inTab(page, id, 'window.__r')).toBe('null');
    expect((await snapshot(page)).todayCount).toBe(before);
    expect((await allUrls(meridian.app)).some((u) => u.startsWith('file:///etc'))).toBe(false);
  });

  test('location = file:// is blocked and the page stays put', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#nav-file');
    await page.waitForTimeout(700);
    expect(await page.evaluate((id) => rt.views.get(id).getURL(), id)).toBe(server.url('/security'));
    expect((await allUrls(meridian.app)).some((u) => u.startsWith('file:///etc'))).toBe(false);
  });

  test('clicking file:// links (same tab and target=_blank) does nothing', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#file-link');
    await clickInTab(page, id, '#blank-file');
    await page.waitForTimeout(700);
    expect(await page.evaluate((id) => rt.views.get(id).getURL(), id)).toBe(server.url('/security'));
    expect((await snapshot(page)).todayCount).toBe(1);
    expect((await allUrls(meridian.app)).some((u) => u.startsWith('file:'))).toBe(true); // only the UI itself
    expect((await allUrls(meridian.app)).filter((u) => u.startsWith('file:')).every((u) => u.includes('renderer/index.html'))).toBe(true);
  });

  test('a server redirect to file:// is blocked', async ({ meridian, page, server }) => {
    const id = await page.evaluate((u) => openTab(u).id, server.url('/redirect-file'));
    await page.waitForTimeout(1500);
    const url = await page.evaluate((id) => rt.views.get(id).getURL(), id);
    expect(url.startsWith('file:')).toBe(false);
    expect((await allUrls(meridian.app)).some((u) => u.startsWith('file:///etc'))).toBe(false);
  });

  test('a file:// URL typed in the command bar is not opened by a page-less tab', async ({ meridian, page }) => {
    // Typing file:///… is a deliberate user action; make sure it at least can't escalate into the UI's privileges.
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.insertText('file:///etc/hosts');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const r = await page.evaluate(async () => { const wv = rt.views.get(space().activeTabId); try { return { url: wv.getURL(), meridian: await wv.executeJavaScript('typeof window.meridian') }; } catch (e) { return { err: e.message }; } });
    test.info().annotations.push({ type: 'typed file:// result', description: JSON.stringify(r) });
    expect(r.meridian === undefined || r.meridian === 'undefined').toBe(true);
    void meridian;
  });

  // BUG (high): a local HTML file opened in a tab (typed/pasted file:// URL — webviews accept file: src,
  // main.js:355, and toUrl() passes file: through, app.js:133) can read ANY local file with fetch()/XHR,
  // e.g. ~/.ssh/id_rsa, and send it anywhere. Chrome forbids file:// → file:// reads. Cause: file:// gets
  // Electron's extra privileges (GrantFileProtocolExtraPrivileges — default in dev, and explicitly re-enabled
  // for packaged builds in package.json "electronFuses" because the UI itself loads from file://).
  test('a local HTML file opened in a tab cannot read other local files', async ({ meridian, page }) => {
    test.fail(true, 'BUG: file:// pages can read arbitrary local files');
    const fs = require('fs');
    const path = require('path');
    const secret = path.join(meridian.userDataDir, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET-TOKEN');
    const f = path.join(meridian.userDataDir, 'evil.html');
    fs.writeFileSync(f, `<title>evil</title><script>
      window.__r = 'pending';
      fetch(${JSON.stringify('file://' + secret)}).then((r) => r.text()).then((t) => { window.__r = t; }).catch((e) => { window.__r = 'blocked: ' + e.message; });
    </script>`);
    const id = await page.evaluate((u) => openTab(u).id, 'file://' + f);
    await waitTabLoaded(page, id);
    await expect.poll(() => inTab(page, id, 'window.__r')).not.toBe('pending');
    expect(await inTab(page, id, 'window.__r')).not.toContain('TOP-SECRET-TOKEN');
  });

  test('javascript: typed in the command bar becomes a search, never runs', async ({ page }) => {
    await page.evaluate(() => runCommand('command-bar'));
    await page.keyboard.insertText('javascript:document.title="PWNED"');
    await expect(page.locator('#cmd-results .cmd-row.sel .cmd-sub')).toHaveText(/^Search /);
    await page.keyboard.press('Escape');
  });

  test('javascript: links run only inside their own page (no navigation, no UI access)', async ({ page, server }) => {
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#js-link');
    await page.waitForTimeout(400);
    expect(await page.evaluate((id) => rt.views.get(id).getURL(), id)).toBe(server.url('/security'));
    expect(await page.evaluate(() => document.title)).toBe('Meridian');
  });
});

test.describe('external protocols', () => {
  test('mailto: link asks first; cancelling opens nothing', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#mailto');
    await expect.poll(async () => (await e2eLog(meridian.app)).dialogs.length).toBeGreaterThan(0);
    const log = await e2eLog(meridian.app);
    expect(log.dialogs.at(-1).detail).toContain('mailto:someone@example.com');
    expect(log.external).toEqual([]);
  });

  // BUG: the external-app confirmation for links (maybeOpenExternal, src/main.js:334) uses defaultId: 0
  // ("Open"), unlike every other Meridian prompt (defaultId = Cancel/Deny). A stray Enter/Space while a page
  // spams zoommtg:/msteams:/tel: links launches the app.
  test('external app prompt defaults to Cancel', async ({ meridian, page, server }) => {
    test.fail(true, 'BUG: external protocol dialog defaults to "Open"');
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#zoom');
    await expect.poll(async () => (await e2eLog(meridian.app)).dialogs.length).toBeGreaterThan(0);
    const d = (await e2eLog(meridian.app)).dialogs.at(-1);
    expect(d.buttons[d.defaultId]).toBe('Cancel');
  });

  test('allowing the prompt hands the URL to the OS exactly once', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await setDialogResponse(meridian.app, 0);
    await clickInTab(page, id, '#zoom');
    await expect.poll(async () => (await e2eLog(meridian.app)).external).toEqual(['zoommtg://zoom.us/join?confno=1']);
  });

  test('unknown schemes are dropped silently (never handed to the OS)', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#custom');
    await page.waitForTimeout(700);
    const log = await e2eLog(meridian.app);
    expect(log.external).toEqual([]);
    expect(log.dialogs).toEqual([]);
  });

  test('a server redirect to mailto: does not open silently', async ({ meridian, page, server }) => {
    await page.evaluate((u) => openTab(u), server.url('/redirect-mailto'));
    await page.waitForTimeout(1500);
    expect((await e2eLog(meridian.app)).external).toEqual([]);
  });

  test('a page cannot open an external app without a user gesture', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await inTab(page, id, `location.href = 'zoommtg://zoom.us/join?confno=2'; 1`);
    await page.waitForTimeout(700);
    const log = await e2eLog(meridian.app);
    test.info().annotations.push({ type: 'dialogs for gesture-less external nav', description: String(log.dialogs.length) });
    expect(log.external).toEqual([]);
  });
});
