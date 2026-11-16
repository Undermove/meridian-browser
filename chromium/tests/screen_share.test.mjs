// Sharing a tab in a call (getDisplayMedia, "Share screen" in Kontur Talk or Meet): the picker lists
// the tabs of the call's space, in a space of the main profile and in one with its own profile.
// That second case used to list no tab at all: the picker took tabs from windows of the call's
// profile, and Meridian's window, which holds every profile's spaces, is the main profile's.
// --auto-select-tab-capture-source-by-title picks the tab from that same list a person sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const T = 'app.$.tabstrip';
const CALL = `<!doctype html><title>Call</title><button id=b style="width:200px;height:80px">Share</button><script>
document.getElementById('b').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    window.shared = s.getVideoTracks()[0].getSettings().displaySurface;
  } catch (e) { window.shared = 'error: ' + e.name; }
};
</script>`;
const SLIDES = '<!doctype html><title>Slides deck</title><h1>Slides</h1>';

for (const own of [false, true]) {
  test(`a call shares another tab of its space${own ? ', in a space of another profile' : ''}`, async () => {
    const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url.startsWith('/slides') ? SLIDES : CALL); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${s.address().port}`;
    const b = await launch(own ? [] : [`${base}/slides`, `${base}/call`], { args: ['--auto-select-tab-capture-source-by-title=Slides deck'] });
    try {
      await b.waitFor(`typeof app !== 'undefined' && !!${T}?.state_`);
      if (own) {
        const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
        const { spaceId } = await b.eval(`${T}.handler_.createSpace('Calls', '', '', '')`);
        await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
        await b.waitFor(`${T}.state_.spaces.find((x) => x.name === 'Calls')?.profileId === ${JSON.stringify(profileId)}`);
        await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
        await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
        await b.eval(`${T}.openUrl(${JSON.stringify(`${base}/slides`)})`);
        await b.page(`${base}/slides`);
        await b.eval(`${T}.openUrl(${JSON.stringify(`${base}/call`)})`);
      }
      await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Call')`);
      await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Call').shadowRoot.querySelector('.row')`);
      await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'Call'`);
      const page = await b.page(`${base}/call`);
      await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('b')`);
      // A click on Share, as a person's (getDisplayMedia needs the gesture).
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.cdp.send('Input.dispatchMouseEvent', { type, x: 100, y: 40, button: 'left', clickCount: 1 });
      }
      const shared = await page.waitFor(`window.shared`, 10000).catch(() => page.eval(`window.shared || 'nothing yet'`));
      assert.equal(shared, 'browser', 'the Slides tab is shared');
      page.close();
    } finally { await b.close(); s.close(); }
  });
}
