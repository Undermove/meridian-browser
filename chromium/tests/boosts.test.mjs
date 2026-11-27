// Boosts, as in Arc: a site the person's way (a colour, dark, a font, size and case, zapped elements,
// their own CSS and JavaScript), in the editor at the right of the page with real clicks; "Improve
// with Claude" asking the AI for the site's CSS; agents making one over MCP; and Arc's boosts brought
// over with the rest of its data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launch, APP, SB, NEEDS_FRAMES } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SC = 'app.$.siteControl.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const KEY = 'sk-ant-test-000000000000000000000000';

const PAGE = `<!doctype html><title>News</title><body style="margin:0;font-family:Arial">
<header id=top style="height:40px;background:rgb(200,0,0)">Top</header>
<div id=promo class="promo-banner" style="height:120px;background:rgb(0,0,200)">Subscribe now!</div>
<main id=story><h1>Story</h1><p>Text of the story.</p>
<div class=card>Ad one</div><div class=card>Ad two</div><div class=card>Ad three</div></main>
<script>window.loads = (window.loads || 0) + 1;</script>`;

function site() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/news` })));
}

function profileWith(meridian = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ meridian }));
  return dir;
}

// The page's own look, read in the page.
const shown = (page, sel) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? getComputedStyle(el).display : 'gone'; })()`);

async function openControls(b) {
  await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`);
  await b.click(`app.$.locationIconButton`);
  await b.waitFor(`app.$.siteControl.open && !!${SC}.querySelector('#boostRow, .boost-row')`);
}

const BE = 'app.$.boostEditor.shadowRoot';

// The site controls' "Boost this site" (or a boost's chevron): the editor at the right of the page.
async function openEditor(b, which = '#boostRow') {
  await openControls(b);
  await b.click(`${SC}.querySelector('${which}')`);
  await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('pad') && !app.$.siteControl.open`);
}

