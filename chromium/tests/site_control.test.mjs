// The Site Control Center (the sliders at the end of the URL pill): what the site may do, with real
// clicks, read back from Chromium's own site settings; and the Arc-style menus of the sidebar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const SC = `app.$.siteControl.shadowRoot`;
const info = (b) => b.eval(`app.$.tabstrip.handler_.getSiteInfo().then((r) => r.info)`);

test('Site Control Center: ads, a permission, zoom and the address; a click outside closes it', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Shop')]);
  try {
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host').textContent === '127.0.0.1'`);
    await b.click(`app.$.locationIconButton`);
    await b.waitFor(`app.$.siteControl.open && ${SC}.getElementById('adsRow')`);
    // It opens under the sliders, inside the window.
    const r = await b.eval(`(() => { const c = ${SC}.getElementById('card').getBoundingClientRect(); const s = app.$.locationIconButton.getBoundingClientRect(); return { top: c.top, below: s.bottom, left: c.left, right: c.right, w: innerWidth }; })()`);
    assert.ok(r.top > r.below && r.left >= 8 && r.right <= r.w - 8, JSON.stringify(r));
    assert.equal(await b.eval(`${SC}.querySelector('.sec + #adsRow') ? ${SC}.getElementById('adsRow').previousElementSibling.textContent.trim() : ''`), '127.0.0.1');

    // Ads: blocked by default; off for this site, and back.
    assert.equal((await info(b)).adblock, true);
    await b.click(`${SC}.getElementById('adsRow')`);
    await b.waitFor(`${SC}.getElementById('adsRow').textContent.includes('Off for this site')`);
    assert.equal((await info(b)).adblock, false);
    await b.click(`${SC}.getElementById('adsRow')`);
    await b.waitFor(`${SC}.getElementById('adsRow').classList.contains('on')`);

    // Pop-ups: blocked by default; allowing them shows as Allowed.
    const popups = `${SC}.querySelector('.row.permission[data-type="popups"]')`;
    assert.match(await b.eval(`${popups}.textContent`), /Blocked \(default\)/);
    await b.click(popups);
    await b.waitFor(`${popups}.textContent.includes('Allowed')`);
    assert.equal((await info(b)).permissions.find((p) => p.type === 'popups').setting, 'allow');

    // Zoom in, then back to 100% from the number.
    await b.click(`${SC}.querySelector('.zoom-btn[data-step="1"]')`);
    await b.waitFor(`${SC}.querySelector('.zoom-value').textContent.trim() === '110%'`);
    await b.click(`${SC}.querySelector('.zoom-value')`);
    await b.waitFor(`${SC}.querySelector('.zoom-value').textContent.trim() === '100%'`);

    // Copy Link puts the page's address on the clipboard.
    await b.click(`${SC}.querySelector('.q[data-action="copy"]')`);
    await b.waitFor(`${SC}.querySelector('.q[data-action="copy"]').textContent.includes('Copied')`);

    // A click on the page side closes it.
    await b.click(`app.$.contentRegion`);
    await b.waitFor(`!app.$.siteControl.open`);
    // A new tab has no site controls.
    await b.eval(`app.$.tabstrip.openUrl('')`);
    await b.waitFor(`app.$.locationIconButton.hidden`);
  } finally { await b.close(); await site.close(); }
});

test('sidebar menus look like Arc’s: a header, icons, shortcuts, and a submenu that stays in the window', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const rows = `${SB}.querySelector('#menu meridian-menu').shadowRoot`;
    // The space dot is at the very bottom: the menu opens upward, inside the window.
    const dot = await b.point(`${SB}.querySelector('.space-dot.active')`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await b.cdp.send('Input.dispatchMouseEvent', { type, x: dot.x, y: dot.y, button: type === 'mouseMoved' ? 'none' : 'right', clickCount: 1 });
    }
    await b.waitFor(`${rows}.querySelector('.menu-header')`);
    await b.waitFor(`(() => { const r = ${SB}.getElementById('menu').getBoundingClientRect(); return r.height > 100 && r.bottom <= innerHeight - 6 && r.top >= 6; })()`);
    assert.ok(await b.eval(`${rows}.querySelectorAll('.menu-item svg').length >= 6`), 'rows have icons');
    // Colour opens a submenu of swatches beside it.
    const colour = await b.point(`[...${rows}.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('Colour'))`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: colour.x, y: colour.y, button: 'none' });
    await b.waitFor(`${SB}.querySelector('#submenu meridian-menu')?.shadowRoot.querySelectorAll('.menu-swatch').length === 7`);
    await b.waitFor(`(() => { const r = ${SB}.getElementById('submenu').getBoundingClientRect(); return r.right <= innerWidth - 6 && r.bottom <= innerHeight - 6; })()`);
    // Escape closes the submenu, then the menu.
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!${SB}.getElementById('submenu')`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`${SB}.getElementById('menu').hidden`);
  } finally { await b.close(); }
});
