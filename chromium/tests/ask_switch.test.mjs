// Several AIs connected: the header of Ask says who answers and switches it for this chat; each AI
// gets its own "this goes to…" before the first thing is sent to it; "codex ⇥"-style words exist for
// whatever is connected. Stand-in CLIs, real clicks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const AK = 'app.$.ask.shadowRoot';
const AC = 'app.$.aiConsent.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const NO_CLI = process.platform === 'win32' && 'Codex is an agent CLI, and those run on macOS only for now';

function fakes(dir) {
  standIn(dir, 'claude', `if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'From Claude' } } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'From Claude' }));
});`);
  standIn(dir, 'codex', `if (process.argv[2] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
  console.log('{"type":"thread.started","thread_id":"t-1"}');
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'From Codex' } }));
});`);
}

test('Ask: switch who answers in the header; every AI is asked about on its own', { skip: NO_CLI }, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fakes(bin);
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`, '--meridian-test-ai-consent'] });
  const send = async (text) => {
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); return true; })()`);
  };
  const lastAnswer = `[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent`;
  const sheet = `app.$.aiConsent.open`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`${H}.getSettings().then(({settings}) => ${H}.setSettings({...settings, aiProvider: 'claude-code'}))`);
    await b.eval(`app.$.ask.toggle()`);
    await b.waitFor(`${AK}.getElementById('who')?.textContent.includes('Claude Code')`);

    // Claude: asked once, then it answers.
    await send('one');
    await b.waitFor(sheet);
    assert.match(await b.eval(`${AC}.getElementById('to').textContent`), /Anthropic/);
    await b.click(`${AC}.getElementById('send')`);
    await b.waitFor(`${lastAnswer}?.includes('From Claude')`, 15000);

    // Codex from the header: its own question, the header says Codex, and it answers.
    await b.click(`${AK}.getElementById('who')`);
    await b.waitFor(`!!${AK}.querySelector('.who-item[data-id="codex"]')`, 10000);
    assert.ok(await b.eval(`!!${AK}.getElementById('whoMore')`), 'a way to connect more');
    await b.click(`${AK}.querySelector('.who-item[data-id="codex"]')`);
    await b.waitFor(`${AK}.getElementById('who').textContent.includes('Codex')`);
    await send('two');
    await b.waitFor(sheet, 10000);
    assert.match(await b.eval(`${AC}.getElementById('to').textContent`), /OpenAI/, 'Send for Claude says nothing about Codex');
    await b.click(`${AC}.getElementById('always')`);
    await b.waitFor(`${lastAnswer}?.includes('From Codex')`, 15000);
    assert.deepEqual((await b.eval(`${H}.getAllowedAi()`)).allowed.map((a) => a.id), ['codex']);

    // A new chat is with the AI from Settings again.
    await b.click(`${AK}.getElementById('new')`);
    await b.waitFor(`${AK}.getElementById('who').textContent.includes('Claude Code')`);
  } finally { await b.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
