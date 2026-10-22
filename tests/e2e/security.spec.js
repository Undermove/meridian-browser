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
    expect(page.url()).toBe('meridian://app/index.html');
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
    // The UI is served from meridian://app/, so no webContents at all may be on file:.
    expect((await allUrls(meridian.app)).some((u) => u.startsWith('file:'))).toBe(false);
    expect((await allUrls(meridian.app))).toContain('meridian://app/index.html');
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

  // Regression (high): a local HTML file opened in a tab (typed/pasted file:// URL) could read ANY local
  // file with fetch()/XHR, e.g. ~/.ssh/id_rsa, and send it anywhere (Electron grants file:// extra
  // privileges in dev; packaged builds have the fuse off). Main now blocks every file:// request from a
  // page except the main-frame navigation and the page itself (installFilePolicy in main.js).
  function localPage(dir, name, html) {
    const fs = require('fs');
    const path = require('path');
    const f = path.join(dir, name);
    fs.writeFileSync(f, html);
    return f;
  }

  test('a local HTML file opened in a tab cannot read other local files', async ({ meridian, page }) => {
    const fs = require('fs');
    const path = require('path');
    const secret = path.join(meridian.userDataDir, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET-TOKEN');
    const f = localPage(meridian.userDataDir, 'evil.html', `<title>evil</title><script>
      window.__r = 'pending';
      fetch(${JSON.stringify('file://' + secret)}).then((r) => r.text()).then((t) => { window.__r = t; }).catch((e) => { window.__r = 'blocked: ' + e.message; });
      window.__x = 'pending';
      const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify('file://' + secret)});
      x.onload = () => { window.__x = x.responseText; }; x.onerror = () => { window.__x = 'blocked'; };
      try { x.send(); } catch (e) { window.__x = 'blocked: ' + e.message; }
    </script>`);
    const id = await page.evaluate((u) => openTab(u).id, 'file://' + f);
    await waitTabLoaded(page, id);
    await expect.poll(() => inTab(page, id, 'window.__r')).not.toBe('pending');
    await expect.poll(() => inTab(page, id, 'window.__x')).not.toBe('pending');
    expect(await inTab(page, id, 'window.__r')).not.toContain('TOP-SECRET-TOKEN');
    expect(await inTab(page, id, 'window.__x')).not.toContain('TOP-SECRET-TOKEN');
    expect(await inTab(page, id, 'window.__r')).toMatch(/^blocked/);
  });

  test('a local HTML file still opens and shows, but its file:// subresources and iframes do not load', async ({ meridian, page }) => {
    const fs = require('fs');
    const path = require('path');
    // a 1×1 PNG next to the page
    fs.writeFileSync(path.join(meridian.userDataDir, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    fs.writeFileSync(path.join(meridian.userDataDir, 'other.html'), '<title>other</title><p id="o">OTHER-FILE</p>');
    const f = localPage(meridian.userDataDir, 'doc.html', `<title>Local Doc</title><h1 id="h">hello local</h1>
      <img id="pic" src="pic.png" onload="window.__img='loaded'" onerror="window.__img='blocked'">
      <iframe id="fr" src="other.html"></iframe>
      <script>window.__self = 'pending'; fetch(location.href).then((r) => r.text()).then((t) => { window.__self = t.includes('hello local') ? 'self-ok' : 'self-other'; }, () => { window.__self = 'self-blocked'; });</script>`);
    const id = await page.evaluate((u) => openTab(u).id, 'file://' + f);
    await waitTabLoaded(page, id);
    expect(await page.evaluate((id) => rt.views.get(id).getTitle(), id)).toBe('Local Doc');
    expect(await inTab(page, id, `document.querySelector('#h').textContent`)).toBe('hello local');
    await expect.poll(() => inTab(page, id, 'window.__img')).toBe('blocked');
    await expect.poll(() => inTab(page, id, 'window.__self')).toBe('self-ok'); // the page itself is allowed
    // the iframe's document never got the other file's content
    expect(await inTab(page, id, `(() => { try { return document.querySelector('#fr').contentDocument?.body?.innerText || ''; } catch (e) { return 'cross-origin'; } })()`)).not.toContain('OTHER-FILE');
    const frameUrls = await meridian.app.evaluate(({ webContents }, wcId) => webContents.fromId(wcId).mainFrame.framesInSubtree.map((fr) => fr.url), await page.evaluate((id) => rt.views.get(id).getWebContentsId(), id));
    expect(frameUrls.some((u) => u.endsWith('/other.html'))).toBe(false);
  });

  test('the file:// policy keeps working when another onBeforeRequest listener (the ad blocker) is set', async ({ meridian, page, server }) => {
    const fs = require('fs');
    const path = require('path');
    await openTabDirect(page, server.url('/p/warm')); // creates and prepares the profile session
    // what the ad blocker does when it is switched on: its own listener for every URL
    await meridian.app.evaluate(({ session }) => {
      global.__seen = [];
      session.fromPartition('persist:profile-default').webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => { global.__seen.push(d.url); cb(d.url.includes('/p/blocked-by-inner') ? { cancel: true } : {}); });
    });
    const secret = path.join(meridian.userDataDir, 'secret2.txt');
    fs.writeFileSync(secret, 'SECRET-TWO');
    const f = localPage(meridian.userDataDir, 'evil2.html', `<title>evil2</title><script>window.__r = 'pending'; fetch(${JSON.stringify('file://' + secret)}).then((r) => r.text()).then((t) => { window.__r = t; }, (e) => { window.__r = 'blocked'; });</script>`);
    const id = await page.evaluate((u) => openTab(u).id, 'file://' + f);
    await waitTabLoaded(page, id);
    await expect.poll(() => inTab(page, id, 'window.__r')).toBe('blocked');
    // the chained listener still sees (and can block) web requests
    const web = await page.evaluate((u) => openTab(u).id, server.url('/p/after-inner'));
    await waitTabLoaded(page, web);
    expect((await meridian.app.evaluate(() => global.__seen)).some((u) => u.includes('/p/after-inner'))).toBe(true);
    const blocked = await page.evaluate((u) => openTab(u).id, server.url('/p/blocked-by-inner'));
    await page.waitForTimeout(800);
    expect(server.hits.some((h) => h.includes('/p/blocked-by-inner'))).toBe(false);
    void blocked;
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

  // Regression: the external-app confirmation for links (maybeOpenExternal) defaulted to "Open", unlike every
  // other Meridian prompt; a stray Enter/Space while a page spams zoommtg:/msteams:/tel: links launched the app.
  test('external app prompt defaults to Cancel', async ({ meridian, page, server }) => {
    const id = await securityTab(page, server);
    await clickInTab(page, id, '#zoom');
    await expect.poll(async () => (await e2eLog(meridian.app)).dialogs.length).toBeGreaterThan(0);
    const d = (await e2eLog(meridian.app)).dialogs.at(-1);
    expect(d.buttons[d.defaultId]).toBe('Cancel');
    expect(d.buttons[d.cancelId]).toBe('Cancel');
    expect((await e2eLog(meridian.app)).external).toEqual([]);
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
    expect(log.dialogs).toEqual([]); // not even a prompt without a click/key in the page
    // window.open() of an external scheme without a gesture: same
    await inTab(page, id, `window.open('zoommtg://zoom.us/join?confno=3'); 1`);
    await page.waitForTimeout(500);
    expect((await e2eLog(meridian.app)).dialogs).toEqual([]);
    // …while a real click in the page still asks
    await clickInTab(page, id, '#zoom');
    await expect.poll(async () => (await e2eLog(meridian.app)).dialogs.length).toBe(1);
    expect((await e2eLog(meridian.app)).external).toEqual([]);
  });
});
