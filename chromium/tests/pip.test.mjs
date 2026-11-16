// A player's "picture in picture" button that opens a document picture-in-picture window (a small
// always-on-top window the page fills itself): it opens, from a tab of a space with its own
// profile too, and the browser stays up. That one used to take the whole browser down. Like Arc's,
// it shows on every space, full screen ones too, and the page's own header moves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

const T = 'app.$.tabstrip';
const PAGE = `<!doctype html><title>Player</title><button id=b>PiP</button><script>
document.getElementById('b').onclick = async () => {
  window.clicked = true;
  const w = await documentPictureInPicture.requestWindow({ width: 320, height: 180 });
  // Kontur Talk's way: the page's own header moves the window.
  w.document.head.innerHTML = '<style>html, body { height: 100%; margin: 0; app-region: drag; }</style>';
  w.document.body.innerHTML = 'mini player <a id=l href="/chat-link" target=_blank style="app-region: no-drag">a link from the chat</a>';
  window.pipOpen = true;
};
</script>`;

for (const own of [false, true]) {
  test(`a page opens a document picture-in-picture window${own ? ' from a space of another profile' : ''}`, async () => {
    const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}/player`;
    const b = await launch(own ? [] : [url], { args: ['--meridian-test-keys'] });
    try {
      await b.waitFor(`typeof app !== 'undefined' && !!${T}?.state_`);
      if (own) {
        const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
        const { spaceId } = await b.eval(`${T}.handler_.createSpace('Films', '', '', '')`);
        await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
        await b.waitFor(`${T}.state_.spaces.find((x) => x.name === 'Films')?.profileId === ${JSON.stringify(profileId)}`);
        await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
        await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
        await b.eval(`${T}.openUrl(${JSON.stringify(url)})`);
      }
      const page = await b.page(url);
      await page.waitFor(`!!document.getElementById('b')`);
      // A click on the button, as a person's.
      const r = await page.eval(`(() => { const r = document.getElementById('b').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      // A tab of another profile's space can still be getting ready for input when it shows (on
      // Windows the first click was lost): click until the page has it.
      for (let i = 0; i < 10 && !(await page.eval('!!window.clicked')); i++) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }).catch(() => {});
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      await page.waitFor(`window.pipOpen === true && documentPictureInPicture.window?.document.body.textContent.startsWith('mini player')`, 8000)
          .catch((e) => { throw new Error(b.proc.exitCode !== null || b.proc.signalCode ? 'the browser crashed' : e.message); });
      assert.equal(b.proc.exitCode, null, 'the browser is still running');
      assert.equal(b.proc.signalCode, null, 'the browser is still running');
      // Like Arc's: on every space, the full screen ones too, and the page's header
      // ("app-region: drag") drags it. 2 is HTCAPTION, the window's title bar.
      const floating = async () => (await b.eval(`${T}.handler_.testFloatingWindows()`)).windows;
      await b.waitFor(`${T}.handler_.testFloatingWindows().then((r) => r.windows.some((w) => / page=2/.test(w)))`, 5000).catch(() => {});
      const [w] = await floating();
      if (process.platform === 'darwin') assert.match(w || '', /allSpaces=1 fullScreenSpaces=1/, `on every space: ${w}`);
      else assert.match(w || '', /onTop=1/, `over the other windows: ${w}`);
      assert.match(w || '', / page=2/, `the page's draggable header moves the window: ${w}`);
      // A link in it (a call's chat) opens as a tab of this window and space, as in Arc, not in a
      // new window.
      const pipTarget = (await (await fetch(`${b.base}/json/list`)).json()).find((t) => t.type === 'page' && t.url === 'about:blank');
      const pip = new WebSocket(pipTarget.webSocketDebuggerUrl);
      await new Promise((r) => (pip.onopen = r));
      let id = 0;
      const send = (method, params) => new Promise((r) => { const my = ++id; pip.addEventListener('message', function on(m) { const d = JSON.parse(m.data); if (d.id === my) { pip.removeEventListener('message', on); r(d.result); } }); pip.send(JSON.stringify({ id: my, method, params })); });
      const { result: { value: at } } = await send('Runtime.evaluate', { expression: `(() => { const r = document.getElementById('l').getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()`, returnByValue: true });
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: at[0], y: at[1], button: 'left', clickCount: 1 });
      pip.close();
      await b.waitFor(`[...${T}.tabs_.values()].some((t) => t.url?.endsWith('/chat-link'))`, 5000, `[...${T}.tabs_.values()].map((t) => t.url)`);
      assert.equal((await b.otherWindows()).length, 0, 'no new window');
      // Closing it from the page works, and the browser is fine afterwards.
      await page.eval(`documentPictureInPicture.window.close()`);
      await page.waitFor(`!documentPictureInPicture.window`);
      assert.ok(await b.eval(`${T}.state_.spaces.length >= 1`));
      page.close();
    } finally { await b.close(); s.close(); }
  });
}
