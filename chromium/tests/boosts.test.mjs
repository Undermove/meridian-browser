// Boosts, as in Arc: a site the person's way (a colour, dark, a font, size and case, zapped elements,
// their own CSS and JavaScript), in the editor at the right of the page with real clicks; "Improve
// with Claude" asking the AI for the site's CSS; agents making one over MCP; and Arc's boosts brought
// over with the rest of its data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launch, APP } from './harness.mjs';

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
    // the amount how far out. Right of the middle, 3/5 of the way out: a yellow-green: the site's accent
    // turns to it; the knob glides there, the small dark one opposite.
    await clickPad(b, 0.8, 0.5);
    await page.waitFor(`!!document.getElementById('meridian-boost-turn') && getComputedStyle(document.documentElement, '::before').mixBlendMode === 'multiply'`, 5000);
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

test('Improve with Claude: the page outline goes to Claude, its CSS becomes the boost; Undo', async () => {
  const s = await site();
  const api = await fakeClaude({ name: 'Calm News', css: '#promo { display: none !important; }', summary: 'Hid the subscription banner.' });
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
    // A boost still called "My Boost" takes the AI's name.
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boost.name, 'Calm News');

    // What Claude got: the boost instructions, the outline with the page's elements, the wish.
    const req = api.requests.filter((r) => r.stream).pop();
    assert.match(req.system, /Boosts in the Meridian browser/);
    assert.equal(req.tools, undefined, 'no browser tools for a boost');
    const text = JSON.stringify(req.messages);
    assert.match(text, /div#promo\.promo-banner/);
    assert.match(text, /Subscribe now!/);
    assert.match(text, /hide the banner/);

    // Undo: the boost as it was before.
    await clickEditor(b, `${BE}.getElementById('undo')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    const after = (await b.eval(`${H}.getBoost()`)).state.boost;
    assert.equal(after.css, '');
    assert.equal(after.name, 'My Boost');
    page.close();
  } finally { await b.close(); s.server.close(); api.server.close(); }
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

test('a colour turns the site’s accent to it: white stays white, text stays, a picture keeps its colours', async () => {
  const PAGE = `<!doctype html><title>Accent</title><style>body{margin:0;background:#fff;color:#222;font:16px system-ui}header{height:90px;background:#1565c0;color:#fff}a{color:#1565c0}img{width:90px;height:90px;display:block}</style><header>Site</header><p>Plain text <a href="#x">a link</a></p><img id="pic" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><rect width="90" height="90" fill="#e53935"/></svg>')}">`;
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
    await page.waitFor(`!!document.getElementById('meridian-boost-turn')`, 5000);
    const turn = await page.eval(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--meridian-boost-turn'))`);
    // #1565c0 is at hue 212: to 90 the short way is -122.
    assert.ok(Math.abs(turn + 122) < 8, `turn ${turn}`);
    assert.match(await page.eval(`getComputedStyle(document.documentElement).filter`), /hue-rotate/);
    assert.match(await page.eval(`getComputedStyle(document.getElementById('pic')).filter`), /hue-rotate/);
    if (process.env.MERIDIAN_SHOT) {
      const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.MERIDIAN_SHOT, Buffer.from(data, 'base64'));
    }
    page.close();
  } finally { await b.close(); server.close(); }
});
