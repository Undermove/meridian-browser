// Space backup: a space (its name, colour, icon, pinned tabs and folders) as a file in Downloads from
// its menu, every space from Settings, and restored as new spaces. No cookies or passwords in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const T = 'app.$.tabstrip';
const ST = 'app.$.settings.shadowRoot';
const SHOTS = process.env.MERIDIAN_SHOTS || '';

function profileWithDownloads() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-dl-')));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: dir, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: dir },
  }));
  return { profile, dir };
}

async function waitFile(dir, re, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const f = fs.readdirSync(dir).find((n) => re.test(n) && !n.endsWith('.crdownload'));
    if (f) { await new Promise((r) => setTimeout(r, 300)); return path.join(dir, f); }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no ${re} in ${dir}: ${fs.readdirSync(dir).join(', ')}`);
}

test('a space backs up to a file and restores as a new space, pinned tabs and folders included', async () => {
  const { profile, dir } = profileWithDownloads();
  const b = await launch(['about:blank'], { profile });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { spaceId } = await b.eval(`${T}.handler_.createSpace('Work', '🚀', '#ff8a65', '#ffd180')`);
    const at = (parentId, index) => `{ container: ${JSON.stringify(spaceId)}, parentId: ${JSON.stringify(parentId)}, index: ${index} }`;
    await b.eval(`${T}.handler_.addPinnedLink(${at('', 0)}, 'Docs', 'https://example.com/docs')`);
    const { itemId: folder } = await b.eval(`${T}.handler_.addFolder(${at('', 1)}, 'Reading')`);
    await b.eval(`${T}.handler_.addPinnedLink(${at(folder, 0)}, 'One', 'https://example.org/1')`);
    await b.eval(`${T}.handler_.addPinnedLink(${at(folder, 1)}, 'Two', 'https://example.org/2')`);
    // Not a web address: not pinned.
    assert.equal((await b.eval(`${T}.handler_.addPinnedLink(${at('', 2)}, 'x', 'file:///etc/passwd')`)).itemId, '');
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
    await b.waitFor(`${T}.state_.spaces.find((s) => s.id === ${JSON.stringify(spaceId)}).pinned.length === 2`);

    // The space's menu: Back Up Space….
    await b.menu(`${SB}.querySelector('.space-header')`, 'Back Up Space…');
    const file = await waitFile(dir, /^Work\.meridian-space\.json$/);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.kind, 'meridian-spaces');
    assert.equal(data.spaces.length, 1);
    const s = data.spaces[0];
    assert.deepEqual({ name: s.name, icon: s.icon, color: s.color, color2: s.color2 },
                     { name: 'Work', icon: '🚀', color: '#ff8a65', color2: '#ffd180' });
    assert.deepEqual(s.pinned, [
      { title: 'Docs', url: 'https://example.com/docs' },
      { title: 'Reading', folder: true, open: true, children: [
        { title: 'One', url: 'https://example.org/1' }, { title: 'Two', url: 'https://example.org/2' }] },
    ]);
    assert.ok(!/cookie|password/i.test(JSON.stringify(data)));

    // Restored: a second "Work" with the same pins, shown.
    const before = await b.eval(`${T}.state_.spaces.length`);
    const ids = await b.eval(`${T}.restoreSpaces(${JSON.stringify(fs.readFileSync(file, 'utf8'))})`);
    assert.equal(ids.length, 1);
    await b.waitFor(`${T}.state_.spaces.length === ${before + 1}`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(ids[0])}`);
    const back = await b.eval(`(() => { const s = ${T}.state_.spaces.find((x) => x.id === ${JSON.stringify(ids[0])}); const it = (i) => i.isFolder ? { title: i.title, folder: true, children: i.children.map(it) } : { title: i.title, url: i.url }; return { name: s.name, icon: s.icon, color: s.color, pinned: s.pinned.map(it) }; })()`);
    assert.deepEqual(back, { name: 'Work', icon: '🚀', color: '#ff8a65', pinned: [
      { title: 'Docs', url: 'https://example.com/docs' },
      { title: 'Reading', folder: true, children: [
        { title: 'One', url: 'https://example.org/1' }, { title: 'Two', url: 'https://example.org/2' }] }] });
    // Restoring opens nothing: no new tabs.
    assert.equal(await b.eval(`${T}.state_.tabs.filter((t) => t.spaceId === ${JSON.stringify(ids[0])}).length <= 1`), true);
    // Not a backup: nothing happens.
    assert.deepEqual(await b.eval(`${T}.restoreSpaces('{"hello": 1}')`), []);
    assert.equal(await b.eval(`${T}.state_.spaces.length`), before + 1);

    // Settings > Advanced: every space at once.
    await b.eval(`${T}.runCommand(13, 0)`);
    await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('member')`);
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'advanced')`);
    await b.waitFor(`!!${ST}.getElementById('backupSpaces')`);
    await b.click(`${ST}.getElementById('backupSpaces')`);
    const all = await waitFile(dir, /^Meridian Spaces \d{4}-\d\d-\d\d\.json$/);
    const allData = JSON.parse(fs.readFileSync(all, 'utf8'));
    assert.equal(allData.spaces.length, before + 1);
    await b.waitFor(`${ST}.getElementById('backupNote').textContent.includes('Saved ${before + 1} spaces')`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await b.eval(`${ST}.getElementById('backupSpaces').scrollIntoView()`); await new Promise((r) => setTimeout(r, 300)); await b.screenshot(path.join(SHOTS, 'backup-settings.png')); }
    assert.equal(await b.eval(`app.$.settings.restoreSpaces('nope')`), 'This file is not a Meridian space backup');
  } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
