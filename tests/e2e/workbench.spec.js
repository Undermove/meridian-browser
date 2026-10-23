// Workbench smoke test: the internal mini-IDE (meridian://workbench, its own partition and preload).
// A temp project is opened through the dev hook MERIDIAN_TEST_PROJECT (skips the native folder dialog).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, press, openTabDirect, seedState } = require('../fixtures/meridian');

// Run JS in the workbench page (its main world: workbench.js globals S, openFile, launch, saveActive…).
const inWb = (page, code) => page.evaluate(([c]) => {
  const t = state.spaces.flatMap((s) => s.today).find((x) => x.kind === 'workbench');
  return rt.views.get(t.id).executeJavaScript(c);
}, [code]);
const wbTabId = (page) => page.evaluate(() => state.spaces.flatMap((s) => s.today).find((x) => x.kind === 'workbench')?.id);
const termText = (page) => inWb(page, `(() => { const t = S.activeTerm; if (!t) return ''; const b = t.xterm.buffer.active; let out = ''; for (let i = 0; i < b.length; i++) out += b.getLine(i).translateToString(true) + '\\n'; return out; })()`);

test.describe('workbench', () => {
  let project, outside, launched;

  test.beforeEach(async ({ userDataDir }) => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mer-wb-')));
    project = path.join(base, 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello world\n');
    outside = path.join(base, 'outside-secret.txt');
    fs.writeFileSync(outside, 'OUTSIDE-SECRET');
    fs.symlinkSync(outside, path.join(project, 'sneaky-link.txt'));
    launched = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_TEST_PROJECT: project } });
  });

  test.afterEach(async () => {
    await closeMeridian(launched?.app);
    try { fs.rmSync(path.dirname(project), { recursive: true, force: true }); } catch {}
  });

  test('opens a project, loads Monaco, runs a terminal, saves with ⌘S and refuses paths outside the project', async ({ server }) => {
    test.setTimeout(90_000);
    const { page } = launched;
    const meridian = launched;
    await page.evaluate(() => runCommand('open-project'));
    await expect.poll(() => wbTabId(page)).toBeTruthy();
    await expect.poll(() => inWb(page, 'S.project && S.project.root').catch(() => null), { timeout: 15_000 }).toBe(project);
    // the sidebar tab follows the project
    await expect.poll(() => page.evaluate(() => state.spaces.flatMap((s) => s.today).find((x) => x.kind === 'workbench').title)).toBe('proj');
    // the page got the workbench preload and nothing else
    expect(await inWb(page, '[typeof window.workbench, typeof window.api, typeof window.meridian, typeof require === "function" && !!require.config]')).toEqual(['object', 'undefined', 'undefined', true]);

    // Monaco
    await expect.poll(() => inWb(page, 'loadMonaco().then(() => !!window.monaco && !!S.editor)').catch(() => false), { timeout: 20_000 }).toBe(true);
    await inWb(page, `openFile('hello.txt', { focus: true }).then(() => true)`);
    expect(await inWb(page, 'S.editor.getModel().getValue()')).toBe('hello world\n');
    expect(await inWb(page, '!!document.querySelector("#editor-host .monaco-editor")')).toBe(true);

    // save with a real ⌘S while the editor has focus: the editor's meaning wins over "Toggle Sidebar"
    await inWb(page, `S.editor.getModel().setValue('saved by the e2e test\\n'); S.editor.focus(); true`);
    await expect.poll(() => inWb(page, '!!document.activeElement?.closest("#editor-host")')).toBe(true);
    await page.waitForTimeout(200); // focus zone reaches main
    const wbWcId = await page.evaluate((id) => rt.views.get(id).getWebContentsId(), await wbTabId(page));
    await press(meridian, 'Meta+S', { target: wbWcId });
    await expect.poll(() => fs.readFileSync(path.join(project, 'hello.txt'), 'utf8')).toBe('saved by the e2e test\n');
    expect(await page.evaluate(() => state.settings.sidebarHidden)).toBe(false);

    // a terminal runs a command in the project folder
    await inWb(page, `launch('shell').then((t) => !!t)`);
    await expect.poll(() => inWb(page, 'S.terms.length')).toBe(1);
    await inWb(page, `window.workbench.ptyWrite(S.activeTerm.id, 'echo meridian-$((40+2)) && pwd\\r'); true`);
    await expect.poll(() => termText(page), { timeout: 15_000 }).toContain('meridian-42');
    expect(await termText(page)).toContain(project);

    // terminals keep receiving output while the workbench tab is hidden
    const other = await openTabDirect(page, server.url('/p/other-tab'));
    expect(await page.evaluate((id) => rt.views.get(id).classList.contains('hidden'), await wbTabId(page))).toBe(true);
    await inWb(page, `window.workbench.ptyWrite(S.activeTerm.id, 'echo hidden-$((1+1))\\r'); true`);
    await expect.poll(() => termText(page), { timeout: 10_000 }).toContain('hidden-2');
    void other;

    // paths outside the project are refused (lexically and through symlinks)
    const tryCall = (code) => inWb(page, `${code}.then(() => 'ok', (e) => 'refused: ' + e.message)`);
    expect(await tryCall(`window.workbench.read('../outside-secret.txt')`)).toMatch(/^refused: .*outside the project/);
    expect(await tryCall(`window.workbench.read(${JSON.stringify(outside)})`)).toMatch(/^refused: .*relative to the project/);
    expect(await tryCall(`window.workbench.read('sneaky-link.txt')`)).toMatch(/^refused: .*symlink/);
    expect(await tryCall(`window.workbench.write('../evil.txt', 'x')`)).toMatch(/^refused/);
    expect(await tryCall(`window.workbench.list('..')`)).toMatch(/^refused/);
    expect(fs.existsSync(path.join(path.dirname(project), 'evil.txt'))).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('OUTSIDE-SECRET');
  });

  test('a dragged side panel keeps its width when customizations reload', async () => {
    test.setTimeout(60_000);
    const { page } = launched;
    await page.evaluate(() => runCommand('open-project'));
    await expect.poll(() => inWb(page, 'S.project && S.project.root').catch(() => null), { timeout: 15_000 }).toBe(project);
    await inWb(page, `openPanel('secrets'); true`);
    const width = () => inWb(page, `Math.round(document.querySelector('#side-pane').getBoundingClientRect().width)`);
    // drag the grip 150px to the left
    await inWb(page, `(() => {
      const g = document.querySelector('#side-grip'), r = g.getBoundingClientRect(), x = r.left + 2, y = r.top + 50;
      g.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: x - 150, clientY: y }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: x - 150, clientY: y }));
      return true;
    })()`);
    const dragged = await width();
    expect(dragged).toBeGreaterThan(400);
    // any change in the customizations folder re-applies settings; that used to snap the panel back to 320px
    await inWb(page, `reloadCustom({ quiet: true }).then(() => true)`);
    expect(await width()).toBe(dragged);
    expect(Number(await inWb(page, `localStorage.getItem('wb.sideW')`))).toBe(dragged);
  });

  test('web pages cannot load the workbench or use its partition', async ({ server }) => {
    const { page } = launched;
    const id = await openTabDirect(page, server.url('/p/wb-attacker'));
    await page.evaluate((id) => rt.views.get(id).executeJavaScript(`location.href = 'meridian://workbench/workbench.html'; 1`), id);
    await page.waitForTimeout(600);
    expect(await page.evaluate((id) => rt.views.get(id).getURL(), id)).toBe(server.url('/p/wb-attacker'));
    // a <webview> asking for the internal partition with a web page is refused
    const tryAttach = (partition) => page.evaluate(([u, p]) => new Promise((resolve) => {
      const wv = document.createElement('webview');
      wv.setAttribute('partition', p);
      wv.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px';
      wv.src = u;
      wv.addEventListener('dom-ready', () => { resolve('attached'); wv.remove(); });
      document.body.appendChild(wv);
      setTimeout(() => { resolve('refused'); wv.remove(); }, 3000);
    }), [server.url('/p/sneak'), partition]);
    expect(await tryAttach('persist:profile-default')).toBe('attached'); // control: a profile partition works
    expect(await tryAttach('meridian-internal')).toBe('refused');
  });
});

