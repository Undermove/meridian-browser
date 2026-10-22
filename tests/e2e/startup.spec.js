// Start-up health: profile directory permissions, time to first visible window, UI localStorage —
// with and without agent access enabled.
const fs = require('fs');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, openTabDirect } = require('../fixtures/meridian');
const S = require('../fixtures/state');

function badDirs(root) {
  const out = [];
  const walk = (d, depth) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      let st; try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if ((st.mode & 0o700) !== 0o700) out.push(`${(st.mode & 0o777).toString(8)} ${path.relative(root, p)}/`);
      else if (depth < 3) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

async function timeToVisible(userDataDir, state) {
  const t0 = Date.now();
  const { app, page } = await launchMeridian({ userDataDir, state });
  let visibleAt = null;
  while (Date.now() - t0 < 15000) {
    if (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()))) { visibleAt = Date.now() - t0; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { app, page, visibleAt };
}

for (const access of ['off', 'full']) {
  test.describe(`agent access "${access}" at start-up`, () => {
    test.use({ seed: async ({}, use) => use(S.seedState({ settings: { agentAccess: access } })) });

    // Regression (access ≠ off): AgentHub.startServer() used to set the process-wide umask to 0o177 while the
    // socket was being created and only restored it in the async listen callback, so Chromium created
    // Cache/, Code Cache/, Local Storage/, blob_storage/ … as 0600 directories (no x bit → unusable):
    // the window showed ~5 s late and the UI's localStorage broke. The socket now lives in a 0700 directory
    // and is chmod'ed 0600 after listen; the umask is never touched.
    test('profile directories are created with usable permissions', async ({ meridian, server }) => {
      await openTabDirect(meridian.page, server.url('/p/perm'));
      await meridian.page.evaluate(() => localStorage.setItem('perm-probe', '1'));
      await meridian.page.waitForTimeout(1500);
      expect(badDirs(meridian.userDataDir)).toEqual([]);
      // Chromium's storage dirs exist and are usable directories
      for (const d of ['Local Storage', 'Partitions']) {
        const st = fs.statSync(path.join(meridian.userDataDir, d));
        expect(st.isDirectory()).toBe(true);
        expect(st.mode & 0o700).toBe(0o700);
      }
      // the main process umask is the one it was started with
      const umask = await meridian.app.evaluate(() => { const m = process.umask(0o022); process.umask(m); return m; });
      expect(umask & 0o100).toBe(0); // owner execute bit never masked
      expect(umask).toBe(process.umask());
      if (access !== 'off') {
        // the agent socket is there and private
        const file = path.join(meridian.userDataDir, 'agent-endpoint.json');
        await expect.poll(() => fs.existsSync(file)).toBe(true);
        const { socket } = JSON.parse(fs.readFileSync(file, 'utf8'));
        expect(fs.statSync(socket).isSocket()).toBe(true);
        expect(fs.statSync(socket).mode & 0o077).toBe(0);
        expect(fs.statSync(path.dirname(socket)).mode & 0o077).toBe(0);
      }
    });

    test('UI localStorage survives a restart (sidebar width)', async ({ meridian }) => {
      await meridian.page.evaluate(() => localStorage.setItem('sidebarWidth', '333'));
      await meridian.page.waitForTimeout(1500); // leveldb flush
      const { page } = await meridian.relaunch();
      expect(await page.evaluate(() => localStorage.getItem('sidebarWidth'))).toBe('333');
    });
  });
}

test('window becomes visible quickly with agent access on (vs off)', async ({ userDataDir }, testInfo) => {
  const fsx = require('fs');
  const os = require('os');
  const results = {};
  for (const access of ['off', 'full']) {
    const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'mer-e2e-'));
    const { app, visibleAt } = await timeToVisible(dir, S.seedState({ settings: { agentAccess: access } }));
    results[access] = visibleAt;
    await closeMeridian(app);
    fsx.rmSync(dir, { recursive: true, force: true });
  }
  testInfo.annotations.push({ type: 'time to visible window (ms)', description: JSON.stringify(results) });
  console.log('time to visible window (ms):', results);
  expect(results.full).toBeLessThan(2500);
  void userDataDir;
});