// A real click in the page, at the middle of `sel`.
async function clickIn(page, sel) {
  const at = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

// A real click on the editor's colour pad (its dotted field, inside the rim of hues), at a fraction of
// its width and height.
async function clickPad(b, fx, fy) {
  const at = await b.eval(`(() => { const r = ${BE}.querySelector('#pad .field').getBoundingClientRect(); return { x: r.x + r.width * ${fx}, y: r.y + r.height * ${fy} }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await b.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

// A real click on something in the editor card: first the wheel over the card until it's in view,
// as a person would (on a small screen the card is taller than the window, the code open even more).
async function clickEditor(b, elExpr) {
  for (let i = 0; i < 20; i++) {
    const where = await b.eval(`(() => { const c = ${BE}.getElementById('card').getBoundingClientRect(), r = (${elExpr}).getBoundingClientRect(); return r.top < c.top ? -1 : r.bottom > c.bottom ? 1 : 0; })()`);
    if (!where) break;
    const at = await b.point(`${BE}.getElementById('card')`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: where * 120 });
    await sleep(60);
  }
  await b.click(elExpr);
}

const style = (page) => page.eval(`document.getElementById('meridian-boost-style')?.textContent || ''`);

test('Boost editor, as Arc’s: a colour on the pad, a font, size, case, dark, code; every page of the site; on and off from the list; a second boost; deleted', async () => {
  const s = await site();
  const b = await launch([s.url]);
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openControls(b);
    assert.match(await b.eval(`${SC}.getElementById('boostRow').textContent`), /Boost this site/);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('pad')`);
    assert.equal(await b.eval(`${BE}.getElementById('name').value`), 'My Boost');

    // A colour on the pad, as Arc's: the hue is the rim's colour at the angle from the middle (magenta
    // at the top, red at the right, clockwise), the amount how far out. Right of the middle, 3/5 of
    // the way out: a red: the page is painted in it; the knob glides there, the small one (the second
    // colour, for the dark parts) opposite, on the cyan side.
    await clickPad(b, 0.8, 0.5);
    await page.waitFor(`!!document.getElementById('meridian-boost-paint') && document.body.hasAttribute('data-mb-fg')`, 5000);
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).filter`), 'none', 'no filter over the page');
    assert.notEqual(await page.eval(`getComputedStyle(document.documentElement, '::after').mixBlendMode`), 'color', 'no colour layer over the whole page');
    const { state } = await b.eval(`${H}.getBoost()`);
    assert.ok(state.boost.tint >= 355 || state.boost.tint <= 5, `tint ${state.boost.tint}`);
    assert.ok(state.boost.tint2 >= 170 && state.boost.tint2 <= 190, `tint2 ${state.boost.tint2}`);
    assert.ok(state.boost.tintStrength >= 55 && state.boost.tintStrength <= 65, `strength ${state.boost.tintStrength}`);
    await b.waitFor(`(() => { const f = ${BE}.querySelector('#pad .field').getBoundingClientRect(); const at = (id) => { const r = ${BE}.getElementById(id).getBoundingClientRect(); return [(r.x + r.width / 2 - f.x) / f.width, (r.y + r.height / 2 - f.y) / f.height]; }; const [kx, ky] = at('knob'), [sx, sy] = at('shade'); return Math.abs(kx - 0.8) < 0.03 && Math.abs(ky - 0.5) < 0.03 && Math.abs(sx - 0.2) < 0.03 && Math.abs(sy - 0.5) < 0.03; })()`, 3000);
    // A font from the grid, the size up, upper case (Arc's order: AA, then aa), dark.
    await clickEditor(b, `${BE}.querySelector('.font[data-font="Baskerville"]')`);
    await page.waitFor(`getComputedStyle(document.querySelector('p')).fontFamily.startsWith('Baskerville')`, 5000);
    await clickEditor(b, `${BE}.getElementById('size')`);
    await page.waitFor(`getComputedStyle(document.body).zoom === '1.1'`, 5000);
    await clickEditor(b, `${BE}.getElementById('case')`);
    await page.waitFor(`getComputedStyle(document.querySelector('p')).textTransform === 'uppercase'`, 5000);
    await clickEditor(b, `${BE}.getElementById('dark')`);
    await page.waitFor(`getComputedStyle(document.documentElement).filter.includes('invert(1)')`, 5000);
    // Quick changes, one boost.
    assert.equal((await b.eval(`${H}.getBoosts()`)).boosts.length, 1);

    // Code, as Arc's: a page of its own (the card widens to 480 px, Back returns); CSS hides the
    // promo at once with the hammer; JavaScript runs from the next load.
    await clickEditor(b, `${BE}.getElementById('code')`);
    await b.waitFor(`${BE}.getElementById('card').getBoundingClientRect().width === 480 && getComputedStyle(${BE}.querySelector('.codev')).visibility === 'visible'`, 3000);
    await b.eval(`(() => { ${BE}.getElementById('css').value = '#promo { display: none !important; }'; ${BE}.getElementById('js').value = "document.body.dataset.boosted = 'yes';"; })()`);
    await clickEditor(b, `${BE}.getElementById('codeSave')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    await clickEditor(b, `${BE}.getElementById('back')`);
    await b.waitFor(`${BE}.getElementById('card').getBoundingClientRect().width === 183`, 3000);
    assert.equal(await page.eval(`document.body.dataset.boosted || ''`), '');

    // Another page of the site, opened fresh: all of it, the JavaScript too, the style after the site's.
    const other = s.url.replace('/news', '/other');
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(other)})`);
    const p2 = await b.page(other);
    await p2.waitFor(`document.body?.dataset.boosted === 'yes'`, 8000);
    assert.equal(await shown(p2, '#promo'), 'none');
    assert.equal(await p2.eval(`document.documentElement.lastElementChild.id`), 'meridian-boost-style');
    p2.close();

    // Back on the first tab, the list in the site controls: off and on with a click.
    await b.click(`[...app.$.tabstrip.shadowRoot.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url === ${JSON.stringify(s.url)}).shadowRoot.querySelector('.row')`);
    await openControls(b);
    assert.match(await b.eval(`${SC}.querySelector('.boost-row').textContent`), /My Boost[\s\S]*Enabled/);
    await b.click(`${SC}.querySelector('.boost-toggle')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    await b.waitFor(`/Disabled/.test(${SC}.querySelector('.boost-row').textContent)`);
    await b.click(`${SC}.querySelector('.boost-toggle')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);

    // A second boost for the site.
    await b.click(`${SC}.getElementById('newBoost')`);
    await b.waitFor(`app.$.boostEditor.open && ${BE}.getElementById('name').value === 'Boost 2'`);
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boosts.length, 2);
    await clickEditor(b, `${BE}.getElementById('more')`);
    await clickEditor(b, `${BE}.getElementById('delete')`);
    await clickEditor(b, `${BE}.getElementById('delete')`);
    await b.waitFor(`!app.$.boostEditor.open`);

    // The first one, from its chevron, deleted (two clicks): the site's own look again.
    await openEditor(b, '.boost-edit');
    assert.equal(await b.eval(`${BE}.getElementById('name').value`), 'My Boost');
    await clickEditor(b, `${BE}.getElementById('more')`);
    await clickEditor(b, `${BE}.getElementById('delete')`);
    await clickEditor(b, `${BE}.getElementById('delete')`);
    await page.waitFor(`!document.getElementById('meridian-boost-style')`, 5000);
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boost, null);
    page.close();
  } finally { await b.close(); s.server.close(); }
});

// A real click on Zap's own controls in the page (the bar, the chooser).
async function clickZapUi(page, sel) {
  const at = await page.eval(`(() => { const r = document.getElementById('meridian-zap').shadowRoot.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

const zapUi = (page, js) => page.eval(`(() => { const r = document.getElementById('meridian-zap')?.shadowRoot; return r ? ${js} : null; })()`);

test('Zap, as Arc’s: Zap This or all related elements; an Undo per zap shows what it brings back; Done; still hidden after a restart', async () => {
  const s = await site();
  const profile = profileWith();
  let b = await launch([s.url], { profile });
  try {
    let page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openEditor(b);
    await clickEditor(b, `${BE}.getElementById('zap')`);
    await page.waitFor(`!!document.getElementById('meridian-zap')`, 5000);
    await b.waitFor(`/Zapping/.test(${BE}.getElementById('zap').textContent)`);

    // A click on the promo: the page doesn't get it; the chooser does. Zap This.
    await page.eval(`document.getElementById('promo').onclick = () => { window.promoClicked = true; }`);
    await clickIn(page, '#promo');
    await page.waitFor(`document.getElementById('meridian-zap').shadowRoot.querySelector('.pick').style.display === 'flex'`, 3000);
    await clickZapUi(page, '.zap-this');
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 3000);
    assert.equal(await page.eval('window.promoClicked || false'), false);
    await b.waitFor(`${BE}.querySelector('#zap .count').textContent.trim() === '1'`, 5000);

    // One card, then all of its kind with the slider: "Zap 3 elements".
    await clickIn(page, '.card');
    await page.waitFor(`document.getElementById('meridian-zap').shadowRoot.querySelector('.pick').style.display === 'flex'`, 3000);
    assert.equal(await zapUi(page, `r.querySelector('.zap-related').textContent`), 'Zap 3 elements');
    assert.equal(await zapUi(page, `r.querySelectorAll('.mark').length`), 1, 'the one clicked is marked');
    // The pointer on "Zap 3 elements": the three are marked.
    const relatedAt = await page.eval(`(() => { const r = document.getElementById('meridian-zap').shadowRoot.querySelector('.zap-related').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: relatedAt.x, y: relatedAt.y, button: 'none' });
    await page.waitFor(`document.getElementById('meridian-zap').shadowRoot.querySelectorAll('.mark').length === 3`, 3000);
    await clickZapUi(page, '.zap-related');
    await page.waitFor(`[...document.querySelectorAll('.card')].every((c) => getComputedStyle(c).display === 'none')`, 3000);
    await b.waitFor(`${BE}.querySelector('#zap .count').textContent.trim() === '2'`, 5000);
    assert.equal(await zapUi(page, `r.querySelectorAll('.undo').length`), 2);

    // Undo: the pointer on it shows the cards, marked; away, hidden again; a click brings them back.
    const undoAt = await page.eval(`(() => { const r = document.getElementById('meridian-zap').shadowRoot.querySelectorAll('.undo')[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: undoAt.x, y: undoAt.y, button: 'none' });
    await page.waitFor(`getComputedStyle(document.querySelector('.card')).display !== 'none'`, 3000);
    await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 30, button: 'none' });
    await page.waitFor(`getComputedStyle(document.querySelector('.card')).display === 'none'`, 3000);
    await clickZapUi(page, '.undo[data-index="1"]');
    await page.waitFor(`[...document.querySelectorAll('.card')].every((c) => getComputedStyle(c).display === 'block')`, 3000);
    await b.waitFor(`${BE}.querySelector('#zap .count').textContent.trim() === '1'`, 5000);
    assert.equal(await shown(page, '#promo'), 'none');

    // Zap This on the second card: only that one.
    await clickIn(page, '.card:nth-of-type(2)');
    await page.waitFor(`document.getElementById('meridian-zap').shadowRoot.querySelector('.pick').style.display === 'flex'`, 3000);
    await clickZapUi(page, '.zap-this');
    const cards = `[...document.querySelectorAll('.card')].map((c) => getComputedStyle(c).display).join()`;
    for (let i = 0; i < 30 && await page.eval(cards) !== 'block,none,block'; i++) await sleep(100);
    assert.equal(await page.eval(cards), 'block,none,block', JSON.stringify(await page.eval(`({ inline: [...document.querySelectorAll('.card')].map((c) => c.style.display), style: document.getElementById('meridian-boost-style')?.textContent, undo: [...document.getElementById('meridian-zap').shadowRoot.querySelectorAll('.undo')].map((u) => u.title) })`)));
    await b.waitFor(`${BE}.querySelector('#zap .count').textContent.trim() === '2'`, 5000);
    await clickZapUi(page, '.undo[data-index="1"]');
    await b.waitFor(`${BE}.querySelector('#zap .count').textContent.trim() === '1'`, 5000);

    // Done: zap is over, a click is the page's again.
    await clickZapUi(page, '.done');
    await page.waitFor(`!document.getElementById('meridian-zap')`, 5000);
    await b.waitFor(`!/Zapping/.test(${BE}.getElementById('zap').textContent)`, 5000);
    await page.eval(`document.getElementById('top').onclick = () => { window.topClicked = true; }`);
    await clickIn(page, '#top');
    await page.waitFor('window.topClicked === true', 3000);

    // After a restart and a reload: still hidden; the editor's × shows it again.
    page.close();
    await b.quit();
    b = await launch([s.url], { profile });
    page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 8000);
    assert.equal(await shown(page, '#story'), 'block');
    await openEditor(b, '.boost-edit');
    // Zap again: the earlier zap has its Undo (Esc ends it too).
    await clickEditor(b, `${BE}.getElementById('zap')`);
    await page.waitFor(`!!document.getElementById('meridian-zap')`, 5000);
    assert.equal(await zapUi(page, `r.querySelectorAll('.undo').length`), 1);
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor(`!document.getElementById('meridian-zap')`, 5000);
    await clickEditor(b, `${BE}.querySelector('.zap-x')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    page.close();
  } finally { await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

function fakeClaude(answer) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push(json);
      if (!json.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: {} });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      // In two pieces, as a stream comes.
      const text = JSON.stringify(answer);
      for (const part of [text.slice(0, 20), text.slice(20)]) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' } });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

test('Improve with Claude: the page measured, with a screenshot, goes to Claude, its CSS becomes the boost, clutter a zap; Undo', async () => {
  const s = await site();
  // The same answer again in the review round: nothing to change, so it's done.
  const api = await fakeClaude({ name: 'Calm News', css: '#story h1 { color: rgb(1, 2, 3); }', hide: ['#promo'], summary: 'Hid the subscription banner.' });
  const b = await launch([s.url], { args: [`--meridian-ai-base-url=${api.base}`] });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openEditor(b);
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    // No AI yet: the button says where to set one up.
    await b.waitFor(`${BE}.getElementById('improve').disabled && /Settings/.test(${BE}.getElementById('improve').textContent)`);
    assert.equal((await b.eval(`${H}.setAiKey(${JSON.stringify(KEY)})`)).ok, true);
    // Folded and opened again: the AI set up meanwhile.
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await b.waitFor(`/Improve with Claude/.test(${BE}.getElementById('improve').textContent)`);

    await b.eval(`${BE}.getElementById('wish').value = 'hide the banner'`);
    await clickEditor(b, `${BE}.getElementById('improve')`);
    await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the subscription banner.')`, 15000, `${BE}.getElementById('note')?.textContent`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    await page.waitFor(`getComputedStyle(document.querySelector('#story h1')).color === 'rgb(1, 2, 3)'`, 5000);
    // A boost still called "My Boost" takes the AI's name; the clutter is a zap (its own Undo in Zap).
    const made = (await b.eval(`${H}.getBoost()`)).state.boost;
    assert.equal(made.name, 'Calm News');
    assert.deepEqual(made.zaps, ['#promo']);

    // What Claude got: the designer's brief, the page measured (landmarks, type, colours, the
    // outline with the page's elements), a screenshot, the wish; then a review round.
    const asked = api.requests.filter((r) => r.stream);
    assert.equal(asked.length, 2, 'a redesign and a review');
    const req = asked[0];
    assert.match(req.system, /senior product designer/);
    assert.equal(req.tools, undefined, 'no browser tools for a boost');
    const text = JSON.stringify(req.messages);
    assert.match(text, /div#promo\.promo-banner/);
    assert.match(text, /Subscribe now!/);
    assert.match(text, /hide the banner/);
    assert.match(text, /Viewport: \d+x\d+ CSS px/);
    assert.match(text, /Type scale in use/);
    assert.match(text, /main#story/);
    const image = req.messages.at(-1).content.find((c) => c.type === 'image');
    assert.equal(image?.source?.media_type, 'image/jpeg', 'a screenshot of the page');
    assert.ok(Buffer.from(image.source.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');
    assert.match(JSON.stringify(asked[1].messages), /Review round 2 of 3/);

    // Undo: the boost as it was before.
    await clickEditor(b, `${BE}.getElementById('undo')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    const after = (await b.eval(`${H}.getBoost()`)).state.boost;
    assert.equal(after.css, '');
    assert.deepEqual(after.zaps, []);
    assert.equal(after.name, 'My Boost');
    page.close();
  } finally { await b.close(); s.server.close(); api.server.close(); }
});

// A stand-in `claude` (Claude Code), signed in: it answers a boost with `answer` (and a review round
// with "done") and writes down the CLAUDE_CONFIG_DIR each run got (the space's account).
function fakeClaudeCode(dir, answer) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const n = fs.readdirSync(log).length;
fs.writeFileSync(path.join(log, n + '.env'), process.env.CLAUDE_CONFIG_DIR ?? '<unset>');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const out = (o) => console.log(JSON.stringify(o));
  // A review round: nothing more to change.
  const text = /Review round/.test(stdin) ? '{"done": true}' : ${JSON.stringify(JSON.stringify(answer))};
  out({ type: 'system', subtype: 'init', session_id: 's-' + n, model: 'claude-opus-5-5' });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
});
`);
  return () => fs.readdirSync(log).sort((a, c) => parseInt(a) - parseInt(c)).map((f) => fs.readFileSync(path.join(log, f), 'utf8'));
}

// The pixels at the left and right edges, a fifth from the bottom, of a JPEG (base64), read through
// macOS's sips as a BMP.
function pageEdges(jpeg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-shot-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.jpg'), Buffer.from(jpeg, 'base64'));
    execFileSync('sips', ['-s', 'format', 'bmp', path.join(dir, 'a.jpg'), '--out', path.join(dir, 'a.bmp')], { stdio: 'ignore' });
    const bmp = fs.readFileSync(path.join(dir, 'a.bmp'));
    const at = bmp.readUInt32LE(10), w = bmp.readInt32LE(18), h = bmp.readInt32LE(22), bpp = bmp.readUInt16LE(28) / 8;
    const row = Math.ceil((w * bpp) / 4) * 4;
    const y = Math.round(Math.abs(h) * 0.8);
    const line = h > 0 ? Math.abs(h) - 1 - y : y;  // Bottom-up unless the height is negative.
    const px = (x) => { const o = at + line * row + x * bpp; return [bmp[o + 2], bmp[o + 1], bmp[o]]; };
    return [px(1), px(4), px(w - 2), px(w - 5)];
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// A stand-in Claude Code that designs in rounds: run n answers `rounds[n]` (the last one again
// after that), a second and a half later, as a real one takes its time; each run's message is
// written down: what it was asked and whether a screenshot came with it.
function fakeDesigner(dir, rounds) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)};
const rounds = ${JSON.stringify(rounds)};
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const n = fs.readdirSync(log).length;
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  // A screenshot comes as a stream-json user message: its picture and its text.
  let text = stdin, images = [];
  if (args.includes('--input-format')) {
    const content = JSON.parse(stdin.trim()).message.content;
    images = content.filter((c) => c.type === 'image').map((c) => c.source.media_type + ':' + c.source.data);
    text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  fs.writeFileSync(path.join(log, n + '.json'), JSON.stringify({ text, images }));
  const out = (o) => console.log(JSON.stringify(o));
  const answer = JSON.stringify(rounds[Math.min(n, rounds.length - 1)]);
  setTimeout(() => {
    out({ type: 'system', subtype: 'init', session_id: 's-' + n, model: 'claude-opus-5-5' });
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } } });
    out({ type: 'result', subtype: 'success', is_error: false, result: answer });
  }, 1500);
});
`);
  return () => fs.readdirSync(log).sort((a, c) => parseInt(a) - parseInt(c)).map((f) => JSON.parse(fs.readFileSync(path.join(log, f), 'utf8')));
}

test('Improve redesigns in rounds: each CSS checked (nothing hidden, nothing from the internet), a screenshot to review it, progress in the editor; kept after a reload; Undo', { skip: NEEDS_FRAMES }, async () => {
  const s = await site();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-accounts-')));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '');
  const runs = fakeDesigner(bin, [
    // Round 1: a redesign, with a rule that hides the content and a picture from the internet.
    { name: 'Night Desk', summary: 'A dark, calm reading desk.', hide: [],
      css: 'main#story { background: rgb(10, 20, 30); color: rgb(240, 240, 240) }\n' +
        'main { display: none !important }\n' +
        'body { background-image: url(https://tracker.example/pixel.png); font-size: 17px }\n' +
        'a:focus-visible { outline: 2px solid rgb(120, 160, 255) }' },
    // Round 2, the review: fixes, the whole CSS again.
    { summary: 'Fixed the heading.', hide: [],
      css: 'main#story { background: rgb(10, 20, 30); color: rgb(240, 240, 240) }\n' +
        'body { font-size: 17px }\n#story h1 { letter-spacing: 1px }' },
    // Round 3: good as it is.
    { done: true, css: '', summary: '' },
  ]);
  const b = await launch([s.url], { args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`] });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    const before = await page.eval(`getComputedStyle(document.getElementById('story')).backgroundColor`);
    await openEditor(b);
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await b.waitFor(`${BE}.getElementById('improve').textContent.trim() === 'Improve with Claude Code' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve').textContent`);
    await b.eval(`${BE}.getElementById('wish').value = 'dark and strict'`);
    await clickEditor(b, `${BE}.getElementById('improve')`);
    // The rounds, as the button and the page's status pill show them; the glow over the page all the
    // while, never in the way.
    const labels = new Set(), pills = new Set();
    let overlay = null, magic = null;
    for (let i = 0; i < 300; i++) {
      const now = await b.eval(`({ label: ${BE}.getElementById('improve').textContent.trim(), magic: ${BE}.getElementById('improve').classList.contains('magic'), note: ${BE}.getElementById('note')?.textContent || '', state: app.$.boostMagic.state, pill: app.$.boostMagic.shadowRoot.getElementById('pill')?.textContent.replace(/\\s+/g, ' ').trim() || '' })`);
      labels.add(now.label);
      if (now.state === 'running') {
        pills.add(now.pill);
        magic ||= now.magic;
        overlay ||= await b.eval(`(() => { const m = app.$.boostMagic, r = m.getBoundingClientRect(), c = app.$.contentRegion.getBoundingClientRect(); const st = getComputedStyle(m); return { over: Math.abs(r.left - c.left) < 2 && Math.abs(r.top - c.top) < 2 && Math.abs(r.width - c.width) < 2 && Math.abs(r.height - c.height) < 2, pointer: st.pointerEvents, opacity: st.opacity, turning: getComputedStyle(m.shadowRoot.querySelector('.ring.edge i')).animationName }; })()`);
      }
      if (now.note) break;
      await sleep(100);
    }
    assert.match(await b.eval(`${BE}.getElementById('note').textContent`), /A dark, calm reading desk\./);
    assert.ok([...labels].some((l) => /Designing… 1\/3/.test(l)), [...labels].join(' | '));
    assert.ok([...labels].some((l) => /2\/3/.test(l)), [...labels].join(' | '));
    assert.ok([...labels].some((l) => /3\/3/.test(l)), [...labels].join(' | '));
    assert.ok(magic, 'the button glows while it works');
    assert.deepEqual({ ...overlay, opacity: undefined }, { over: true, pointer: 'none', opacity: undefined, turning: 'magic-turn' });
    assert.ok([...pills].some((p) => /Designing… 1\/3.*going for “dark and strict”/.test(p)), [...pills].join(' | '));
    assert.ok([...pills].some((p) => /Reviewing… 2\/3.*fixing what the checks took out/.test(p)), [...pills].join(' | '));
    assert.ok([...pills].some((p) => /Polishing… 3\/3/.test(p)), [...pills].join(' | '));
    // Done: a moment with Undo in the pill, then it goes by itself.
    await b.waitFor(`app.$.boostMagic.state === 'done' && /Done/.test(app.$.boostMagic.shadowRoot.getElementById('pill').textContent) && !!app.$.boostMagic.shadowRoot.getElementById('magicUndo')`, 3000);
    await b.waitFor(`app.$.boostMagic.state === 'off' && getComputedStyle(app.$.boostMagic).visibility === 'hidden'`, 8000);

    // Three runs, each with a screenshot; the review hears what the checks took out.
    const asked = runs();
    assert.equal(asked.length, 3);
    for (const r of asked) assert.deepEqual(r.images.map((i) => i.split(':')[0]), ['image/jpeg'], 'a screenshot each round');
    // The glow is the browser's, over the tab: the AI's screenshot (taken while it shone) is the
    // page alone, its edges the page's own white.
    if (process.platform === 'darwin') {
      const edges = pageEdges(asked[1].images[0].split(':')[1]);
      assert.ok(edges.every((px) => px.every((v) => v > 235)), `screenshot edges ${JSON.stringify(edges)}`);
    }
    assert.match(asked[0].text, /The person's direction: dark and strict/);
    assert.match(asked[0].text, /Landmarks/);
    assert.match(asked[1].text, /Review round 2 of 3/);
    assert.match(asked[1].text, /main: display: none hides content/);
    assert.match(asked[1].text, /loads from the internet/);
    assert.match(asked[1].text, /<css_on_the_page>[\s\S]*main#story/);

    // On the page: round 2's CSS; the content shown; nothing loaded from the internet.
    const look = () => page.eval(`(() => { const st = getComputedStyle(document.getElementById('story')); return { bg: st.backgroundColor, display: st.display, spacing: getComputedStyle(document.querySelector('#story h1')).letterSpacing, image: getComputedStyle(document.body).backgroundImage }; })()`);
    await page.waitFor(`getComputedStyle(document.querySelector('#story h1')).letterSpacing === '1px'`, 5000);
    assert.deepEqual(await look(), { bg: 'rgb(10, 20, 30)', display: 'block', spacing: '1px', image: 'none' });
    const saved = (await b.eval(`${H}.getBoost()`)).state.boost;
    assert.equal(saved.name, 'Night Desk');
    assert.match(saved.css, /#story h1 \{\n {2}letter-spacing: 1px !important;\n\}/);
    assert.doesNotMatch(saved.css, /display: none|tracker\.example/);
    // In the editor's code, to change by hand.
    await clickEditor(b, `${BE}.getElementById('code')`);
    await b.waitFor(`${BE}.getElementById('css')?.value.includes('letter-spacing: 1px')`, 5000);

    // A reload: still there.
    await page.eval('location.reload()');
    await page.waitFor(`document.readyState === 'complete' && getComputedStyle(document.getElementById('story')).backgroundColor === 'rgb(10, 20, 30)'`, 8000);

    // Undo: the page as before Improve, also after a reload.
    await clickEditor(b, `${BE}.getElementById('undo')`);
    await page.waitFor(`getComputedStyle(document.getElementById('story')).backgroundColor === ${JSON.stringify(before)}`, 5000);
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boost.css, '');
    await page.eval('location.reload()');
    await page.waitFor(`document.readyState === 'complete'`);
    await sleep(500);
    assert.equal(await page.eval(`getComputedStyle(document.getElementById('story')).backgroundColor`), before);
    page.close();
  } finally {
    await b.close(); s.server.close();
    fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Improve with reduced motion: the glow stands still, the round in words; it goes on an error', async () => {
  const s = await site();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-accounts-')));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '');
  // Not a boost: an error, and the magic goes at once.
  fakeDesigner(bin, [{ nothing: 'here' }]);
  const b = await launch([s.url], { args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`] });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await b.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await openEditor(b);
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await b.waitFor(`${BE}.getElementById('improve').textContent.trim() === 'Improve with Claude Code' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve').textContent`);
    await clickEditor(b, `${BE}.getElementById('improve')`);
    await b.waitFor(`app.$.boostMagic.state === 'running' && /Designing… 1\\/3/.test(app.$.boostMagic.shadowRoot.getElementById('pill').textContent)`, 8000);
    const still = await b.eval(`(() => { const r = app.$.boostMagic.shadowRoot; const a = (sel) => getComputedStyle(r.querySelector(sel)).animationName; return { ring: a('.ring.edge i'), glow: a('.ring.glow'), shimmer: getComputedStyle(r.querySelector('.shimmer')).display, button: getComputedStyle(${BE}.getElementById('improve'), '::before').animationName, shown: getComputedStyle(app.$.boostMagic).opacity }; })()`);
    assert.deepEqual(still, { ring: 'none', glow: 'none', shimmer: 'none', button: 'none', shown: '1' });
    await b.waitFor(`${BE}.getElementById('note')?.classList.contains('err')`, 15000);
    await b.waitFor(`app.$.boostMagic.state === 'off'`, 2000);
    page.close();
  } finally {
    await b.close(); s.server.close();
    fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Improve with Claude Code when nothing is picked in Settings › AI: in the default space and in a space with its own profile (as its AI account)', { skip: NEEDS_FRAMES }, async () => {
  const s = await site();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const runs = fakeClaudeCode(bin, { name: 'Calm News', css: '#story { color: rgb(1, 2, 3); }', hide: ['#promo'], summary: 'Hid the banner.' });
  // Claude Code's accounts: its own folder and a Work one.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-accounts-')));
  for (const dir of ['.claude', '.claude-work']) { fs.mkdirSync(path.join(home, dir)); fs.writeFileSync(path.join(home, dir, 'settings.json'), ''); }
  // No AI picked, no key: "Automatic".
  const b = await launch([s.url], { args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`] });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    assert.equal((await b.eval(`${H}.getSettings()`)).settings.aiProvider, '');

    // (a) The default space: Claude Code, found on this computer, improves the boost.
    await openEditor(b);
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await b.waitFor(`${BE}.getElementById('improve').textContent.trim() === 'Improve with Claude Code' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve').textContent`);
    await clickEditor(b, `${BE}.getElementById('improve')`);
    await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the banner.')`, 20000, `${BE}.getElementById('note')?.textContent`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    assert.deepEqual(runs(), ['<unset>', '<unset>'], 'a redesign and a review, as Claude Code’s own account');
    await b.eval('app.$.boostEditor.open = false');
    page.close();

    // (b) A space in its own profile, with the Work account for Claude: the same button, and the
    // run goes as Work.
    const { profileId } = await b.eval(`${H}.addProfile('Work')`);
    const { spaceId } = await b.eval(`${H}.createSpace('Client', '', '', '')`);
    await b.eval(`${H}.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
    const accounts = JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json);
    const work = accounts.vendors.find((v) => v.id === 'claude').accounts.find((a) => a.label === 'Claude Work').id;
    await b.eval(`${H}.setSpaceAiAccount(${JSON.stringify(spaceId)}, 'claude', ${JSON.stringify(work)})`);
    await b.eval(`${H}.activateSpace(${JSON.stringify(spaceId)})`);
    await b.waitFor(`app.$.tabstrip.state_.activeSpaceId === ${JSON.stringify(spaceId)} && app.$.tabstrip.state_.profileId === ${JSON.stringify(profileId)}`);
    const there = `${s.url}?client`;
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(there)})`);
    const page2 = await b.page(there);
    await page2.waitFor(`document.readyState === 'complete'`);
    // The site's boost from (a), improved again here.
    // On Windows the new page can bring a mouse move of its own (the OS cursor is elsewhere):
    // the sidebar's mouseleave closes the site controls 450 ms later. Then again, as a person would.
    await openEditor(b, '.boost-edit').catch(async (e) => {
      if (process.platform !== 'win32' || await b.eval('app.$.siteControl.open')) throw e;
      await openEditor(b, '.boost-edit');
    });
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await b.waitFor(`${BE}.getElementById('improve').textContent.trim() === 'Improve with Claude Code' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve').textContent`);
    await clickEditor(b, `${BE}.getElementById('improve')`);
    await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the banner.')`, 20000, `${BE}.getElementById('note')?.textContent`);
    await page2.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    assert.deepEqual(runs(), ['<unset>', '<unset>', path.join(home, '.claude-work'), path.join(home, '.claude-work')], 'the space’s Work account');
    page2.close();
  } finally {
    await b.close(); s.server.close();
    fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Improve with AI in a space that never chose runs as the main subscription (Settings › AI › New spaces)', async () => {
  const s = await site();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const runs = fakeClaudeCode(bin, { name: 'Calm News', css: '#story { color: rgb(1, 2, 3); }', hide: ['#promo'], summary: 'Hid the banner.' });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-accounts-')));
  for (const dir of ['.claude', '.claude-work']) { fs.mkdirSync(path.join(home, dir)); fs.writeFileSync(path.join(home, dir, 'settings.json'), ''); }
  const b = await launch([s.url], { args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`] });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    // The main subscription is Work; this space never chose one.
    const accounts = JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json);
    const work = accounts.vendors.find((v) => v.id === 'claude').accounts.find((a) => a.label === 'Claude Work').id;
    await b.eval(`${H}.setMainAiAccount('claude', ${JSON.stringify(work)})`);
    await openEditor(b);
    await clickEditor(b, `${BE}.getElementById('improveToggle')`);
    await b.waitFor(`${BE}.getElementById('improve').textContent.trim() === 'Improve with Claude Code' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve').textContent`);
    await clickEditor(b, `${BE}.getElementById('improve')`);
    await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the banner.')`, 20000, `${BE}.getElementById('note')?.textContent`);
    assert.deepEqual(runs(), [path.join(home, '.claude-work'), path.join(home, '.claude-work')], 'as the main subscription');
    page.close();
  } finally {
    await b.close(); s.server.close();
    fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

// An MCP client talking to the bridge.
function bridge(profile) {
  const proc = spawn(APP, ['--mcp-bridge', `--user-data-dir=${profile}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = (await request('tools/call', { name, arguments: args })).result;
    const c = r.content[0];
    const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
    return { error: r.isError ? c.text : null, value: !r.isError ? parse(c.text) : null };
  };
  return { request, call, close: () => proc.kill() };
}

test('an agent makes a boost over MCP: get_boost, set_boost; JavaScript only if allowed', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_allow_js: false });
  const b = await launch([s.url], { profile });
  const mcp = bridge(profile);
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    const names = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('get_boost') && names.includes('set_boost'));

    // get_boost without a tab: the active one (the site's, once the window has made it active).
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].some((t) => t.isActive && t.url === ${JSON.stringify(s.url)})`, 10000,
      `[...app.$.tabstrip.tabs_.values()].map((t) => [t.url, t.isActive])`);
    const first = await mcp.call('get_boost');
    assert.deepEqual(first.value, { host: '127.0.0.1', boost: null }, first.error);
    const set = await mcp.call('set_boost', { css: '#promo { display: none !important; }', zaps: ['#top'], name: 'Agent boost' });
    assert.equal(set.error, null, set.error);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none' && getComputedStyle(document.getElementById('top')).display === 'none'`, 5000);
    const got = (await mcp.call('get_boost')).value.boost;
    assert.equal(got.name, 'Agent boost');
    assert.deepEqual(got.zaps, ['#top']);
    // Fields it leaves out stay.
    await mcp.call('set_boost', { hue: 90 });
    assert.deepEqual((await mcp.call('get_boost')).value.boost.zaps, ['#top']);

    assert.match((await mcp.call('set_boost', { js: 'alert(1)' })).error, /JavaScript in boosts is off/);
    assert.equal((await mcp.call('set_boost', { remove: true })).value.removed, true);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    page.close();
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('Arc’s boosts come over with Arc’s data and work on their sites', async () => {
  const s = await site();
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.mkdirSync(path.join(arcDir, 'User Data'));
  // Arc's sidebar: without it Settings doesn't offer Arc's data.
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arcDir, 'StorableSidebar.json'));
  const boost = path.join(arcDir, 'boosts', 'B1A2');
  fs.mkdirSync(boost, { recursive: true });
  fs.writeFileSync(path.join(boost, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Quiet news', version: '1.0',
    content_scripts: [{ matches: ['*://127.0.0.1/*'], css: ['styles.css'], js: ['content.js'], run_at: 'document_end' }],
  }));
  fs.writeFileSync(path.join(boost, 'styles.css'), '#promo { display: none; }');
  fs.writeFileSync(path.join(boost, 'content.js'), "document.title = 'Boosted ' + document.title;");
  const b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${arcDir}`] });
  const ST = 'app.$.settings.shadowRoot';
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!app.$.tabstrip?.state_`);
    await b.eval(`app.$.tabstrip.runCommand(13, 0)`);  // Meridian > Settings
    await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('importArcData')`);
    await b.eval(`${ST}.getElementById('importArcData').scrollIntoView()`);
    await b.click(`${ST}.getElementById('importArcData')`);
    await b.waitFor(`/1 boost/.test(${ST}.getElementById('arcDataNote').textContent)`, 30000, `${ST}.getElementById('arcDataNote').textContent`);
    await b.eval(`${ST}.getElementById('close').click()`);
    const boosts = (await b.eval(`${H}.getBoosts()`)).boosts;
    assert.deepEqual(boosts.map((x) => [x.host, x.name]), [['127.0.0.1', 'Quiet news']]);

    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(s.url)})`);
    const page = await b.page(s.url);
    await page.waitFor(`document.title === 'Boosted News'`, 8000);
    assert.equal(await shown(page, '#promo'), 'none');
    page.close();
  } finally { await b.close(); s.server.close(); fs.rmSync(arcDir, { recursive: true, force: true }); }
});

// Colour helpers, in the page: WCAG contrast of each text element on what's under it.
const CONTRAST = `(() => {
  const p = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return m.length > 3 && m[3] === 0 ? null : m.slice(0, 3); };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = p(getComputedStyle(e).backgroundColor); if (c) return c; } return [255, 255, 255]; };
  let worst = 99, at = '';
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const cs = getComputedStyle(el);
    const need = parseFloat(cs.fontSize) >= 24 ? 3 : 4.5;
    const r = ratio(p(cs.color), bg(el)) / need;
    if (r < worst) { worst = r; at = el.tagName + ' ' + el.textContent.trim().slice(0, 20); }
  }
  return { worst, at };
})()`;
const HUE = (expr, prop) => `(() => { const m = getComputedStyle(${expr}).${prop}.match(/[\\d.]+/g).map((v) => v / 255); const [r, g, b] = m, hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo; if (!d) return -1; const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4; return Math.round(h * 60); })()`;
const near = (a, b, tol) => Math.abs((((a - b) % 360) + 540) % 360 - 180) <= tol;

test('a colour paints the page, Arc’s way: a tinted background and accents in the main colour, the dark top bar in the second, text still readable, a picture untouched; undone at once', async () => {
  const PAGE = `<!doctype html><title>Accent</title><style>body{margin:0;background:#fff;color:#222;font:16px system-ui}header{height:90px;background:#123a6b;color:#fff}a{color:#1565c0}button{background:#1565c0;color:#fff;border:0;padding:6px}img{width:90px;height:90px;display:block}</style><header>Site</header><p>Plain text <a href="#x">a link</a> <button>Go</button></p><img id="pic" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="90" height="90" fill="#e53935"/></svg>')}">`;
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const b = await launch([url]);
  try {
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openControls(b);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('pad')`);
    await clickPad(b, 1, 0.5);  // the right edge: red (hue 0), full colour; the second colour cyan
    await page.waitFor(`!!document.getElementById('meridian-boost-paint') && document.querySelector('header').hasAttribute('data-mb-bg')`, 5000);
    // No filter: not on the page, not on the picture; the picture is as it was.
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).filter`), 'none');
    assert.equal(await page.eval(`getComputedStyle(document.getElementById('pic')).filter`), 'none');
    // The white page takes a tint of the colour (still light), the link and the button the colour;
    // the dark blue top bar the second colour (still dark).
    const bodyBg = await page.eval(`getComputedStyle(document.documentElement).backgroundColor`);
    assert.notEqual(bodyBg, 'rgb(255, 255, 255)');
    assert.ok(near(await page.eval(HUE('document.documentElement', 'backgroundColor')), 0, 30), bodyBg);
    assert.ok(near(await page.eval(HUE(`document.querySelector('a')`, 'color')), 0, 30), 'the link takes the colour');
    assert.ok(near(await page.eval(HUE(`document.querySelector('button')`, 'backgroundColor')), 0, 30), 'the button takes the colour');
    assert.ok(near(await page.eval(HUE(`document.querySelector('header')`, 'backgroundColor')), 180, 30), 'the top bar takes the second colour');
    // Readable everywhere: AA (4.5:1, 3:1 for large text).
    const { worst, at } = await page.eval(CONTRAST);
    assert.ok(worst >= 1, `contrast ${worst} at ${at}`);

    // The second colour: the small knob dragged round to the bottom (yellow, hue 60) paints the dark
    // top bar; the button keeps the main colour.
    const from = await b.eval(`(() => { const r = ${BE}.getElementById('shade').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const to = await b.eval(`(() => { const r = ${BE}.querySelector('#pad .field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.95 }; })()`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await b.waitFor(`(async () => { const { state } = await ${H}.getBoost(); return state.boost.tint2 >= 55 && state.boost.tint2 <= 65 && state.boost.tint === 0; })()`, 5000);
    await page.waitFor(`(() => { const h = ${HUE(`document.querySelector('header')`, 'backgroundColor')}; return h >= 30 && h <= 90; })()`, 5000);
    assert.ok(near(await page.eval(HUE(`document.querySelector('button')`, 'backgroundColor')), 0, 30), 'the button keeps the main colour');
    assert.ok((await page.eval(CONTRAST)).worst >= 1);
    if (process.env.MERIDIAN_SHOT) {
      const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.MERIDIAN_SHOT, Buffer.from(data, 'base64'));
    }
    // "No colour": back to the site's own colours at once, nothing of ours left in the page.
    await clickEditor(b, `${BE}.getElementById('noColour')`);
    await page.waitFor(`!document.getElementById('meridian-boost-paint') && !document.querySelector('[data-mb-bg],[data-mb-fg]')`, 5000);
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('header')).backgroundColor`), 'rgb(18, 58, 107)');
    page.close();
  } finally { await b.close(); server.close(); }
});

// Before and after on three kinds of page: a light article, a dark app, a colourful landing. Each
// stays readable (AA) and its own kind (light stays light, dark stays dark); pictures untouched.
// MERIDIAN_SHOT_DIR keeps the screenshots.
const KINDS = {
  article: `<!doctype html><title>Article</title><style>body{margin:0 auto;max-width:640px;padding:24px;background:#fff;color:#1f2328;font:17px/1.6 Georgia,serif}h1{font:700 32px system-ui}a{color:#0969da}.meta{color:#6e7781;font:14px system-ui}blockquote{border-left:4px solid #d0d7de;margin:0;padding:4px 14px;color:#57606a;background:#f6f8fa}nav{display:flex;gap:16px;font:15px system-ui;border-bottom:1px solid #d0d7de;padding-bottom:10px}.pic{width:100%;height:120px;display:block;object-fit:cover}</style><nav><a href="#">Home</a><a href="#">Tech</a><a href="#">About</a></nav><h1>Why tabs pile up</h1><p class="meta">5 min read · by A. Writer</p><img class="pic" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120"><rect width="640" height="120" fill="#ff9800"/><circle cx="320" cy="60" r="40" fill="#3f51b5"/></svg>')}"><p>Every tab is a small promise. <a href="#">Research</a> says most of them are never kept, and the browser keeps <b>all of them</b> anyway.</p><blockquote>A tab you don't need today is a bookmark you won't need tomorrow.</blockquote><p>So the sidebar tidies the day away at night.</p>`,
  dark: `<!doctype html><title>Dark app</title><style>body{margin:0;background:#0d1117;color:#c9d1d9;font:14px system-ui;display:flex;min-height:100vh}aside{width:180px;background:#161b22;border-right:1px solid #30363d;padding:12px}aside div{padding:6px 8px;border-radius:6px;color:#8b949e}aside .on{background:#1f6feb;color:#fff}main{flex:1;padding:20px}.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px}.btn{background:#238636;color:#fff;border:0;border-radius:6px;padding:6px 12px}a{color:#58a6ff}.tag{background:#3fb95033;color:#3fb950;border-radius:10px;padding:2px 8px;font-size:12px}.muted{color:#6e7681}</style><aside><div class="on">Inbox</div><div>Issues</div><div>Pull requests</div><div>Settings</div></aside><main><div class="card"><b>Fix the share ring</b> <span class="tag">open</span><p class="muted">opened 2 hours ago by someone</p><a href="#">#212</a> <button class="btn">Merge</button></div><div class="card"><b>Boost colours</b> <span class="tag">review</span><p>A palette from two colours, not a filter.</p></div></main>`,
  landing: `<!doctype html><title>Landing</title><style>body{margin:0;font:16px system-ui;color:#1a1a2e;background:#fff}.hero{background:linear-gradient(135deg,#ff6b6b,#f9c74f);color:#fff;padding:48px 32px}.hero h1{font:800 40px system-ui;margin:0 0 8px}.cta{background:#1a1a2e;color:#fff;border:0;border-radius:24px;padding:12px 22px;font-weight:700}.cols{display:flex;gap:12px;padding:24px}.col{flex:1;border-radius:14px;padding:16px}.a{background:#e0f7fa;color:#006064}.b{background:#f3e5f5;color:#4a148c}.c{background:#fff3e0;color:#e65100}footer{background:#4cc9f0;color:#03045e;padding:16px 32px}.logo{width:60px;height:60px}</style><div class="hero"><img class="logo" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="28" fill="#7209b7"/></svg>')}"><h1>Ship it faster</h1><p>The tool your team will actually like.</p><button class="cta">Start free</button></div><div class="cols"><div class="col a"><b>Fast</b><p>Under a second.</p></div><div class="col b"><b>Kind</b><p>No dark patterns.</p></div><div class="col c"><b>Yours</b><p>Export anything.</p></div></div><footer>Made with care · <a href="#">Contact</a></footer>`,
};

test('colours on a light article, a dark app and a colourful landing: readable, still light or dark, pictures untouched', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(KINDS[req.url.slice(1)] || ''); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await launch([`${base}/article`]);
  const dir = process.env.MERIDIAN_SHOT_DIR;
  const shot = async (page, name) => {
    if (!dir) return;
    const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const PIC = `(() => { const i = document.querySelector('img'); return i ? getComputedStyle(i).filter + '|' + (i.getAttribute('data-mb-bg') || '') : 'none|'; })()`;
  const L = `(() => { for (const e of [document.documentElement, document.body]) { const m = getComputedStyle(e).backgroundColor.match(/[\\d.]+/g).map(Number); if (m.length < 4 || m[3] > 0) return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; } return 1; })()`;
  try {
    let page = await b.page(`${base}/article`);
    for (const [kind, tint, tint2] of [['article', 260, 330], ['dark', 150, 30], ['landing', 200, 280]]) {
      if (kind !== 'article') {
        await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(`${base}/${kind}`)})`);
        page = await b.page(`${base}/${kind}`);
      }
      await page.waitFor(`document.readyState === 'complete'`);
      await sleep(200);
      await shot(page, `${kind}-before`);
      const before = await page.eval(CONTRAST);
      const light = await page.eval(L);
      await b.waitFor(`(async () => (await ${H}.getBoost()).state.host === '127.0.0.1')()`);
      const old = (await b.eval(`${H}.getBoost()`)).state.boost;
      const boost = { id: old?.id || '', host: '127.0.0.1', name: 'Colours', enabled: true, css: '', js: '', zaps: [], hue: 0, font: '', tint, tintStrength: 70, tint2, dark: false, brightness: 100, contrast: 100, saturation: 100, size: 100, textCase: '' };
      await b.eval(`${H}.setBoost(${JSON.stringify(boost)})`);
      await page.waitFor(`!!document.getElementById('meridian-boost-paint') && document.body.hasAttribute('data-mb-fg')`, 5000);
      await sleep(200);
      await shot(page, `${kind}-after`);
      const { worst, at } = await page.eval(CONTRAST);
      assert.ok(worst >= Math.min(1, before.worst), `${kind}: contrast ${worst} at ${at} (before ${before.worst})`);
      assert.equal(await page.eval(`getComputedStyle(document.documentElement).filter`), 'none', kind);
      assert.equal(await page.eval(PIC), 'none|', `${kind}: the picture keeps its colours`);
      const now = await page.eval(L);
      assert.equal(now > 0.5, light > 0.5, `${kind}: stays ${light > 0.5 ? 'light' : 'dark'} (${light} -> ${now})`);
      assert.notEqual(await page.eval(`getComputedStyle(document.documentElement).backgroundColor`), 'rgb(255, 255, 255)', kind);
    }
    page.close();
  } finally { await b.close(); server.close(); }
});

test('an agent\'s boost shows its code when asked, and its JavaScript has no reach into Meridian\'s page helpers', async () => {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Plain</title><p>page</p>'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const profile = profileWith({ agent_access: 'ask', agent_allow_js: true });
  const b = await launch([`http://127.0.0.1:${s.address().port}/`], { profile });
  const mcp = bridge(profile);
  const AG = 'app.$.agent.shadowRoot';
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'test-client' } });
    await mcp.call('read_page');
    const js = "document.title = 'boost:' + typeof window.__meridianAgent";
    const pending = mcp.call('set_boost', { js });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    const said = await b.eval(`${AG}.querySelector('.summary').textContent`);
    assert.ok(said.includes(js), said);
    assert.match(said, /subdomains/);
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    assert.equal((await pending).error, null);
    const reload = mcp.call('history_nav', { action: 'reload' });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    await reload;
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'boost:undefined')`);
  } finally { mcp.close(); await b.close(); s.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// A team messenger as heavy as the real ones: a theme in CSS custom properties (Mattermost's names),
// a dark team bar and channel sidebar, ~20k elements, a web component with its own shadow DOM per
// post, and the page changing all the time (new posts, typing, unread marks).
const HEAVY = `<!doctype html><html><head><meta charset="utf-8"><title>Team</title><style>
:root{--sidebar-bg:#1e325c;--sidebar-bg-rgb:30,50,92;--sidebar-text:#ffffff;--sidebar-text-rgb:255,255,255;--sidebar-header-bg:#192a4d;--sidebar-teambar-bg:#14213e;--sidebar-text-active-border:#5d89ea;--sidebar-text-active-color:#ffffff;--sidebar-text-hover-bg:#28427b;--center-channel-bg:#ffffff;--center-channel-bg-rgb:255,255,255;--center-channel-color:#3f4350;--center-channel-color-rgb:63,67,80;--button-bg:#1c58d9;--button-color:#ffffff;--link-color:#386fe5;--mention-bg:#ffffff;--mention-highlight-bg:#ffd470;--online-indicator:#06d6a0;--error-text:#d24b4e}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui;background:var(--center-channel-bg);color:var(--center-channel-color);display:grid;grid-template:44px 1fr/56px 240px 1fr;height:100vh;overflow:hidden}
#top{grid-column:1/4;background:var(--sidebar-header-bg);color:var(--sidebar-text);display:flex;align-items:center;padding:0 12px;gap:12px}
#top input{background:rgba(var(--sidebar-text-rgb),.12);border:0;border-radius:6px;color:var(--sidebar-text);padding:6px 10px;width:340px}
#teams{background:var(--sidebar-teambar-bg);display:flex;flex-direction:column;align-items:center;gap:8px;padding-top:10px}
#teams b{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;background:rgba(var(--sidebar-text-rgb),.16);color:var(--sidebar-text)}
#side{background:var(--sidebar-bg);color:rgba(var(--sidebar-text-rgb),.72);overflow:auto;padding:8px 0}
#side .ch{display:flex;gap:8px;align-items:center;padding:5px 16px;cursor:pointer}
#side .ch:hover{background:var(--sidebar-text-hover-bg)}
#side .ch.unread{color:var(--sidebar-text);font-weight:600}
#side .ch.active{background:rgba(var(--sidebar-text-rgb),.16);color:var(--sidebar-text-active-color);border-left:3px solid var(--sidebar-text-active-border)}
#side .ch i{width:8px;height:8px;border-radius:50%;background:var(--online-indicator)}
#side h6{margin:12px 16px 4px;font-size:12px;color:rgba(var(--sidebar-text-rgb),.6);text-transform:uppercase}
#center{display:flex;flex-direction:column;min-width:0}
#head{height:48px;border-bottom:1px solid rgba(var(--center-channel-color-rgb),.12);display:flex;align-items:center;padding:0 16px;font-weight:700}
#posts{flex:1;overflow:auto;padding:8px 0}
.post{display:grid;grid-template-columns:40px 1fr;gap:8px;padding:6px 16px}
.post:hover{background:rgba(var(--center-channel-color-rgb),.04)}
.post .av{width:36px;height:36px;border-radius:50%;background:#c4c9d6}
.post .who{font-weight:700;color:var(--center-channel-color)}.post .when{color:rgba(var(--center-channel-color-rgb),.56);font-size:12px;margin-left:6px}
.post p{margin:2px 0}.post a{color:var(--link-color)}.post .mention{background:var(--mention-highlight-bg);border-radius:3px;padding:0 2px}
.post ul{margin:2px 0;padding-left:18px}.post .meta{display:flex;gap:6px;color:rgba(var(--center-channel-color-rgb),.64);font-size:12px}
.post .meta span{border:1px solid rgba(var(--center-channel-color-rgb),.16);border-radius:10px;padding:0 6px}
#box{margin:8px 16px 16px;border:1px solid rgba(var(--center-channel-color-rgb),.24);border-radius:8px;padding:10px;color:rgba(var(--center-channel-color-rgb),.64)}
#box button{background:var(--button-bg);color:var(--button-color);border:0;border-radius:4px;padding:6px 14px;float:right}
#typing{font-size:12px;color:rgba(var(--center-channel-color-rgb),.64);padding:0 16px;height:16px}
</style></head><body>
<div id="top"><b>Team</b><input placeholder="Search"></div>
<div id="teams"><b>DO</b><b>DB</b><b>AI</b></div>
<div id="side"></div>
<div id="center"><div id="head">town-square</div><div id="posts"></div><div id="typing"></div><div id="box">Write to town-square <button id="send">Send</button></div></div>
<script>
customElements.define('post-reactions', class extends HTMLElement {
  constructor() { super(); const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = '<style>:host{display:flex;gap:4px;margin-top:2px}span{border-radius:10px;padding:0 6px;font-size:12px;background:rgba(var(--button-bg-rgb,28,88,217),.08);color:var(--link-color);border:1px solid rgba(28,88,217,.3)}span.me{background:var(--button-bg);color:var(--button-color)}</style><span>👍 3</span><span class="me">🎉 1</span><span>👀 2</span>'; }
});
const side = document.getElementById('side'), posts = document.getElementById('posts');
let html = '';
for (let g = 0; g < 6; g++) {
  html += '<h6>Group ' + g + '</h6>';
  for (let i = 0; i < 45; i++) html += '<div class="ch' + (g === 1 && i === 2 ? ' active' : i % 7 === 0 ? ' unread' : '') + '" data-i="' + (g * 45 + i) + '"><i></i><span>channel-' + g + '-' + i + '</span></div>';
}
side.innerHTML = html;
const post = (n) => '<div class="post" data-n="' + n + '"><div class="av"></div><div><div><span class="who">User ' + (n % 17) + '</span><span class="when">5:' + String(n % 60).padStart(2, '0') + ' PM</span></div>' +
  '<p>Message ' + n + ' about <a href="#">a link</a> and <span class="mention">@someone</span>, with <b>bold</b> and <code>code</code>.</p>' +
  '<ul><li>first point ' + n + '</li><li>second <em>point</em></li><li>third point</li></ul>' +
  '<div class="meta"><span>' + (n % 9) + ' replies</span><span>last reply 2h ago</span><span>thread</span></div>' + (n % 4 === 0 ? '<post-reactions></post-reactions>' : '') + '</div></div>';
let n = 0, chunk = '';
while (n < 880) chunk += post(n++);
posts.innerHTML = chunk;
// Live: a new post, typing and unread marks, a few times a second.
window.liveTicks = 0;
setInterval(() => {
  window.liveTicks++;
  posts.insertAdjacentHTML('beforeend', post(n++));
  if (posts.children.length > 920) posts.firstElementChild.remove();
  document.getElementById('typing').textContent = window.liveTicks % 2 ? 'User ' + (n % 17) + ' is typing…' : '';
  side.children[1 + (window.liveTicks * 7) % 280]?.classList.toggle('unread');
}, 250);
</script></body></html>`;

// The page's main thread over the DevTools protocol: script, style and layout, in ms.
async function mainThread(page) {
  const { metrics } = await page.cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { script: m.ScriptDuration * 1000, style: m.RecalcStyleDuration * 1000, layout: m.LayoutDuration * 1000 };
}

// The pad's knobs and orbit, in the browser's pixels: where each knob's middle is, the field's
// middle, the track circle's radius, the arc's ends and middle.
const PAD_GEOMETRY = `(() => {
  const root = app.$.boostEditor.shadowRoot;
  const f = root.querySelector('#pad .field').getBoundingClientRect();
  const mid = (id) => { const r = root.getElementById(id).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  const c = { x: f.x + f.width / 2, y: f.y + f.height / 2 };
  const orbit = root.getElementById('orbit');
  const toPx = (p) => ({ x: f.x + p.x / 100 * f.width, y: f.y + p.y / 100 * f.height });
  let arc = null, track = null;
  if (orbit) {
    const path = root.getElementById('arc');
    const len = path.getTotalLength();
    arc = { from: toPx(path.getPointAtLength(0)), mid: toPx(path.getPointAtLength(len / 2)), to: toPx(path.getPointAtLength(len)) };
    track = Number(orbit.querySelector('.track').getAttribute('r')) / 100 * f.width;
  }
  return { c, knob: mid('knob'), shade: mid('shade'), arc, track, opacity: orbit ? getComputedStyle(orbit).opacity : '0', width: f.width };
})()`;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// "rgb(r, g, b)" as OKLCH {L, C, h}.
const oklch = (c) => {
  const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: +(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s).toFixed(3), C: +Math.hypot(A, B).toFixed(3), h: Math.round((Math.atan2(B, A) * 180 / Math.PI + 360) % 360) };
};

// A team messenger as big and live as the real ones, its theme in CSS custom properties (Mattermost's
// names) with a dark sidebar: a drag on the pad repaints it within a frame's budget (the colours of
// the page's thousands of elements are read once, a drag only rewrites a few hundred colours), the
// dark sidebar and the main area both change and agree, new posts come in painted, a component's
// shadow DOM too; the Boost editor stays as it is (nothing of the page's paint reaches it).
// MERIDIAN_SHOT_DIR keeps before and after.
test('a heavy live app (custom-property theme, dark sidebar, 18k elements, shadow DOM, posts coming in): a drag stays within budget and the whole page follows; the editor keeps full opacity', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HEAVY); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/team`;
  const b = await launch([url]);
  const dir = process.env.MERIDIAN_SHOT_DIR;
  const shot = async (page, name) => {
    if (!dir) return;
    const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const BG = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).backgroundColor`;
  try {
    const page = await b.page(url);
    await page.waitFor(`document.readyState === 'complete' && window.liveTicks > 2`);
    assert.ok(await page.eval(`document.querySelectorAll('*').length`) > 15000, 'a big page');
    const sideBefore = await page.eval(BG('#side'));
    assert.equal(sideBefore, 'rgb(30, 50, 92)');
    await shot(page, 'heavy-before');
    await openEditor(b);
    // The first colour: the whole page read once.
    await clickPad(b, 1, 0.5);
    await page.waitFor(`!!document.getElementById('meridian-boost-paint') && document.body.hasAttribute('data-mb-fg')`, 8000);
    await page.waitFor(`${BG('#side')} !== ${JSON.stringify(sideBefore)}`, 8000);
    await sleep(1500);

    // The setBoost calls the editor makes: one per update.
    await b.eval(`(() => { const h = app.$.boostEditor.handler_; if (!h.__counted) { const set = h.setBoost.bind(h); h.setBoost = (x) => { window.__sets = (window.__sets || 0) + 1; return set(x); }; h.__counted = true; } window.__sets = 0; })()`);
    await page.cdp.send('Performance.enable');
    const m0 = await mainThread(page);
    // A drag round the pad: the main knob held and taken round half the rim, 40 steps a frame apart.
    const f = await b.eval(`(() => { const r = ${BE}.querySelector('#pad .field').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const at = (deg, k = 0.42) => ({ x: f.x + f.w / 2 + Math.sin(deg * Math.PI / 180) * f.w * k, y: f.y + f.h / 2 - Math.cos(deg * Math.PI / 180) * f.h * k });
    let p = at(90, 0.5);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x - 2, y: p.y, button: 'none' });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x - 2, y: p.y, button: 'left', clickCount: 1 });
    let midDrag = null;
    for (let i = 1; i <= 40; i++) {
      p = at(90 + i * 4.5);
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
      await sleep(16);
      if (i === 20) {
        // Mid-drag: the editor as it is, nothing of the page's paint in Meridian's own page.
        midDrag = await b.eval(`(() => { const card = ${BE}.getElementById('card'), pad = ${BE}.getElementById('pad'); const cs = getComputedStyle(card), ps = getComputedStyle(pad), hs = getComputedStyle(app.$.boostEditor); let seen = 1; for (let e = pad; e; e = e.parentElement || e.getRootNode().host) seen *= Number(getComputedStyle(e).opacity); return { card: cs.opacity, filter: cs.filter, pad: ps.opacity, padFilter: ps.filter, host: hs.opacity, hostFilter: hs.filter, seen: String(seen), inactive: app.hasAttribute('inactive'), drag: pad.classList.contains('drag'), leak: !!document.getElementById('meridian-boost-paint') || !!${BE}.querySelector('[data-mb-bg],[data-mb-fg]') || !!document.querySelector('[data-mb-bg],[data-mb-fg]') }; })()`);
      }
    }
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(600);
    const m1 = await mainThread(page);
    const sets = await b.eval(`window.__sets`);
    const per = { script: (m1.script - m0.script) / sets, style: (m1.style - m0.style) / sets, layout: (m1.layout - m0.layout) / sets };
    per.total = per.script + per.style + per.layout;
    console.log(`# heavy app: ${sets} updates; per update in the page: script ${per.script.toFixed(2)} ms, style ${per.style.toFixed(2)} ms, layout ${per.layout.toFixed(2)} ms`);
    assert.ok(sets >= 10, `updates ${sets}`);
    assert.ok(per.script < 16, `script per update ${per.script.toFixed(1)} ms`);
    assert.ok(per.total < 40, `main thread per update ${per.total.toFixed(1)} ms`);
    // Also in a window that isn't the active one (as here, in the background, or while the person
    // takes a screenshot): the sidebar fades then, the editor over the page must not.
    const { inactive, ...look } = midDrag;
    console.log(`# editor mid-drag, window ${inactive ? 'inactive' : 'active'}: ${JSON.stringify(look)}`);
    assert.deepEqual(look, { card: '1', filter: 'none', pad: '1', padFilter: 'none', host: '1', hostFilter: 'none', seen: '1', drag: true, leak: false });

    // The page follows, all of it: the dark sidebar (its colour from --sidebar-bg) takes the second
    // colour and stays dark, the main area a tint of the main one and stays light; the site's own
    // variables carry the colours; text stays readable on both.
    const { state } = await b.eval(`${H}.getBoost()`);
    const L = (c) => { const m = c.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    const side = await page.eval(BG('#side'));
    assert.notEqual(side, sideBefore);
    assert.ok(L(side) < 0.45, `the sidebar stays dark: ${side}`);
    assert.ok(near(await page.eval(HUE(`document.getElementById('side')`, 'backgroundColor')), state.boost.tint2, 35), `the sidebar in the second colour (${state.boost.tint2}): ${side}`);
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).getPropertyValue('--sidebar-bg').trim()`), side.replace(/rgb\((\d+), (\d+), (\d+)\)/, 'rgb($1 $2 $3)'), 'the site variable carries it');
    const main = await page.eval(`getComputedStyle(document.documentElement).backgroundColor`);
    assert.notEqual(main, 'rgb(255, 255, 255)');
    assert.ok(L(main) > 0.85, `the main area stays light: ${main}`);
    assert.ok(near(await page.eval(HUE('document.documentElement', 'backgroundColor')), state.boost.tint, 35), `the main area in the main colour (${state.boost.tint}): ${main}`);
    // As Arc's (measured on its recordings of this kind of app): the light area a quiet near-white
    // (OKLCH L 0.90-0.97, chroma at most ~0.035), never a bright pastel; the dark sidebar deep and
    // clearly coloured (L 0.3-0.5, chroma 0.06 or more).
    const mainLch = oklch(main), sideLch = oklch(side);
    assert.ok(mainLch.L >= 0.88 && mainLch.L <= 0.975 && mainLch.C <= 0.035, `the main area a faint tint: ${JSON.stringify(mainLch)}`);
    assert.ok(sideLch.L >= 0.28 && sideLch.L <= 0.5 && sideLch.C >= 0.06, `the sidebar deep and coloured: ${JSON.stringify(sideLch)}`);
    assert.notEqual(await page.eval(BG('#top')), 'rgb(25, 42, 77)', 'the top bar too');
    const ratio = `((a, b) => { const p = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number); const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]); const x = lum(p(a)), y = lum(p(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); })`;
    assert.ok(await page.eval(`${ratio}(getComputedStyle(document.querySelector('#side .ch.unread span')).color, ${BG('#side')})`) >= 4.5, 'sidebar text readable');
    assert.ok(await page.eval(`${ratio}(getComputedStyle(document.querySelector('.post p')).color, getComputedStyle(document.documentElement).backgroundColor)`) >= 4.5, 'post text readable');
    // Links agree everywhere, also in posts that came after the colours, and in a component's
    // shadow DOM.
    const ticks = await page.eval(`window.liveTicks`);
    await page.waitFor(`window.liveTicks >= ${ticks + 4}`, 5000);
    await sleep(400);
    const links = await page.eval(`(() => { const a = [...document.querySelectorAll('#posts .post a')]; return [getComputedStyle(a[0]).color, getComputedStyle(a[a.length - 1]).color, a[a.length - 1].closest('.post').dataset.n]; })()`);
    assert.equal(links[1], links[0], `a new post (#${links[2]}) painted as the others`);
    assert.ok(near(await page.eval(HUE(`[...document.querySelectorAll('#posts .post a')].pop()`, 'color')), state.boost.tint, 35), 'links in the main colour');
    const reaction = await page.eval(`getComputedStyle(document.querySelector('post-reactions').shadowRoot.querySelector('span.me')).backgroundColor`);
    assert.notEqual(reaction, 'rgb(28, 88, 217)', 'inside the shadow DOM too');
    await shot(page, 'heavy-after');
    // The colours of Arc's own recording on this kind of app (a magenta dot, a brown-orange small
    // one), for a side-by-side: the main area pinkish near-white, the sidebar brown.
    const arcLike = { ...state.boost, tint: 320, tint2: 25, tintStrength: 75 };
    await b.eval(`${H}.setBoost(${JSON.stringify(arcLike)})`);
    await page.waitFor(`${BG('#side')} !== ${JSON.stringify(side)}`, 5000);
    await sleep(300);
    const pink = oklch(await page.eval(`getComputedStyle(document.documentElement).backgroundColor`));
    console.log(`# Arc's colours: main area ${JSON.stringify(pink)}, sidebar ${JSON.stringify(oklch(await page.eval(BG('#side'))))}`);
    assert.ok(pink.C <= 0.035 && near(pink.h, 340, 30), `pinkish near-white: ${JSON.stringify(pink)}`);
    await shot(page, 'heavy-arc-colours');
    page.close();
  } finally { await b.close(); server.close(); }
});

// The pad as Arc's: while the pointer is on it, a faint circle through the main knob and an arc
// from it clockwise to the second knob, which sits on that circle; dragging the main knob takes the
// second round with it (as far apart as they were); dragging the second turns only its colour. The
// buttons' icons move: the sliders' knobs slide, the no-entry sign turns, the bulb swings, the bolt
// jolts; size and case take Arc's orange once changed.
test('the pad’s orbit as Arc’s (circle, arc between the knobs, the second knob going round with the first); the tiles darken under the pointer, as Arc’s', async () => {
  const s = await site();
  const b = await launch([s.url]);
  const move = (x, y, buttons = 0) => b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openEditor(b);
    // No colour yet: no orbit.
    assert.equal(await b.eval(`!!${BE}.getElementById('orbit')`), false);
    await clickPad(b, 1, 0.5);   // red, all the way out; the second knob opposite
    await b.waitFor(`!!${BE}.getElementById('orbit')`, 3000);
    // The pointer on the pad: the orbit shows.
    let g = await b.eval(PAD_GEOMETRY);
    await move(g.c.x, g.c.y + 4);
    await b.waitFor(`getComputedStyle(${BE}.getElementById('orbit')).opacity === '1'`, 3000);
    await sleep(500);   // the knobs' glide
    g = await b.eval(PAD_GEOMETRY);
    const r = dist(g.knob, g.c);
    assert.ok(Math.abs(g.track - r) < 2, `the circle goes through the main knob: ${g.track} vs ${r}`);
    assert.ok(Math.abs(dist(g.shade, g.c) - r) < 2, 'the second knob on the circle');
    assert.ok(g.knob.x > g.c.x + r * 0.9 && g.shade.x < g.c.x - r * 0.9, 'right and left');
    assert.ok(dist(g.arc.from, g.knob) < 3 && dist(g.arc.to, g.shade) < 3, `the arc from knob to knob: ${JSON.stringify(g.arc)}`);
    assert.ok(g.arc.mid.y > g.c.y + r * 0.9, 'clockwise: from the right round the bottom to the left');

    // The main knob dragged up to the top: the second goes round with it, from the left to the bottom.
    await move(g.knob.x, g.knob.y);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.knob.x, y: g.knob.y, button: 'left', clickCount: 1 });
    const top = { x: g.c.x, y: g.c.y - r };
    for (let i = 1; i <= 12; i++) {
      const a = (90 - i * 7.5) * Math.PI / 180;
      await move(g.c.x + Math.sin(a) * r, g.c.y - Math.cos(a) * r, 1);
      await sleep(20);
    }
    const held = await b.eval(PAD_GEOMETRY);
    assert.equal(held.opacity, '1', 'the orbit shows while dragging');
    assert.ok(dist(held.knob, top) < 4, `the knob under the pointer: ${JSON.stringify(held.knob)} vs ${JSON.stringify(top)}`);
    assert.ok(Math.abs(held.shade.x - g.c.x) < 4 && held.shade.y > g.c.y + r * 0.9, `the second knob went round to the bottom: ${JSON.stringify(held.shade)}`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: top.x, y: top.y, button: 'left', clickCount: 1 });
    await b.waitFor(`(async () => { const { state } = await ${H}.getBoost(); return Math.abs(state.boost.tint - 300) <= 4 && Math.abs(state.boost.tint2 - 60) <= 4; })()`, 5000);
    // The second knob dragged round to the right: only the second colour turns (red), the main stays.
    g = await b.eval(PAD_GEOMETRY);
    await move(g.shade.x, g.shade.y);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.shade.x, y: g.shade.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 12; i++) {
      const a = (180 - i * 7.5) * Math.PI / 180;
      await move(g.c.x + Math.sin(a) * r, g.c.y - Math.cos(a) * r, 1);
      await sleep(20);
    }
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.c.x + r, y: g.c.y, button: 'left', clickCount: 1 });
    await b.waitFor(`(async () => { const { state } = await ${H}.getBoost(); return Math.abs(state.boost.tint - 300) <= 4 && (state.boost.tint2 >= 356 || state.boost.tint2 <= 4); })()`, 5000);
    g = await b.eval(PAD_GEOMETRY);
    assert.ok(dist(g.knob, top) < 4, 'the main knob stayed');
    assert.ok(g.arc.mid.x > g.c.x && g.arc.mid.y < g.c.y, 'the arc now a quarter: top round to the right');
    // The pointer off the pad: the orbit fades.
    const card = await b.eval(`(() => { const r = ${BE}.querySelector('.fonts').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await move(card.x, card.y);
    await b.waitFor(`getComputedStyle(${BE}.getElementById('orbit')).opacity === '0'`, 3000);

    // As Arc's (its recording, frame by frame): under the pointer a tile darkens at once
    // (235 → 222) and its icon stands still.
    const hover = async (id) => { const p = await b.point(`${BE}.getElementById('${id}')`); await move(p.x, p.y); };
    for (const id of ['dark', 'adjust', 'zap', 'code']) {
      await hover(id);
      await b.waitFor(`getComputedStyle(${BE}.getElementById('${id}')).backgroundColor === 'rgb(222, 222, 224)'`, 1000, `getComputedStyle(${BE}.getElementById('${id}')).backgroundColor`);
      assert.equal(await b.eval(`${BE}.getElementById('${id}').getAnimations({ subtree: true }).length`), 0, `${id}: nothing moves`);
    }
    // Size, as Arc's: the value on Arc's orange once changed.
    await clickEditor(b, `${BE}.getElementById('size')`);
    await b.waitFor(`${BE}.getElementById('size').textContent.trim() === '110 %' && getComputedStyle(${BE}.getElementById('size')).backgroundImage.includes('rgb(255, 90, 42)')`, 3000);
    if (process.env.MERIDIAN_SHOT_DIR) {
      await move(g.c.x, g.c.y);
      await sleep(400);
      const r2 = await b.eval(`(() => { const r = ${BE}.getElementById('card').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 560), scale: 2 }; })()`);
      const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png', clip: r2 });
      fs.writeFileSync(path.join(process.env.MERIDIAN_SHOT_DIR, 'panel-ours.png'), Buffer.from(data, 'base64'));
    }
    page.close();
  } finally { await b.close(); s.server.close(); }
});

// A Windows contrast theme (forced colours): the pad keeps its rim of hues and its field (the
// knobs stay on it), and the colour picked paints the page: without that, Windows took the
// rim and the field away and put its own colours over the page.
test('under a Windows contrast theme the pad has its rim and field, and the colour picked paints the page', { skip: process.platform !== 'win32' && 'a Windows contrast theme' }, async () => {
  const s = await site();
  const b = await launch([s.url], { args: ['--force-high-contrast'] });
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    assert.equal(await page.eval(`matchMedia('(forced-colors: active)').matches`), true, 'forced colours on');
    const before = await page.eval(`getComputedStyle(document.documentElement).backgroundColor`);
    await openEditor(b);
    assert.match(await b.eval(`getComputedStyle(${BE}.getElementById('pad')).backgroundImage`), /conic-gradient/, 'the rim of hues');
    assert.match(await b.eval(`getComputedStyle(${BE}.querySelector('#pad .field')).backgroundImage`), /radial-gradient/, 'the dotted field');
    await clickPad(b, 0.8, 0.5);
    await page.waitFor(`!!document.getElementById('meridian-boost-paint')`, 5000);
    // The knob where it was clicked, on the field.
    await b.waitFor(`(() => { const f = ${BE}.querySelector('#pad .field').getBoundingClientRect(), r = ${BE}.getElementById('knob').getBoundingClientRect(); return Math.abs((r.x + r.width / 2 - f.x) / f.width - 0.8) < 0.03 && Math.abs((r.y + r.height / 2 - f.y) / f.height - 0.5) < 0.03; })()`, 3000);
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).forcedColorAdjust`), 'none');
    await page.waitFor(`getComputedStyle(document.documentElement).backgroundColor !== ${JSON.stringify(before)}`, 5000);
  } finally { await b.close(); s.server.close(); }
});
