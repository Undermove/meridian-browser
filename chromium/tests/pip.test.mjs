// A player's "picture in picture" button that opens a document picture-in-picture window (a small
// always-on-top window the page fills itself): it opens, from a tab of a space with its own
// profile too, and the browser stays up. That one used to take the whole browser down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch } from './harness.mjs';

const T = 'app.$.tabstrip';
const PAGE = `<!doctype html><title>Player</title><button id=b>PiP</button><script>
document.getElementById('b').onclick = async () => {
  const w = await documentPictureInPicture.requestWindow({ width: 320, height: 180 });
  w.document.body.textContent = 'mini player';
  window.pipOpen = true;
};
</script>`;

for (const own of [false, true]) {
  test(`a page opens a document picture-in-picture window${own ? ' from a space of another profile' : ''}`, async () => {
    const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${s.address().port}/player`;
    const b = await launch(own ? [] : [url]);
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
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }).catch(() => {});
      }
      await page.waitFor(`window.pipOpen === true && documentPictureInPicture.window?.document.body.textContent === 'mini player'`, 8000)
          .catch((e) => { throw new Error(b.proc.exitCode !== null || b.proc.signalCode ? 'the browser crashed' : e.message); });
      assert.equal(b.proc.exitCode, null, 'the browser is still running');
      assert.equal(b.proc.signalCode, null, 'the browser is still running');
      // Closing it from the page works, and the browser is fine afterwards.
      await page.eval(`documentPictureInPicture.window.close()`);
      await page.waitFor(`!documentPictureInPicture.window`);
      assert.ok(await b.eval(`${T}.state_.spaces.length >= 1`));
      page.close();
    } finally { await b.close(); s.close(); }
  });
}
