// Drag and drop in the sidebar: Today -> pinned / favorites / a folder / another space, and back to Today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB, itemEl } from './harness.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const todayRow = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})?.shadowRoot.querySelector('.row')`;
const itemRow = (title) => `${itemEl(title)}?.shadowRoot.querySelector('.row')`;

test('dragging tabs pins them, orders pins, files them into folders and favorites, and back to Today', async () => {
  const b = await launch([page('One'), page('Two'), page('Three'), page('Four')]);
  try {
    await b.waitFor(today(4));
    // Onto the empty pinned area: pinned.
    await b.drag(todayRow('One'), `${SB}.querySelector('.space-header')`);
    await b.waitFor(`!!${itemEl('One')}`);
    // Above "One": pinned first.
    await b.drag(todayRow('Two'), itemRow('One'), { fy: 0.2 });
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].pinned.length === 2`);
    assert.deepEqual((await b.pinned()).map((p) => p.title), ['Two', 'One']);
    // Into a folder.
    await b.eval(`app.$.tabstrip.handler_.addFolder({ container: app.$.tabstrip.state_.activeSpaceId, parentId: '', index: -1 }, 'Box')`);
    await b.waitFor(`!!${itemEl('Box')}`);
    await b.drag(itemRow('One'), itemRow('Box'), { fy: 0.5 });
    await b.waitFor(`${itemEl('One')}?.depth === 1`);
    // To favorites.
    await b.drag(todayRow('Three'), `${SB}.getElementById('favorites')`);
    await b.waitFor(`${SB}.querySelectorAll('meridian-fav').length === 1`);
    // A pin back to Today: unpinned, still open.
    await b.drag(itemRow('Two'), `${SB}.getElementById('today')`);
    await b.waitFor(`!${itemEl('Two')}`);
    await b.waitFor(today(2));
    assert.ok((await b.tabs()).some((t) => t.title === 'Two'));
  } finally { await b.close(); }
});

test('dropping a tab on another space\'s dot moves it there', async () => {
  const b = await launch([page('Stay'), page('Go')]);
  try {
    await b.waitFor(today(2));
    await b.eval(`app.$.tabstrip.handler_.createSpace('Work', '', '#e08a8a', '')`);
    await b.waitFor(`${SB}.querySelectorAll('.space-dot').length === 2`);
    await b.drag(todayRow('Go'), `${SB}.querySelectorAll('.space-dot')[1]`);
    await b.waitFor(today(1));
    const s = await b.state();
    const work = s.spaces[1].id;
    assert.equal(s.tabs.filter((t) => t.space === work).length, 1);
  } finally { await b.close(); }
});
