// Before anything goes to an AI on the internet, Meridian says where it goes and asks once: Send
// (this time, until the browser restarts), Always (remembered), Use another AI (Settings › AI), Turn
// AI features off, Cancel. Nothing is sent before the answer. Local AIs (Ollama, LM Studio) don't ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const KEY = 'sk-ant-test-000000000000000000000000';
const AK = 'app.$.ask.shadowRoot';
const AC = 'app.$.aiConsent.shadowRoot';
const H = 'app.$.tabstrip.handler_';

// A stand-in Anthropic API: every streamed request answers "Hello there".
function fakeAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push(json);
      if (!json.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello there' } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' } });
      send('message_stop', {});
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, requests, streamed: () => requests.filter((q) => q.stream).length, base: `http://127.0.0.1:${server.address().port}` })));
}

test('online AI: Meridian asks before anything is sent; Send, Cancel, Always, another AI, off', async () => {
  const api = await fakeAnthropic();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const args = [`--meridian-ai-base-url=${api.base}`, '--meridian-test-ai-consent'];
  let b = await launch(['about:blank'], { profile, args });
  const sheetOpen = 'app.$.aiConsent.open';
  const openAsk = async () => {
    if (!(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
  };
  const ask = async (text) => {
    await openAsk();
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); return true; })()`);
  };
  const askText = `${AK}.textContent`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    assert.deepEqual(await b.eval(`${H}.setAiKey(${JSON.stringify(KEY)})`), { ok: true, error: '' });
    const before = api.streamed();

    // The first question: the sheet says where it goes; nothing has left.
    await ask('first question');
    await b.waitFor(sheetOpen);
    assert.equal(await b.eval(`${AC}.getElementById('to').textContent`), 'Anthropic (Claude)');
    assert.equal(api.streamed(), before, 'nothing sent before the answer');
    // Cancel: still nothing, and Ask says why.
    await b.click(`${AC}.getElementById('cancel')`);
    await b.waitFor(`!(${sheetOpen})`);
    await b.waitFor(`${askText}.includes('Not sent: you didn’t allow it.')`);
    assert.equal(api.streamed(), before);

    // Send: this question goes, and the next one doesn't ask again (until a restart).
    await ask('second question');
    await b.waitFor(sheetOpen);
    await b.click(`${AC}.getElementById('send')`);
    await b.waitFor(`${askText}.includes('Hello there')`);
    assert.equal(api.streamed(), before + 1);
    await ask('third question');
    await b.waitFor(`${AK}.querySelectorAll('.msg.assistant').length >= 2 && [...${AK}.querySelectorAll('.msg.assistant')].pop().textContent.includes('Hello there')`);
    assert.ok(!(await b.eval(sheetOpen)), 'asked once this run');
    assert.equal((await b.eval(`${H}.getSettings().then((r) => r.settings)`)).aiConsent, '', 'Send is not remembered');

    // After a restart it asks again; Always is remembered.
    await b.quit();
    b = await launch(['about:blank'], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    const n = api.streamed();
    await ask('after a restart');
    await b.waitFor(sheetOpen);
    assert.equal(api.streamed(), n);
    await b.click(`${AC}.getElementById('always')`);
    await b.waitFor(`${askText}.includes('Hello there')`);
    assert.deepEqual((await b.eval(`${H}.getAllowedAi()`)).allowed.map((a) => a.id), ['claude-code'], 'Always is for this AI');
    await b.quit();
    b = await launch(['about:blank'], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await ask('always now');
    await b.waitFor(`${askText}.includes('Hello there')`);
    assert.ok(!(await b.eval(sheetOpen)), 'Always: no question');

    // Back to Ask in Settings: Use another AI… opens Settings › AI; nothing is sent.
    await b.eval(`${H}.forgetAiConsent('claude-code'), true`);
    await b.quit();
    b = await launch(['about:blank'], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    const m = api.streamed();
    await ask('another AI please');
    await b.waitFor(sheetOpen);
    await b.click(`${AC}.getElementById('other')`);
    await b.waitFor('app.$.settings.open');
    await b.waitFor(`${askText}.includes('Pick the AI to use in Settings › AI.')`);
    assert.equal(api.streamed(), m);
    await b.eval('app.$.settings.open = false');
    await b.waitFor('!app.$.settings.open');

    // Turn AI features off: remembered; later questions are refused without a question.
    await ask('and now off');
    await b.waitFor(sheetOpen);
    await b.click(`${AC}.getElementById('off')`);
    await b.waitFor(`${askText}.includes('AI features are off')`);
    assert.equal((await b.eval(`${H}.getSettings().then((r) => r.settings)`)).aiConsent, 'off');
    await ask('still off?');
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(!(await b.eval(sheetOpen)), 'off: no question');
    assert.equal(api.streamed(), m);
  } finally {
    await b.close();
    api.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
