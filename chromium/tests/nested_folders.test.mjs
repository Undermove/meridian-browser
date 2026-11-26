// Folders inside folders in Pinned, as in Arc: New Folder Inside, dragging a folder into another and
// a tab out again, and each folder's open or closed state kept over a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB, itemEl } from './harness.mjs';

const page = (t) => `data:text/html,<title>${t}</title><h1>${t}</h1>`;
const itemRow = (title) => `${itemEl(title)}?.shadowRoot.querySelector('.row')`;
const T = 'app.$.tabstrip';

test('folders nest in folders by menu and by drag, and remember being closed', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-nest-'));
  try {
    let b = await launch([page('Doc')], { profile });
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      const add = (title, parent = '') => b.eval(`${T}.handler_.addFolder({ container: ${T}.state_.activeSpaceId, parentId: ${parent || "''"}, index: -1 }, ${JSON.stringify(title)})`);
      await add('Work');
      await add('Side');
      await b.waitFor(`!!${itemEl('Work')} && !!${itemEl('Side')}`);
      // New Folder Inside, from the folder's menu.
      await b.menu(itemRow('Work'), 'New Folder Inside');
      await b.waitFor(`${itemEl('New Folder')}?.depth === 1`);
      await b.key('Escape', 'Escape', 27);
      // A folder dragged into the inner one: three levels.
      await b.drag(itemRow('Side'), itemRow('New Folder'), { fy: 0.5 });
      await b.waitFor(`${itemEl('Side')}?.depth === 2`);
      // (A folder toggles on press, so the drag closed it: open it again.)
      await b.eval(`${T}.handler_.setFolderOpen(${itemEl('Side')}.item.id, true)`);
      await b.waitFor(`${itemEl('Side')}.item.open`);
      // A tab pinned into the deepest one, then dragged out to the top.
      await b.eval(`${T}.handler_.pinTab([...${SB}.querySelectorAll('meridian-tab-row')][0].tab.id, { container: ${T}.state_.activeSpaceId, parentId: ${itemEl('Side')}.item.id, index: 0 }, '')`);
      await b.waitFor(`${itemEl('Doc')}?.depth === 3`);
      await b.drag(itemRow('Doc'), itemRow('Work'), { fy: 0.1 });
      await b.waitFor(`${itemEl('Doc')}?.depth === 0`);
      // A folder can't go into its own child.
      await b.eval(`${T}.handler_.moveItem(${itemEl('Work')}.item.id, { container: ${T}.state_.activeSpaceId, parentId: ${itemEl('Side')}.item.id, index: 0 })`);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await b.eval(`${itemEl('Work')}.depth`), 0);
      // The inner folder closed.
      await b.click(itemRow('New Folder'));
      await b.waitFor(`${itemEl('New Folder')}.shadowRoot.querySelector('.folder-wrap.collapsed')`);
      await b.quit();
    } catch (e) { await b.close(); throw e; }
    b = await launch([], { profile });
    try {
      await b.waitFor(`!!${itemEl('Work')}`);
      assert.ok(await b.eval(`!!${itemEl('New Folder')}.shadowRoot.querySelector('.folder-wrap.collapsed')`), 'still closed after a restart');
      // Work > New Folder (closed) > Side, and Doc at the top.
      const tree = await b.eval(`(() => { const t = (items) => items.map((i) => i.isFolder ? { [i.title]: { open: i.open, children: t(i.children) } } : i.title); return t(${T}.state_.spaces[0].pinned); })()`);
      assert.deepEqual(tree, ['Doc', { Work: { open: true, children: [{ 'New Folder': { open: false, children: [{ Side: { open: true, children: [] } }] } }] } }]);
    } finally { await b.close(); }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
