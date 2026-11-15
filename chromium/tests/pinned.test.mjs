// Pinned tabs, Arc's way (ARC_SPEC.md "Sidebar: pinned tabs"): Edit Pinned Page replaces the
// pinned address with the current one, or takes a typed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('Rename… and a double click name a Today tab (kept by the browser); a double click renames a pinned tab', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const b = await launch(['A', 'B'].map((p) => `http://127.0.0.1:${server.address().port}/${p}`));
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const input = (el) => `${el}.shadowRoot.querySelector('input.rename')`;
  const saved = () => b.eval(`${T}.state_.tabs.map((t) => t.title).filter(Boolean).sort()`);
  const dblclick = (el) => b.eval(`(${el}.shadowRoot.querySelector('.row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true })), true)`);
  try {
    await b.waitFor(`!!${row('A')} && !!${row('B')}`);

    // The menu: the name in place of the title, typed, Return.
    await b.menu(row('A'), 'Rename…');
    await b.waitFor(`${input(row('A'))}?.value === 'A'`);
    await b.type('Alpha tab');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!!${row('Alpha tab')} && !${row('A')}`);
    // The browser has it (it is saved with the session), not only this page.
    await b.waitFor(`${T}.state_.tabs.some((t) => t.title === 'Alpha tab')`);

    // A double click on the row does the same; Escape leaves the name as it was.
    await dblclick(row('B'));
    await b.waitFor(`${input(row('B'))}?.value === 'B'`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!${input(row('B'))}`);
    await dblclick(row('B'));
    await b.waitFor(`${input(row('B'))}?.value === 'B'`);
    await b.type('Beta tab');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!!${row('Beta tab')}`);
    assert.deepEqual(await saved(), ['Alpha tab', 'Beta tab']);

    // No name gives the page's title back.
    await dblclick(row('Beta tab'));
    await b.waitFor(`${input(row('Beta tab'))}?.value === 'Beta tab'`);
    await b.eval(`(${input(row('Beta tab'))}.value = '', true)`);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!!${row('B')}`);
    assert.deepEqual(await saved(), ['Alpha tab']);

    // Pinned, it keeps the name; a double click renames the pinned tab too.
    await b.menu(row('Alpha tab'), 'Pin Tab');
    await b.waitFor(`!!${itemEl('Alpha tab')}`);
    await dblclick(itemEl('Alpha tab'));
    await b.waitFor(`${input(itemEl('Alpha tab'))}?.value === 'Alpha tab'`);
    await b.type('Pinned alpha');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`${T}.state_.spaces[0].pinned[0]?.title === 'Pinned alpha'`);
  } finally { await b.close(); server.close(); }
});

test('the name given to a Today tab is still there after a restart', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-name-'));
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  try {
    let b = await launch(['A', 'B'].map((p) => `http://127.0.0.1:${server.address().port}/${p}`), { profile });
    try {
      await b.waitFor(`!!${row('A')} && !!${row('B')}`);
      await b.menu(row('A'), 'Rename…');
      await b.waitFor(`${row('A')}.shadowRoot.querySelector('input.rename')?.value === 'A'`);
      await b.type('Kept name');
      await b.key('Enter', 'Enter', 13);
      await b.waitFor(`${T}.state_.tabs.some((t) => t.title === 'Kept name')`);
      await b.quit();
    } catch (e) { await b.close(); throw e; }
    // A plain relaunch restores the session, the name with it.
    b = await launch([], { profile });
    try {
      await b.waitFor(`!!${row('Kept name')} && !!${row('B')}`, 15000, `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`);
    } finally { await b.close(); }
  } finally { fs.rmSync(profile, { recursive: true, force: true }); server.close(); }
});
