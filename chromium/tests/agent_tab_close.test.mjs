// What an agent did when Meridian crashed at once and then at every start (1.4.0, SIGABRT in
// views::Label::PaintText, a not-yet-fatal CHECK made fatal in a non-official build): open_tab with
// activate, run_javascript that focuses a contenteditable, pastes (a synthetic ClipboardEvent) and
// clicks Send, three seconds, close_tab of that tab. Done over MCP a few times on a local page;
// Meridian is still there after it, and after a restart.
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

// A composer, as chat sites have: a contenteditable that takes a paste, and a Send button.
const COMPOSE = `<title>Compose</title>
<div id=ce contenteditable=true aria-label="Message" style="border:1px solid;min-height:40px"></div>
<button id=send>Send</button>
<ul id=sent></ul>
<script>
  const ce = document.getElementById('ce');
  ce.addEventListener('paste', (e) => { e.preventDefault(); ce.textContent += e.clipboardData.getData('text/plain'); });
  document.getElementById('send').addEventListener('click', () => {
    const li = document.createElement('li'); li.textContent = ce.textContent; document.getElementById('sent').append(li);
    ce.textContent = ''; document.title = 'Sent ' + document.getElementById('sent').children.length;
  });
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

const PASTE_AND_SEND = `const ce = document.getElementById('ce');
ce.focus();
const data = new DataTransfer();
data.setData('text/plain', 'hello from the agent');
ce.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
document.getElementById('send').click();
return document.querySelectorAll('#sent li').length;`;

test('an agent opens a tab (activate), pastes into a contenteditable and clicks Send, waits, closes the tab: Meridian keeps running, also after a restart', async () => {
  const s = await site({ '/compose': COMPOSE });
  const profile = profileWith({ agent_access: 'full', agent_allow_js: true });
  let b = await launch([s.url('/')], { profile });
  let mcp;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    mcp = bridge(profile);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    for (let round = 1; round <= 3; round++) {
      const opened = await mcp.call('open_tab', { url: s.url('/compose'), activate: true });
      assert.ok(!opened.error, opened.error);
      const { tab_id } = opened.value;
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
      let sent;
      for (let i = 0; i < 20; i++) {
        const r = await mcp.call('run_javascript', { tab_id, code: PASTE_AND_SEND });
        if (!r.error) { sent = r.value; break; }
        await sleep(250);
      }
      assert.equal(sent, 1, `round ${round}: pasted and sent`);
      await sleep(3000);
      const closed = await mcp.call('close_tab', { tab_id });
      assert.ok(!closed.error, closed.error);
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
      await sleep(1000);
      assert.equal(await b.eval('1 + 1'), 2, `round ${round}: still running`);
    }
    mcp.close(); mcp = null;
    await b.close();
    // And it starts again (the crash came back at every start).
    b = await launch([], { profile });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await sleep(3000);
    assert.equal(await b.eval('1 + 1'), 2, 'running after a restart');
  } finally {
    mcp?.close();
    await b.close();
    s.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
