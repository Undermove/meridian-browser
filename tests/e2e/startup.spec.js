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

    // BUG (access ≠ off): AgentHub.startServer() sets the process-wide umask to 0o177 while the socket is
    // being created (src/agent/hub.js:463) and only restores it in the async listen callback. main.js:768
    // calls it right before createMainWindow(), so Chromium creates Cache/, Code Cache/, Local Storage/,
    // blob_storage/, Shared Dictionary/ … as 0600 directories (no x bit → unusable), and child processes
    // spawned in that window inherit the umask. Symptoms: the window shows ~5 s late, the UI's localStorage
    // and code cache are broken, and the damage persists across restarts.
    test('profile directories are created with usable permissions', async ({ meridian, server }) => {
      if (access !== 'off') test.fail(true, 'BUG: umask leak from agent socket setup');
      await openTabDirect(meridian.page, server.url('/p/perm'));
      await meridian.page.waitForTimeout(1500);
      expect(badDirs(meridian.userDataDir)).toEqual([]);
    });

    test('UI localStorage survives a restart (sidebar width)', async ({ meridian }) => {
      if (access !== 'off') test.fail(true, 'BUG: umask leak breaks Local Storage');
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
  test.fail(results.full > 2500, 'BUG: start-up delayed when agent access is on (umask leak)');
  expect(results.full).toBeLessThan(2500);
  void userDataDir;
});
