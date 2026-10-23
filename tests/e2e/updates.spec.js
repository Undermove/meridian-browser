// Update check (src/updates.js): a newer GitHub release shows a toast; the same version shows nothing.
// MERIDIAN_UPDATE_FEED points the check at the fixture server's fake "latest release".
const { test, expect, launchMeridian, closeMeridian } = require('../fixtures/meridian');
const { isNewer, assetFor, macInstallDir } = require('../../src/updates');
const { version } = require('../../package.json');

test.describe('update check', () => {
  test('version compare and asset choice', () => {
    expect(isNewer('0.2.15', '0.2.14')).toBe(true);
    expect(isNewer('0.2.10', '0.2.9')).toBe(true);
    expect(isNewer('0.3.0', '0.2.99')).toBe(true);
    expect(isNewer('0.2.14', '0.2.14')).toBe(false);
    expect(isNewer('0.2.13', '0.2.14')).toBe(false);
    expect(isNewer('0.3.0-beta', '0.2.14')).toBe(false);
    expect(isNewer('', '0.2.14')).toBe(false);

    const assets = ['Meridian-win.exe', 'Meridian-1.0.0-win.exe', 'Meridian-1.0.0-mac-arm64.dmg', 'Meridian-1.0.0-linux-amd64.deb']
      .map((name) => ({ name, browser_download_url: 'https://x/' + name }));
    expect(assetFor(assets, 'win32', 'x64')).toBe('https://x/Meridian-1.0.0-win.exe');
    expect(assetFor(assets, 'darwin', 'arm64')).toBe('https://x/Meridian-1.0.0-mac-arm64.dmg');
    expect(assetFor(assets, 'darwin', 'x64')).toMatch(/releases\/latest$/); // missing: the release page
    expect(assetFor(assets, 'linux', 'x64')).toBe('https://x/Meridian-1.0.0-linux-amd64.deb');

    expect(macInstallDir('/Volumes/Meridian/Meridian.app/Contents/MacOS/Meridian')).toBe(null);
    expect(macInstallDir('/private/var/folders/x/AppTranslocation/y/d/Meridian.app/Contents/MacOS/Meridian')).toBe(null);
    expect(macInstallDir('/usr/local/bin/meridian')).toBe(null);
  });

  test('a newer release shows a toast; × hides it', async ({ server, userDataDir }) => {
    const { app, page } = await launchMeridian({ userDataDir, env: { MERIDIAN_UPDATE_FEED: server.url('/release/v99.0.0') } });
    try {
      const t = page.locator('#toast-update');
      await expect(t).toContainText('Meridian 99.0.0 is available');
      await expect(t.locator('.toast-action')).toHaveText(process.platform === 'darwin' ? 'Update' : 'Download');
      await t.locator('.toast-close').click();
      await expect(t).toHaveCount(0);
      // main keeps the release it found, for a UI that boots after the check
      expect(await page.evaluate(() => api.updateLatest())).toMatchObject({ version: '99.0.0' });
    } finally { await closeMeridian(app); }
  });

  test('macOS: "Update" asks first; Later installs nothing', async ({ server, userDataDir }) => {
    test.skip(process.platform !== 'darwin', 'in-app install is macOS only');
    const { app, page } = await launchMeridian({ userDataDir, env: { MERIDIAN_UPDATE_FEED: server.url('/release/v99.0.0') } });
    try {
      await page.locator('#toast-update .toast-action').click();
      await expect.poll(() => app.evaluate(() => global.__e2e.dialogs.length)).toBe(1);
      const [d] = await app.evaluate(() => global.__e2e.dialogs);
      expect(d.message).toBe('Update Meridian to 99.0.0?');
      expect(d.buttons).toEqual(['Update and Restart', 'Later']);
      await expect(page.locator('#toast-update')).toContainText('is available'); // still offered
    } finally { await closeMeridian(app); }
  });

  test('Windows/Linux: "Download" opens the installer for this computer in a tab', async ({ server, userDataDir }) => {
    test.skip(process.platform === 'darwin', 'macOS installs in place');
    const { app, page } = await launchMeridian({ userDataDir, env: { MERIDIAN_UPDATE_FEED: server.url('/release/v99.0.0') } });
    try {
      await page.locator('#toast-update .toast-action').click();
      await expect(page.locator('#toast-update')).toHaveCount(0);
      expect(await page.evaluate(() => space().today[0].url)).toMatch(/\/p\/Meridian-99\.0\.0-(win\.exe|linux-)/);
    } finally { await closeMeridian(app); }
  });

  test('the same version shows nothing', async ({ server, userDataDir }) => {
    const { app, page } = await launchMeridian({ userDataDir, env: { MERIDIAN_UPDATE_FEED: server.url(`/release/v${version}`) } });
    try {
      await expect.poll(() => server.hits.some((h) => h.startsWith('/release/'))).toBe(true);
      await page.waitForTimeout(500);
      await expect(page.locator('#toast-update')).toHaveCount(0);
      expect(await page.evaluate(() => api.updateLatest())).toBe(null);
    } finally { await closeMeridian(app); }
  });
});
