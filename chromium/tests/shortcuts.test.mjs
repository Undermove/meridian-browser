// Keyboard: ⌘1-9 and ⌘⌥↑/↓ walk the active space's favorites, pins and Today; ⌃1-9 and ⌘⌥←/→ switch
// spaces; ⌘D pins; ⌘S hides the sidebar. On macOS every shortcut is resolved from the real NSEvent (menu
// key equivalents and ChromeCommandDispatcherDelegate) into an IDC_* command, which
// meridian::SidebarHandler::HandleCommand hands to the sidebar as a Command. DevTools key events carry no
// NSEvent and are dropped before that, so most tests here start from the Command; the first one presses
// the keys for real (--meridian-test-keys: an NSEvent through AppKit, the menus and the pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB, itemEl } from './harness.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const activeTitle = `[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.title`;
// sidebar.mojom Command enum order.
const C = { selectTab: 0, stepTab: 1, selectSpace: 2, stepSpace: 3, togglePin: 4, toggleSidebar: 5, newFolder: 6 };
// NSEventModifierFlags and macOS virtual key codes.
const CMD = 1 << 20, OPT = 1 << 19, CTRL = 1 << 18;
const K = { 1: [18, '1'], 2: [19, '2'], 3: [20, '3'], t: [17, 't'], left: [123, '\uF702'], right: [124, '\uF703'], up: [126, '\uF700'], down: [125, '\uF701'] };

