// Little window: a web link from another app opens in a small window without the sidebar;
// "Open in Meridian" moves it into the main window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, APP, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openFromOtherApp = (url) => promisify(execFile)('open', ['-g', '-a', path.resolve(APP, '../../..'), url]);
const todayTitles = `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`;

test('a link from another app opens in a Little window; Open in Meridian moves it to the main window', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Main')]);
  try {
    await b.waitFor(`${todayTitles}.includes('Main')`);
    // What macOS does when a link is clicked in another app (this exact app bundle).
    await openFromOtherApp(site.url('/p/Little'));
    let little;
    for (let i = 0; i < 100 && !little; i++) {
      await sleep(200);
      const [w] = await b.otherWindows();
      if (w && await w.eval(`app?.hasAttribute('little') && app.shadowRoot.querySelector('#littleBar .host').textContent === '127.0.0.1'`)) {
        little = w;
      } else {
        w?.close();
      }
    }
    assert.ok(little, 'a Little window opened');
    if (process.env.SHOT) await little.screenshot(process.env.SHOT);
    assert.equal(await little.eval(`getComputedStyle(app.shadowRoot.getElementById('sidebar')).display`), 'none');
    assert.equal(await little.eval(`app.$.tabstrip.state_.tabs.length`), 1);
    // The main window didn't get the link.
    assert.deepEqual(await b.eval(todayTitles), ['Main']);

    await little.eval(`app.shadowRoot.getElementById('openInMeridian').click()`);
    await b.waitFor(`${todayTitles}.includes('Little')`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Little')?.tab.isActive`);
    little.close();
    const windowCount = async () => { const ws = await b.otherWindows(); ws.forEach((w) => w.close()); return ws.length; };
    for (let i = 0; i < 50 && await windowCount(); i++) await sleep(200);
    assert.equal(await windowCount(), 0, 'the Little window closed');
  } finally { await b.close(); await site.close(); }
});

test('Air Traffic Control: a matching rule sends the link to the main window instead', async () => {
  const site = await startServer();
  // Settings → Links writes this pref; here it's seeded into a new profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    meridian: { atc: { fallback: 'little', rules: [{ id: 'r1', pattern: '127.0.0.1/p/work', target: 'main' }] } },
  }));
  const b = await launch([site.url('/p/Main')], { profile });
  try {
    await b.waitFor(`${todayTitles}.includes('Main')`);
    await openFromOtherApp(site.url('/p/Work'));
    await b.waitFor(`${todayTitles}.includes('Work')`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Work')?.tab.isActive`);
    const count = async () => { const ws = await b.otherWindows(); ws.forEach((w) => w.close()); return ws.length; };
    assert.equal(await count(), 0, 'no Little window for a matching link');
    // Anything else still goes to the Little window.
    await openFromOtherApp(site.url('/p/Elsewhere'));
    for (let i = 0; i < 50 && !(await count()); i++) await sleep(200);
    assert.equal(await count(), 1);
    assert.ok(!(await b.eval(todayTitles)).includes('Elsewhere'));
  } finally { await b.close(); await site.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
