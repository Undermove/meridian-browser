// The home page: shown instead of an empty new tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const HM = 'app.$.home.shadowRoot';
const OB = 'app.$.onboarding.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;

test('a new tab shows the home page; search opens ⌘T; Make a space; it goes once a site opens', async () => {
  const site = await startServer();
  const b = await launch(['chrome://newtab/']);
  try {
    await b.waitFor(`app.$.home.shown`);
    assert.match(await b.eval(`${HM}.querySelector('.greet').textContent`), /^Good (morning|afternoon|evening|night)$/);
    assert.deepEqual(await b.eval(`[...${HM}.querySelectorAll('.card')].map((c) => c.dataset.card)`), ['everyday', 'designer', 'manager', 'developer']);
    await b.click(`${HM}.getElementById('search')`);
    await b.waitFor(`app.$.commandBar.open`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.commandBar.open`);
    await b.eval(`${HM}.querySelector('.card[data-card="manager"] .btn.accent').scrollIntoView({ block: 'center' })`);
    await b.click(`${HM}.querySelector('.card[data-card="manager"] .btn.accent')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2`);
    await b.waitFor(`!!${SB}.querySelector('.space-header input.rename')`);
    await b.key('Escape', 'Escape', 27);
    // A site in this tab: the home page goes.
    await b.eval(`app.$.tabstrip.tabStripService_.createTabAt(null, ${JSON.stringify(site.url('/p/Site'))})`);
    await b.waitFor(`!app.$.home.shown`);
  } finally { await b.close(); await site.close(); }
});

test('Set up for me: the preset as a preview, then its spaces and favorites', async () => {
  const b = await launch(['chrome://newtab/']);
  try {
    await b.waitFor(`app.$.home.shown`);
    await b.eval(`${HM}.querySelector('.card[data-card="designer"] .btn.ghost').scrollIntoView({ block: 'center' })`);
    await b.click(`${HM}.querySelector('.card[data-card="designer"] .btn.ghost')`);
    await b.waitFor(`${step} === 'preview'`);
    assert.equal(await b.eval(`${OB}.querySelector('.persona').textContent`), 'Set up for design work');
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!app.$.onboarding.open`);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Projects', 'Inspiration', 'Personal']);
    assert.deepEqual((await b.favorites()).map((f) => f.title), ['Figma', 'Dribbble', 'Pinterest', 'Gmail']);
  } finally { await b.close(); }
});
