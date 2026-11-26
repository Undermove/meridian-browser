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
import { launch, APP, SB } from './harness.mjs';
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

    // A colour on the pad, as Arc's: the hue is the angle from the middle (red at the top, clockwise),
    // the amount how far out. Right of the middle, 3/5 of the way out: a yellow-green: the page is
    // painted in it; the knob glides there, the small one (the second colour) opposite.
    await clickPad(b, 0.8, 0.5);
    await page.waitFor(`!!document.getElementById('meridian-boost-paint') && document.body.hasAttribute('data-mb-fg')`, 5000);
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).filter`), 'none', 'no filter over the page');
    assert.notEqual(await page.eval(`getComputedStyle(document.documentElement, '::after').mixBlendMode`), 'color', 'no colour layer over the whole page');
    const { state } = await b.eval(`${H}.getBoost()`);
    assert.ok(state.boost.tint >= 85 && state.boost.tint <= 95, `tint ${state.boost.tint}`);
    assert.ok(state.boost.tintStrength >= 55 && state.boost.tintStrength <= 65, `strength ${state.boost.tintStrength}`);
    await b.waitFor(`(() => { const f = ${BE}.querySelector('#pad .field').getBoundingClientRect(); const at = (id) => { const r = ${BE}.getElementById(id).getBoundingClientRect(); return [(r.x + r.width / 2 - f.x) / f.width, (r.y + r.height / 2 - f.y) / f.height]; }; const [kx, ky] = at('knob'), [sx, sy] = at('shade'); return Math.abs(kx - 0.8) < 0.03 && Math.abs(ky - 0.5) < 0.03 && Math.abs(sx - 0.2) < 0.03 && Math.abs(sy - 0.5) < 0.03; })()`, 3000);
    // A font from the grid, the size up, lower case, dark.
    await clickEditor(b, `${BE}.querySelector('.font[data-font="Georgia"]')`);
    await page.waitFor(`getComputedStyle(document.querySelector('p')).fontFamily.startsWith('Georgia')`, 5000);
    await clickEditor(b, `${BE}.getElementById('size')`);
    await page.waitFor(`getComputedStyle(document.body).zoom === '1.1'`, 5000);
    await clickEditor(b, `${BE}.getElementById('case')`);
    await page.waitFor(`getComputedStyle(document.querySelector('p')).textTransform === 'lowercase'`, 5000);
    await clickEditor(b, `${BE}.getElementById('dark')`);
    await page.waitFor(`getComputedStyle(document.documentElement).filter.includes('invert(1)')`, 5000);
    // Quick changes, one boost.
    assert.equal((await b.eval(`${H}.getBoosts()`)).boosts.length, 1);

    // Code: CSS hides the promo at once; JavaScript runs from the next load.
    await clickEditor(b, `${BE}.getElementById('code')`);
    await b.eval(`(() => { ${BE}.getElementById('css').value = '#promo { display: none !important; }'; ${BE}.getElementById('js').value = "document.body.dataset.boosted = 'yes';"; })()`);
    await clickEditor(b, `${BE}.getElementById('codeSave')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
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
    await clickEditor(b, `${BE}.getElementById('delete')`);
    await clickEditor(b, `${BE}.getElementById('delete')`);
    await b.waitFor(`!app.$.boostEditor.open`);

    // The first one, from its chevron, deleted (two clicks): the site's own look again.
    await openEditor(b, '.boost-edit');
    assert.equal(await b.eval(`${BE}.getElementById('name').value`), 'My Boost');
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

test('Improve redesigns in rounds: each CSS checked (nothing hidden, nothing from the internet), a screenshot to review it, progress in the editor; kept after a reload; Undo', async () => {
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

test('Improve with Claude Code when nothing is picked in Settings › AI: in the default space and in a space with its own profile (as its AI account)', async () => {
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

test('a colour paints the page, Arc’s way: a tinted background, the accent turned, text still readable, a picture untouched; undone at once', async () => {
  const PAGE = `<!doctype html><title>Accent</title><style>body{margin:0;background:#fff;color:#222;font:16px system-ui}header{height:90px;background:#1565c0;color:#fff}a{color:#1565c0}button{background:#1565c0;color:#fff;border:0;padding:6px}img{width:90px;height:90px;display:block}</style><header>Site</header><p>Plain text <a href="#x">a link</a> <button>Go</button></p><img id="pic" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="90" height="90" fill="#e53935"/></svg>')}">`;
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
    await clickPad(b, 1, 0.5);  // the right edge: hue 90, full colour
    await page.waitFor(`!!document.getElementById('meridian-boost-paint') && document.querySelector('header').hasAttribute('data-mb-bg')`, 5000);
    // No filter: not on the page, not on the picture; the picture is as it was.
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).filter`), 'none');
    assert.equal(await page.eval(`getComputedStyle(document.getElementById('pic')).filter`), 'none');
    // The white page takes a tint of the colour (still light); the blue header turns to it.
    const bodyBg = await page.eval(`getComputedStyle(document.documentElement).backgroundColor`);
    assert.notEqual(bodyBg, 'rgb(255, 255, 255)');
    assert.ok(near(await page.eval(HUE('document.documentElement', 'backgroundColor')), 90, 30), bodyBg);
    assert.ok(near(await page.eval(HUE(`document.querySelector('header')`, 'backgroundColor')), 90, 30));
    assert.ok(near(await page.eval(HUE(`document.querySelector('a')`, 'color')), 90, 30), 'the link takes the colour');
    // Readable everywhere: AA (4.5:1, 3:1 for large text).
    const { worst, at } = await page.eval(CONTRAST);
    assert.ok(worst >= 1, `contrast ${worst} at ${at}`);

    // The second colour: the small knob dragged round to the bottom (hue 180) paints the accents.
    const from = await b.eval(`(() => { const r = ${BE}.getElementById('shade').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const to = await b.eval(`(() => { const r = ${BE}.querySelector('#pad .field').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.95 }; })()`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await b.waitFor(`(async () => { const { state } = await ${H}.getBoost(); return state.boost.tint2 >= 170 && state.boost.tint2 <= 190 && state.boost.tint === 90; })()`, 5000);
    await page.waitFor(`${HUE(`document.querySelector('button')`, 'backgroundColor')} > 150`, 5000);
    assert.ok(near(await page.eval(HUE(`document.querySelector('button')`, 'backgroundColor')), 180, 30), 'the button takes the second colour');
    assert.ok(near(await page.eval(HUE(`document.querySelector('header')`, 'backgroundColor')), 90, 30), 'the header keeps the main one');
    assert.ok((await page.eval(CONTRAST)).worst >= 1);
    if (process.env.MERIDIAN_SHOT) {
      const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.MERIDIAN_SHOT, Buffer.from(data, 'base64'));
    }
    // "No colour": back to the site's own colours at once, nothing of ours left in the page.
    await clickEditor(b, `${BE}.getElementById('noColour')`);
    await page.waitFor(`!document.getElementById('meridian-boost-paint') && !document.querySelector('[data-mb-bg],[data-mb-fg]')`, 5000);
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('header')).backgroundColor`), 'rgb(21, 101, 192)');
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
