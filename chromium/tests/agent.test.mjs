// AI agents over MCP: `Meridian --mcp-bridge` (stdio) → the running browser's agent socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { launch, APP, SB, FOREGROUND } from './harness.mjs';

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
    } else if (req.url === '/login') {
      res.end(`<title>Login</title><input id=a type=PASSWORD aria-label="Code" value="kept-out-1"><input id=b type=text autocomplete="current-password" aria-label="Shown code" value="kept-out-2">`);
    } else if (req.url === '/filter') {
      // A native dropdown: its list opens outside the page, so clicks and keys can't pick from it.
      res.end(`<title>Filter</title><label for=cat>Category</label>
        <select id=cat onchange="document.title = 'Filter: ' + this.value"><option value="">All (30)</option><option>Winter</option><option>Summer</option><option value="k">Kitchen</option><option disabled>Archived</option></select>`);
    } else res.end('<title>Home</title><p>Welcome to the test site</p>');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: (p) => `http://127.0.0.1:${server.address().port}${p}` })));
}

// An agent outside Meridian (Claude Code in a terminal) lost its browser tools when the browser
// crashed: every call failed at once with "Meridian is not running". Now the bridge waits for the
// browser to come back (it reopens itself after a crash) and the call goes through.
test('a tool call while the browser is down after a crash waits for it to come back', async () => {
  const profile = profileWith({ agent_access: 'full' });
  let b = await launch(['about:blank'], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'patient' } });
    assert.equal((await mcp.call('list_tabs')).error, null);
    process.kill(b.proc.pid, 'SIGKILL');  // a crash
    await b.close();
    const pending = mcp.call('list_tabs');
    await sleep(3000);
    b = await launch(['about:blank'], { profile });
    const after = await pending;
    assert.equal(after.error, null, `answered once the browser was back: ${after.error}`);
    assert.ok(Array.isArray(after.value));
  } finally { mcp.close(); await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// A dropdown (<select>): its options are listed, and type_text chooses one, with the page's change
// event (an agent recording a demo couldn't pick a category on a shop's admin page, 20.11.2026).
test('type_text chooses an option in a <select>; get_interactive_elements lists the options', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'ask' });
  const b = await launch([s.url('/filter')], { profile });
  const mcp = bridge(profile);
  const answer = async (pending, re) => {
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    assert.match(await b.eval(`${AG}.querySelector('.summary').textContent`), re);
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    return pending;
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'chooser' } });
    const els = (await mcp.call('get_interactive_elements')).value;
    const select = els.find((e) => e.tag === 'select');
    assert.deepEqual(select.options, ['All (30)', 'Winter', 'Summer', 'Kitchen', 'Archived']);
    assert.equal(select.value, 'All (30)');
    assert.equal(select.label, 'Category', 'named by its <label>, not by its options');
    // The question says what it chooses, and the page hears it.
    const chose = await answer(mcp.call('type_text', { element_index: select.i, value: 'winter' }), /choose “winter” in “Category/);
    assert.equal(chose.value.chosen, 'Winter');
    await b.waitFor(`app.$.tabstrip.state_.spaces.some(() => true) && [...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Filter: Winter')`);
    // By value too; and an option that isn't there names the ones that are.
    assert.equal((await answer(mcp.call('type_text', { selector: '#cat', value: 'k' }), /choose “k”/)).value.chosen, 'Kitchen');
    const none = await answer(mcp.call('type_text', { selector: '#cat', value: 'Spring' }), /choose “Spring”/);
    assert.match(none.error, /no option "Spring"; the options are: All \(30\) \| Winter \| Summer \| Kitchen/);
    assert.match((await answer(mcp.call('type_text', { selector: '#cat', value: 'Archived' }), /Archived/)).error, /disabled/);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// run_javascript answers for the code it was given. One shared result slot let a call that didn't
