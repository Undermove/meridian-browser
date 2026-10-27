// Ad and tracker blocking: Chromium's subresource filter on every site, with Meridian's ruleset
// (here a tiny list made with ruleset_converter, as the build does with EasyList and EasyPrivacy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, APP, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONVERTER = path.resolve(APP, '../../../../ruleset_converter');

test('ads are blocked on every site; turning it off in Settings lets them through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-adblock-'));
  fs.writeFileSync(path.join(dir, 'list.txt'), '/ads/banner.\n||tracker.invalid^\n');
  execFileSync(CONVERTER, ['--input_format=filter-list', '--output_format=unindexed-ruleset',
    `--input_files=${path.join(dir, 'list.txt')}`, `--output_file=${path.join(dir, 'ruleset.dat')}`]);
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>Page</title><img src="/ads/banner.gif?${req.url}"><img src="/ok.gif?${req.url}">`);
    } else { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A real first page, as a restored session gives: Chromium publishes the ruleset after startup.
  const b = await launch([`${base}/page0`], { args: [`--meridian-adblock-ruleset=${path.join(dir, 'ruleset.dat')}`] });
  const open = async (n) => {
    await fetch(`${b.base}/json/new?${base}/page${n}`, { method: 'PUT' });
    for (let i = 0; i < 50 && !hits.includes(`/ok.gif?/page${n}`); i++) await sleep(100);
    await sleep(300);
    return hits.includes(`/ads/banner.gif?/page${n}`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // The ruleset is indexed in the background after start; then ads stop loading.
    // Chromium indexes and publishes the ruleset once startup settles.
    const indexed = path.join(b.profile, 'Subresource Filter', 'Indexed Rules');
    for (let i = 0; i < 100 && !(fs.existsSync(indexed) && fs.readdirSync(indexed, { recursive: true }).some((f) => String(f).endsWith('Ruleset Data'))); i++) await sleep(200);
    await sleep(1000);
    let blocked = false;
    for (let n = 1; n <= 10 && !blocked; n++) {
      const loaded = await open(n);
      blocked = !loaded;
      if (!blocked) await sleep(500);
    }
    assert.ok(blocked, 'the ad image was blocked');
    assert.equal((await b.eval(`app.$.tabstrip.handler_.getSettings()`)).settings.adblock, true);
    // Off: ads load again.
    await b.eval(`app.$.tabstrip.handler_.getSettings().then(({settings}) => app.$.tabstrip.handler_.setSettings({...settings, adblock: false}))`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => !r.settings.adblock)`);
    assert.equal(await open(100), true, 'with blocking off the ad loads');
  } finally { await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