// Discoverability: an always-visible way in, and a first screen that says what it's for in plain words.
test('the sidebar button opens the Workbench; its first screen leads with "Open a project folder"', async ({ userDataDir }) => {
  const m = await launchMeridian({ userDataDir, state: seedState({ settings: { mode: 'developer' } }) });
  try {
    const { page } = m;
    const btn = page.locator('#btn-workbench');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('title', /Workbench \(.+E\)/);
    await expect(page.locator('#empty-state .ea-workbench')).toBeVisible();
    await btn.click();
    await expect.poll(() => wbTabId(page)).toBeTruthy();
    await expect.poll(() => inWb(page, '!document.querySelector("#welcome").hidden').catch(() => false), { timeout: 15_000 }).toBe(true);
    const ui = await inWb(page, `({
      primary: document.querySelector('#open-folder').textContent.trim(),
      ideas: [...document.querySelectorAll('.wb-idea')].map((p) => p.textContent.trim()),
      hub: document.querySelector('.welcome-hub').textContent.replace(/\\s+/g, ' ').trim(),
      secrets: document.querySelector('#btn-secrets').textContent.trim(),
      mission: document.querySelector('#mission-chip') && !document.querySelector('#mission-chip').hidden ? document.querySelector('#mission-chip').textContent.trim() : null,
    })`);
    expect(ui.primary).toBe('Open a project folder');
    expect(ui.ideas).toHaveLength(2);
    expect(ui.ideas[0]).toMatch(/coding agent lives in a browser tab/);
    expect(ui.hub).toMatch(/A hub is a folder set up for that\. Create one/);
    expect(ui.secrets).toBe('Secrets');
    expect(ui.mission).toBe('Mission Control');
    // In every mode — people end up in Everyday after an Arc import and still need to find it.
    await page.evaluate(() => applySettingsPatch({ mode: 'everyday' }));
    await expect(btn).toBeVisible();
  } finally { await closeMeridian(m.app); }
});
