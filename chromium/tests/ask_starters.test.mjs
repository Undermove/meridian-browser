// Ask isn't empty when it opens: suggestions for the page and the browser. "Make it distraction-free"
// makes a real Boost, says what changed and offers Undo. While the AI works the panel shows it
// (thinking, then a caret while the words arrive). A stand-in `claude`, real clicks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const AK = 'app.$.ask.shadowRoot';

function fakeClaude(dir) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)};
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const n = fs.readdirSync(log).length;
const say = (text) => console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(log, n + '.stdin'), stdin);
  const boost = stdin.includes('page_outline');
  const full = boost ? JSON.stringify({ name: 'Calm', css: '#promo { display: none !important; }', summary: 'Hid the promo banner.' }) : 'Try a space for work.';
  setTimeout(() => {
    if (boost) { say(full); console.log(JSON.stringify({ type: 'result', is_error: false, result: full })); return; }
    say('Try a space ');
    setTimeout(() => { say('for work.'); console.log(JSON.stringify({ type: 'result', is_error: false, result: full })); }, 900);
  }, 900);
});
`);
  return log;
}

test('Ask opens with suggestions; one click makes a Boost, explains it and can undo it; work is animated', async () => {
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Kiwi news</title><div id="promo">BUY NOW</div><article><h1>Kiwi news</h1><p>Kiwis grow on vines.</p></article>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeClaude(bin);
  const b = await launch([`http://127.0.0.1:${site.address().port}/`], { args: [`--meridian-agents-path=${bin}`] });
  const starter = (k) => `${AK}.querySelector('.starter[data-kind="${k}"]')`;
  const boosts = `app.$.tabstrip.handler_.getBoost().then(({state}) => state.boosts.map((x) => x.css))`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`app.$.tabstrip.handler_.getSettings().then(({settings}) => app.$.tabstrip.handler_.setSettings({...settings, aiProvider: 'claude-code', aiConsent: 'always'}))`);
    await b.eval(`app.$.ask.toggle()`);
    await b.waitFor(`!!${starter('focus')}`);
    assert.match(await b.eval(`${starter('focus')}.textContent`), /127\.0\.0\.1/);
    for (const k of ['look', 'tune', 'setup']) assert.ok(await b.eval(`!!${starter(k)}`), k);

    // One click: a Boost, what changed, and how to take it back.
    await b.click(starter('focus'));
    await b.waitFor(`!!${AK}.querySelector('.thinking')`);
    await b.waitFor(`[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent.includes('Hid the promo banner')`, 20000);
    assert.deepEqual(await b.eval(boosts), ['#promo { display: none !important; }']);
    assert.ok(await b.eval(`!${AK}.querySelector('.starter')`), 'suggestions gave way to the chat');
    await b.click(`${AK}.querySelector('.undo-boost')`);
    await b.waitFor(`${AK}.querySelector('.boost-note')?.textContent.includes('Undone')`);
    assert.deepEqual(await b.eval(boosts), [], 'a new boost is gone');

    // A new chat: suggestions again. A plain answer: thinking, then a caret, then neither.
    await b.click(`${AK}.getElementById('new')`);
    await b.waitFor(`!!${starter('setup')}`);
    await b.click(starter('setup'));
    await b.waitFor(`!!${AK}.querySelector('.thinking')`);
    await b.waitFor(`!!${AK}.querySelector('.answer.streaming') && !${AK}.querySelector('.thinking')`, 10000);
    await b.waitFor(`[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent.includes('for work') && !${AK}.querySelector('.streaming')`, 10000);
    const sent = fs.readdirSync(log).map((f) => fs.readFileSync(path.join(log, f), 'utf8')).find((s) => s.includes('Spaces:'));
    assert.match(sent, /127\.0\.0\.1/, 'what is open, by site');
    assert.doesNotMatch(sent, /Kiwis grow on vines/, 'not the page');
  } finally { await b.close(); site.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