// compile (or one still running) hand back the previous call's result, and an IIFE ("return" inside)
// was wrapped as a function body and came back null (a report from a user, 18.11.2026, on
// developer.apple.com).
test('run_javascript: an IIFE, a body, a bad one and the next one each give their own answer', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_allow_js: true });
  const b = await launch([s.url('/form')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const js = (code) => mcp.call('run_javascript', { code });
    assert.equal((await js(`(() => { return 'from an IIFE'; })()`)).value, 'from an IIFE');
    assert.equal((await js('document.title')).value, 'Form');
    assert.equal((await js(`const el = document.getElementById('name'); el.value = 'Ada'; return el.value`)).value, 'Ada');
    // A syntax error is said as one: not the last answer again.
    const bad = await js('return (;');
    assert.match(bad.error || '', /SyntaxError/);
    assert.notEqual(bad.value, 'Ada');
    // The next call is its own: it runs, and its answer is its own.
    assert.equal((await js(`document.getElementById('name').value = 'Grace'; return document.getElementById('name').value`)).value, 'Grace');
    assert.equal((await js(`[1, 2, 3].map((n) => { return n * 2; })`)).value.join(','), '2,4,6');
    // Two at once: each gets its own.
    const [a, c] = await Promise.all([js(`new Promise((r) => setTimeout(() => r('slow'), 400))`), js(`'fast'`)]);
    assert.deepEqual([a.value, c.value], ['slow', 'fast']);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('full access: an MCP client lists, opens, reads, clicks, types, screenshots and runs JS', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_allow_js: true });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(profile, 'Meridian Agent.json')).mode & 0o777), 0o600, 'the token file is private');
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.equal(init.result.serverInfo.name, 'meridian');
    const names = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('click') && names.includes('read_page') && names.length >= 20);

    const tabs = (await mcp.call('list_tabs')).value;
    assert.equal(tabs.find((t) => t.zone === 'today').title, 'Home');
    const opened = (await mcp.call('open_tab', { url: s.url('/form'), activate: true })).value;
    assert.equal(opened.title, 'Form');
    // Local files stay closed to agents, with an honest error rather than "https://file///...".
    const local = await mcp.call('open_tab', { url: 'file:///etc/hosts' });
    assert.match(local.error || '', /only http\(s\) URLs/);
    assert.ok(!(await mcp.call('list_tabs')).value.some((t) => /file\//.test(t.url || '')), 'no tab for the file URL');
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
    // The tab it works in glows: the page card on screen and its row in the sidebar.
    await b.waitFor(`app.hasAttribute('agent-on-page')`, 3000)
        .catch(() => assert.fail('the page card glows while the agent works on it'));
    assert.equal(await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].filter((r) => r.agent).map((r) => r.tab.title).join()`), 'Hello Ada');
    // (A DOM click: real mouse input can lag seconds while the Mac's screen sleeps.)
    await b.eval(`${AG}.getElementById('stop').click()`);
    await b.waitFor(`!!${AG}.getElementById('resume')`);
    assert.match((await mcp.call('list_tabs')).error, /stopped the agents/);
    await b.eval(`${AG}.getElementById('resume').click()`);
    assert.equal((await mcp.call('list_tabs')).error, null);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('going back can not take an agent to a browser page', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full' });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'test-client' } });
    const page = await b.page(s.url('/'));
    await page.cdp.send('Page.navigate', { url: 'chrome://version/' });
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => /chrome:\\/\\/version/.test(r.tab.url))`);
    await page.cdp.send('Page.navigate', { url: s.url('/form') });
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Form')`);
    page.close();
    assert.match((await mcp.call('history_nav', { action: 'back' })).error, /only work on web pages/);
    assert.match((await mcp.call('read_page')).value.text, /Sign up/);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('what a login field holds stays in the page', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full' });
  const b = await launch([s.url('/login')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'test-client' } });
    const els = (await mcp.call('get_interactive_elements')).value;
    assert.doesNotMatch(JSON.stringify(els), /kept-out/);
    for (const e of els) {
      const typed = await mcp.call('type_text', { element_index: e.i, value: 'x' });
      assert.equal(typed.error, null);
      assert.equal(typed.value.field_now, undefined);
      assert.doesNotMatch(JSON.stringify(await mcp.call('click', { element_index: e.i })), /kept-out/);
    }
    assert.match((await mcp.call('click', { text: 'kept-out-1' })).error, /not found/);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('an approval holds for the page it was asked about', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'ask' });
  const b = await launch([s.url('/form')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'asker' } });
    const button = (await mcp.call('get_interactive_elements')).value.find((e) => e.label === 'Say hello');
    const pending = mcp.call('click', { element_index: button.i });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    const page = await b.page(s.url('/form'));
    await page.eval(`void (location.href = ${JSON.stringify(s.url('/'))})`).catch(() => {});
    page.close();
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Home')`);
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    assert.match((await pending).error, /page changed/);
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
    // Allow takes no click in the first 600 ms (no click meant for the page lands on it).
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    assert.equal((await allowed).value.title, 'Form');
    assert.match((await mcp.call('run_javascript', { code: '1' })).error, /JavaScript is off/);
    // Always allow: this one is allowed, and the next ones aren't asked (full control, as in Settings).
    const always = mcp.call('open_tab', { url: s.url('/') });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    await sleep(700);
    await b.click(`${AG}.getElementById('always')`);
    assert.equal((await always).error, null);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentAccess === 'full')`);
    const quiet = mcp.call('open_tab', { url: s.url('/form') });
    assert.equal((await quiet).error, null);
    assert.equal(await b.eval(`!!${AG}.getElementById('ask')`), false, 'not asked again');
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }

  const off = profileWith({ agent_access: 'off', agent_access_decided: true });
  const b2 = await launch(['about:blank'], { profile: off });
  const mcp2 = bridge(off);
  try {
    await b2.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await mcp2.request('initialize', {});
    assert.match((await mcp2.call('list_tabs')).error, /not running, or AI agent access is off/);
  } finally { mcp2.close(); await b2.close(); fs.rmSync(off, { recursive: true, force: true }); }
});

// Runs `expression` in the page target whose URL starts with `prefix` (CDP), or sends `method`.
async function inPage(b, prefix, method, params) {
  const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(prefix));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const reply = await new Promise((r) => { ws.onmessage = (m) => r(JSON.parse(m.data)); ws.send(JSON.stringify({ id: 1, method, params })); });
  ws.close();
  return reply.result;
}
const pageEval = async (b, prefix, expression) => (await inPage(b, prefix, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;

test('guide: the agent highlights a step with a note (read-only access), waits for the person to do it, then clears', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'read' });
  const b = await launch([s.url('/form')], { profile });
  const mcp = bridge(profile);
  const prefix = s.url('/');
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const init = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
    for (const name of ['translate_page', 'highlight', 'wait_for_user', 'clear_highlights']) assert.ok(init.includes(name), name);
    assert.match((await mcp.call('wait_for_user', { timeout_seconds: 1 })).error, /nothing is highlighted/);

    const els = (await mcp.call('get_interactive_elements')).value;
    const input = els.find((e) => e.label === 'Your name');
    const shown = await mcp.call('highlight', { element_index: input.i, note: 'Type your name here', step: 1 });
    assert.equal(shown.error, null, 'read-only access may guide');
    assert.equal(shown.value.highlighted, 'Your name');
    assert.equal(await pageEval(b, prefix, '!!document.querySelector("meridian-guide")'), true, 'the overlay is on the page');
    // Nothing done yet.
    assert.equal((await mcp.call('wait_for_user', { timeout_seconds: 1 })).value.did, 'nothing yet');
    // The person clicks the field (a real click on the page) while the agent waits.
    const waiting = mcp.call('wait_for_user', { timeout_seconds: 20 });
    await sleep(500);
    const [x, y] = await pageEval(b, prefix, '(() => { const r = document.getElementById("name").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()');
    for (const type of ['mousePressed', 'mouseReleased']) await inPage(b, prefix, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    assert.equal((await waiting).value.did, 'clicked');
    // The next step replaces it; the page still works under the overlay.
    assert.equal((await mcp.call('highlight', { text: 'Say hello', note: 'Then press this', step: 2 })).value.marks, 1);
    assert.equal((await mcp.call('clear_highlights')).value.cleared, 1);
    assert.match((await mcp.call('wait_for_user', { timeout_seconds: 1 })).error, /nothing is highlighted/);
    assert.match((await mcp.call('highlight', { selector: '#nothing-here', note: 'x' })).error, /not found/);
  } finally {
    mcp.close(); await b.close(); s.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// Needs the network: Chromium's language model and Google Translate.
test('translate: the site controls translate a Georgian page to English and back; so does translate_page', async (t) => {
  try { await fetch('https://translate.googleapis.com/translate_a/l?client=chrome', { signal: AbortSignal.timeout(4000) }); } catch { return t.skip('offline'); }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html lang="ka"><title>გადასახადები</title><h1>გადასახადის გადახდა</h1>
      <p>ამ გვერდზე შეგიძლიათ გადაიხადოთ ქონების გადასახადი. შეიყვანეთ თქვენი პირადი ნომერი და დააჭირეთ ღილაკს.</p>
      <p>საქართველოს შემოსავლების სამსახური გთავაზობთ ელექტრონულ მომსახურებას ყველა გადამხდელისთვის.</p>
      <button>გადახდა</button></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/tax`;
  const profile = profileWith({ agent_access: 'read' });
  // Lets Chromium fetch its language detection model, as it does for people.
  const b = await launch([url], { profile, args: ['--disable-features=OptimizationGuideOnDeviceModel'] });
  const mcp = bridge(profile);
  const SC = 'app.$.siteControl.shadowRoot';
  const info = async () => (await b.eval(`app.$.tabstrip.handler_.getSiteInfo()`)).info;
  const translated = () => pageEval(b, url, 'document.documentElement.className.includes("translated")');
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 40 && (await info()).pageLanguage !== 'ka'; i++) await sleep(500);
    assert.equal((await info()).pageLanguage, 'ka');
    await b.click('app.$.locationIconButton');
    await b.waitFor(`app.$.siteControl.open && !!${SC}.getElementById('translateRow')`);
    assert.match(await b.eval(`${SC}.getElementById('translateRow').textContent`), /Translate to English[\s\S]*The page is in Georgian/);
    await b.click(`${SC}.getElementById('translateRow')`);
    await b.waitFor(`${SC}.getElementById('translateRow')?.textContent.includes('From Georgian')`, 20000);
    for (let i = 0; i < 40 && !(await translated()); i++) await sleep(250);
    assert.equal(await translated(), true, 'the page shows the translation');
    await b.click(`${SC}.getElementById('translateRow')`);
    await b.waitFor(`${SC}.getElementById('translateRow')?.textContent.includes('The page is in Georgian')`, 10000);
    assert.equal(await translated(), false, 'back to the original');
    await b.eval(`${SC}.getElementById('shield').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}))`);

    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const r = await mcp.call('translate_page', { to: 'en' });
    assert.equal(r.error, null);
    assert.deepEqual(r.value, { translated_to: 'en', from: 'ka' });
    assert.match((await mcp.call('read_page')).value.text, /tax/i, 'the agent reads it in English');
    assert.deepEqual((await mcp.call('translate_page', { original: true })).value, { shown: 'original' });
  } finally {
    mcp.close(); await b.close(); server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// A background tab Chromium froze (as it does to save power) answered an agent only once the person
// looked at it, and meanwhile every other tool waited too: wait_for, then search_tabs, hung for 15
// minutes (a report from the promotion session, 19.11.2026, on x.com). Now the agent's tab is woken
// and kept awake, a page that doesn't answer is an error after 20 s, and calls don't wait in line.
test('a frozen background tab answers the agent; a page that never answers is an error; other tools don’t wait', async () => {
  const s = await site();
  // Another site (another renderer) whose page locks up its main thread.
  const busy = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Busy</title><p id=x>x</p><script>setTimeout(() => { for (;;) {} }, 300)</script>'); });
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const profile = profileWith({ agent_access: 'full' });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    // A tab in the background, then frozen the way Chromium freezes one.
    const { tab_id } = (await mcp.call('open_tab', { url: s.url('/form') })).value;
    const page = await b.page(s.url('/form'));
    await page.waitFor(`!!document.getElementById('name')`);
    await page.cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    await sleep(300);
    const t0 = Date.now();
    const found = await mcp.call('wait_for', { tab_id, selector: '#name', timeout_ms: 10000 });
    assert.deepEqual(found.value, { found: true }, `the frozen tab answered: ${JSON.stringify(found)}`);
    assert.ok(Date.now() - t0 < 8000, `in ${Date.now() - t0} ms`);

    // A page that never answers: an error after 20 s, and meanwhile other tools answer at once.
    const stuck = (await mcp.call('open_tab', { url: `http://localhost:${busy.address().port}/` })).value;
    await sleep(1500);
    const t1 = Date.now();
    const reading = mcp.call('read_page', { tab_id: stuck.tab_id });
    await sleep(300);
    const t2 = Date.now();
    const list = await mcp.call('search_tabs', { query: 'Form' });
    assert.ok(!list.error, list.error);
    assert.ok(Date.now() - t2 < 3000, `search_tabs didn't wait for read_page: ${Date.now() - t2} ms`);
    const read = await reading;
    assert.match(read.error || '', /didn't answer within 20 seconds/, JSON.stringify(read).slice(0, 300));
    assert.ok(Date.now() - t1 < 30000, `read_page gave up in ${Date.now() - t1} ms`);
  } finally { mcp.close(); await b.close(); s.server.close(); busy.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// A covered or minimized window: the tab the agent works in is drawn and "visible" to its page
// (screenshots, lists that draw on scroll, date pickers); some time after its last call, hidden again.
test('the agent\'s tab in a minimized window is visible and drawn while the agent works in it', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_allow_js: true });
  const b = await launch([s.url('/')], { profile, args: ['--meridian-test-agent-awake-seconds=6'] });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const { tab_id } = (await mcp.call('open_tab', { url: s.url('/form') })).value;
    const page = await b.page(s.url('/form'));
    await page.waitFor(`!!document.getElementById('name')`);
    // The window minimized.
    const { windowId } = await page.cdp.send('Browser.getWindowForTarget');
    await page.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await sleep(1500);
    const js = async (code) => { const r = await mcp.call('run_javascript', { tab_id, code }); assert.ok(!r.error, r.error); return r.value; };
    assert.equal(await js('document.visibilityState'), 'visible');
    const frames = await js('return await new Promise((r) => { let n = 0; const f = () => (++n < 5 ? requestAnimationFrame(f) : r(n)); requestAnimationFrame(f); setTimeout(() => r(n), 3000); })');
    assert.equal(frames, 5, 'requestAnimationFrame ticks');
    // A screenshot of it: one frame of a video capture (as Chrome's tab previews). Only with a real
    // screen: in background mode (windows see-through) nothing draws a tab that isn't shown.
    if (FOREGROUND) {
      const shot = await mcp.call('screenshot', { tab_id });
      assert.ok(!shot.error, `the screenshot: ${shot.error}`);
    }
    // After the agent stops: hidden again.
    await page.waitFor(`document.visibilityState === 'hidden'`, 20000);
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// A background tab the agent is working in reads as visible to its page, but isn't on the screen:
// its screenshot is still a frame of that tab (it used to fail with "couldn't capture the tab").
test('a screenshot of a background tab the agent has just worked in', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_allow_js: true });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const { tab_id } = (await mcp.call('open_tab', { url: s.url('/form') })).value;
    const r = await mcp.call('run_javascript', { tab_id, code: 'await new Promise((r) => setTimeout(r, 800)); return document.visibilityState' });
    assert.equal(r.value, 'visible');
    const shot = await mcp.call('screenshot', { tab_id });
    assert.ok(!shot.error, `the screenshot: ${shot.error}`);
    assert.ok(shot.image?.data?.length > 1000, 'a real picture');
  } finally { mcp.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// The page's own dialogs: an agent sees them (list_tabs pending_dialog), gets an error at once from
// a tab whose page waits for one (it used to hang), and answers them with handle_dialog: alert,
// confirm (OK / Cancel), prompt (with its text), "Leave site?" (stay / leave), and one in a tab in
// the background (a report from the promotion session, 19.11.2026).
test('page dialogs: pending_dialog in list_tabs, an error instead of a hang, handle_dialog answers each', async () => {
  const pages = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/dialogs') res.end('<title>Dialogs</title><textarea id=t></textarea><script>addEventListener("beforeunload", (e) => { if (document.getElementById("t").value) { e.preventDefault(); e.returnValue = ""; } });</script>');
    else res.end('<title>Elsewhere</title><p>Elsewhere</p>');
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${pages.address().port}${p}`;
  const profile = profileWith({ agent_access: 'full' });
  const b = await launch([url('/dialogs')], { profile });
  const mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const page = await b.page(url('/dialogs'));
    const tabs = async () => (await mcp.call('list_tabs')).value;
    const tabId = (await tabs()).find((t) => t.url === url('/dialogs')).id;
    const dialogOf = async () => (await tabs()).find((t) => t.id === tabId)?.pending_dialog;
    const waitDialog = async (type) => { for (let i = 0; i < 40; i++) { const d = await dialogOf(); if (d?.type === type) return d; await sleep(150); } throw new Error(`no ${type} dialog`); };
    // The page opens one (from a timer, as pages do).
    const open = (js) => page.cdp.send('Runtime.evaluate', { expression: `setTimeout(() => { ${js} }, 0); 1` });
    const title = () => page.eval('document.title');

    // alert: seen, and the tab answers nothing else meanwhile: an error at once, not a hang.
    await open(`alert('Saved!'); document.title = 'after alert'`);
    const alert = await waitDialog('alert');
    assert.equal(alert.message, 'Saved!');
    assert.deepEqual(alert.buttons, ['OK (accept)']);
    const t0 = Date.now();
    const blocked = await mcp.call('read_page', { tab_id: tabId });
    assert.match(blocked.error || '', /open alert dialog: "Saved!".*handle_dialog/);
    assert.ok(Date.now() - t0 < 3000, `at once: ${Date.now() - t0} ms`);
    assert.deepEqual((await mcp.call('handle_dialog', { tab_id: tabId, action: 'accept' })).value, { handled: true, type: 'alert', accepted: true });
    await page.waitFor(`document.title === 'after alert'`);
    assert.equal(await dialogOf(), undefined);

    // confirm: Cancel, then OK.
    await open(`document.title = 'confirm:' + confirm('Delete it?')`);
    assert.equal((await waitDialog('confirm')).message, 'Delete it?');
    await mcp.call('handle_dialog', { tab_id: tabId, action: 'dismiss' });
    await page.waitFor(`document.title === 'confirm:false'`);
    await open(`document.title = 'confirm:' + confirm('Delete it?')`);
    await waitDialog('confirm');
    await mcp.call('handle_dialog', { tab_id: tabId, action: 'accept' });
    await page.waitFor(`document.title === 'confirm:true'`);

    // prompt: with the agent's text.
    await open(`document.title = 'prompt:' + prompt('Your name?', 'Anon')`);
    const p = await waitDialog('prompt');
    assert.equal(p.default_text, 'Anon');
    assert.equal((await mcp.call('handle_dialog', { tab_id: tabId, action: 'accept', prompt_text: 'Ada' })).value.text, 'Ada');
    await page.waitFor(`document.title === 'prompt:Ada'`);

    // "Leave site?": unsaved text (typed by a person, so the page may ask), then the agent navigates.
    await page.eval(`document.getElementById('t').focus(), true`);
    await page.cdp.send('Input.insertText', { text: 'a draft' });
    const going = mcp.call('navigate', { tab_id: tabId, url: url('/elsewhere') });
    const leave = await waitDialog('beforeunload');
    assert.deepEqual(leave.buttons, ['Leave (accept)', 'Cancel (dismiss)']);
    await mcp.call('handle_dialog', { tab_id: tabId, action: 'dismiss' });
    await going;
    await sleep(500);
    assert.equal((await tabs()).find((t) => t.id === tabId).url, url('/dialogs'), 'stayed');
    const again = mcp.call('navigate', { tab_id: tabId, url: url('/elsewhere') });
    await waitDialog('beforeunload');
    await mcp.call('handle_dialog', { tab_id: tabId, action: 'accept' });
    await again;
    for (let i = 0; i < 40 && (await tabs()).find((t) => t.id === tabId).url !== url('/elsewhere'); i++) await sleep(150);
    assert.equal((await tabs()).find((t) => t.id === tabId).url, url('/elsewhere'), 'left');

    // In a tab in the background: the dialog waits there; the agent answers it all the same.
    const front = (await mcp.call('open_tab', { url: url('/front'), activate: true })).value;
    assert.ok(front.tab_id);
    await page.cdp.send('Runtime.evaluate', { expression: `setTimeout(() => { document.title = 'bg:' + prompt('Code?', '1234') }, 0); 1` });
    await waitDialog('prompt');
    assert.equal((await mcp.call('handle_dialog', { tab_id: tabId, action: 'accept' })).value.text, '1234');
    await page.waitFor(`document.title === 'bg:1234'`);
    // No dialog: said so.
    assert.match((await mcp.call('handle_dialog', { tab_id: tabId, action: 'accept' })).error || '', /no open dialog/);
  } finally { mcp.close(); await b.close(); pages.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// A connected agent before the person decided: one question in the browser, no trip to Settings.
test('an agent connected earlier asks once: Allow means it asks before each action, its call goes through; Deny closes the door', async () => {
  const allowed = profileWith({});
  const b = await launch(['about:blank'], { profile: allowed });
  const mcp = bridge(allowed);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(allowed, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'Claude Desktop' } });
    const first = mcp.call('list_tabs');
    const second = mcp.call('list_tabs');
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    assert.match(await b.eval(`${AG}.querySelector('#ask .summary').textContent`), /before each action[\s\S]*signed in[\s\S]*can't verify/);
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    assert.equal((await first).error, null);
    assert.equal((await second).error, null, 'one question for both calls');
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentAccess === 'ask')`);
    assert.equal((await mcp.call('list_tabs')).error, null);
    assert.equal(await b.eval(`!!${AG}.getElementById('ask')`), false, 'reading needs no question');
    // A change is still put to the person.
    const change = mcp.call('open_tab', { url: 'about:blank' });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    await sleep(700);
    await b.click(`${AG}.getElementById('deny')`);
    assert.match((await change).error, /declined/);
  } finally { mcp.close(); await b.close(); fs.rmSync(allowed, { recursive: true, force: true }); }

  const denied = profileWith({});
  const b2 = await launch(['about:blank'], { profile: denied });
  const mcp2 = bridge(denied);
  try {
    await b2.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(denied, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp2.request('initialize', {});
    const call = mcp2.call('list_tabs');
    await b2.waitFor(`!!${AG}.getElementById('ask')`);
    await sleep(700);
    await b2.click(`${AG}.getElementById('deny')`);
    assert.match((await call).error, /declined/);
    for (let i = 0; i < 60 && fs.existsSync(path.join(denied, 'Meridian Agent.json')); i++) await sleep(100);
    assert.equal(fs.existsSync(path.join(denied, 'Meridian Agent.json')), false, 'nothing listens after a no');
    assert.equal(await b2.eval(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentAccess)`), 'off');
  } finally { mcp2.close(); await b2.close(); fs.rmSync(denied, { recursive: true, force: true }); }
});

test('a space with its own profile doesn\'t take over the agent: Settings of the browser decide', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'full', agent_access_decided: true, agent_allow_js: true });
  const b = await launch([s.url('/form')], { profile });
  const T = 'app.$.tabstrip';
  const info = path.join(profile, 'Meridian Agent.json');
  let mcp;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(info); i++) await sleep(100);
    const first = JSON.parse(fs.readFileSync(info, 'utf8')).socket;
    const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
    const { spaceId } = await b.eval(`${T}.handler_.createSpace('Client', '', '', '')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(spaceId)}, ${JSON.stringify(profileId)})`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(spaceId)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(spaceId)}`);
    await b.eval(`${T}.openUrl(${JSON.stringify(s.url('/form?work'))})`);
    await b.page(s.url('/form?work'));
    await sleep(500);
    assert.equal(JSON.parse(fs.readFileSync(info, 'utf8')).socket, first, 'the same agent server');

    mcp = bridge(profile);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    assert.equal((await mcp.call('run_javascript', { code: '1 + 1' })).value, 2);

    // Turned off from a window showing that space: nothing listens any more.
    await b.eval(`${T}.handler_.getSettings().then((r) => ${T}.handler_.setSettings({ ...r.settings, agentAccess: 'off' }))`);
    for (let i = 0; i < 60 && fs.existsSync(info); i++) await sleep(100);
    assert.equal(fs.existsSync(info), false, 'nothing listens after Off');
  } finally { mcp?.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// A profile folder longer than a unix socket path may be (tests' temp folders, a long TMPDIR):
// the bridge used to say "Meridian is not running". The socket now goes in a short private folder.
test('a long profile path: the socket is short and private, and the bridge connects', { skip: process.platform === 'win32' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const profile = path.join(base, 'a-profile-folder-with-a-really-long-name-'.repeat(3));
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  assert.ok(profile.length > 120);
  const b = await launch(['about:blank'], { profile });
  const mcp = bridge(profile);
  try {
    const endpoint = path.join(profile, 'Meridian Agent.json');
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await sleep(100);
    const socket = JSON.parse(fs.readFileSync(endpoint, 'utf8')).socket;
    assert.ok(socket.length < 100, socket);
    assert.equal(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700, 'its folder is private');
    assert.equal(fs.statSync(path.dirname(socket)).uid, process.getuid());
    await mcp.request('initialize', { clientInfo: { name: 'long-path' } });
    const tabs = await mcp.call('list_tabs');
    assert.equal(tabs.error, null, 'the bridge reached Meridian');
  } finally { mcp.close(); await b.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

// A moodboard (six links) used to take a dozen "Allow"s. "Allow for this task" covers this agent's
// connection on every site, signed-in ones too (the card says so), until it disconnects, Stop, or 30 minutes.
test('ask: Allow for this task stops the questions for this connection only; Stop and a reconnect bring them back', async () => {
  const s = await site();
  const profile = profileWith({ agent_access: 'ask' });
  const b = await launch([s.url('/')], { profile });
  const mcp = bridge(profile);
  let other;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { clientInfo: { name: 'Claude' } });
    const first = mcp.call('open_tab', { url: s.url('/form') });
    await b.waitFor(`!!${AG}.getElementById('task')`);
    const card = await b.eval(`${AG}.querySelector('.card').textContent.replace(/\\s+/g, ' ')`);
    assert.match(card, /Claude wants to/);
    assert.match(card, /Allow for this task lets Claude act without asking on every site, including ones you’re signed in to, until it disconnects or for 30 minutes/);
    assert.deepEqual(await b.eval(`[...${AG}.querySelectorAll('.actions button')].map((x) => x.textContent.trim())`), ['Always allow', 'Deny', 'Allow once', 'Allow for this task']);
    assert.equal(await b.eval(`${AG}.activeElement?.id`), 'deny', 'the keyboard starts on Deny');
    if (process.env.MERIDIAN_SHOTS) {
      const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.MERIDIAN_SHOTS, 'ask-card.png'), Buffer.from(data, 'base64'));
    }
    // Too soon: a click meant for the page doesn't answer.
    await b.click(`${AG}.getElementById('task')`);
    assert.equal(await b.eval(`!!${AG}.getElementById('task')`), true);
    await sleep(700);
    await b.click(`${AG}.getElementById('task')`);
    assert.equal((await first).value.title, 'Form');
    // The rest of the task: no questions, on any site.
    for (const p of ['/', '/filter', '/login']) {
      const r = await mcp.call('open_tab', { url: s.url(p) });
      assert.equal(r.error, null, p);
      assert.equal(await b.eval(`!!${AG}.getElementById('ask')`), false, `not asked for ${p}`);
    }
    assert.equal((await b.eval(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings)`)).agentAccess, 'ask', 'access stays at ask');

    // Another connection (the agent restarted, or another app with the same name) is asked.
    other = bridge(profile);
    await other.request('initialize', { clientInfo: { name: 'Claude' } });
    const again = other.call('open_tab', { url: s.url('/form') });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    await sleep(700);
    await b.click(`${AG}.getElementById('allow')`);
    assert.equal((await again).error, null);

    // Stop ends the task: the first connection is asked again.
    await b.eval(`app.$.agent.onStopClick_()`);
    await b.eval(`app.$.agent.onResumeClick_()`);
    const after = mcp.call('open_tab', { url: s.url('/') });
    await b.waitFor(`!!${AG}.getElementById('ask')`);
    await b.click(`${AG}.getElementById('deny')`);
    assert.match((await after).error, /declined/);
  } finally { mcp.close(); other?.close(); await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
