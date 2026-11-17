// Boosts, as in Arc: a site the person's way (colours, a font, zapped elements, their own CSS and
// JavaScript), from the site controls with real clicks; "Improve with Claude" asking the AI for the
// site's CSS; agents making one over MCP; and Arc's boosts brought over with the rest of its data.
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
<main id=story><h1>Story</h1><p>Text of the story.</p></main>
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
  await b.waitFor(`app.$.siteControl.open && !!${SC}.getElementById('boostRow')`);
}

// A real click in the page, at the middle of `sel`.
async function clickIn(page, sel) {
  const at = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

test('Boost from the site controls: colours, font, code; on every page of the site, off, deleted', async () => {
  const s = await site();
  const b = await launch([s.url]);
  try {
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openControls(b);
    assert.match(await b.eval(`${SC}.getElementById('boostRow').textContent`), /Boost this site/);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.waitFor(`!!${SC}.getElementById('boostZap')`);
    assert.match(await b.eval(`${SC}.querySelector('.bhost').textContent`), /127\.0\.0\.1/);

    // A font: the page's text takes it at once.
    await b.eval(`(() => { const f = ${SC}.getElementById('boostFont'); f.value = 'Georgia'; f.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`getComputedStyle(document.querySelector('p')).fontFamily.startsWith('Georgia')`, 5000);
    // Colours: the header's red turns.
    await b.eval(`(() => { const h = ${SC}.getElementById('boostHue'); h.value = '180'; h.dispatchEvent(new Event('change')); })()`);
    await page.waitFor(`getComputedStyle(document.documentElement).filter.includes('hue-rotate(180deg)')`, 5000);

    // Code: CSS hides the promo at once; JavaScript runs from the next load.
    await b.click(`${SC}.querySelector('#boostCode summary')`);
    await b.eval(`(() => { ${SC}.getElementById('boostCss').value = '#promo { display: none !important; }'; ${SC}.getElementById('boostJs').value = "document.body.dataset.boosted = 'yes';"; })()`);
    await b.click(`${SC}.getElementById('boostSave')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    assert.equal(await page.eval(`document.body.dataset.boosted || ''`), '');
    const { state } = await b.eval(`${H}.getBoost()`);
    assert.equal(state.boost.host, '127.0.0.1');
    assert.equal(state.boost.font, 'Georgia');
    assert.equal(state.boost.hue, 180);
    // Quick changes, one boost.
    assert.equal((await b.eval(`${H}.getBoosts()`)).boosts.length, 1);

    // Another page of the site, opened fresh: all of it, the JavaScript too, and the style after the
    // site's own.
    const other = s.url.replace('/news', '/other');
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(other)})`);
    const p2 = await b.page(other);
    await p2.waitFor(`document.body?.dataset.boosted === 'yes'`, 8000);
    assert.equal(await shown(p2, '#promo'), 'none');
    assert.equal(await p2.eval(`document.documentElement.lastElementChild.id`), 'meridian-boost-style');
    p2.close();

    // Off: the page is the site's again; on; then deleted (two clicks).
    await b.click(`[...app.$.tabstrip.shadowRoot.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url === ${JSON.stringify(s.url)}).shadowRoot.querySelector('.row')`);
    await openControls(b);
    assert.match(await b.eval(`${SC}.getElementById('boostRow').textContent`), /On/);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.click(`${SC}.getElementById('boostEnabled')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    await b.click(`${SC}.getElementById('boostEnabled')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    await b.eval(`${SC}.getElementById('boostDelete').scrollIntoView()`);
    await b.click(`${SC}.getElementById('boostDelete')`);
    await b.click(`${SC}.getElementById('boostDelete')`);
    await page.waitFor(`!document.getElementById('meridian-boost-style')`, 5000);
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boost, null);
    page.close();
  } finally { await b.close(); s.server.close(); }
});

test('Zap: click what to hide on the page, Esc to stop; it stays hidden after a reload', async () => {
  const s = await site();
  const profile = profileWith();
  let b = await launch([s.url], { profile });
  try {
    let page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await openControls(b);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.click(`${SC}.getElementById('boostZap')`);
    await b.waitFor(`!app.$.siteControl.open`);
    await page.waitFor(`!!document.getElementById('meridian-zap-hint')`, 5000);
    await clickIn(page, '#promo');
    // The page didn't get the click (the hint is still there), and the browser kept the zap.
    await b.waitFor(`${H}.getBoost().then((r) => r.state.boost?.zaps.length === 1)`, 5000);
    assert.equal(await shown(page, '#promo'), 'none');
    assert.match((await b.eval(`${H}.getBoost()`)).state.boost.zaps[0], /promo/);
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor(`!document.getElementById('meridian-zap-hint')`, 5000);
    // Zap is over: a click is the page's again.
    await page.eval(`document.getElementById('top').onclick = () => { window.topClicked = true; }`);
    await clickIn(page, '#top');
    await page.waitFor('window.topClicked === true', 3000);

    // After a restart and a reload: still hidden.
    page.close();
    await b.quit();
    b = await launch([s.url], { profile });
    page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 8000);
    assert.equal(await shown(page, '#story'), 'block');
    // The zap is listed and comes back with its ×.
    await openControls(b);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.click(`${SC}.querySelector('.zap-x')`);
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
    await openControls(b);
    await b.click(`${SC}.getElementById('boostRow')`);
    // No AI yet: the button says where to set one up.
    await b.waitFor(`${SC}.getElementById('boostImprove').disabled && /Settings/.test(${SC}.getElementById('boostImprove').textContent)`);
    assert.equal((await b.eval(`${H}.setAiKey(${JSON.stringify(KEY)})`)).ok, true);
    await b.click(`${SC}.getElementById('boostBack')`);
    await b.click(`${SC}.getElementById('boostRow')`);
    await b.waitFor(`/Improve with Claude/.test(${SC}.getElementById('boostImprove').textContent)`);

    await b.eval(`${SC}.getElementById('boostWish').value = 'hide the banner'`);
    await b.click(`${SC}.getElementById('boostImprove')`);
    await b.waitFor(`${SC}.getElementById('boostNote')?.textContent.includes('Hid the subscription banner.')`, 15000, `${SC}.getElementById('boostNote')?.textContent`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'none'`, 5000);
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boost.name, 'Calm News');

    // What Claude got: the boost instructions, the outline with the page's elements, the wish.
    const req = api.requests.filter((r) => r.stream).pop();
    assert.match(req.system, /Boosts in the Meridian browser/);
    assert.equal(req.tools, undefined, 'no browser tools for a boost');
    const text = JSON.stringify(req.messages);
    assert.match(text, /div#promo\.promo-banner/);
    assert.match(text, /Subscribe now!/);
    assert.match(text, /hide the banner/);

    // Undo: the site had no boost, so it has none again.
    await b.click(`${SC}.getElementById('boostUndo')`);
    await page.waitFor(`getComputedStyle(document.getElementById('promo')).display === 'block'`, 5000);
    assert.equal((await b.eval(`${H}.getBoost()`)).state.boost, null);
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

    assert.deepEqual((await mcp.call('get_boost')).value, { host: '127.0.0.1', boost: null });
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
