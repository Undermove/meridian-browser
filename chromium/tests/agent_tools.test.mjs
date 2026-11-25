// Agent input tools over MCP, as in a real site: key chords sent to the page (never the browser's
// shortcuts), Enter that sends a chat message in a tab in the background, right and double clicks
// that reach the page's own handlers, hover menus, and a file chooser a button opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { launch, APP, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function profileWith(meridian) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ meridian }));
  return dir;
}

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

// A chat page: its composers send only on a real (trusted) Enter keydown, as chat sites do.
const CHAT = `<title>Chat</title>
<div id=ce contenteditable=true aria-label="Message" style="border:1px solid;min-height:40px"></div>
<textarea id=ta aria-label="Note"></textarea>
<ul id=sent></ul>
<script>
  window.log = [];
  const send = (el, text) => { const li = document.createElement('li'); li.textContent = el.id + ':' + text; document.getElementById('sent').append(li); document.title = 'Chat ' + document.getElementById('sent').children.length; };
  for (const el of [document.getElementById('ce'), document.getElementById('ta')]) {
    el.addEventListener('keydown', (e) => {
      window.log.push({ id: el.id, key: e.key, trusted: e.isTrusted, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, focus: document.hasFocus(), vis: document.visibilityState });
      if (e.key === 'Enter' && !e.shiftKey && e.isTrusted && !e.isComposing) {
        e.preventDefault();
        const text = el.value !== undefined ? el.value : el.innerText;
        if (el.value !== undefined) el.value = ''; else el.textContent = '';
        send(el, text.trim());
      }
    });
  }
  document.addEventListener('keydown', (e) => { if (!e.target.closest || !e.target.closest('#ce,#ta')) window.log.push({ id: 'doc', key: e.key, trusted: e.isTrusted, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }); });
</script>`;

function site(routes) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(routes[req.url] || '<title>Home</title><p>Home</p>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: (p) => `http://127.0.0.1:${server.address().port}${p}` })));
}

async function start(s, meridian, args = []) {
  const profile = profileWith(meridian);
  const b = await launch([s.url('/')], { profile, args });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
  const mcp = bridge(profile);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
  return { b, mcp, profile, done: async () => { mcp.close(); await b.close(); fs.rmSync(profile, { recursive: true, force: true }); } };
}

test('Enter sends a chat message in a tab in the background (contenteditable and textarea)', async () => {
  const s = await site({ '/chat': CHAT });
  const { b, mcp, done } = await start(s, { agent_access: 'full', agent_allow_js: true }, ['--meridian-test-agent-awake-seconds=2']);
  try {
    const { tab_id } = (await mcp.call('open_tab', { url: s.url('/chat') })).value;
    const page = await b.page(s.url('/chat'));
    await page.waitFor(`!!document.getElementById('ce')`);
    const sent = () => page.eval(`[...document.querySelectorAll('#sent li')].map((li) => li.textContent)`);
    const log = () => page.eval(`JSON.stringify(window.log)`);
    // type_text, then press_key Enter: in the contenteditable.
    let r = await mcp.call('type_text', { tab_id, selector: '#ce', value: 'hello one' });
    assert.ok(!r.error, r.error);
    r = await mcp.call('press_key', { tab_id, key: 'Enter' });
    assert.ok(!r.error, r.error);
    await page.waitFor(`document.querySelectorAll('#sent li').length === 1`, 3000).catch(async () => assert.fail(`not sent: ${JSON.stringify(await sent())} log ${await log()}`));
    // In the textarea, with submit: true.
    r = await mcp.call('type_text', { tab_id, selector: '#ta', value: 'hello two', submit: true });
    assert.ok(!r.error, r.error);
    await page.waitFor(`document.querySelectorAll('#sent li').length === 2`, 3000).catch(async () => assert.fail(`not sent: ${JSON.stringify(await sent())} log ${await log()}`));
    // After the tab went back to sleep (hidden again): once more, each way.
    await sleep(4000);
    r = await mcp.call('type_text', { tab_id, selector: '#ce', value: 'hello three', submit: true });
    assert.ok(!r.error, r.error);
    await page.waitFor(`document.querySelectorAll('#sent li').length === 3`, 3000).catch(async () => assert.fail(`not sent: ${JSON.stringify(await sent())} log ${await log()}`));
    await sleep(4000);
    r = await mcp.call('type_text', { tab_id, selector: '#ta', value: 'hello four' });
    await sleep(4000);
    r = await mcp.call('press_key', { tab_id, key: 'Enter' });
    assert.ok(!r.error, r.error);
    await page.waitFor(`document.querySelectorAll('#sent li').length === 4`, 3000).catch(async () => assert.fail(`not sent: ${JSON.stringify(await sent())} log ${await log()}`));
    assert.deepEqual(await sent(), ['ce:hello one', 'ta:hello two', 'ce:hello three', 'ta:hello four']);
  } finally { await done(); s.server.close(); }
});

