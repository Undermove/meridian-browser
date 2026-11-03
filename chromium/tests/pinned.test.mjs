// Pinned tabs, Arc's way (ARC_SPEC.md "Sidebar: pinned tabs"): Edit Pinned Page replaces the
// pinned address with the current one, or takes a typed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB, itemEl } from './harness.mjs';

const T = 'app.$.tabstrip';

test('Edit Pinned Page: Replace Pinned URL with Current, and Edit… a typed address', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}/${p}`;
  const b = await launch([url('home')]);
  const pinnedUrl = () => b.eval(`${T}.state_.spaces[0].pinned[0]?.url`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.menu(`${SB}.querySelector('meridian-tab-row')`, 'Pin Tab');
    await b.waitFor(`!!${itemEl('home')}`);
    // The pinned tab goes on within its site.
    const page = await b.page(url('home'));
    await page.eval(`(location.href = '/inside', true)`);
    page.close();
    await b.waitFor(`${T}.state_.tabs.length && [...${T}.tabs_.values()].some((t) => t.url.endsWith('/inside'))`);
    assert.equal(await pinnedUrl(), url('home'));

    await b.menu(itemEl('home'), 'Edit Pinned Page > Replace Pinned URL with Current');
    await b.waitFor(`${T}.state_.spaces[0].pinned[0].url === ${JSON.stringify(url('inside'))}`);

    // Edit…: the address in place of the title, typed, Return.
    await b.menu(itemEl('home'), 'Edit Pinned Page > Edit…');
    const input = `${itemEl('home')}.shadowRoot.querySelector('input.rename.url')`;
    await b.waitFor(`${input}?.value === ${JSON.stringify(url('inside'))}`);
    await b.eval(`(${input}.select(), true)`);
    await b.type(`127.0.0.1:${server.address().port}/typed`);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`${T}.state_.spaces[0].pinned[0].url === 'https://127.0.0.1:${server.address().port}/typed'`, 5000, `${T}.state_.spaces[0].pinned[0].url`);
  } finally { await b.close(); server.close(); }
});

test('Archive Below sends the Today tabs under the clicked one to the Archive', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = await launch(['A', 'B', 'C', 'D'].map((p) => `http://127.0.0.1:${server.address().port}/${p}`));
  const titles = () => b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].filter((r) => /^[A-D]$/.test(r.tab.title)).length === 4`);
    const order = await titles();
    await b.menu(`${SB}.querySelectorAll('meridian-tab-row')[1]`, 'Archive Below');
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    assert.deepEqual(await titles(), order.slice(0, 2));
    // In the Archive.
    await b.eval(`app.$.tabstrip.runCommand(9, 0)`);  // kShowArchive
    await b.waitFor(`[...app.$.archive.shadowRoot.querySelectorAll('.entry')].map((e) => e.textContent).join() .includes(${JSON.stringify(order[3])})`, 10000, `[...app.$.archive.shadowRoot.querySelectorAll('.entry')].map((e) => e.textContent.trim().slice(0, 30))`);
  } finally { await b.close(); server.close(); }
});
