// Split view: two tabs side by side as two cards, a draggable divider, and back to one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const page = (t, bg) => `data:text/html,<title>${t}</title><body style="background:${bg}"><h1>${t}</h1>`;
const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const CR = `app.$.contentRegion`;
const boxes = `(() => { const s = ${CR}.shadowRoot; const a = s.querySelector('.split-start').getBoundingClientRect(); const b = s.querySelector('.split-end').getBoundingClientRect(); return { a: [a.left, a.width], b: [b.left, b.width] }; })()`;

test('Open in Split View shows both tabs side by side; the divider resizes; ⌃⇧- unsplits', async () => {
  const b = await launch([page('Left', '%23fde'), page('Right', '%23def')]);
  try {
    await b.waitFor(today(2));
    // From the other tab's menu: split it with the active one.
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => !r.tab.isActive)`, 'Open in Split View');
    await b.waitFor(`${CR}.hasAttribute('split')`);
    let r = await b.eval(boxes);
    assert.ok(r.a[1] > 300 && r.b[1] > 300, 'both halves have room');
    assert.ok(r.b[0] > r.a[0] + r.a[1], 'side by side, with a gap');
    assert.ok(Math.abs(r.a[1] - r.b[1]) < 4, 'half and half');

    // Drag the divider right; the new ratio is saved on the split.
    const h = await b.eval(`(() => { const r = ${CR}.shadowRoot.getElementById('splitHandle').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h.x, y: h.y });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: h.x, y: h.y, button: 'left', clickCount: 1 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h.x + 200, y: h.y, button: 'left', buttons: 1 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x + 200, y: h.y, button: 'left', clickCount: 1 });
    await b.waitFor(`app.$.tabstrip.state_.splits[0]?.ratio > 0.55`);
    r = await b.eval(boxes);
    assert.ok(r.a[1] > r.b[1] + 300, 'left is wider now');

    await b.eval(`app.$.tabstrip.runCommand(8, 0)`);  // kUnsplit (⌃⇧-)
    await b.waitFor(`!${CR}.hasAttribute('split')`);
    assert.equal(await b.eval(`app.$.tabstrip.state_.splits.length`), 0);
    assert.equal((await b.tabs()).length, 2, 'both tabs stay open');
  } finally { await b.close(); }
});

// Arc: a tab dragged onto the middle of another in the sidebar makes a split, shown there as one
// row with both tabs; a click on either half shows the split; dragging a half out separates it.
test('a tab dropped onto another in the sidebar splits them into one row; dragged out, they separate', async () => {
  const b = await launch([page('Left', '%23fde'), page('Right', '%23def'), page('Third', '%23efd')]);
  const half = (t) => `[...${SB}.querySelectorAll('.split-row meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(t)})?.shadowRoot.querySelector('.row')`;
  const row = (t) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(t)})?.shadowRoot.querySelector('.row')`;
  const active = `[...app.$.tabstrip.tabs_.values()].find((t) => t.isActive)?.title`;
  try {
    await b.waitFor(today(3));
    await b.drag(row('Right'), row('Left'), { fy: 0.5 });
    await b.waitFor(`${SB}.querySelectorAll('.split-row').length === 1`);
    assert.deepEqual(await b.eval(`[...${SB}.querySelectorAll('.split-row meridian-tab-row')].map((r) => r.tab.title)`), ['Left', 'Right'], 'one row, the dropped tab on the right');
    assert.equal(await b.eval(`${SB}.querySelectorAll('#today > meridian-tab-row').length`), 1, 'Third stays a row of its own');
    await b.waitFor(`${CR}.hasAttribute('split')`);
    assert.equal(await b.eval(active), 'Right', 'the dropped tab is the active one');
    const r = await b.eval(`(() => { const a = ${half('Left')}.getBoundingClientRect(), c = ${half('Right')}.getBoundingClientRect(); return { top: Math.abs(a.top - c.top), side: c.left > a.right - 1 }; })()`);
    assert.ok(r.top < 2 && r.side, 'the halves side by side in the row');

    // Away to Third, then a click on the split's left half: the split again, Left focused.
    await b.click(row('Third'));
    await b.waitFor(`!${CR}.hasAttribute('split')`);
    await b.click(half('Left'));
    await b.waitFor(`${CR}.hasAttribute('split') && ${active} === 'Left'`);
    assert.ok(await b.eval(`${SB}.querySelector('.split-row').classList.contains('active')`));

    // The right half dragged out above Third: no split, three rows.
    await b.drag(half('Right'), row('Third'), { fy: 0.1 });
    await b.waitFor(`${SB}.querySelectorAll('.split-row').length === 0 && ${today(3)}`);
    await b.waitFor(`app.$.tabstrip.state_.splits.length === 0`);
    assert.equal((await b.tabs()).length, 3, 'every tab stays open');

    // Again, then the menu's Separate Split.
    await b.drag(row('Third'), row('Left'), { fy: 0.5 });
    await b.waitFor(`${SB}.querySelectorAll('.split-row').length === 1`);
    await b.menu(half('Left'), 'Separate Split');
    await b.waitFor(`${SB}.querySelectorAll('.split-row').length === 0 && app.$.tabstrip.state_.splits.length === 0`);
  } finally { await b.close(); }
});
