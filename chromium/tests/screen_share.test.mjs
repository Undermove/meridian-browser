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
  window.clicked = true;
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
      // A click on Share, as a person's (getDisplayMedia needs the gesture). A tab that just came
      // to the front can still lose the first click (Windows): click until the page has it.
      for (let i = 0; i < 10 && !(await page.eval('!!window.clicked')); i++) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await page.cdp.send('Input.dispatchMouseEvent', { type, x: 100, y: 40, button: 'left', clickCount: 1 });
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      const shared = await page.waitFor(`window.shared`, 10000).catch(() => page.eval(`window.shared || 'nothing yet'`));
      assert.equal(shared, 'browser', 'the Slides tab is shared');
      page.close();
    } finally { await b.close(); s.close(); }
  });
}

test('the tab on air is marked; a monitor on another tab moves the share there', async () => {
  const pages = { '/slides': SLIDES, '/other': '<!doctype html><title>Other doc</title><h1>Other</h1>', '/call': CALL };
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(pages[req.url] || ''); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const b = await launch([`${base}/slides`, `${base}/other`, `${base}/call`], { args: ['--auto-select-tab-capture-source-by-title=Slides deck'] });
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const on = (title) => `!!${row(title)}?.shadowRoot.querySelector('.row.sharing .share.on')`;
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!${T}?.state_`);
    await b.waitFor(`!!${row('Call')} && !!${row('Other doc')} && !!${row('Slides deck')}`);
    await b.click(`${row('Call')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'Call'`);
    const page = await b.page(`${base}/call`);
    await page.waitFor(`document.readyState === 'complete' && !!document.getElementById('b')`);
    for (let i = 0; i < 10 && !(await page.eval('!!window.clicked')); i++) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await page.cdp.send('Input.dispatchMouseEvent', { type, x: 100, y: 40, button: 'left', clickCount: 1 });
      }
      await new Promise((res) => setTimeout(res, 300));
    }
    assert.equal(await page.waitFor('window.shared', 10000), 'browser');
    await b.waitFor(on('Slides deck'), 10000);
    assert.equal(await b.eval(on('Other doc')), false);
    // The pointer on the call itself: nothing to offer.
    const hover = async (title) => {
      const p = await b.point(`${row(title)}.shadowRoot.querySelector('.row')`);
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
    };
    await hover('Call');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await b.eval(`!!${row('Call')}.shadowRoot.querySelector('.share')`), false);

    await b.click(`${row('Slides deck')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`app.hasAttribute('shared-on-page')`);

    await hover('Other doc');
    await b.waitFor(`!!${row('Other doc')}.shadowRoot.querySelector('.share')`);
    await b.waitFor(`getComputedStyle(${row('Other doc')}.shadowRoot.querySelector('.share')).display !== 'none'`);
    await b.click(`${row('Other doc')}.shadowRoot.querySelector('.share')`);
    await b.waitFor(on('Other doc'), 10000);
    await b.waitFor(`!${on('Slides deck')}`, 10000);
    // The ring follows what's on screen: on the tab on air, and off on any other.
    const active = await b.eval(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title`);
    await b.waitFor(`app.hasAttribute('shared-on-page') === ${active === 'Other doc'}`);
    await b.click(`${row('Call')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'Call'`);
    await b.waitFor(`!app.hasAttribute('shared-on-page')`);
    await b.click(`${row('Other doc')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`app.hasAttribute('shared-on-page')`);
    page.close();
  } finally { await b.close(); s.close(); }
});
