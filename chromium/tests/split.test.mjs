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
