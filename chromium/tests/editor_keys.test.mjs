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
addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); kept.push((e.metaKey ? 'cmd+' : '') + (e.shiftKey ? 'shift+' : '') + e.key.toLowerCase()); document.title = 'Board ' + kept.join(' '); }, true);
</script>`;

// CDP modifiers: Alt 1, Ctrl 2, Meta 4, Shift 8. nativeVirtualKeyCode: the Mac key code.
const key = (k, native, modifiers) => ({ key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: native, modifiers });
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
  const saved = execFileSync('pbpaste');
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

    execFileSync('pbcopy', { input: 'before' });
    await press(KEYS.copyLink);
    let clip = '';
    for (let i = 0; i < 30 && clip !== url; i++) { await sleep(100); clip = execFileSync('pbpaste').toString(); }
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
    execFileSync('pbcopy', { input: saved });
  }
});
