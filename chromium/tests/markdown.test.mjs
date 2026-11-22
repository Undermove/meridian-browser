// AI answers: a Markdown table is a real table, also while it streams in, and model text stays text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const render = (b, source) => b.eval(`(async () => {
  const [{ renderMarkdown }, { render }] = await Promise.all([import('/meridian/markdown.js'), import('//resources/lit/v3_0/lit.rollup.js')]);
  const d = document.createElement('div');
  render(renderMarkdown(${JSON.stringify(source)}), d);
  return { heads: [...d.querySelectorAll('th')].map((c) => c.textContent), rows: [...d.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent)), bold: d.querySelectorAll('td b').length, images: d.querySelectorAll('img').length, align: d.querySelector('td:last-child')?.style.textAlign || '', text: d.textContent };
})()`);

test('a Markdown table in an answer is a table; a pipe in plain text is not', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const r = await render(b, 'Plans:\n| Plan | Price |\n|---|---:|\n| **Team** | $12 |\n| A \\| B | <img src=x> |\n\nAfter.');
    assert.deepEqual(r.heads, ['Plan', 'Price']);
    assert.deepEqual(r.rows, [['Team', '$12'], ['A | B', '<img src=x>']]);
    assert.equal(r.bold, 1, 'inline Markdown works in cells');
    assert.equal(r.images, 0, 'model text stays text');
    assert.equal(r.align, 'right');
    assert.match(r.text, /Plans:[\s\S]*After\./);
    const plain = await render(b, 'Use a | b in the shell.\nNext line | here.');
    assert.equal(plain.heads.length, 0);
    assert.match(plain.text, /a \| b/);
  } finally { await b.close(); }
});
