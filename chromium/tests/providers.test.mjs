// Other AIs answering Ask: a local model server (Ollama), a cloud key (OpenAI) and an agent CLI
// (Codex), all stand-ins. The browser sees only the fake CLI directory, never the developer's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const AK = 'app.$.ask.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const GOOD = 'sk-proj-good000000000000000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Agent CLIs answer Ask only inside a sandbox that keeps them out of credentials and other
// browsers' data; Meridian has one on macOS only (SandboxedArgv), so elsewhere they don't run.
const NO_CLI = process.platform === 'win32' && 'agent CLIs run only in a sandbox, which Windows doesn’t have yet';

function serve(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      requests.push({ url: req.url, headers: req.headers, body: json });
      handler(req, res, json);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

// Ollama: one model; the answer echoes the last line of the prompt.
const ollama = () => serve((req, res, json) => {
  if (req.url === '/api/tags') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'llama3.2' }] })); }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const question = json.messages[json.messages.length - 1].content.split('\n').pop();
  for (const piece of ['Ollama ', `heard: ${question}`]) res.write(JSON.stringify({ message: { role: 'assistant', content: piece }, done: false }) + '\n');
  res.end(JSON.stringify({ done: true }) + '\n');
});

// OpenAI-compatible cloud API under /<provider>/.
const cloud = () => serve((req, res, json) => {
  if (req.headers.authorization !== `Bearer ${GOOD}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  }
  if (req.url === '/openai/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: ['gpt-4o-mini', 'gpt-5.2-mini', 'gpt-5.2', 'text-embedding-3-large'].map((id) => ({ id })) }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const piece of ['Cloud ', `(${json.model}) says hi`]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});

// A stand-in `codex`: records argv and stdin, answers in Codex's JSON lines.
function fakeCodex(dir) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'codex', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
if (args[0] === 'login') {
  console.log('Logged in using ChatGPT');
} else {
  const n = fs.readdirSync(log).filter((f) => f.includes('args')).length;
  fs.writeFileSync(path.join(log, n + '.args'), args.map((a) => a + '\\n').join(''));
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { stdin += d; });
  process.stdin.on('end', () => {
    fs.writeFileSync(path.join(log, n + '.stdin'), stdin);
    fs.writeFileSync(path.join(log, n + '.pid'), String(process.pid));
    console.log('{"type":"thread.started","thread_id":"t-1"}');
    const answer = () => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex answer ' + n } }));
    if (stdin.includes('slow')) setTimeout(answer, 30000); else answer();
  });
}
`);
  return log;
}

test('other AIs: Ollama, a cloud key with a model picker, and Codex (sessions, Stop)', async () => {
  const local = await ollama();
  const api = await cloud();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeCodex(bin);
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`, `--meridian-ollama-url=${local.base}`, `--meridian-cloud-base-url=${api.base}`] });
  const settings = () => b.eval(`${H}.getSettings().then(({settings}) => settings)`);
  const openAi = async () => {
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    // Not a click at its place: Settings may still be coming in, and a click on the overlay
    // behind it closes Settings.
    await b.eval(`${ST}.querySelector('[data-id="ai"]').click()`);
    await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('aiRows')`);
  };
  const ask = async (text, expect) => {
    if (!(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    const before = await b.eval(`${AK}.querySelectorAll('.msg.assistant').length`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); })()`);
    if (expect) await b.waitFor(`${AK}.querySelectorAll('.msg.assistant').length > ${before} && [...${AK}.querySelectorAll('.msg.assistant')].pop().textContent.includes(${JSON.stringify(expect)})`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Nothing set up yet: the panel says so.
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`!!${AK}.getElementById('addKey')`);
    await b.eval('app.$.tabstrip.runCommand(14, 0)');

    // Ollama is running with a model: Ready. Picking it makes it answer.
    await openAi();
    await b.waitFor(`${ST}.getElementById('ai-ollama')?.textContent.includes('Ready')`);
    assert.match(await b.eval(`${ST}.getElementById('ai-ollama').textContent`), /llama3\.2/);
    assert.equal(await b.eval(`!!${ST}.getElementById('ai-cursor')`), false, 'agents that aren’t on this computer wait under “Add another agent”');
    await b.click(`${ST}.getElementById('ai-ollama')`);
    await b.waitFor(`${ST}.getElementById('ai-ollama').classList.contains('on')`);
    assert.equal((await settings()).aiProvider, 'ollama');
    await b.eval('app.$.settings.hide()');
    await ask('hello there', 'Ollama heard: hello there');
    assert.equal(await b.eval(`${AK}.getElementById('who').textContent`), 'Ollama');
    const chat = local.requests.find((r) => r.url === '/api/chat');
    assert.equal(chat.body.model, 'llama3.2');
    assert.match(chat.body.messages[0].content, /<meridian_guide>/);

    // A cloud key: a wrong one is refused, the right one is recognised as OpenAI and answers.
    await openAi();
    await b.eval(`${ST}.getElementById('aiKey').value = 'sk-proj-wrong00000000000000000000000'`);
    await b.eval(`${ST}.getElementById('saveKey').scrollIntoView({ block: 'center' })`);
    await b.click(`${ST}.getElementById('saveKey')`);
    await b.waitFor(`${ST}.getElementById('keyMessage').textContent.includes('didn’t accept')`);
    await b.eval(`${ST}.getElementById('aiKey').value = ${JSON.stringify(GOOD)}`);
    await b.eval(`${ST}.getElementById('saveKey').scrollIntoView({ block: 'center' })`);
    await b.click(`${ST}.getElementById('saveKey')`);
    await b.waitFor(`${ST}.getElementById('keyMessage').textContent.includes('ChatGPT answers')`);
    assert.equal((await settings()).aiProvider, 'openai');
    await b.waitFor(`${ST}.querySelector('select.model[data-id="openai"]')?.options.length === 4`);
    assert.match(await b.eval(`${ST}.querySelector('select.model[data-id="openai"]').options[0].textContent`), /gpt-5\.2-mini/);
    await b.eval(`(() => { const s = ${ST}.querySelector('select.model[data-id="openai"]'); s.value = 'gpt-5.2'; s.dispatchEvent(new Event('change')); })()`);
    await b.eval('app.$.settings.hide()');
    await b.eval(`${AK}.getElementById('new').click()`);
    await ask('and you?', 'Cloud (gpt-5.2) says hi');
    const sent = api.requests.filter((r) => r.url === '/openai/chat/completions').pop();
    assert.equal(sent.body.stream, true);
    assert.equal(sent.body.messages[1].content, 'and you?');

    // (Not on Windows: see NO_CLI.)
    if (!NO_CLI) {
      // Codex, simply there once it's on this computer: signed in (from `codex login status`),
      // read-only sandbox, the prompt on stdin; the next turn resumes its session with only the new
      // message.
      await openAi();
      await b.waitFor(`${ST}.getElementById('ai-codex')?.textContent.includes('Ready')`);
      // Not a click at its place: the rows above it move as cloud models arrive.
      await b.eval(`${ST}.getElementById('ai-codex').click()`);
      await b.waitFor(`${ST}.getElementById('ai-codex').classList.contains('on')`);
      await b.eval('app.$.settings.hide()');
      await b.eval(`${AK}.getElementById('new').click()`);
      await ask('first question', 'Codex answer 0');
      const args0 = fs.readFileSync(path.join(log, '0.args'), 'utf8').split('\n');
      assert.equal(args0[0], 'exec');
      assert.ok(args0.includes('sandbox_mode="read-only"'));
      assert.match(fs.readFileSync(path.join(log, '0.stdin'), 'utf8'), /<meridian_guide>[\s\S]*first question$/);
      await ask('second question', 'Codex answer 1');
      const args1 = fs.readFileSync(path.join(log, '1.args'), 'utf8').split('\n');
      assert.deepEqual(args1.slice(0, 2), ['exec', 'resume']);
      assert.ok(args1.includes('t-1'));
      assert.equal(fs.readFileSync(path.join(log, '1.stdin'), 'utf8'), 'second question');

      // Stop kills the CLI.
      await ask('a slow one');
      await b.waitFor(`${AK}.querySelector('#stop') !== null`);
      for (let i = 0; i < 50 && !fs.existsSync(path.join(log, '2.pid')); i++) await sleep(100);
      const pid = Number(fs.readFileSync(path.join(log, '2.pid'), 'utf8'));
      await b.eval(`${AK}.getElementById('stop').click()`);
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) { await sleep(100); try { process.kill(pid, 0); } catch { alive = false; } }
      assert.equal(alive, false, 'the CLI was killed');
    }

    // Removing the key: the row goes, and the key never sat in Preferences as plain text.
    await openAi();
    await b.waitFor(`!!${ST}.querySelector('button[data-id="openai"]')`);
    await b.eval(`${ST}.querySelector('button[data-id="openai"]').scrollIntoView({ block: 'center' })`);
    await b.click(`${ST}.querySelector('button[data-id="openai"]')`);
    await b.waitFor(`!${ST}.getElementById('ai-openai')`);
    // Chromium writes Preferences up to 10 s after a change.
    const prefsFile = path.join(b.profile, 'Default', 'Preferences');
    for (let i = 0; i < 150 && !fs.existsSync(prefsFile); i++) await sleep(100);
    const prefs = fs.readFileSync(prefsFile, 'utf8');
    assert.ok(!prefs.includes(GOOD));
  } finally {
    await b.close(); local.server.close(); api.server.close();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// A report (21.11.2026): OpenCode picked for Ask answered "Unrecognized flag: --dir in command
// opencode run" (an OpenCode that doesn't know --dir), and the error couldn't even be selected to
// copy. The stand-in refuses --dir like that OpenCode; the answer and the error are selectable.
test('OpenCode answers Ask without --dir; what Ask shows can be selected and copied', { skip: NO_CLI }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  standIn(bin, 'opencode', `const args = process.argv.slice(2);
if (args[0] === 'auth') {
  console.log('1 credentials');
} else if (args.includes('--dir')) {
  console.error('Unrecognized flag: --dir in command opencode run');
  process.exitCode = 1;
} else {
  process.stdin.resume();
  process.stdin.on('end', () => console.log(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'OpenCode says the page is blank' } })));
}
`);
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('aiRows')`);
    await b.click(`${ST}.getElementById('otherAgents')`);
    await b.waitFor(`${ST}.getElementById('ai-opencode')?.textContent.includes('Ready')`, 15000);
    await b.eval(`${ST}.getElementById('ai-opencode').click()`);
    await b.waitFor(`${ST}.getElementById('ai-opencode').classList.contains('on')`);
    await b.eval('app.$.settings.hide()');
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'What is this page?'; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent.includes('OpenCode says the page is blank')`, 15000);
    // Text in the conversation can be selected (the browser's frame around it can't).
    for (const sel of ['.msg.user .bubble', '.msg.assistant .answer']) {
      assert.equal(await b.eval(`getComputedStyle(${AK}.querySelector(${JSON.stringify(sel)})).userSelect`), 'text', sel);
    }
    // Selected with the mouse, as a person does: a double-click on a word of the question.
    const at = await b.eval(`(() => { const r = ${AK}.querySelector('.msg.user .bubble').getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await b.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    for (const type of ['mousePressed', 'mouseReleased']) await b.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 2 });
    assert.match(await b.eval(`String(${AK}.getSelection ? ${AK}.getSelection() : getSelection())`), /What/);
  } finally { await b.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});

