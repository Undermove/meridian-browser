// The Meridian sidebar on Chromium: layout, switching, opening and closing tabs with the mouse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, tabEl, SB } from './harness.mjs';

export const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const count = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;

test('the sidebar holds the address field and a vertical list of tabs', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(count(2));
    const rects = await b.eval(`[0, 1].map((i) => { const r = ${SB}.querySelectorAll('meridian-tab-row')[i].getBoundingClientRect(); return { x: r.x, y: r.y }; })`);
    assert.equal(rects[0].x, rects[1].x, 'tabs share a column');
    assert.ok(rects[1].y > rects[0].y, 'second tab is below the first');
    assert.equal(await b.eval(`app.shadowRoot.getElementById('sidebar').getBoundingClientRect().width`), 260);
    assert.ok(await b.eval(`app.shadowRoot.getElementById('sidebar').contains(app.$.urlPill)`), 'URL pill in the sidebar');
    // Today lists the newest tab first, like Arc.
    assert.deepEqual((await b.tabs()).map((t) => t.title), ['Two', 'One']);
  } finally { await b.close(); }
});

test('clicking a tab in the sidebar switches to it', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(count(2));
    const tabs = await b.tabs();
    const inactive = tabs.findIndex((t) => !t.active);
    await b.click(tabEl(inactive));
    await b.waitFor(`${tabEl(inactive)}.tab.isActive`);
    assert.equal((await b.tabs()).filter((t) => t.active).length, 1);
    const other = inactive === 0 ? 1 : 0;
    await b.click(tabEl(other));
    await b.waitFor(`${tabEl(other)}.tab.isActive`);
  } finally { await b.close(); }
});

test('the close button closes a tab', async () => {
  const b = await launch([page('One'), page('Two')]);
  try {
    await b.waitFor(count(2));
    await b.click(`${tabEl(0)}.shadowRoot.querySelector('.close')`);
    await b.waitFor(count(1));
    assert.equal((await b.tabs())[0].title, 'One');
  } finally { await b.close(); }
});
