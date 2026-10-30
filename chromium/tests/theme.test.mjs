// Edit Space Theme: colour, gradient, grain, icon and name, live; Cancel puts it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const TE = 'app.$.themeEditor.shadowRoot';
const space = (b) => b.eval(`app.$.tabstrip.state_.spaces[0]`);

test('Edit Space Theme from the space menu: live colour, icon and name; Cancel restores', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const before = await space(b);
    await b.menu(`${SB}.querySelector('.space-header')`, 'Edit Theme…');
    await b.waitFor(`app.$.themeEditor.open && !!${TE}.querySelector('.sw')`);
    // A gradient preset: the window takes it at once.
    await b.click(`${TE}.querySelector('.sw[data-index="10"]')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].color === '#43cea2' && app.$.tabstrip.state_.spaces[0].color2 === '#185a9d'`);
    await b.waitFor(`getComputedStyle(app).getPropertyValue('--meridian-space').trim() === '#43cea2'`);
    assert.equal(await b.eval(`${TE}.getElementById('gradient').checked`), true);
    await b.click(`${TE}.querySelector('.em[data-emoji="🚀"]')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].icon === '🚀'`);
    // Arc's grain over the window's colour.
    await b.click(`${TE}.getElementById('grain')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].grain && app.hasAttribute('grain')`);
    // Cancel: back to how it was.
    await b.click(`${TE}.getElementById('cancel')`);
    await b.waitFor(`!app.$.themeEditor.open`);
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].color === '${before.color}' && app.$.tabstrip.state_.spaces[0].icon === '${before.icon}'`);
    await b.waitFor(`!app.$.tabstrip.state_.spaces[0].grain && !app.hasAttribute('grain')`);

    // Again, renamed and kept with Done.
    await b.menu(`${SB}.querySelector('.space-header')`, 'Edit Theme…');
    await b.waitFor(`app.$.themeEditor.open`);
    await b.click(`${TE}.querySelector('.sw[data-index="3"]')`);
    await b.click(`${TE}.getElementById('grain')`);
    await b.eval(`(() => { const i = ${TE}.getElementById('name'); i.value = 'Garden'; i.dispatchEvent(new Event('input')); })()`);
    await b.click(`${TE}.getElementById('done')`);
    await b.waitFor(`!app.$.themeEditor.open`);
    const after = await space(b);
    assert.deepEqual([after.name, after.color, after.color2], ['Garden', '#7fbf8e', '#7fbf8e']);
    assert.equal(await b.eval(`${SB}.querySelector('.space-name').textContent`), 'Garden');
    assert.equal(after.grain, true);
  } finally { await b.close(); }
});
