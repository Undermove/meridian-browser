// The built-in AI against a stand-in Anthropic API (server-sent events like the real one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const KEY = 'sk-ant-test-000000000000000000000000';
const AK = 'app.$.ask.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      const json = JSON.parse(body || '{}');
      requests.push({ headers: req.headers, body: json });
      if (req.headers['x-api-key'] !== KEY) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      if (!json.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const last = json.messages[json.messages.length - 1];
      const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const question = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const toolResult = parts.find((p) => p.type === 'tool_result');
      send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      if (toolResult) {
        const tabs = JSON.parse(toolResult.content);
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `There are ${tabs.length} tabs.` } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' } });
      } else if (/use a tool/.test(question) && json.tools?.some((t) => t.name === 'list_tabs')) {
        send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Listing tabs.' } });
        send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig123' } });
        send('content_block_stop', { index: 0 });
        send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_tabs', input: {} } });
        send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{' } });
        send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '}' } });
        send('content_block_stop', { index: 1 });
        send('message_delta', { delta: { stop_reason: 'tool_use' } });
      } else if (/slow/.test(question)) {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (let i = 0; i < 40 && !res.destroyed; i++) {
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'word ' } });
          await sleep(250);
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' } });
      } else {
        const page = /<current_page url="[^"]*" title="([^"]*)">/.exec(question);
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        for (const piece of ['**Answer**: ', `page is ${page ? page[1] : 'none'}`, '\n\n- one\n- two']) {
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
        }
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' } });
      }
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

test('Ask (⌘J): key check, an answer about the page, a browser tool, Stop', async () => {
  const api = await fakeAnthropic();
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Home</title><p>Welcome</p>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  let b = await launch([`http://127.0.0.1:${site.address().port}/`], { profile, args: [`--meridian-ai-base-url=${api.base}`] });
  const H = 'app.$.tabstrip.handler_';
  const ask = async (text) => {
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); })()`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.match((await b.eval(`${H}.setAiKey('nope')`)).error, /sk-ant-/);
    assert.match((await b.eval(`${H}.setAiKey('sk-ant-wrong-00000000000000000000000')`)).error, /didn’t accept/);
    assert.deepEqual(await b.eval(`${H}.setAiKey(${JSON.stringify(KEY)})`), { ok: true, error: '' });
    assert.equal((await b.eval(`${H}.hasAiKey()`)).hasKey, true);

    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await ask('What is this page?');
    await b.waitFor(`${AK}.querySelector('.msg.assistant .answer')?.textContent.includes('page is Home')`);
    assert.equal(await b.eval(`${AK}.querySelector('.msg.assistant .answer b').textContent`), 'Answer');
    assert.equal(await b.eval(`${AK}.querySelectorAll('.msg.assistant .answer li').length`), 2);
    const first = api.requests.find((r) => r.body.stream);
    assert.equal(first.headers['anthropic-version'], '2026-10-21');
    assert.equal(first.body.model, 'claude-opus-5-5');
    assert.ok(first.body.tools.some((t) => t.name === 'click'), 'full access offers the browser tools');

    await ask('Please use a tool to count my tabs');
    await b.waitFor(`[...${AK}.querySelectorAll('.msg.assistant .answer')].some((a) => a.textContent.includes('There are 1 tabs.'))`);
    assert.match(await b.eval(`[...${AK}.querySelectorAll('.tools')].pop().textContent`), /list tabs/);
    // The thinking block went back untouched with the tool result.
    const followUp = api.requests.filter((r) => r.body.stream).pop().body.messages;
    const assistantTurn = followUp[followUp.length - 2];
    assert.equal(assistantTurn.content[0].signature, 'sig123');
    assert.equal(followUp[followUp.length - 1].content[0].tool_use_id, 'toolu_1');
    // Mission Control sees the chat and its browser tool call (never the prompt).
    const mission = JSON.parse((await b.eval(`${H}.getMissionState()`)).snapshotJson);
    const chat = mission.nodes.find((n) => n.kind === 'assistant');
    assert.equal(chat.label, '⌘J Assistant');
    assert.equal(chat.log.at(-1).name, 'list_tabs');
    assert.ok(!JSON.stringify(mission).includes('count my tabs'));

    // Ask in the command bar (⌘↵): a quick model, the answer right there.
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.eval('app.$.commandBar.show(true, "what is meridian")');
    await b.waitFor(`!!app.$.commandBar.shadowRoot.getElementById('ask')`);
    await b.eval(`app.$.commandBar.shadowRoot.getElementById('ask').click()`);
    await b.waitFor(`app.$.commandBar.shadowRoot.getElementById('answer')?.textContent.includes('page is none')`);
    assert.equal(api.requests.filter((r) => r.body.stream).pop().body.model, 'claude-haiku-5-5');
    await b.eval('app.$.commandBar.hide()');
    await b.waitFor('!app.$.commandBar.open');
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor('app.$.ask.open');

    await ask('a slow one');
    await b.waitFor(`!!${AK}.getElementById('stop')`);
    await sleep(600);
    await b.eval(`${AK}.getElementById('stop').click()`);
    await b.waitFor(`!!${AK}.getElementById('send')`);
    await b.quit();
    // The key is stored encrypted, not as text.
    assert.ok(!fs.readFileSync(path.join(profile, 'Default', 'Preferences'), 'utf8').includes(KEY));
    b = await launch([], { profile, args: [`--meridian-ai-base-url=${api.base}`] });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    assert.equal((await b.eval(`${H}.hasAiKey()`)).hasKey, true);
  } finally { await b.close(); api.server.close(); site.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
