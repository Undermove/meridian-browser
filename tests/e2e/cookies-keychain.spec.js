// Saved sign-ins survive restarts (and updates, which are a quit + relaunch); and when the keychain key
// that encrypts them can't be read at launch (keychainReady in main.js), Meridian opens nothing that
// would load cookies, so Chromium can't drop them, and asks for a restart instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, openTabDirect, inTab, ROOT } = require('../fixtures/meridian');
const { _electron: electron } = require('@playwright/test');
const { startServer } = require('../fixtures/server');

const cookiesFile = (dir) => ['Network/Cookies', 'Cookies'].map((f) => path.join(dir, 'Partitions', 'profile-default', f)).find((f) => fs.existsSync(f));

test('sign-ins (cookies) survive a quit and relaunch', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-cookies-'));
  const server = await startServer();
  try {
    let m = await launchMeridian({ userDataDir, state: seedState() });
    await openTabDirect(m.page, server.url('/cookie/set?v=still-here'));
    await closeMeridian(m.app);
    expect(cookiesFile(userDataDir)).toBeTruthy();
    m = await launchMeridian({ userDataDir, keepState: true });
    const id = await openTabDirect(m.page, server.url('/cookie/show'));
    expect(await inTab(m.page, id, 'document.getElementById("out").textContent')).toContain('meridian_test=still-here');
    await closeMeridian(m.app);
  } finally { await server.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); }
});

test('a locked keychain at launch: nothing opens, saved cookies stay untouched, Meridian asks to restart', async () => {
  test.skip(process.platform !== 'darwin', 'macOS keychain');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-cookies-'));
  const server = await startServer();
  try {
    const m = await launchMeridian({ userDataDir, state: seedState() });
    await openTabDirect(m.page, server.url('/cookie/set?v=keep-me'));
    await closeMeridian(m.app);
    const file = cookiesFile(userDataDir);
    const before = fs.readFileSync(file);

    const app = await electron.launch({
      args: ['-r', path.join(ROOT, 'tests', 'fixtures', 'no-focus.js'), '.'], cwd: ROOT,
      env: { ...process.env, MERIDIAN_USER_DATA: userDataDir, MERIDIAN_E2E_NO_FOCUS: '1', MERIDIAN_E2E_KEYCHAIN: 'locked' },
    });
    try {
      await expect.poll(() => app.evaluate(() => global.__keychainDialog?.message || null), { timeout: 15_000 }).toContain('can’t unlock your saved sign-ins');
      expect(await app.evaluate(() => global.__keychainDialog.buttons)).toEqual(['Restart Meridian', 'Quit']);
      await new Promise((r) => setTimeout(r, 1000));
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
      const exited = new Promise((r) => app.process().once('exit', r));
      await app.evaluate(() => global.__keychainAnswer(1)).catch(() => {}); // Quit
      await exited;
    } finally { try { process.kill(app.process().pid, 'SIGKILL'); } catch {} }
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  } finally { await server.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); }
});
