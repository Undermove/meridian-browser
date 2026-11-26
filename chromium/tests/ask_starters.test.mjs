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

// The setup a suggestion describes, applied with one button: a preview first (nothing changes
// until the click), then Undo. Only sites that were sent and new spaces count; the person's own
// link rules stay as they are.
test('Ask: a suggested setup (spaces, link rules) is previewed, applied with one button and undone', async () => {
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Docs</title><h1>Docs</h1>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const block = JSON.stringify({ spaces: [{ name: 'Reading', icon: '📚', color: '#7fbf8e' }, { name: 'personal', icon: '🏠', color: '#000000' }],
    linkRules: [{ site: '127.0.0.1', space: 'Reading' }, { site: 'evil.example', space: 'Reading' }, { site: '127.0.0.1', space: 'Nowhere' }] });
  const answer = `Make a **Reading** space and send your docs there.\n\n\`\`\`meridian-setup\n${block}\n\`\`\`\n`;
  standIn(bin, 'claude', `if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
let stdin = ''; process.stdin.on('data', (d) => { stdin += d; }); process.stdin.on('end', () => {
  const out = ${JSON.stringify(answer)};
  console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: out } } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: out }));
});`);
  const b = await launch([`http://127.0.0.1:${site.address().port}/docs`], { args: [`--meridian-agents-path=${bin}`] });
  const H = 'app.$.tabstrip.handler_';
  const spaces = `${H}.getState().then(({state}) => state.spaces.map((s) => s.name))`;
  const rules = `${H}.getSettings().then(({settings}) => settings.atc.rules.map((r) => r.pattern + ' -> ' + r.target))`;
  const msg = `[...${AK}.querySelectorAll('.msg.assistant')].pop()`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`${H}.getSettings().then(({settings}) => ${H}.setSettings({...settings, aiProvider: 'claude-code', aiConsent: 'always', atc: {...settings.atc, rules: [{id: 'mine', pattern: 'example.org', target: 'little'}]}}))`);
    await b.waitFor(`${rules}.then((r) => r.length === 1)`);
    const before = await b.eval(spaces);
    await b.eval(`app.$.ask.toggle()`);
    await b.waitFor(`!!${AK}.querySelector('.starter[data-kind="setup"]')`);
    await b.click(`${AK}.querySelector('.starter[data-kind="setup"]')`);
    await b.waitFor(`!!${msg}?.querySelector('.setup-card')`, 20000);
    const said = await b.eval(`${msg}.textContent`);
    assert.match(said, /send your docs there/);
    assert.doesNotMatch(said, /meridian-setup|linkRules/, 'the machine part is not shown');
    const card = await b.eval(`${msg}.querySelector('.setup-card').textContent.replace(/\\s+/g, ' ')`);
    assert.match(card, /New space\s*📚\s*Reading/);
    assert.match(card, /Links to 127\.0\.0\.1 open in Reading/);
    assert.doesNotMatch(card, /evil\.example|Nowhere|🏠/, 'only sites that were sent, only new spaces');
    if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, Buffer.from((await b.cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    assert.deepEqual(await b.eval(spaces), before, 'a preview changes nothing');
    assert.deepEqual(await b.eval(rules), ['example.org -> little']);

    await b.click(`${msg}.querySelector('.apply-setup')`);
    await b.waitFor(`${spaces}.then((n) => n.includes('Reading'))`);
    await b.waitFor(`${rules}.then((r) => r.length === 2)`);
    const st = await b.eval(`${H}.getState().then(({state}) => state)`);
    const reading = st.spaces.find((s) => s.name === 'Reading');
    assert.equal(reading.icon, '📚');
    assert.deepEqual(await b.eval(rules), ['example.org -> little', `127.0.0.1 -> space:${reading.id}`]);
    const route = await b.eval(`${H}.getSettings().then(({settings}) => ${H}.testLinkRoute(settings.atc, 'http://127.0.0.1:${site.address().port}/docs'))`);
    assert.deepEqual([route.target, route.spaceId], ['space', reading.id]);
    await b.waitFor(`/Applied/.test(${msg}.querySelector('.setup-card').textContent)`);

    await b.click(`${msg}.querySelector('.undo-setup')`);
    await b.waitFor(`${spaces}.then((n) => JSON.stringify(n) === ${JSON.stringify(JSON.stringify(before))})`);
    assert.deepEqual(await b.eval(rules), ['example.org -> little'], 'the person\'s own rule stays');
    await b.waitFor(`/Undone/.test(${msg}.querySelector('.setup-card').textContent)`);
  } finally { await b.close(); site.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
