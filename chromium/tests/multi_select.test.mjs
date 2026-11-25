// Several Today tabs at once, as in Arc: ⌘-click / ⇧-click pick them; the context menu, a drag and
// Esc act on the group (pin, folder, another space, archive, close, reorder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launch, SB, itemEl } from './harness.mjs';
import { startServer } from './server.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const rowEl = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
const todayRow = (title) => `${rowEl(title)}?.shadowRoot.querySelector('.row .title')`;
const todayTitles = `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`;
const picked = `[...${SB}.querySelectorAll('meridian-tab-row[selected]')].map((r) => r.tab.title).sort()`;
const SHOTS = process.env.MERIDIAN_SHOTS || '';
const META = process.platform === 'darwin' ? 4 : 2;

async function modClick(b, expr, modifiers) {
  const r = await b.point(expr);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, modifiers, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

test('⌘-click and ⇧-click pick tabs; Esc and a plain click let go; the menu pins, files and archives them', async () => {
  // Real pages: the archive keeps web pages only.
  const site = await startServer();
  const b = await launch(['One', 'Two', 'Three', 'Four', 'Five'].map((t) => site.url(`/p/${t}`)));
  try {
    await b.waitFor(today(5));
    const order = await b.eval(todayTitles);
    const open = await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive).tab.title`);
    const two = order.find((t) => t !== open && t !== 'Three');
    // ⌘-click: the open tab and the clicked one; the open tab stays open.
    await modClick(b, todayRow(two), META);
    await b.waitFor(`${picked}.length === 2`);
    assert.deepEqual(await b.eval(picked), [open, two].sort());
    assert.ok(await b.eval(`${rowEl(open)}.tab.isActive`), 'no switch on ⌘-click');
    // ⌘-click again takes it away.
    await modClick(b, todayRow(two), META);
    await b.waitFor(`${picked}.length === 1`);
    // Esc clears.
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`${picked}.length === 0`);
    // ⇧-click: everything between the open tab and the clicked one.
    const from = order.indexOf(open);
    const to = order.indexOf('Three');
    await modClick(b, todayRow('Three'), 8);
    const want = order.slice(Math.min(from, to), Math.max(from, to) + 1).sort();
    await b.waitFor(`${picked}.length === ${want.length}`);
    assert.deepEqual(await b.eval(picked), want);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await b.screenshot(path.join(SHOTS, 'multi-select.png')); }
    // A plain click on another tab lets go.
    const other = order.find((t) => !want.includes(t));
    await b.click(todayRow(other));
    await b.waitFor(`${picked}.length === 0`);

    // The menu on a picked tab acts on all: into a new folder.
    await modClick(b, todayRow(order[0]), META);
    await modClick(b, todayRow(order[1]), META);
    await b.waitFor(`${picked}.length >= 2`);
    const group = await b.eval(picked);
    await b.menu(todayRow(order[1]), 'Add to Folder > New Folder');
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].pinned[0]?.children?.length === ${group.length}`);
    await b.key('Escape', 'Escape', 27);  // leave the folder's rename
    await b.waitFor(today(5 - group.length));
    assert.deepEqual(await b.eval(picked), []);

    // Archive the rest together.
    const rest = await b.eval(todayTitles);
    await b.click(todayRow(rest[0]));
    for (const t of rest.slice(1)) await modClick(b, todayRow(t), META);
    await b.waitFor(`${picked}.length === ${rest.length}`);
    if (SHOTS) {
      const r = await b.point(todayRow(rest[0]));
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 });
      await b.waitFor(`!!${SB}.querySelector('#menu meridian-menu')`);
      await new Promise((r) => setTimeout(r, 300));
      await b.screenshot(path.join(SHOTS, 'multi-select-menu.png'));
      await b.key('Escape', 'Escape', 27);
    }
    await b.menu(todayRow(rest[0]), `Archive ${rest.length} Tabs`);
    await b.waitFor(today(0));
    const archived = await b.eval(`app.$.tabstrip.handler_.searchArchive('').then((r) => r.tabs.map((t) => t.title))`);
    for (const t of rest) assert.ok(archived.includes(t), `${t} archived`);
  } finally { await b.close(); site.close(); }
});

test('a picked group drags together: reordered in Today, pinned in its order', async () => {
  const b = await launch([page('A'), page('B'), page('C'), page('D')]);
  try {
    await b.waitFor(today(4));
    const order = await b.eval(todayTitles);
    // The last two, dragged above the first: they keep their order, on top.
    const [x, y] = order.slice(2);
    await b.click(todayRow(x));
    await modClick(b, todayRow(y), META);
    await b.waitFor(`${picked}.length === 2`);
    await b.drag(todayRow(y), `${rowEl(order[0])}.shadowRoot.querySelector('.row')`, { fy: 0.1 });
    await b.waitFor(`${todayTitles}.join() === ${JSON.stringify([x, y, order[0], order[1]].join())}`, 5000, todayTitles);
    // And pinned together, in that order.
    await b.drag(todayRow(x), `${SB}.querySelector('.space-header')`);
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].pinned.length === 2`);
    assert.deepEqual((await b.pinned()).map((p) => p.title), [x, y]);
    await b.waitFor(today(2));
    assert.ok(!!(await b.eval(`!!${itemEl(x)}`)));
  } finally { await b.close(); }
});
