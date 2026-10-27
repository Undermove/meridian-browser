// Other AIs answering Ask: a local model server (Ollama), a cloud key (OpenAI) and an agent CLI
// (Codex), all stand-ins. The browser sees only the fake CLI directory, never the developer's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const AK = 'app.$.ask.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const GOOD = 'sk-proj-good000000000000000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const script = `#!/bin/sh
if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi
n=$(ls ${log} | grep -c args)
printf '%s\\n' "$@" > ${log}/$n.args
cat > ${log}/$n.stdin
echo $$ > ${log}/$n.pid
echo '{"type":"thread.started","thread_id":"t-1"}'
if grep -q slow ${log}/$n.stdin; then sleep 30; fi
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Codex answer '$n'"}}'
`;
  fs.writeFileSync(path.join(dir, 'codex'), script, { mode: 0o755 });
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
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('aiRows')`);
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
    assert.equal(await b.eval(`!!${ST}.getElementById('ai-codex')`), false, 'other agents stay hidden until turned on');
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
    await b.click(`${ST}.getElementById('saveKey')`);
    await b.waitFor(`${ST}.getElementById('keyMessage').textContent.includes('didn’t accept')`);
    await b.eval(`${ST}.getElementById('aiKey').value = ${JSON.stringify(GOOD)}`);
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

    // Codex, once "Other agents" is on: signed in (from `codex login status`), read-only sandbox,
    // the prompt on stdin; the next turn resumes its session with only the new message.
    await openAi();
    await b.click(`${ST}.getElementById('otherAgents')`);
    await b.waitFor(`${ST}.getElementById('ai-codex')?.textContent.includes('Ready')`);
    await b.click(`${ST}.getElementById('ai-codex')`);
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

    // Removing the key: the row goes, and the key never sat in Preferences as plain text.
    await openAi();
    await b.waitFor(`!!${ST}.querySelector('button[data-id="openai"]')`);
    await b.eval(`${ST}.querySelector('button[data-id="openai"]').scrollIntoView({ block: 'center' })`);
    await b.click(`${ST}.querySelector('button[data-id="openai"]')`);
    await b.waitFor(`!${ST}.getElementById('ai-openai')`);
    const prefs = fs.readFileSync(path.join(b.profile, 'Default', 'Preferences'), 'utf8');
    assert.ok(!prefs.includes(GOOD));
  } finally {
    await b.close(); local.server.close(); api.server.close();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
