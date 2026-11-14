// Drag and drop in the sidebar: Today -> pinned / favorites / a folder / another space, back to Today, and Today's own order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB, itemEl } from './harness.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const todayRow = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})?.shadowRoot.querySelector('.row')`;
const itemRow = (title) => `${itemEl(title)}?.shadowRoot.querySelector('.row')`;
const todayTitles = `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`;

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

test('a Today tab dragged onto another goes above or below it, and stays there after a restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-keep-'));
  try {
    let b = await launch([page('One'), page('Two'), page('Three'), page('Four')], { profile });
    let order;
    try {
      await b.waitFor(today(4));
      await b.waitFor(`${todayTitles}.every((t) => ['One', 'Two', 'Three', 'Four'].includes(t))`);
      order = await b.eval(todayTitles);  // newest first: Four, Three, Two, One
      // The bottom one onto the top half of the top one: first now.
      await b.drag(todayRow(order[3]), todayRow(order[0]), { fy: 0.2 });
      order = [order[3], order[0], order[1], order[2]];
      await b.waitFor(`JSON.stringify(${todayTitles}) === ${JSON.stringify(JSON.stringify(order))}`, 3000)
          .catch(async () => assert.deepEqual(await b.eval(todayTitles), order, 'dropped above the top row'));
      // The top one onto the bottom half of the third: right below it.
      await b.drag(todayRow(order[0]), todayRow(order[2]), { fy: 0.8 });
      order = [order[1], order[2], order[0], order[3]];
      await b.waitFor(`JSON.stringify(${todayTitles}) === ${JSON.stringify(JSON.stringify(order))}`, 3000)
          .catch(async () => assert.deepEqual(await b.eval(todayTitles), order, 'dropped below the third row'));
      // Still all four, none pinned.
      assert.equal((await b.pinned()).length, 0);
      await b.quit();
    } catch (e) { await b.close(); throw e; }

    // A plain relaunch restores the session: the same order.
    b = await launch([], { profile });
    try {
      await b.waitFor(today(4), 15000);
      await b.waitFor(`JSON.stringify(${todayTitles}) === ${JSON.stringify(JSON.stringify(order))}`, 8000)
          .catch(async () => assert.deepEqual(await b.eval(todayTitles), order, 'the order after a restart'));
    } finally { await b.close(); }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
