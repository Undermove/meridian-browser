// The archive: closed Today tabs and Today tabs left alone past the archive time go there; ⌥⌘A finds and
// reopens them; Clear Today archives the lot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB, tabEl } from './harness.mjs';
import { startServer } from './server.mjs';

const today = (n) => `${SB}.querySelectorAll('meridian-tab-row').length === ${n}`;
const AR = `app.$.archive`;
const entries = `[...${AR}.shadowRoot.querySelectorAll('.entry .title')].map((e) => e.textContent.trim())`;
const C = { showArchive: 9, clearToday: 10 };

test('a closed tab lands in the archive; the archive searches and reopens it', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Keep'), site.url('/p/Closed one')]);
  try {
    await b.waitFor(today(2));
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Closed one').shadowRoot.querySelector('.close')`);
    await b.waitFor(today(1));
    await b.eval(`app.$.tabstrip.runCommand(${C.showArchive}, 0)`);
    await b.waitFor(`${AR}.open`);
    await b.waitFor(`${entries}.includes('Closed one')`);
    await b.type('clos');
    await b.waitFor(`${entries}.length === 1`);
    await b.click(`${AR}.shadowRoot.querySelector('.entry')`);
    await b.waitFor(`!${AR}.open`);
    await b.waitFor(today(2));
    await b.waitFor(`${tabEl(0)}.tab.title === 'Closed one'`);
  } finally { await b.close(); await site.close(); }
});

test('Today tabs left alone past the archive time are archived; pinned and active ones stay', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Active'), site.url('/p/Stale'), site.url('/p/Pinned')],
                         { args: ['--meridian-archive-after-seconds=8'] });
  try {
    await b.waitFor(today(3));
    // Pinning has to happen before the tabs go stale, so through the model (the
    // menu and clicks have their own tests; mouse input can lag while the screen sleeps).
    await b.eval(`(() => { const s = app.$.tabstrip; const row = [...${SB}.querySelectorAll('meridian-tab-row')]; s.handler_.pinTab(row.find((r) => r.tab.title === 'Pinned').tab.id, { container: s.state_.activeSpaceId, parentId: '', index: 0 }); s.tabStripService_.activateTab(row.find((r) => r.tab.title === 'Active').tab.id); })()`);
    await b.waitFor(today(2));
    await b.waitFor(today(1), 30000);
    assert.equal((await b.tabs())[0].title, 'Active');
    assert.equal((await b.pinned())[0].loaded, true, 'the pinned tab stays open');
    await b.eval(`app.$.tabstrip.runCommand(${C.showArchive}, 0)`);
    await b.waitFor(`${entries}.includes('Stale')`);
  } finally { await b.close(); await site.close(); }
});

test('Clear Today archives the space\'s Today tabs', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/A'), site.url('/p/B')]);
  try {
    await b.waitFor(today(2));
    await b.eval(`app.$.tabstrip.runCommand(${C.clearToday}, 0)`);
    // A and B archived; a new tab keeps the window open.
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1 && !['A', 'B'].includes(${tabEl(0)}.tab.title)`);
    await b.eval(`app.$.tabstrip.runCommand(${C.showArchive}, 0)`);
    await b.waitFor(`${entries}.length === 2`);
  } finally { await b.close(); await site.close(); }
});
