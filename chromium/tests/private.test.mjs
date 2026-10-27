// A private (incognito) window: Meridian's sidebar, dark, one space, "Private".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

test('a private window is dark, says Private and has one space', async () => {
  const b = await launch(['about:blank'], { args: ['--incognito'] });
  try {
    await b.waitFor(`app.hasAttribute('private')`);
    assert.equal(await b.eval(`app.shadowRoot.getElementById('privateBadge').hidden`), false);
    assert.equal(await b.eval(`${SB}.querySelector('.space-name').textContent`), 'Private');
    assert.equal(await b.eval(`getComputedStyle(${SB}.getElementById('addSpace')).visibility`), 'hidden');
    assert.equal(await b.eval(`getComputedStyle(app).getPropertyValue('--meridian-surface').trim()`), '#1f1f24');
    // No welcome tour here.
    assert.equal(await b.eval(`app.$.onboarding.open`), false);
  } finally { await b.close(); }
});

test('a normal window is not private', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.equal(await b.eval(`app.hasAttribute('private')`), false);
    assert.equal(await b.eval(`app.shadowRoot.getElementById('privateBadge').hidden`), true);
  } finally { await b.close(); }
});