// ⌘D and ⌘S are main menu key equivalents: AppKit hands those to the menu, which doesn't answer a test
// window in the background, so they stay with the Command tests below.
test('real key presses: ⌘1-3 tabs in sidebar order, ⌃1/⌃2 and ⌘⌥←/→ spaces', async () => {
  const b = await launch([page('A'), page('B'), page('C')], { args: ['--meridian-test-keys'] });
  const press = ([code, ch], mods) => b.eval(`app.$.tabstrip.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const space = `app.$.tabstrip.state_.spaces.findIndex((s) => s.id === app.$.tabstrip.state_.activeSpaceId)`;
  try {
    await b.waitFor(today(3));
    // Today is newest first: C, B, A; ⌘1 is the sidebar's first, not the tab strip's.
    await press(K[1], CMD);
    await b.waitFor(`${activeTitle} === 'C'`);
    await press(K[3], CMD);
    await b.waitFor(`${activeTitle} === 'A'`);
    await b.eval(`app.$.tabstrip.handler_.createSpace('Work', '', '#e08a8a', '')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2`);
    await press(K[2], CTRL);
    await b.waitFor(`${space} === 1`);
    await press(K[1], CTRL);
    await b.waitFor(`${space} === 0`);
    await press(K.right, CMD | OPT);
    await b.waitFor(`${space} === 1`);
    await press(K.left, CMD | OPT);
    await b.waitFor(`${space} === 0`);
    await b.waitFor(`${activeTitle} === 'A'`);
  } finally { await b.close(); }
});


test('⌘1-9 and ⌘⌥↓/↑ go through the sidebar order, not the raw tab strip', async () => {
  const b = await launch([page('A'), page('B'), page('C')]);
  try {
    await b.waitFor(today(3));
    // Today is newest first: C, B, A.
    const run = (c, arg) => b.eval(`app.$.tabstrip.runCommand(${c}, ${arg})`);
    await run(C.selectTab, 0);  // ⌘1
    await b.waitFor(`${activeTitle} === 'C'`);
    await run(C.selectTab, 8);  // ⌘9: the last one
    await b.waitFor(`${activeTitle} === 'A'`);
    await run(C.stepTab, 1);  // ⌃Tab / ⌘⌥↓ wraps around
    await b.waitFor(`${activeTitle} === 'C'`);
    await run(C.stepTab, -1);
    await b.waitFor(`${activeTitle} === 'A'`);
    await run(C.selectTab, 1);  // ⌘2
    await b.waitFor(`${activeTitle} === 'B'`);
  } finally { await b.close(); }
});

test('⌃2 switches to the second space and ⌃1 back; step and pin commands work', async () => {
  const b = await launch([page('Home')]);
  try {
    await b.waitFor(today(1));
    await b.eval(`app.$.tabstrip.handler_.createSpace('Work', '', '#e08a8a', '')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2`);
    await b.eval(`app.$.tabstrip.runCommand(${C.selectSpace}, 1)`);  // ⌃2
    await b.waitFor(`app.$.tabstrip.state_.activeSpaceId === app.$.tabstrip.state_.spaces[1].id`);
    await b.eval(`app.$.tabstrip.runCommand(${C.selectSpace}, 0)`);  // ⌃1
    await b.waitFor(`app.$.tabstrip.state_.activeSpaceId === app.$.tabstrip.state_.spaces[0].id`);
    await b.waitFor(`${activeTitle} === 'Home'`);

    // ⌘⌥→ (menu): next space, wrapping.
    await b.eval(`app.$.tabstrip.runCommand(${C.stepSpace}, 1)`);
    await b.waitFor(`app.$.tabstrip.state_.activeSpaceId === app.$.tabstrip.state_.spaces[1].id`);
    await b.eval(`app.$.tabstrip.runCommand(${C.stepSpace}, 1)`);
    await b.waitFor(`app.$.tabstrip.state_.activeSpaceId === app.$.tabstrip.state_.spaces[0].id`);

    // ⌘D (menu): pin the active tab, again to unpin.
    await b.waitFor(`${activeTitle} === 'Home'`);
    await b.eval(`app.$.tabstrip.runCommand(${C.togglePin}, 0)`);
    await b.waitFor(`!!${itemEl('Home')}`);
    await b.waitFor(today(0));
    await b.eval(`app.$.tabstrip.runCommand(${C.togglePin}, 0)`);
    await b.waitFor(today(1));
    assert.equal(await b.eval(`app.$.tabstrip.state_.spaces[0].pinned.length`), 0);
  } finally { await b.close(); }
});

test('⌘S hides the sidebar; the window edge brings it back over the page', async () => {
  const b = await launch([page('Page')]);
  try {
    await b.waitFor(today(1));
    await b.eval(`app.$.tabstrip.runCommand(${C.toggleSidebar}, 0)`);
    await b.waitFor(`app.hasAttribute('sidebar-hidden')`);
    // The page takes the whole window.
    await b.waitFor(`app.$.contentRegion.getBoundingClientRect().left === 8`);
    assert.equal(await b.eval(`innerWidth - app.$.contentRegion.getBoundingClientRect().right`), 8);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 300 });
    await b.waitFor(`app.hasAttribute('sidebar-peek')`);
    // Leaving the card (through the margin around it, as a real pointer does) hides it again.
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 300 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 292, y: 300 });
    await b.waitFor(`!app.hasAttribute('sidebar-peek')`);
    await b.eval(`app.$.tabstrip.runCommand(${C.toggleSidebar}, 0)`);
    await b.waitFor(`!app.hasAttribute('sidebar-hidden')`);
  } finally { await b.close(); }
});

test('a real ⌘T opens the command bar, not a new tab', async () => {
  const b = await launch([page('A')], { args: ['--meridian-test-keys'] });
  const press = ([code, ch], mods) => b.eval(`app.$.tabstrip.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  try {
    await b.waitFor(today(1));
    await press(K.t, CMD);
    await b.waitFor(`app.$.commandBar.open`);
    assert.equal(await b.eval(`app.$.tabstrip.tabs_.size`), 1, 'no tab opened');
  } finally { await b.close(); }
});

// chrome_command_ids.h. Menu commands run as their menu item would (TestCommand).
const IDC = { copyUrl: 34071, copyMarkdown: 39726, littleWindow: 39727 };

test('⇧⌥⌘C copies the page as a Markdown link; ⌥⌘N opens a Little Window', async () => {
  const { execFileSync } = await import('node:child_process');
  const saved = execFileSync('pbpaste');  // the person's clipboard comes back afterwards
  const b = await launch(['data:text/html,<title>A [b] c</title>'], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(today(1));
    await b.waitFor(`${activeTitle} === 'A [b] c'`);
    await b.eval(`app.$.tabstrip.handler_.testCommand(${IDC.copyMarkdown})`);
    let text = '';
    for (let i = 0; i < 20 && !text.startsWith('[A b c]'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      text = execFileSync('pbpaste').toString();
    }
    assert.equal(text, '[A b c](data:text/html,<title>A [b] c</title>)');
    // Both say so at the bottom of the window, like Arc.
    await b.waitFor(`app.shadowRoot.querySelector('#missionToast .mt-title')?.textContent.trim() === 'Copied as Markdown'`);
    await b.eval(`app.$.tabstrip.handler_.testCommand(${IDC.copyUrl})`);
    await b.waitFor(`app.shadowRoot.querySelector('#missionToast .mt-title')?.textContent.trim() === 'Copied link'`);
    await b.eval(`app.$.tabstrip.handler_.testCommand(${IDC.littleWindow})`);
    let little = false;
    for (let i = 0; i < 40 && !little; i++) {
      await new Promise((r) => setTimeout(r, 150));
      for (const w of await b.otherWindows()) {
        try { little ||= await w.eval(`app.hasAttribute('little')`); } catch {}
      }
    }
    assert.ok(little, 'a Little Window opened');
    // On an empty page it starts in the command bar, with a compact home behind (Little Arc).
    let asks = false;
    for (let i = 0; i < 30 && !asks; i++) {
      for (const w of await b.otherWindows()) {
        try { asks ||= await w.eval(`app.hasAttribute('little') && app.$.commandBar.open && app.$.home.hasAttribute('little')`); } catch {}
      }
      if (!asks) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(asks, 'the command bar, over a compact home');
  } finally {
    await b.close();
    execFileSync('pbcopy', { input: saved });
  }
});

test('⇧⌘T brings the last closed tab back into its space’s Today', async () => {
  const b = await launch([page('Keep'), page('Gone')], { args: ['--meridian-test-keys'] });
  const titles = `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title).sort().join()`;
  try {
    await b.waitFor(today(2));
    const row = `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Gone')`;
    await b.click(`${row}.shadowRoot.querySelector('.close')`);
    await b.waitFor(today(1));
    await b.eval(`app.$.tabstrip.handler_.testCommand(34028)`);  // IDC_RESTORE_TAB
    await b.waitFor(`${titles} === 'Gone,Keep'`);
  } finally { await b.close(); }
});

// Arc: the sidebar scrolls along with the active tab, whatever moved it there.
test('⌘⌥↑/↓ through a long Today keep the active tab in sight; so does a tab picked elsewhere', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `Tab ${String(i + 1).padStart(2, '0')}`);
  const b = await launch(names.map(page), { args: ['--meridian-test-keys'] });
  const press = ([code, ch], mods) => b.eval(`app.$.tabstrip.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const DOWN = [125, ''], UP = [126, ''];
  // The active row's place against the scrolling sidebar's visible box.
  const inSight = () => b.eval(`(() => {
    const scroller = ${SB}.getElementById('spacePage');
    const row = [...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive);
    if (!row) return 'no active row';
    const v = scroller.getBoundingClientRect(), r = row.getBoundingClientRect();
    return r.top >= v.top - 1 && r.bottom <= v.bottom + 1 ? true : row.tab.title + ' at ' + Math.round(r.top) + '..' + Math.round(r.bottom) + ', visible ' + Math.round(v.top) + '..' + Math.round(v.bottom);
  })()`);
  const settled = async () => { await new Promise((r) => setTimeout(r, 400)); return inSight(); };
  try {
    await b.waitFor(today(30));
    assert.ok(await b.eval(`${SB}.getElementById('spacePage').scrollHeight > ${SB}.getElementById('spacePage').clientHeight + 200`), 'the list scrolls');
    // Start at the top.
    await b.eval(`app.$.tabstrip.runCommand(${C.selectTab}, 0)`);
    await b.eval(`${SB}.getElementById('spacePage').scrollTop = 0`);
    for (let i = 0; i < 29; i++) {
      await press(DOWN, CMD | OPT);
      assert.equal(await settled(), true, `after ${i + 1} × ⌘⌥↓`);
    }
    for (let i = 0; i < 29; i++) {
      await press(UP, CMD | OPT);
      assert.equal(await settled(), true, `after ${i + 1} × ⌘⌥↑`);
    }
    // Picked in the command bar's Switch to Tab, far down the list.
    await b.eval(`app.$.tabstrip.tabStripService_.activateTab([...app.$.tabstrip.tabs_.values()].find((t) => t.title === 'Tab 28').id)`);
    assert.equal(await settled(), true, 'a tab activated from elsewhere');
  } finally { await b.close(); }
});

// Arc: ⇧⌘C copies the address without tracking parameters; so does the link button by it.
test('⇧⌘C and the link button copy the address without utm_ and other tracking parameters', async () => {
  const { execFileSync } = await import('node:child_process');
  const saved = execFileSync('pbpaste');  // the person's clipboard comes back afterwards
  const url = 'data:text/html,<title>T</title>';
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Shared</title>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const page = `http://127.0.0.1:${server.address().port}/post?id=7&utm_source=news&fbclid=abc`;
  const clean = `http://127.0.0.1:${server.address().port}/post?id=7`;
  const b = await launch([page], { args: ['--meridian-test-keys'] });
  const clip = async (want) => { let t = ''; for (let i = 0; i < 30 && t !== want; i++) { await new Promise((r) => setTimeout(r, 100)); t = execFileSync('pbpaste').toString(); } return t; };
  try {
    await b.waitFor(`${activeTitle} === 'Shared'`);
    execFileSync('pbcopy', { input: url });
    await b.click('app.$.contentRegion');
    await b.eval(`app.$.tabstrip.handler_.testKeyPress(8, 'c', ${CMD | (1 << 17)})`);  // ⇧⌘C
    assert.equal(await clip(clean), clean);
    await b.waitFor(`app.shadowRoot.querySelector('#missionToast .mt-title')?.textContent.trim() === 'Copied link'`);
    execFileSync('pbcopy', { input: url });
    await b.eval(`app.shadowRoot.getElementById('copyLinkButton').click()`);
    assert.equal(await clip(clean), clean, 'the link button too');
  } finally {
    await b.close(); server.close();
    execFileSync('pbcopy', { input: saved });
  }
});

// Arc: ⌘⌥↑/↓ step tabs whatever the page does with arrow keys (a page that keeps every arrow press
// for itself, like an editor or a slideshow, with the focus in it). The commands are reserved, so
// the browser takes them before the page. (A test window is never the key window, and only the
// key window hands keys to the page first, so this can't show the page taking them on 0.5.13.)
test('⌘⌥↑/↓ step tabs from a page that keeps the arrow keys for itself', async () => {
  const greedy = (t) => `data:text/html,<title>${t}</title><script>addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) e.preventDefault(); }, true)</script><textarea autofocus></textarea>`;
  const b = await launch([greedy('A'), greedy('B'), greedy('C')], { args: ['--meridian-test-keys'] });
  const press = ([code, ch], mods) => b.eval(`app.$.tabstrip.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const order = () => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);
  try {
    await b.waitFor(today(3));
    const [top, middle, bottom] = await order();
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === '${top}').shadowRoot.querySelector('.row')`);
    await b.click('app.$.contentRegion');
    await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
    await press(K.down, CMD | OPT);
    await b.waitFor(`${activeTitle} === '${middle}'`);
    await press(K.down, CMD | OPT);
    await b.waitFor(`${activeTitle} === '${bottom}'`);
    await press(K.up, CMD | OPT);
    await b.waitFor(`${activeTitle} === '${middle}'`);
  } finally { await b.close(); }
});

// Arc: stepping through a big folder of pinned tabs that aren't loaded yet (after an import or a
// restart) keeps the one opening in sight; it shows in Today for a moment before its item comes back.
test('⌘⌥↓ through an open folder of unloaded pinned tabs, under closed nested folders, keeps the active one in sight', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  // Pages that take a moment, as real ones do.
  const server = http.createServer((req, res) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title><p>x`); }, 300));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}/${p}`;
  let n = 0;
  const tabs = (k) => Array.from({ length: k }, () => { n++; return { id: `t${n}`, title: `T${n}`, url: url(`T${n}`) }; });
  const folder = (open, children) => ({ id: `f${++n}`, title: `F${n}`, folder: true, open, children });
  const steps = folder(true, tabs(33));
  const pinned = [
    folder(false, [folder(false, tabs(13)), folder(false, tabs(2)), folder(false, tabs(7))]),
    folder(false, []), folder(false, tabs(19)), steps, folder(false, tabs(20)), ...tabs(9),
  ];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-folders-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Meridian Sidebar.json'), JSON.stringify({
    version: 1, activeSpace: 's1', mainProfileName: '', profiles: [], favorites: [],
    spaces: [{ id: 's1', name: 'Work', color: '#888888', color2: '', icon: '', pinned }],
  }));
  const b = await launch([url('today1'), url('today2')], { profile, args: ['--meridian-test-keys'] });
  const press = ([code, ch], mods) => b.eval(`app.$.tabstrip.handler_.testKeyPress(${code}, ${JSON.stringify(ch)}, ${mods})`);
  const inSight = () => b.eval(`(() => {
    const scroller = ${SB}.getElementById('spacePage');
    const deep = (root) => { for (const it of root?.querySelectorAll('meridian-item') || []) { const own = it.shadowRoot?.querySelector('.row.pinned.active'); if (own) return own; const inner = deep(it.shadowRoot); if (inner) return inner; } return null; };
    const row = [...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive) || deep(${SB});
    if (!row) return 'no active row';
    const v = scroller.getBoundingClientRect(), r = row.getBoundingClientRect();
    return r.top >= v.top - 1 && r.bottom <= v.bottom + 1 ? true : Math.round(r.top) + '..' + Math.round(r.bottom) + ', visible ' + Math.round(v.top) + '..' + Math.round(v.bottom);
  })()`);
  try {
    await b.waitFor(`app.$.tabstrip.state_?.spaces[0]?.pinned.length === ${pinned.length}`);
    await b.eval(`app.$.tabstrip.handler_.openItem('${steps.children[0].id}')`);
    await b.waitFor(`${activeTitle} === 'T${steps.children[0].title.slice(1)}'`, { timeout: 10000 }).catch(() => {});
    const seen = [];
    for (let i = 1; i <= 40; i++) {
      await press(K.down, CMD | OPT);
      await new Promise((r) => setTimeout(r, 700));
      seen.push(await b.eval(activeTitle));
      assert.equal(await inSight(), true, `after ${i} × ⌘⌥↓ (${seen.at(-1)})`);
    }
    assert.equal(new Set(seen).size, 40, `each press moved on: ${seen}`);
  } finally { await b.close(); server.closeAllConnections(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
