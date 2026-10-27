// The Chat view (⌥⌘J): suggestions, a conversation, the list, and chats surviving a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const KEY = 'sk-ant-test-000000000000000000000000';
const CH = 'app.$.chat.shadowRoot';
const CHAT = 15;

function fakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push(json);
      if (!json.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"content":[],"stop_reason":"max_tokens"}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const last = json.messages[json.messages.length - 1];
      const parts = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
      const question = parts.map((p) => p.text).join(' ');
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: {} });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `Echo (${json.messages.length}): ${question.slice(0, 40)}` } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' } });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

test('Chat view: a conversation, the chat list, and chats after a restart', async () => {
  const api = await fakeAnthropic();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const args = [`--meridian-ai-base-url=${api.base}`];
  const lastAnswer = `[...${CH}.querySelectorAll('.msg.assistant .answer')].pop()?.textContent || ''`;
  const send = (b, text) => b.eval(`(() => { const i = ${CH}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${CH}.getElementById('send').click(); })()`);
  const ready = (b) => b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
  let b = await launch(['about:blank'], { profile, args });
  try {
    await ready(b);
    // Nothing set up: the view says so.
    await b.eval(`app.$.tabstrip.runCommand(${CHAT}, 0)`);
    await b.waitFor(`app.$.chat.shown && !!${CH}.getElementById('setup')`);
    await b.eval(`app.$.tabstrip.runCommand(${CHAT}, 0)`);
    await b.waitFor('!app.$.chat.shown');
    assert.equal((await b.eval(`app.$.tabstrip.handler_.setAiKey(${JSON.stringify(KEY)})`)).ok, true);

    await b.eval(`app.$.tabstrip.runCommand(${CHAT}, 0)`);
    await b.waitFor(`${CH}.querySelectorAll('.suggestion').length === 4`);
    assert.equal(await b.eval(`${CH}.getElementById('who').textContent`), 'Claude');
    await b.click(`[...${CH}.querySelectorAll('.suggestion')].find((s) => s.textContent.includes('Brainstorm'))`);
    await b.waitFor(`(${lastAnswer}).includes('Echo (1): Help me brainstorm')`);
    await b.waitFor(`${CH}.querySelectorAll('.chat-row').length === 1`);
    assert.match(await b.eval(`${CH}.querySelector('.chat-row.on').textContent`), /Help me brainstorm ideas/);

    await send(b, 'a garden');
    await b.waitFor(`(${lastAnswer}).includes('Echo (3): a garden')`);

    // A new chat, then back to the first one.
    await b.click(`${CH}.getElementById('new')`);
    await b.waitFor(`${CH}.querySelectorAll('.suggestion').length === 4`);
    await send(b, 'something else');
    await b.waitFor(`${CH}.querySelectorAll('.chat-row').length === 2`);
    await b.click(`[...${CH}.querySelectorAll('.chat-row')].find((r) => r.textContent.includes('brainstorm'))`);
    await b.waitFor(`${CH}.querySelectorAll('.msg').length === 4`);
    await b.quit();

    // After a restart: the chats are there, and the old one continues with its earlier turns.
    b = await launch(['about:blank'], { profile, args });
    await ready(b);
    await b.eval(`app.$.tabstrip.runCommand(${CHAT}, 0)`);
    await b.waitFor(`${CH}.querySelectorAll('.chat-row').length === 2`);
    await b.click(`[...${CH}.querySelectorAll('.chat-row')].find((r) => r.textContent.includes('brainstorm'))`);
    await b.waitFor(`${CH}.querySelectorAll('.msg').length === 4`);
    await send(b, 'with roses');
    await b.waitFor(`(${lastAnswer}).includes('Echo (5): with roses')`);

    // Delete: gone from the list and from the file.
    await b.eval(`[...${CH}.querySelectorAll('.chat-row')].find((r) => r.textContent.includes('something else')).querySelector('.delete').click()`);
    await b.waitFor(`${CH}.querySelectorAll('.chat-row').length === 1`);
    await b.quit();
    const file = path.join(profile, 'Default', 'Meridian Chats.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.chats.map((c) => c.messages.length), [6]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { await b.close(); api.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
