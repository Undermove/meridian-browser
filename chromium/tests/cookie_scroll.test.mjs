// Hide cookie banners gives back the scrolling a consent popup locked: OneTrust, Didomi and
// Sourcepoint style popups lock <html>/<body> (overflow hidden, position fixed) while they're up;
// with the popup hidden the page scrolls again. A site's own dialog (no consent popup) still locks
// the page, and so does one opened over a page whose popup is hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The popups' boxes are in the real list in these forms.
const LIST = `[Adblock Plus 2.0]
! Title: test cookie list
###onetrust-consent-sdk
###didomi-host
##div[id^="sp_message_container_"]
`;
const TALL = '<main>' + Array.from({ length: 80 }, (_, i) => `<p style="height:60px">Paragraph ${i}</p>`).join('') + '</main>';
// The popup comes after the page, as consent managers' scripts do.
const later = (js) => `<script>setTimeout(() => { ${js} }, 300)</script>`;
const PAGES = {
  // OneTrust: a box with a dark filter and the banner; inline !important locks on <html> and <body>.
  '/onetrust': `<!doctype html><title>OneTrust</title>${TALL}
    <div id="onetrust-consent-sdk"><div class="onetrust-pc-dark-filter" style="position:fixed;inset:0;background:#0008"></div>
    <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;height:200px;background:#fff">We value your privacy</div></div>
    ${later(`for (const el of [document.documentElement, document.body]) el.style.setProperty('overflow', 'hidden', 'important');`)}`,
  // Didomi: a class on <html> and <body>, the lock in the popup's own style sheet.
  '/didomi': `<!doctype html><title>Didomi</title>
    <style>.didomi-popup-open { overflow: hidden !important; } .modal { display: none; } .modal.show { display: block; position: fixed; top: 20px; left: 20px; background: #fff; }
    body.modal-open { overflow: hidden; }</style>${TALL}
    <div id="didomi-host"><div class="didomi-popup-backdrop" style="position:fixed;inset:0;background:#0008"><div class="didomi-popup">Consent</div></div></div>
    <div class="modal" id="site-modal" role="dialog" aria-modal="true">Subscribe to our newsletter</div>
    ${later(`document.documentElement.classList.add('didomi-popup-open'); document.body.classList.add('didomi-popup-open');`)}`,
  // Sourcepoint: a full-screen overlay with the message in a frame; <html> fixed in place.
  '/sourcepoint': `<!doctype html><title>Sourcepoint</title>
    <style>html.sp-message-open { overflow: hidden !important; position: fixed !important; width: 100%; }</style>${TALL}
    ${later(`const box = document.createElement('div'); box.id = 'sp_message_container_1180364';
      box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0009';
      box.innerHTML = '<iframe src="/sp-frame" style="width:600px;height:400px;border:0"></iframe>';
      document.body.appendChild(box); document.documentElement.classList.add('sp-message-open');`)}`,
  '/sp-frame': '<!doctype html><p>We and our partners use cookies</p><button>Accept</button>',
  // A site's own dialog, no consent popup: Bootstrap's modal-open.
  '/modal': `<!doctype html><title>Modal</title>
    <style>.modal { display: none; } .modal.show { display: block; position: fixed; top: 20px; left: 20px; background: #fff; } body.modal-open { overflow: hidden; }</style>${TALL}
    <div class="modal" role="dialog" aria-modal="true">Sign in to continue</div>
    ${later(`document.querySelector('.modal').classList.add('show'); document.body.classList.add('modal-open');`)}`,
};

test('the page scrolls again when a consent popup that locked it is hidden; site dialogs still lock it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-cookie-list-'));
  fs.writeFileSync(path.join(dir, 'list.txt'), LIST);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGES[new URL(req.url, 'http://x').pathname] || '<!doctype html><title>Start</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const b = await launch([`${origin}/start`], { args: [`--meridian-cookie-list=${path.join(dir, 'list.txt')}`] });
  let page;
  // The tab's page at `p` (the popup's lock in place, 300 ms after the load).
  const open = async (p) => {
    await page.cdp.send('Page.navigate', { url: origin + p });
    page.close();
    page = await b.page(origin + p + '$');
    await page.waitFor(`document.readyState === 'complete'`);
    await sleep(600);
  };
  // Real wheel input: does the page move?
  const scrolls = async () => {
    await page.eval('(scrollTo(0, 0), true)');
    for (let i = 0; i < 12; i++) {
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 300 });
      await sleep(150);
      if (await page.eval('scrollY > 0')) return true;
    }
    return false;
  };
  const shown = (sel) => page.eval(`document.querySelector(${JSON.stringify(sel)}).checkVisibility()`);
  const setHide = (on) => b.eval(`app.$.tabstrip.handler_.getSettings().then(({settings}) => app.$.tabstrip.handler_.setSettings({...settings, hideCookieBanners: ${on}}))`);
  try {
    page = await b.page(`${origin}/start`);
    // The list is read once the first tab opens: wait for it to be in.
    for (let i = 0; i < 30; i++) {
      await open('/onetrust');
      if (!await shown('#onetrust-consent-sdk')) break;
    }
    assert.equal(await shown('#onetrust-consent-sdk'), false, 'OneTrust: hidden');
    assert.equal(await page.eval(`document.body.style.getPropertyPriority('overflow')`), 'important', 'OneTrust: its lock is there');
    assert.equal(await scrolls(), true, 'OneTrust: the page scrolls (over inline !important locks)');

    await open('/didomi');
    assert.equal(await shown('#didomi-host'), false, 'Didomi: hidden');
    assert.ok(await page.eval(`document.documentElement.classList.contains('didomi-popup-open')`), 'Didomi: its lock is there');
    assert.equal(await scrolls(), true, 'Didomi: the page scrolls');
    // The site's own dialog over it locks the page, as the site meant; closed, it scrolls again.
    await page.eval(`(document.getElementById('site-modal').classList.add('show'), document.body.classList.add('modal-open'), true)`);
    await sleep(300);
    assert.equal(await scrolls(), false, "Didomi: the site's own dialog still locks the page");
    await page.eval(`(document.getElementById('site-modal').classList.remove('show'), document.body.classList.remove('modal-open'), true)`);
    await sleep(300);
    assert.equal(await scrolls(), true, "Didomi: the site's dialog closed, it scrolls again");

    await open('/sourcepoint');
    assert.equal(await shown('[id^="sp_message_container_"]'), false, 'Sourcepoint: the overlay is hidden');
    assert.ok(await page.eval(`document.documentElement.classList.contains('sp-message-open')`), 'Sourcepoint: its lock is there');
    assert.equal(await scrolls(), true, 'Sourcepoint: the page scrolls');
    // Off: the popup is back, and so is its lock (nothing of ours left).
    await setHide(false);
    for (let i = 0; i < 25 && !await shown('[id^="sp_message_container_"]'); i++) await sleep(200);
    assert.equal(await shown('[id^="sp_message_container_"]'), true, 'off: the popup shows');
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).position`), 'fixed', 'off: its lock is the page\'s again');
    await setHide(true);
    for (let i = 0; i < 25 && await shown('[id^="sp_message_container_"]'); i++) await sleep(200);
    assert.equal(await scrolls(), true, 'on again: it scrolls');

    await open('/modal');
    assert.equal(await shown('.modal'), true, 'a site dialog shows');
    assert.equal(await scrolls(), false, 'a site dialog (no consent popup) still locks the page');
    assert.equal(await page.eval(`getComputedStyle(document.body).overflow`), 'hidden');
    page.close();
  } finally { await b.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
