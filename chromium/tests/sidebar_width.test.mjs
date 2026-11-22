// Arc: the sidebar's inner edge drags to make it wider or narrower; the width is kept, and a
// double click on the edge gives the sidebar its own width back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const SIDEBAR = `app.shadowRoot.getElementById('sidebar')`;
const HANDLE = `app.shadowRoot.getElementById('sidebarResize')`;
const width = (b) => b.eval(`Math.round(${SIDEBAR}.getBoundingClientRect().width)`);

test('the sidebar\'s edge drags to resize it, within limits; the width survives a restart; a double click resets it', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-width-'));
  const mouse = (b, type, x, y, more = {}) => b.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...more });
  // Presses the edge, moves by dx in steps, lets go.
  const dragEdge = async (b, dx) => {
    const r = await b.point(HANDLE);
    await mouse(b, 'mouseMoved', r.x, r.y, { button: 'none' });
    await mouse(b, 'mousePressed', r.x, r.y);
    for (let i = 1; i <= 5; i++) await mouse(b, 'mouseMoved', r.x + (dx * i) / 5, r.y, { buttons: 1 });
    await mouse(b, 'mouseReleased', r.x + dx, r.y);
  };
  try {
    let b = await launch(['about:blank'], { profile });
    let kept;
    try {
      await b.waitFor(`!!${HANDLE}`);
      const own = await width(b);
      const page = () => b.eval(`Math.round(app.shadowRoot.getElementById('main').getBoundingClientRect().width)`);
      const pageBefore = await page();

      // Wider by 60: the sidebar follows the pointer, also once it is over the page (which must not
      // swallow it), and the page gives the room.
      await dragEdge(b, 60);
      await b.waitFor(`Math.abs(${SIDEBAR}.getBoundingClientRect().width - ${own + 60}) <= 2`, 5000, `${SIDEBAR}.getBoundingClientRect().width`);
      assert.ok(Math.abs((await page()) - (pageBefore - 60)) <= 2, `the page: ${await page()}, was ${pageBefore}`);
      assert.equal(await b.eval(`app.hasAttribute('sidebar-resizing')`), false);

      // Never narrower than its least width, however far it is dragged.
      await dragEdge(b, -2000);
      await b.waitFor(`${SIDEBAR}.getBoundingClientRect().width === 200`, 5000, `${SIDEBAR}.getBoundingClientRect().width`);
      // Nor wider than half the window.
      await dragEdge(b, 4000);
      const most = await b.eval(`Math.round(Math.max(200, Math.min(520, innerWidth / 2)))`);
      await b.waitFor(`Math.round(${SIDEBAR}.getBoundingClientRect().width) === ${most}`, 5000, `${SIDEBAR}.getBoundingClientRect().width`);

      await dragEdge(b, -40);
      kept = await width(b);
      assert.ok(kept < most && kept > 200, `kept ${kept}`);
      await b.quit();
    } catch (e) { await b.close(); throw e; }

    b = await launch([], { profile });
    try {
      await b.waitFor(`!!${HANDLE} && Math.round(${SIDEBAR}.getBoundingClientRect().width) === ${kept}`, 15000, `${SIDEBAR}?.getBoundingClientRect().width`);
      // A double click on the edge: the sidebar's own width.
      const r = await b.point(HANDLE);
      await mouse(b, 'mouseMoved', r.x, r.y, { button: 'none' });
      for (const clickCount of [1, 2]) {
        await mouse(b, 'mousePressed', r.x, r.y, { clickCount });
        await mouse(b, 'mouseReleased', r.x, r.y, { clickCount });
      }
      await b.waitFor(`Math.round(${SIDEBAR}.getBoundingClientRect().width) === 276`, 5000, `${SIDEBAR}.getBoundingClientRect().width`);
    } finally { await b.close(); }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
