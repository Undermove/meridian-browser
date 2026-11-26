// Hide cookie banners (Settings > Advanced, on by default): the EasyList Cookie List's element hiding
// rules hide cookie notices in pages and their frames. Tests give their own list with
// --meridian-cookie-list (the harness gives an empty one, so nothing is downloaded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const LIST = `[Adblock Plus 2.0]
! Title: test cookie list
||consent.example^$script
##.cookie-notice
###gdpr-popup
127.0.0.1##.site-consent
other.example##.content
127.0.0.1#@#.allowed-here
##.allowed-here
`;
const PAGE = `<!doctype html><title>Cookies</title>
<div class="cookie-notice">We use cookies</div>
<div id="gdpr-popup">Accept all?</div>
<div class="site-consent">This site's own consent box</div>
<div class="allowed-here">Not a banner here</div>
<div class="content">The article</div>
<iframe src="/frame"></iframe>`;
const FRAME = '<!doctype html><div class="cookie-notice">In a frame</div><p>frame text</p>';
const T = 'app.$.tabstrip';

test('cookie notices are hidden in pages and frames; the setting brings them back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-cookie-list-'));
  fs.writeFileSync(path.join(dir, 'list.txt'), LIST);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/frame' ? FRAME : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/page`;
  const b = await launch([url], { args: [`--meridian-cookie-list=${path.join(dir, 'list.txt')}`] });
  const shown = (p, sel) => p.eval(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display !== 'none'`);
  const frameShown = (p) => p.eval(`getComputedStyle(document.querySelector('iframe').contentDocument.querySelector('.cookie-notice')).display !== 'none'`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.equal((await b.eval(`${T}.handler_.getSettings()`)).settings.hideCookieBanners, true, 'on by default');
    // The list is read once the first tab opens: the page loaded after it is in has it.
    let page = await b.page(url);
    for (let i = 0; i < 50 && await shown(page, '.cookie-notice'); i++) {
      await new Promise((r) => setTimeout(r, 200));
      await page.eval('(location.reload(), true)');
      await new Promise((r) => setTimeout(r, 300));
      page.close();
      page = await b.page(url);
    }
    assert.equal(await shown(page, '.cookie-notice'), false, 'a rule for every site');
    assert.equal(await shown(page, '#gdpr-popup'), false);
    assert.equal(await shown(page, '.site-consent'), false, "the site's own rule");
    assert.equal(await shown(page, '.allowed-here'), true, 'an exception for this site');
    assert.equal(await shown(page, '.content'), true, "another site's rule isn't used here");
    for (let i = 0; i < 25 && await frameShown(page); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(await frameShown(page), false, 'in a frame too');
    // Off: the notices show again at once, without a reload.
    await b.eval(`${T}.handler_.getSettings().then(({settings}) => ${T}.handler_.setSettings({...settings, hideCookieBanners: false}))`);
    for (let i = 0; i < 25 && !await shown(page, '.cookie-notice'); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(await shown(page, '.cookie-notice'), true, 'off: shown');
    assert.equal(await frameShown(page), true, 'off: in the frame too');
    // And on again.
    await b.eval(`${T}.handler_.getSettings().then(({settings}) => ${T}.handler_.setSettings({...settings, hideCookieBanners: true}))`);
    for (let i = 0; i < 25 && await shown(page, '.cookie-notice'); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(await shown(page, '.cookie-notice'), false, 'on again: hidden');
    page.close();
  } finally { await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
