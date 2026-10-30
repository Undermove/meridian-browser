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
const K = { 1: [18, '1'], 2: [19, '2'], 3: [20, '3'], t: [17, 't'], left: [123, '\uF702'], right: [124, '\uF703'] };

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
