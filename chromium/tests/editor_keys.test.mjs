// An editor or a whiteboard (Google Docs, a canvas) takes every key it sees: preventDefault on each
// keydown, ⌘ ones too. Arc's own shortcuts still work there, as in Arc: ⇧⌘C copies the link, ⌘S
// hides the sidebar, ⌘L opens the command bar. The editor keeps the editing keys (⌘C, ⌘F).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';

const EDITOR = `<!doctype html><title>Board</title><body style="margin:0">
<div id=e contenteditable style="height:100vh;outline:0">draw here</div><script>
const kept = [];
addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); kept.push((e.metaKey || e.ctrlKey ? 'cmd+' : '') + (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase()); document.title = 'Board ' + kept.join(' '); }, true);
</script>`;

// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. nativeVirtualKeyCode: the Mac key code; on Windows
// the key's virtual key code, and Ctrl in place of ⌘.
const MAC = process.platform === 'darwin';
const PLATFORM = MAC ? 4 : 2;
const key = (k, native, modifiers) => ({ key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: MAC ? native : k.toUpperCase().charCodeAt(0), modifiers: (modifiers & 4 ? PLATFORM : 0) | (modifiers & 8) });
// The system clipboard's text, and putting text there.
const clipboard = {
  read: () => (MAC ? execFileSync('pbpaste') : execFileSync('powershell', ['-NoProfile', '-Command', '[Console]::Out.Write((Get-Clipboard -Raw))'])).toString(),
  write: (text) => (MAC ? execFileSync('pbcopy', { input: text }) : execFileSync('powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard'], { input: text })),
};
const KEYS = {
  copyLink: key('c', 8, 4 | 8),
  sidebar: key('s', 1, 4),
  location: key('l', 37, 4),
  copy: key('c', 8, 4),
  find: key('f', 3, 4),
};

test('an editor that takes every key keeps the editing keys, not Arc\'s: ⇧⌘C, ⌘S, ⌘L', async () => {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(EDITOR); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/board`;
  const saved = clipboard.read();
  const b = await launch([url], { args: ['--meridian-test-keys'] });
  try {
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'Board'`);
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    // A click into the board, as a person's: the page has the keys.
    for (const type of ['mousePressed', 'mouseReleased']) await page.cdp.send('Input.dispatchMouseEvent', { type, x: 300, y: 200, button: 'left', clickCount: 1 });
    await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
    const press = async (k) => {
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
      await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    };
    const kept = () => page.eval(`kept.join(' ')`);

    // The board has the keys: ⌘C and ⌘F stay with it.
    await press(KEYS.copy);
    await press(KEYS.find);
    await page.waitFor(`kept.length === 2`);
    assert.equal(await kept(), 'cmd+c cmd+f');

    clipboard.write('before');
    await press(KEYS.copyLink);
    let clip = '';
    for (let i = 0; i < 30 && clip.trim() !== url; i++) { await sleep(100); clip = clipboard.read(); }
    clip = clip.trim();
    assert.equal(clip, url, '⇧⌘C copied the link');
    await b.waitFor(`app.shadowRoot.querySelector('#missionToast .mt-title')?.textContent.trim() === 'Copied link'`);

    const shown = await b.eval(`!app.sidebarHidden_`);
    await press(KEYS.sidebar);
    await b.waitFor(`app.sidebarHidden_ === ${shown}`, 3000, 'app.sidebarHidden_');
    await press(KEYS.sidebar);
    await b.waitFor(`app.sidebarHidden_ === ${!shown}`, 3000, 'app.sidebarHidden_');

    await press(KEYS.location);
    await b.waitFor('app.$.commandBar.open', 3000);

    await sleep(300);
    assert.equal(await kept(), 'cmd+c cmd+f', 'the board kept none of Arc\'s shortcuts');
    page.close();
  } finally {
    await b.close(); s.close();
    if (saved) clipboard.write(saved);
  }
});

// A plain page leaves the browser's shortcuts alone: ⌘F (not reserved) goes to the page first and,
// left there, to the browser, which finds; an editor that takes ⌘F keeps it (above).
test('a page that leaves ⌘F to the browser gets the find bar', async () => {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Plain</title><p>a needle here</p>'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/plain`;
  const b = await launch([url], { args: ['--meridian-test-keys', '--meridian-test-bubbles'] });
  try {
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'Plain'`);
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.cdp.send('Input.dispatchMouseEvent', { type, x: 300, y: 200, button: 'left', clickCount: 1 });
    await b.waitFor(`app.$.contentRegion.activeWebview?.shadowRoot.activeElement?.classList.contains('content')`);
    const findBar = async () => (await b.eval(`${T}.handler_.testBubbles('bounds')`)).bubbles.some((x) => /^View /.test(x));
    assert.equal(await findBar(), false);
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...KEYS.find });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEYS.find });
    let shown = false;
    for (let i = 0; i < 30 && !shown; i++) { await sleep(100); shown = await findBar(); }
    assert.ok(shown, 'the find bar is shown');
    page.close();
  } finally { await b.close(); s.close(); }
});
