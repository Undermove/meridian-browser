// The Workbench's tab keeps its own icon (</> on the accent colour) in the sidebar, in Today and
// pinned: Chromium recoloured chrome:// icons for the theme and it became a grey square on the Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const T = 'app.$.tabstrip';

// The colour in the middle of the icon's left half (the accent, not the white </>): how far from grey.
const colourOf = (img) => `(async () => {
  const img = ${img};
  if (!img) return null;
  await img.decode().catch(() => {});
  const c = document.createElement('canvas'); c.width = img.naturalWidth || 32; c.height = img.naturalHeight || 32;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height);
  const [r, gr, b, a] = g.getImageData(Math.round(c.width * 0.12), Math.round(c.height * 0.5), 1, 1).data;
  return { r, g: gr, b, a, chroma: Math.max(r, gr, b) - Math.min(r, gr, b) };
})()`;

test('the Workbench tab shows its own coloured icon in the sidebar, in Today and pinned', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`${T}.runCommand(16, 0)`);
    const row = `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url.startsWith('chrome://workbench'))`;
    await b.waitFor(`!!${row}?.tab.favicon?.dataUrl`, 15000);
    let c = await b.eval(colourOf(`${row}.shadowRoot.querySelector('img')`));
    assert.ok(c && c.a > 200 && c.chroma > 60, `the accent colour, not grey: ${JSON.stringify(c)}`);
    assert.ok(c.b > c.g, `purple-blue: ${JSON.stringify(c)}`);

    // Pinned: the same.
    await b.eval(`(() => { const s = ${T}; s.handler_.pinTab(${row}.tab.id, { container: s.state_.activeSpaceId, parentId: '', index: 0 }, ''); return true; })()`);
    const item = `[...${SB}.querySelectorAll('meridian-item')].find((r) => r.item?.url?.startsWith('chrome://workbench'))`;
    await b.waitFor(`!!${item}?.shadowRoot.querySelector('.favicon img')`, 10000);
    await new Promise((r) => setTimeout(r, 500));
    c = await b.eval(colourOf(`${item}.shadowRoot.querySelector('.favicon img')`));
    assert.ok(c && c.a > 200 && c.chroma > 60, `pinned: the accent colour, not grey: ${JSON.stringify(c)}`);
  } finally { await b.close(); }
});
