// AI agents over MCP: `Meridian --mcp-bridge` (stdio) → the running browser's agent socket.
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
const AG = 'app.$.agent.shadowRoot';

// A profile with agent access set as Settings > AI would.
function profileWith(meridian) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ meridian }));
  return dir;
}

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
    return { error: r.isError ? c.text : null, value: c.type === 'text' && !r.isError ? parse(c.text) : null, image: c.type === 'image' ? c : null };
  };
  return { request, call, close: () => proc.kill() };
}

function site() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/form') {
      res.end(`<title>Form</title><h1>Sign up</h1><input id=name aria-label="Your name">
        <button onclick="document.title='Hello ' + document.getElementById('name').value">Say hello</button>`);
    } else res.end('<title>Home</title><p>Welcome to the test site</p>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: (p) => `http://127.0.0.1:${server.address().port}${p}` })));
}

test('full access: an MCP client lists, opens, reads, clicks, types, screenshots and runs JS', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_allow_js: true });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    assert.equal((fs.statSync(path.join(profile, 'Meridian Agent.json')).mode & 0o777), 0o600, 'the token file is private');
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'meridian');
    const names = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('click') && names.includes('read_page') && names.length >= 20);

    const tabs = (await mcp.call('list_tabs')).value;
    assert.equal(tabs.find((t) => t.zone === 'today').title, 'Home');
    const opened = (await mcp.call('open_tab', { url: s.url('/form'), activate: true })).value;
    assert.equal(opened.title, 'Form');
    // The window names the agent while it works.
    await b.waitFor(`app.$.agent.working && ${AG}.querySelector('.what').textContent.includes('test-client')`);
    const page = (await mcp.call('read_page')).value;
    assert.match(page.text, /Sign up/);
    const els = (await mcp.call('get_interactive_elements')).value;
    const input = els.find((e) => e.label === 'Your name');
    const button = els.find((e) => e.label === 'Say hello');
    assert.ok(input && button);
    assert.equal((await mcp.call('type_text', { element_index: input.i, value: 'Ada' })).value.field_now, 'Ada');
    await mcp.call('click', { element_index: button.i });
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Hello Ada')`);
    // A screenshot needs drawn frames: not while the Mac's screen sleeps.
    const drawing = await b.eval(`new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 1000); })`);
    if (drawing) {
      const shot = await mcp.call('screenshot');
      assert.equal(shot.image.mimeType, 'image/jpeg');
      assert.ok(shot.image.data.length > 1000);
    }
    assert.equal((await mcp.call('run_javascript', { code: 'return await Promise.resolve(document.title)' })).value, 'Hello Ada');
    assert.match((await mcp.call('search_tabs', { query: 'hello' })).value[0].title, /Hello Ada/);
    assert.match((await mcp.call('click', { selector: '#nothing-here' })).error, /not found/);
    // Stop pauses agents until Resume (the bar shows for a few seconds after an action).
    await mcp.call('read_page');
    await b.waitFor(`app.$.agent.working && !!${AG}.getElementById('stop')`);
    // (A DOM click: real mouse input can lag seconds while the Mac's screen sleeps.)
    await b.eval(`${AG}.getElementById('stop').click()`);
    await b.waitFor(`!!${AG}.getElementById('resume')`);
    assert.match((await mcp.call('list_tabs')).error, /stopped the agents/);
    await b.eval(`${AG}.getElementById('resume').click()`);
    assert.equal((await mcp.call('list_tabs')).error, null);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('ask: every action is put to the person; read-only refuses changes; off has no socket', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'ask' });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'asker' } });
    // Reading needs no question.
    assert.equal((await mcp.call('list_tabs')).error, null);
    const pending = mcp.call('open_tab', { url: s.url('/form') });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    assert.match(await b.eval(`${AG}.querySelector('.summary').textContent`), /open http:\/\/127\.0\.0\.1:\d+\/form/);
    await b.click(`${AG}.getElementById('deny')`);
    assert.match((await pending).error, /declined/);
    const allowed = mcp.call('open_tab', { url: s.url('/form') });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    await b.click(`${AG}.getElementById('allow')`);
    assert.equal((await allowed).value.title, 'Form');
    assert.match((await mcp.call('run_javascript', { code: '1' })).error, /JavaScript is off/);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }

  const off = profileWith({ agent_access: 'off' });
  const b2 = await launch(['about:blank'], { profile: off });
  const mcp2 = bridge(off);
  try {
    await b2.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await mcp2.request('initialize', {});
    assert.match((await mcp2.call('list_tabs')).error, /not running, or AI agent access is off/);
  } finally { mcp2.close(); await b2.close(); fs.rmSync(off, { recursive: true, force: true }); }
});