// A page that logs what reaches it: keys with modifiers, right and double clicks, and a menu
// that opens only on hover.
const INPUTS = `<title>Inputs</title>
<input id=field aria-label="Field" value="abc">
<button id=target style="width:120px;height:40px">Target</button>
<div id=menu style="width:120px;height:40px;border:1px solid">Menu<ul id=items hidden><li>Item</li></ul></div>
<script>
  window.events = [];
  const t = document.getElementById('target');
  t.addEventListener('click', (e) => events.push('click:' + e.button));
  t.addEventListener('dblclick', () => events.push('dblclick'));
  t.addEventListener('contextmenu', (e) => { e.preventDefault(); events.push('contextmenu:' + e.button); });
  document.getElementById('field').addEventListener('keydown', (e) => events.push('key:' + [e.metaKey && 'Meta', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key].filter(Boolean).join('+') + (e.isTrusted ? '' : ':untrusted')));
  const m = document.getElementById('menu');
  m.addEventListener('mouseenter', () => { document.getElementById('items').hidden = false; events.push('hover'); });
</script>`;

test('key chords reach the page, right and double clicks reach its handlers, hover opens a hover menu', async () => {
  const s = await site({ '/inputs': INPUTS });
  const { b, mcp, done } = await start(s, { agent_access: 'full', agent_allow_js: true }, ['--meridian-test-agent-awake-seconds=2']);
  try {
    const names = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('hover'), 'hover is offered');
    const { tab_id } = (await mcp.call('open_tab', { url: s.url('/inputs') })).value;
    const page = await b.page(s.url('/inputs'));
    await page.waitFor(`!!document.getElementById('target')`);
    const events = () => page.eval(`window.events.slice()`);
    let r = await mcp.call('click', { tab_id, selector: '#field' });
    assert.ok(!r.error, r.error);
    for (const key of ['Meta+A', 'Control+Shift+Tab', 'Alt+ArrowLeft', 'Shift+Enter']) {
      r = await mcp.call('press_key', { tab_id, key });
      assert.ok(!r.error, `${key}: ${r.error}`);
    }
    r = await mcp.call('press_key', { tab_id, key: 'Meta+Nope' });
    assert.ok(r.error, 'an unknown key is an error');
    r = await mcp.call('click', { tab_id, selector: '#target', button: 'right' });
    assert.ok(!r.error, r.error);
    r = await mcp.call('click', { tab_id, selector: '#target', double: true });
    assert.ok(!r.error, r.error);
    r = await mcp.call('click', { tab_id, selector: '#target', button: 'right', double: true });
    assert.match(r.error || '', /left button only/);
    r = await mcp.call('hover', { tab_id, selector: '#menu' });
    assert.ok(!r.error, r.error);
    await page.waitFor(`!document.getElementById('items').hidden`, 3000);
    const ev = await events();
    for (const want of ['key:Meta+a', 'key:Control+Shift+Tab', 'key:Alt+ArrowLeft', 'key:Shift+Enter', 'contextmenu:2', 'dblclick', 'hover']) {
      assert.ok(ev.some((e) => e.toLowerCase() === want.toLowerCase()), `${want} in ${JSON.stringify(ev)}`);
    }
    assert.ok(!ev.some((e) => e.endsWith(':untrusted')), `all input is real: ${JSON.stringify(ev)}`);
  } finally { await done(); s.server.close(); }
});