// A report (24.11.2026): Ask with OpenCode 2.4.1 failed with `Agent not found: "meridian"`. OpenCode
// 2.x `run` joins its background service when one is up, and that service never saw Meridian's
// config: no agent, and none of its "deny everything" either. --standalone gives the run a private
// server. OpenCode 1.x doesn't know that flag. Both read the person's global config in a closed home.
async function askOpenCode(version) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-oc-')));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const log = path.join(root, 'args.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.mkdirSync(path.join(home, 'dotfiles'));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'PRIVATE');
  fs.writeFileSync(path.join(home, 'notes.txt'), 'PERSONAL');
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), '// mine\n{"model":"jsonc-model"}');
  // Kept in a dotfiles repository, as many people do.
  fs.writeFileSync(path.join(home, 'dotfiles', 'opencode.json'), '{"model":"json-model"}');
  fs.symlinkSync(path.join(home, 'dotfiles', 'opencode.json'), path.join(home, '.config', 'opencode', 'opencode.json'));
  const v2 = version === 2;
  standIn(bin, 'opencode', `const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2); const home = process.env.HOME;
const can = (...p) => { try { return fs.readFileSync(path.join(home, ...p), 'utf8').includes('model') ? 'read' : 'read'; } catch { return 'blocked'; } };
// A Mac with no ~/.local yet: OpenCode makes its folders at start.
const canWrite = () => { try { const d = path.join(home, '.local/state/opencode'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x'), '1'); return 'written'; } catch { return 'blocked'; } };
if (args[0] === 'auth') { console.log('1 credentials'); }
else if (args.includes('--help')) { console.log('opencode run [message..]\\n  --format\\n  --agent\\n  --session${v2 ? '\\n  --standalone  Run with a private server' : ''}'); }
else {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  if (${!v2} && args.includes('--standalone')) { console.error('Unrecognized flag: --standalone in command opencode run'); process.exit(1); }
  if (${v2} && !args.includes('--standalone')) { console.log(JSON.stringify({ type: 'error', sessionID: 's', error: { type: 'unknown', message: 'Agent not found: "meridian"' } })); process.exit(1); }
  process.stdin.resume();
  process.stdin.on('end', () => console.log(JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { text: 'ANSWER jsonc=' + can('.config/opencode/opencode.jsonc') + ' json=' + can('.config/opencode/opencode.json') + ' ssh=' + can('.ssh/id_test') + ' notes=' + can('notes.txt') + ' state=' + canWrite() } })));
}
`);
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`, `--meridian-test-home=${home}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('aiRows')`);
    await b.click(`${ST}.getElementById('otherAgents')`);
    await b.waitFor(`${ST}.getElementById('ai-opencode')?.textContent.includes('Ready')`, 15000);
    await b.eval(`${ST}.getElementById('ai-opencode').click()`);
    await b.waitFor(`${ST}.getElementById('ai-opencode').classList.contains('on')`);
    await b.eval('app.$.settings.hide()');
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'What is this page?'; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`/ANSWER|Agent not found|Unrecognized/.test([...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent || '')`, 20000)
      .catch(async (e) => { throw new Error(`${e.message}\nAsk shows: ${await b.eval(`${AK}.textContent.replace(/\\s+/g, ' ').slice(-400)`)}`); });
    const said = await b.eval(`[...${AK}.querySelectorAll('.msg.assistant')].pop().textContent`);
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return { said, runs };
  } finally { await b.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

for (const version of [1, 2]) {
  test(`OpenCode ${version}.x answers Ask, on its own server if it has one, reading only its global config`, { skip: process.platform !== 'darwin' && 'needs the macOS sandbox' }, async () => {
    const { said, runs } = await askOpenCode(version);
    assert.match(said, /ANSWER/);
    assert.match(said, /jsonc=read/, 'the global opencode.jsonc');
    assert.match(said, /json=read/, 'the global opencode.json, through its symlink');
    assert.match(said, /ssh=blocked/);
    assert.match(said, /notes=blocked/);
    assert.match(said, /state=written/, 'its own state folder, on a Mac without ~/.local');
    assert.equal(runs[0].includes('--standalone'), version === 2);
  });
}

test('LM Studio installed but off: Start server turns it on, then it answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-lms-'));
  const started = path.join(dir, 'started');
  // LM Studio's OpenAI-compatible server: off (refused) until `lms server start`.
  const lm = await serve((req, res, json) => {
    if (!fs.existsSync(started)) { res.writeHead(503); return res.end(); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'qwen3-4b' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const question = json.messages[json.messages.length - 1].content.split('\n').pop();
    for (const piece of ['LM Studio ', `heard: ${question}`]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const lms = standIn(dir, 'lms', `const args = process.argv.slice(2);
if (args[0] === 'server' && args[1] === 'start') require('fs').writeFileSync(${JSON.stringify(started)}, '');
`);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`, `--meridian-lmstudio-url=${lm.base}`, `--meridian-lms-path=${lms}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`${ST}.getElementById('ai-lmstudio')?.textContent.includes('Server off')`);
    await b.click(`${ST}.querySelector('#ai-lmstudio button[data-action="start"]')`);
    await b.waitFor(`${ST}.getElementById('aiMessage').textContent.includes('LM Studio is running')`);
    assert.ok(fs.existsSync(started), 'lms server start ran');
    assert.match(await b.eval(`${ST}.getElementById('ai-lmstudio').textContent`), /Ready/);
    await b.click(`${ST}.getElementById('ai-lmstudio')`);
    await b.waitFor(`${ST}.getElementById('ai-lmstudio').classList.contains('on')`);
    await b.eval('app.$.settings.hide()');
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'hi lm'; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent.includes('LM Studio heard: hi lm')`);
    assert.equal(lm.requests.find((r) => r.url === '/v1/chat/completions')?.body.model, 'qwen3-4b');
  } finally {
    await b.close(); lm.server.close();
    for (const d of [dir, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Where agent CLIs can't run (no sandbox: NO_CLI), they aren't offered: each says so and can't be
// picked; one picked before (an older setting, or synced from a Mac) answers Ask with that, never
// silence.
test('agent CLIs where they can’t run: “macOS only for now”, can’t be picked; one picked before says so in Ask', { skip: !NO_CLI && 'agent CLIs run here' }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fakeCodex(bin);
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`] });
  const settings = () => b.eval(`${H}.getSettings().then(({settings}) => settings)`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('aiRows')`);
    await b.click(`${ST}.getElementById('otherAgents')`);
    for (const id of ['codex', 'opencode', 'cursor', 'qwen', 'amp', 'goose', 'droid', 'copilot']) {
      await b.waitFor(`${ST}.getElementById('ai-${id}')?.textContent.includes('macOS only for now')`, 15000);
      assert.equal(await b.eval(`${ST}.getElementById('ai-${id}').hasAttribute('disabled')`), true, `${id} can't be picked`);
    }
    await b.eval(`${ST}.getElementById('ai-codex').click()`);
    await sleep(500);
    assert.notEqual((await settings()).aiProvider, 'codex');

    // Picked before: Ask says why, and where to pick another.
    await b.eval(`${H}.getSettings().then(({settings}) => ${H}.setSettings({...settings, aiProvider: 'codex', aiOtherAgents: true}))`);
    await b.eval('app.$.settings.hide()');
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'hello'; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`${AK}.textContent.includes('Codex answers Ask on macOS only for now; pick another AI in Settings › AI.')`, 15000);
  } finally { await b.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
