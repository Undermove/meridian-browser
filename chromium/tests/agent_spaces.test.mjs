// Settings > AI > "Agents can use": all spaces, or only the ones checked. Tabs in the others are
// not listed (list_tabs, list_spaces, search_tabs) and tools refuse them with a clear message.
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
const ST = 'app.$.settings.shadowRoot';
const SHOTS = process.env.MERIDIAN_SHOTS || '';

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

test('Agents can use only some spaces: the others are hidden and refused; All spaces brings them back', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/work' ? '<title>Work page</title><p>work</p>' : '<title>Home page</title><p>home</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  const b = await launch([url('/home')], { profile });
  const mcp = bridge(profile);
  const settings = () => b.eval(`app.$.tabstrip.handler_.getSettings().then((r) => ({ spaces: r.settings.agentSpaces, ids: r.settings.agentSpaceIds }))`);
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Home page')`, 15000);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.deepEqual(await settings(), { spaces: 'all', ids: [] }, 'all spaces by default');

    const [home] = (await mcp.call('list_spaces')).value;
    const homeTab = (await mcp.call('list_tabs')).value.find((t) => t.title === 'Home page');
    assert.ok(homeTab, 'the home tab is listed');
    const work = (await mcp.call('create_space', { name: 'Work' })).value.space_id;
    const opened = await mcp.call('open_tab', { url: url('/work'), space_id: work, activate: true });
    assert.ok(opened.value?.tab_id, JSON.stringify(opened) + ' space ' + work);
    const workTab = opened.value.tab_id;
    for (let i = 0; i < 100 && !(await mcp.call('list_tabs')).value.some((t) => t.title === 'Work page'); i++) await sleep(100);

    // Settings > AI: "Only these" starts with the space on screen (Work).
    await b.eval(`app.$.tabstrip.runCommand(13, 0)`);
    await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('member')`);
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'ai')`);
    await b.waitFor(`!!${ST}.getElementById('agentSpaces-only')`);
    await b.eval(`${ST}.getElementById('agentSpaces-only').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    await b.click(`${ST}.getElementById('agentSpaces-only')`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentSpaces === 'only' && r.settings.agentSpaceIds.length === 1)`);
    await b.waitFor(`${ST}.querySelectorAll('.agent-space').length === 2`);
    const box = (id) => `[...${ST}.querySelectorAll('.agent-space input')].find((i) => i.dataset.space === ${JSON.stringify(id)})`;
    const toggle = async (id) => { await b.eval(`${box(id)}.scrollIntoView({ block: 'center' })`); await sleep(200); await b.click(box(id)); };
    // The space on screen is the one checked; Work only, by clicks.
    if (!(await settings()).ids.includes(work)) {
      await toggle(work);
      await toggle(home.id);
    }
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentSpaceIds.join() === ${JSON.stringify(work)})`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await sleep(300); await b.screenshot(path.join(SHOTS, 'agent-spaces.png')); }

    // Hidden: the home space and its tab.
    assert.deepEqual((await mcp.call('list_spaces')).value.map((s) => s.id), [work]);
    const listed = (await mcp.call('list_tabs')).value;
    assert.ok(listed.some((t) => t.id === workTab), 'the work tab is listed');
    assert.ok(!listed.some((t) => t.space_id === home.id || t.title === 'Home page'), JSON.stringify(listed));
    assert.ok(!(await mcp.call('search_tabs', { query: 'home' })).value.some((t) => t.title === 'Home page'));
    // Refused, saying why.
    const refused = await mcp.call('read_page', { tab_id: homeTab.id });
    assert.match(refused.error || '', new RegExp(`in the space “${home.name}”.*Agents can use`));
    assert.match((await mcp.call('close_tab', { tab_id: homeTab.id })).error || '', /agents can't use/);
    assert.match((await mcp.call('open_tab', { url: url('/x'), space_id: home.id })).error || '', /can't use that space/);
    assert.ok(!(await mcp.call('read_page', { tab_id: workTab })).error, 'the work tab still works');

    // The home space checked too: listed again.
    await toggle(home.id);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentSpaceIds.includes(${JSON.stringify(home.id)}))`);
    assert.ok((await mcp.call('list_tabs')).value.some((t) => t.title === 'Home page'));

    // Unchecked again, then "All spaces": everything again.
    await toggle(home.id);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => !r.settings.agentSpaceIds.includes(${JSON.stringify(home.id)}))`);
    assert.match((await mcp.call('read_page', { tab_id: homeTab.id })).error || '', /Agents can use/);
    await b.click(`${ST}.getElementById('agentSpaces-all')`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentSpaces === 'all')`);
    assert.ok(!(await mcp.call('read_page', { tab_id: homeTab.id })).error, 'all spaces: the home tab works');
    assert.equal((await mcp.call('list_spaces')).value.length, 2);
  } finally {
    mcp.close();
    await b.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
