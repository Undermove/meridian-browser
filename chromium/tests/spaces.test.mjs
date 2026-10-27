// Spaces, pinned tabs, folders and favorites: the sidebar model in chrome/browser/meridian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, tabEl, itemEl, favEl, SB } from './harness.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const todayCount = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;

test('pinning a tab moves it from Today to the space; closing it keeps the pin, clicking reopens it', async () => {
  const b = await launch([page('Docs'), page('Mail')]);
  try {
    await b.waitFor(todayCount(2));
    const space = (await b.state()).spaces[0].name;
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Docs')`, `Pin to ${space}`);
    await b.waitFor(todayCount(1));
    let pinned = await b.pinned();
    assert.deepEqual(pinned.map((p) => p.title), ['Docs']);
    assert.ok(pinned[0].loaded);

    // Closing a pinned tab unloads it; the pin stays.
    await b.click(`${itemEl('Docs')}.shadowRoot.querySelector('.close')`);
    await b.waitFor(`${itemEl('Docs')}.shadowRoot.querySelector('.row.unloaded')`);
    pinned = await b.pinned();
    assert.equal(pinned.length, 1);
    assert.equal(pinned[0].loaded, false);

    // Clicking the pin opens its page again, as that pin's tab (not a Today tab).
    await b.click(`${itemEl('Docs')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`${itemEl('Docs')}.shadowRoot.querySelector('.row.active')`);
    assert.equal((await b.tabs()).length, 1, 'Today still has only Mail');
  } finally { await b.close(); }
});

test('a new space starts with a new tab and its own colour; switching spaces shows each space\'s tabs', async () => {
  const b = await launch([page('Home tab')]);
  try {
    await b.waitFor(todayCount(1));
    const tint1 = await b.eval(`getComputedStyle(app).getPropertyValue('--meridian-space').trim()`);
    await b.click(`${SB}.getElementById('addSpace')`);
    // The new space is active, renaming in place.
    await b.waitFor(`${SB}.querySelector('.space-header input.rename')`);
    await b.type('Work');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`${SB}.querySelector('.space-name')?.textContent === 'Work'`);
    let state = await b.state();
    assert.equal(state.spaces.length, 2);
    assert.equal(state.spaces.find((s) => s.id === state.active).name, 'Work');
    await b.waitFor(todayCount(1));
    assert.notEqual((await b.tabs())[0].title, 'Home tab', 'Work shows only its own new tab');
    const tint2 = await b.eval(`getComputedStyle(app).getPropertyValue('--meridian-space').trim()`);
    assert.notEqual(tint1, tint2, 'the window takes the space colour');

    // Back to the first space: its tab is back and active.
    await b.click(`${SB}.querySelectorAll('.space-dot')[0]`);
    await b.waitFor(`${SB}.querySelector('.space-name')?.textContent !== 'Work'`);
    await b.waitFor(`${tabEl(0)}?.tab.title === 'Home tab' && ${tabEl(0)}.tab.isActive`);
    assert.equal((await b.tabs()).length, 1);
  } finally { await b.close(); }
});

test('folders hold pins; favorites are shared by every space', async () => {
  const b = await launch([page('Figma'), page('Linear')]);
  try {
    await b.waitFor(todayCount(2));
    const space = (await b.state()).spaces[0].name;
    // New folder from the space header, renamed in place.
    await b.menu(`${SB}.querySelector('.space-header')`, 'New Folder');
    await b.waitFor(`${itemEl('New Folder')}?.shadowRoot.querySelector('input.rename')`);
    await b.type('Design');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!!${itemEl('Design')}`);
    // Pin Figma, then move it into the folder through the model (drag & drop comes later).
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Figma')`, `Pin to ${space}`);
    await b.waitFor(`!!${itemEl('Figma')}`);
    await b.eval(`(async () => { const s = app.$.tabstrip; const folder = ${itemEl('Design')}.item.id; const fig = ${itemEl('Figma')}.item.id; s.handler_.moveItem(fig, { container: s.state_.activeSpaceId, parentId: folder, index: 0 }); })()`);
    await b.waitFor(`(${itemEl('Figma')})?.depth === 1`);
    // Collapse the folder.
    await b.click(`${itemEl('Design')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`${itemEl('Design')}.shadowRoot.querySelector('.folder-wrap.collapsed')`);
    assert.deepEqual((await b.pinned()).map((p) => p.title), ['Design']);

    // Linear to favorites; it shows as a tile in every space.
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Linear')`, 'Add to Favorites');
    await b.waitFor(`${SB}.querySelectorAll('meridian-fav').length === 1`);
    await b.click(`${SB}.getElementById('addSpace')`);
    await b.waitFor(`${SB}.querySelector('.space-header input.rename')`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2 && app.$.tabstrip.state_.activeSpaceId === app.$.tabstrip.state_.spaces[1].id`);
    assert.equal((await b.favorites()).length, 1, 'favorites are there in the new space too');
    // Opening the favorite doesn't switch back to the first space.
    const before = (await b.state()).active;
    await b.click(favEl(0));
    await b.waitFor(`${favEl(0)}.shadowRoot.querySelector('.fav.active')`);
    assert.equal((await b.state()).active, before);
  } finally { await b.close(); }
});

test('spaces, pins and which space each tab is in survive a restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-keep-'));
  try {
    let b = await launch([page('Keep me'), page('Work tab')], { profile });
    await b.waitFor(todayCount(2));
    const space = (await b.state()).spaces[0].name;
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Keep me')`, `Pin to ${space}`);
    await b.waitFor(`!!${itemEl('Keep me')}`);
    await b.eval(`app.$.tabstrip.handler_.createSpace('Work', '', '#e08a8a', '#f0b5a8')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces.length === 2`);
    await b.menu(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Work tab')`, 'Move to Work');
    await b.waitFor(todayCount(0));
    await b.quit();

    // A plain relaunch: Meridian restores the last session by default, like Arc.
    b = await launch([], { profile });
    try {
      await b.waitFor(`app.$.tabstrip.state_?.spaces.length === 2`, 15000);
      const state = await b.state();
      assert.deepEqual(state.spaces.map((s) => s.name), [space, 'Work']);
      assert.ok(await b.waitFor(`!!${itemEl('Keep me')}`));
      // The restored tabs are back in their spaces: "Keep me" is its pin's tab,
      // "Work tab" is in Work, not in the first space's Today.
      await b.waitFor(`app.$.tabstrip.state_.tabs.length === 2`, 15000);
      const s2 = await b.state();
      const work = s2.spaces.find((s) => s.name === 'Work').id;
      assert.ok(s2.tabs.some((t) => t.item), 'pinned tab restored as the pin\'s tab');
      assert.ok(s2.tabs.some((t) => t.space === work && !t.item), 'Work tab restored into Work');
    } finally { await b.close(); }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
