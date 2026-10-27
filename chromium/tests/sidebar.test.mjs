// The Meridian sidebar on Chromium: layout, switching, opening and closing tabs with the mouse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, tabEl } from './harness.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;

test('the sidebar holds the address field and a vertical list of tabs', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(`app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab').length === 2`);
    const rects = await b.eval(`[0, 1].map((i) => { const r = app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab')[i].getBoundingClientRect(); return { x: r.x, y: r.y }; })`);
    assert.equal(rects[0].x, rects[1].x, 'tabs share a column');
    assert.ok(rects[1].y > rects[0].y, 'second tab is below the first');
    const sidebar = await b.eval(`app.shadowRoot.getElementById('sidebar').getBoundingClientRect().width`);
    assert.equal(sidebar, 260);
    assert.ok(await b.eval(`app.shadowRoot.getElementById('sidebar').contains(app.$.address)`), 'address field in the sidebar');
  } finally { await b.close(); }
});

test('clicking a tab in the sidebar switches to it', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(`app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab').length === 2`);
    let tabs = await b.tabs();
    const activeBefore = tabs.findIndex((t) => t.active);
    const other = activeBefore === 0 ? 1 : 0;
    await b.click(tabEl(other));
    await b.waitFor(`${tabEl(other)}.hasAttribute('active')`);
    tabs = await b.tabs();
    assert.equal(tabs.filter((t) => t.active).length, 1);
    await b.click(tabEl(activeBefore));
    await b.waitFor(`${tabEl(activeBefore)}.hasAttribute('active')`);
  } finally { await b.close(); }
});

test('New tab opens a tab and the close button closes one', async () => {
  const b = await launch([page('One')]);
  try {
    await b.waitFor(`app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab').length === 1`);
    await b.click(`app.$.tabstrip.shadowRoot.getElementById('newTabButton')`);
    await b.waitFor(`app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab').length === 2`);
    const tabs = await b.tabs();
    assert.ok(tabs[1].active, 'the new tab is active');
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await b.click(`${tabEl(1)}.shadowRoot.querySelector('.close')`);
    await b.waitFor(`app.$.tabstrip.shadowRoot.querySelectorAll('webui-browser-tab').length === 1`);
  } finally { await b.close(); }
});
