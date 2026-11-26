// 1.5.3 RC soak: one long-lived test browser driven the way agents drive it over MCP, mixed with
// ordinary actions (tabs, spaces, pin/unpin, favorites, Boost colours, split view, navigation),
// for SOAK_MIN minutes. Runs from the tests folder given in TESTS (harness.mjs, its guards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const TESTS = process.env.TESTS;
const { launch, APP, SB } = await import(path.join(TESTS, 'harness.mjs'));
const MIN = Number(process.env.SOAK_MIN || 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function bridge(profile) {
  const proc = spawn(APP, ['--mcp-bridge', `--user-data-dir=${profile}`], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${method} ${params.name || ''}: no answer in 60 s`)); }, 60000);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const m = await request('tools/call', { name, arguments: args });
    if (m.error) return { error: JSON.stringify(m.error), value: null };
    const r = m.result; const c = r.content[0];
    const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
    return { error: r.isError ? c.text : null, value: !r.isError ? parse(c.text) : null };
  };
  return { request, call, proc, close: () => proc.kill() };
}

const PAGES = {
  '/compose': `<title>Compose</title>
<div id=ce contenteditable=true aria-label="Message" style="border:1px solid;min-height:40px"></div>
<textarea id=ta aria-label="Note"></textarea>
<button id=send>Send</button><ul id=sent></ul>
<script>
  const ce = document.getElementById('ce');
  ce.addEventListener('paste', (e) => { e.preventDefault(); ce.textContent += e.clipboardData.getData('text/plain'); });
  document.getElementById('send').addEventListener('click', () => {
    const li = document.createElement('li'); li.textContent = ce.textContent; document.getElementById('sent').append(li);
    ce.textContent = ''; document.title = 'Sent ' + document.getElementById('sent').children.length;
  });
</script>`,
  '/form': `<title>Form</title><h1>Order</h1>
<label>Name <input id=name></label>
<label>Category <select id=cat><option>Kitchen</option><option>Garden</option></select></label>
<button id=go onclick="document.title='Done '+document.getElementById('name').value">Order</button>
<a href="/article">Read the article</a>`,
  '/article': `<title>Article</title><style>body{font:16px Georgia;background:#fff;color:#222} header{background:#123;color:#fff;padding:8px}</style>
<header>Daily News</header><main>${'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10) + '</p>'}${'<h2>Section</h2><p>More text here for scrolling.</p>'.repeat(40)}<img alt=pic width=200 height=120 src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main>`,
  '/app': `<title>Dark app</title><style>body{background:#111;color:#eee;font:14px system-ui}.card{background:#222;margin:8px;padding:8px;border-radius:8px}</style>
${'<div class=card>Card <button>Open</button></div>'.repeat(200)}`,
  '/dialog': `<title>Dialog</title><button id=b onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Ask</button>`,
};

function site() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGES[req.url.split('?')[0]] || `<title>Home ${req.url}</title><p>Home</p><a href="/form">Form</a>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: (p) => `http://127.0.0.1:${server.address().port}${p}` })));
}

test(`soak: ${MIN} min of agent MCP scenarios and ordinary actions in one browser`, { timeout: (MIN + 15) * 60000 }, async () => {
  const s = await site();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full', agent_allow_js: true } }));
  let b = await launch([s.url('/')], { profile });
  let mcp;
  const counts = {};
  const errors = [];
  const did = (k) => { counts[k] = (counts[k] || 0) + 1; };
  const ok = async (name, args, { soft = false } = {}) => {
    const r = await mcp.call(name, args);
    did(name);
    if (r.error && !soft) { const e = `${name}: ${String(r.error).slice(0, 200)}`; if (!errors.includes(e)) log('new error', e); errors.push(e); }
    return r;
  };
  const alive = async (where) => assert.equal(await b.eval('1 + 1'), 2, `browser alive after ${where}`);
  const tabCount = () => b.eval(`${SB}.querySelectorAll('meridian-tab-row').length`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    const connect = async () => {
      mcp = bridge(profile);
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'soak', version: '1' }, capabilities: {} });
    };
    await connect();
    const end = Date.now() + MIN * 60000;
    const spaces = [];
    let round = 0;
    while (Date.now() < end) {
      round++;
      // 1. The 1.4.0 crash: open (activate), paste + Send, wait, close.
      const opened = await ok('open_tab', { url: s.url('/compose'), activate: true });
      const tab = opened.value?.tab_id;
      if (tab) {
        for (let i = 0; i < 20; i++) {
          const r = await mcp.call('run_javascript', { tab_id: tab, code: `const ce = document.getElementById('ce'); ce.focus(); const d = new DataTransfer(); d.setData('text/plain', 'hi ${round}'); ce.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true })); document.getElementById('send').click(); return document.querySelectorAll('#sent li').length;` });
          if (!r.error) { did('paste_send'); break; }
          await sleep(250);
        }
        await ok('type_text', { tab_id: tab, selector: '#ta', value: `note ${round}`, submit: true }, { soft: true });
        await ok('type_text', { tab_id: tab, selector: '#ce', value: `typed ${round}` }, { soft: true });
        await sleep(1500);
        await ok('close_tab', { tab_id: tab });
      }
      await alive(`round ${round} compose`);
      // 2. Reading and clicking through a form, back and forward, a dialog.
      const form = (await ok('open_tab', { url: s.url('/form') })).value?.tab_id;
      if (form) {
        await ok('wait_for', { tab_id: form, text: 'Order', timeout_ms: 10000 }, { soft: true });
        await ok('read_page', { tab_id: form });
        const els = (await ok('get_interactive_elements', { tab_id: form })).value;
        const input = Array.isArray(els) ? els.find((e) => /Name/.test(e.label || '')) : null;
        if (input) await ok('type_text', { tab_id: form, element_index: input.i, value: 'Ada' }, { soft: true });
        await ok('type_text', { tab_id: form, selector: '#cat', value: 'Garden' }, { soft: true });
        await ok('highlight', { tab_id: form, selector: '#go', note: 'Press this' }, { soft: true });
        await ok('hover', { tab_id: form, selector: '#go' }, { soft: true });
        await ok('clear_highlights', { tab_id: form }, { soft: true });
        await ok('click', { tab_id: form, selector: '#go' }, { soft: true });
        await ok('screenshot', { tab_id: form });
        await ok('click', { tab_id: form, text: 'Read the article' }, { soft: true });
        await ok('wait_for', { tab_id: form, text: 'Daily News', timeout_ms: 10000 }, { soft: true });
        await ok('scroll', { tab_id: form, direction: 'down', screens: 3 }, { soft: true });
        await ok('scroll', { tab_id: form, direction: 'top' }, { soft: true });
        await ok('history_nav', { tab_id: form, action: 'back' }, { soft: true });
        await ok('history_nav', { tab_id: form, action: 'forward' }, { soft: true });
        await ok('history_nav', { tab_id: form, action: 'reload' }, { soft: true });
        await ok('press_key', { tab_id: form, key: 'End' }, { soft: true });
        await ok('navigate', { tab_id: form, url: s.url('/dialog') });
        await ok('click', { tab_id: form, selector: '#b' }, { soft: true });
        await ok('handle_dialog', { tab_id: form, action: round % 2 ? 'accept' : 'dismiss' }, { soft: true });
      }
      await alive(`round ${round} form`);
      // 3. Spaces, pinning, favorites, moving, split view (every few rounds a new space).
      await ok('list_spaces', {});
      if (round % 3 === 1 && spaces.length < 4) {
        const sp = (await ok('create_space', { name: `Soak ${round}` })).value?.space_id;
        if (sp) spaces.push(sp);
      }
      const art = (await ok('open_tab', { url: s.url('/article'), activate: round % 2 === 0 })).value?.tab_id;
      const app = (await ok('open_tab', { url: s.url('/app') })).value?.tab_id;
      if (art) {
        await ok('organize_tab', { tab_id: art, action: 'pin' }, { soft: true });
        await ok('organize_tab', { tab_id: art, action: 'rename', title: `Pinned ${round}` }, { soft: true });
        await ok('organize_tab', { tab_id: art, action: 'unpin' }, { soft: true });
        if (round % 4 === 0) await ok('organize_tab', { tab_id: art, action: 'favorite' }, { soft: true });
        if (spaces.length) await ok('organize_tab', { tab_id: art, action: 'move_to_space', space_id: spaces[round % spaces.length] }, { soft: true });
      }
      if (art && app && round % 2 === 1) await ok('split_view', { left_tab_id: art, right_tab_id: app }, { soft: true });
      // 4. Boost colours on a light page and a heavy dark app, as a drag would set them; removed.
      for (const t of [art, app].filter(Boolean)) {
        await ok('activate_tab', { tab_id: t }, { soft: true });
        for (const hue of [20, 140, 260, 330]) await ok('set_boost', { tab_id: t, hue, tint: hue, tint_strength: 60, tint2: (hue + 120) % 360, name: `Soak ${hue}` }, { soft: true });
        await ok('set_boost', { tab_id: t, css: 'h2 { letter-spacing: .02em; }', zaps: ['header'], dark: round % 2 === 0, font: 'Georgia', size: 110, text_case: 'normal' }, { soft: true });
        await ok('get_boost', { tab_id: t }, { soft: true });
        await ok('set_boost', { tab_id: t, enabled: false }, { soft: true });
        await ok('set_boost', { tab_id: t, remove: true }, { soft: true });
      }
      await alive(`round ${round} boosts`);
      // 5. Find and list, then close what this round opened (some left, so tabs build up a little).
      await ok('search_tabs', { query: 'Article' });
      await ok('search_history', { query: 'Form', limit: 5 });
      await ok('list_tabs', {});
      await ok('list_ai_accounts', {}, { soft: true });
      for (const t of [form, app, round % 3 ? art : null].filter(Boolean)) await ok('close_tab', { tab_id: t }, { soft: true });
      // 6. Every 5th round: the bridge reconnects (as Claude Code restarting), and every 8th the
      // browser restarts on the same profile.
      if (round % 5 === 0) { mcp.close(); await connect(); did('reconnect'); }
      if (round % 8 === 0) {
        mcp.close(); await b.close();
        b = await launch([], { profile });
        await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 30000);
        for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
        await connect(); did('restart');
      }
      if (round % 3 === 0) log(`round ${round}: tabs ${await tabCount()}, errors ${errors.length}`);
    }
    log('counts', JSON.stringify(counts));
    log('errors', errors.length, JSON.stringify([...new Set(errors)].slice(0, 30)));
    await alive('the soak');
  } finally {
    mcp?.close();
    await b.close();
    s.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
