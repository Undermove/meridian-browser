// Import from Arc (a fixture in Arc's format, never the real Arc data): spaces, pinned tabs, folders,
// favorites, and Arc's open tabs as Today tabs that load only when opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';

const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const H = 'app.$.tabstrip.handler_';

test('Arc import: preview, then spaces, pins, folders, favorites and Today', async () => {
  // Arc's open tabs point at a local server, which counts what actually loads.
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.writeFileSync(path.join(arcDir, 'StorableSidebar.json'),
    fs.readFileSync(path.join(ARC, 'StorableSidebar.json'), 'utf8').replace('https://news.ycombinator.com/', `http://127.0.0.1:${server.address().port}/hn`));
  const b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { preview } = await b.eval(`${H}.getArcPreview()`);
    assert.deepEqual(
      { s: preview.spaceCount, p: preview.pinnedCount, t: preview.todayCount, f: preview.favoriteCount },
      { s: 2, p: 3, t: 2, f: 2 });
    assert.deepEqual(preview.spaces.map((s) => [s.name, s.icon, s.color]), [['Work', '💼', '#ff8000'], ['Home', '', '']]);

    assert.equal((await b.eval(`${H}.importArc()`)).ok, true);
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Work,Home'`);
    // The untouched first space made way for Arc's; Work is shown.
    await b.waitFor(`${SB}.querySelector('.space-name')?.textContent === 'Work'`);
    const pinned = await b.pinned();
    assert.deepEqual(pinned.map((p) => [p.title, p.folder]), [['Linear', false], ['Design', true]]);
    assert.deepEqual((await b.favorites()).map((f) => f.title), ['Gmail', 'YouTube']);
    // Arc's open tabs, in Today, not loaded until opened.
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title).includes('Arc today')`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.deepEqual(hits, [], 'Arc tabs wait to be opened');
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'HN')`);
    for (let i = 0; i < 50 && !hits.includes('/hn'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(hits.includes('/hn'), 'an Arc tab loads when opened');
  } finally { await b.close(); server.close(); fs.rmSync(arcDir, { recursive: true, force: true }); }
});
