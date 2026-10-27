// Little window: a web link from another app opens in a small window without the sidebar;
// "Open in Meridian" moves it into the main window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { launch, APP, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayTitles = `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`;

test('a link from another app opens in a Little window; Open in Meridian moves it to the main window', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Main')]);
  try {
    await b.waitFor(`${todayTitles}.includes('Main')`);
    // What macOS does when a link is clicked in another app (this exact app bundle).
    await promisify(execFile)('open', ['-g', '-a', path.resolve(APP, '../../..'), site.url('/p/Little')]);
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
