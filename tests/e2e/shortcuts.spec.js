// The shortcut table (src/shortcuts.js): every entry with a key dispatches its command when keyboard
// focus is inside a web page — even one that preventDefault()s every key. Keys are delivered as real
// input events to the page's webContents (see press() in fixtures), so they go through main's
// before-input-event matching exactly like a physical key. Native menu accelerators can't be triggered
// by synthetic input, so "soft" shortcuts (left to the page, menu only) are checked against the menu.
const { test, expect, openTabDirect, clickIntoActivePage, inTab } = require('../fixtures/meridian');
const { shortcutTable, parseAccelerator } = require('../../src/shortcuts');

const IS_MAC = process.platform === 'darwin';
const TABLE = shortcutTable(IS_MAC);
// keyCode names sendInputEvent understands for the accelerator keys in the table
const KEYCODES = { Plus: 'Plus', Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down', Tab: 'Tab', Enter: 'Return', Escape: 'Escape' };

function inputFor(accel) {
  const m = parseAccelerator(accel, IS_MAC);
  const key = accel.split('+').pop();
  const modifiers = [m.meta && 'meta', m.control && 'control', m.alt && 'alt', m.shift && 'shift'].filter(Boolean);
  return { keyCode: KEYCODES[key] || key, modifiers };
}

async function sendKey(meridian, wcId, accel) {
  await meridian.app.evaluate(({ webContents }, { wcId, keyCode, modifiers }) => {
    const wc = webContents.fromId(wcId);
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }, { wcId, ...inputFor(accel) });
}

const windowUrls = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));

test('every shortcut in the table dispatches its command from inside a web page', async ({ meridian, server }) => {
  test.setTimeout(180_000);
  const { page, app } = meridian;
  const tab = await openTabDirect(page, server.url('/greedy'));
  await clickIntoActivePage(page);
  const wcId = await page.evaluate((id) => rt.views.get(id).getWebContentsId(), tab);

  // Record commands instead of running them (runCommand asks onboardingIntercept first), so the page
  // keeps focus and nothing changes between keys.
  await page.evaluate(() => { window.__cmds = []; window.onboardingIntercept = (...a) => { window.__cmds.push(a); return true; }; });
  // Main-process shortcuts: watch for the window they open / the call they make.
  await app.evaluate(({ BrowserWindow }) => {
    global.__focusCalls = 0;
    const orig = BrowserWindow.prototype.focus;
    BrowserWindow.prototype.focus = function focus() { global.__focusCalls++; return orig.call(this); };
  });

  const checked = [];
  for (const sc of TABLE) {
    if (!sc.accel) { checked.push(`${sc.id}: no default key`); continue; }
    if (sc.soft) {
      // left to the page first; reaches Meridian through the menu accelerator only
      const inMenu = await app.evaluate(({ Menu }, accel) => {
        const walk = (items) => items.some((i) => i.accelerator === accel || (i.submenu && walk(i.submenu.items)));
        return walk(Menu.getApplicationMenu().items);
      }, sc.accel);
      expect(inMenu, `${sc.id} (${sc.accel}) is in the menu`).toBe(true);
      checked.push(`${sc.id}: soft (menu)`);
      continue;
    }
    if (sc.cmd) {
      const before = await page.evaluate(() => window.__cmds.length);
      await sendKey(meridian, wcId, sc.accel);
      await expect.poll(() => page.evaluate(() => window.__cmds.length), { message: `${sc.id} (${sc.accel})`, timeout: 3000 }).toBe(before + 1);
      expect(await page.evaluate(() => window.__cmds.at(-1)), `${sc.id} (${sc.accel})`).toEqual(sc.cmd);
      checked.push(`${sc.id}: ${JSON.stringify(sc.cmd)}`);
      continue;
    }
    // sc.run: handled in main
    const before = await windowUrls(app);
    const focusBefore = await app.evaluate(() => global.__focusCalls);
    await sendKey(meridian, wcId, sc.accel);
    const opened = async (pred) => (await windowUrls(app)).filter((u) => !before.includes(u) || pred(u)).filter(pred);
    if (sc.run === 'settings' || sc.run === 'shortcuts-help') {
      await expect.poll(async () => (await windowUrls(app)).filter((u) => u.startsWith('meridian://app/settings.html')).length, { message: sc.id }).toBe(1);
      if (sc.run === 'shortcuts-help') await expect.poll(async () => (await windowUrls(app)).find((u) => u.startsWith('meridian://app/settings.html'))).toContain('#shortcuts');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('meridian://app/settings.html')).forEach((w) => w.destroy()));
    } else if (sc.run === 'private-window') {
      await expect.poll(async () => (await opened((u) => u.includes('?private=meridian-private-'))).length, { message: sc.id }).toBe(1);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('?private=')).forEach((w) => w.close()));
    } else if (sc.run === 'mini-window') {
      await expect.poll(async () => (await opened((u) => u.includes('mini=1'))).length, { message: sc.id }).toBe(1);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('mini=1')).forEach((w) => w.close()));
    } else if (sc.run === 'new-window') {
      // the main window exists, so "New Window" brings it forward
      const calls = focusBefore;
      await expect.poll(() => app.evaluate(() => global.__focusCalls), { message: sc.id }).toBeGreaterThan(calls);
      expect((await windowUrls(app)).filter((u) => u === 'meridian://app/index.html')).toHaveLength(1);
    } else if (sc.run === 'ui-devtools') {
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL() === 'meridian://app/index.html' && w.webContents.isDevToolsOpened())), { message: sc.id }).toBe(true);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => { if (w.webContents.isDevToolsOpened()) w.webContents.closeDevTools(); }));
    } else {
      throw new Error(`no check for run=${sc.run} (${sc.id}) — add one`);
    }
    checked.push(`${sc.id}: run ${sc.run}`);
    await clickIntoActivePage(page); // a closed window may have moved focus
  }
  test.info().annotations.push({ type: 'shortcuts checked', description: checked.join('\n') });
  // every key was taken by Meridian before the greedy page could swallow it
  expect(await inTab(page, tab, 'window.__keys')).toEqual([]);
  expect(checked.filter((c) => !c.includes('no default key')).length).toBe(TABLE.filter((s) => s.accel).length);
  expect(checked.length).toBe(TABLE.length);
});

test('a remapped shortcut (Settings → Shortcuts) dispatches on the new key only', async ({ meridian, server }) => {
  const { page } = meridian;
  const tab = await openTabDirect(page, server.url('/greedy'));
  await clickIntoActivePage(page);
  const wcId = await page.evaluate((id) => rt.views.get(id).getWebContentsId(), tab);
  // the same patch the Settings window sends; main rebuilds its table from the UI's snapshot
  await page.evaluate(() => { applySettingsPatch({ shortcutOverrides: { 'copy-url': 'CmdOrCtrl+Alt+Shift+U' } }); sendSnapshot(); });
  await page.evaluate(() => { window.__cmds = []; window.onboardingIntercept = (...a) => { window.__cmds.push(a); return true; }; });
  await page.waitForTimeout(300);
  await sendKey(meridian, wcId, 'CmdOrCtrl+Shift+C');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__cmds)).toEqual([]);
  await sendKey(meridian, wcId, 'CmdOrCtrl+Alt+Shift+U');
  await expect.poll(() => page.evaluate(() => window.__cmds)).toEqual([['copy-url']]);
});
