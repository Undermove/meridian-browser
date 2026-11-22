// "word ⇥" in the command bar, as in Brk or Raycast: a site's keyword then Tab searches that site;
// "claude", "codex", "ask", "page", "summarize" then Tab ask that AI (Summarize with nothing typed
// sums up the page). Backspace in an empty field leaves the mode. Real key presses in the bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const BAR = 'app.$.commandBar';
const CB = `${BAR}.shadowRoot`;
const AK = 'app.$.ask.shadowRoot';

function fakeClaude(dir) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const n = fs.readdirSync(log).filter((f) => f.endsWith('.stdin')).length;
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(log, n + '.stdin'), stdin);
  console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Claude answer ' + n } } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: 'Claude answer ' + n }));
});
`);
  return log;
}

test('"word ⇥" in the command bar: a site keyword searches that site; claude/summarize ask Claude Code', async () => {
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Kiwi farm</title><h1>Kiwi farm</h1><p>Kiwis grow on vines in New Zealand.</p>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeClaude(bin);
  const b = await launch([`http://127.0.0.1:${site.address().port}/`], { args: [`--meridian-agents-path=${bin}`] });
  const openBar = async () => {
    await b.click(`${SB}.getElementById('newTabButton')`);
    await b.waitFor(`${BAR}.open && ${BAR}.$.address.matches(':focus-within') && ${BAR}.keywords_.size > 0`);
  };
  const field = `${BAR}.$.address.shadowRoot.querySelector('cr-searchbox-input').shadowRoot.querySelector('input').value`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Claude Code answers (no consent sheet for the stand-in run).
    await b.eval(`app.$.tabstrip.handler_.getSettings().then(({settings}) => app.$.tabstrip.handler_.setSettings({...settings, aiProvider: 'claude-code', aiConsent: 'always'}))`);

    // A site search by its keyword: the default engine's, whatever this build has.
    const { keywords } = await b.eval(`app.$.tabstrip.handler_.getSearchKeywords()`);
    assert.ok(keywords.length > 0, 'some site searches');
    const kw = keywords[0];
    const { url: expected } = await b.eval(`app.$.tabstrip.handler_.searchUrl(${JSON.stringify(kw.keyword)}, 'kiwi pear')`);
    assert.match(expected, /kiwi/);
    await openBar();
    await b.type(kw.keyword);
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`${CB}.getElementById('mode')?.dataset.keyword === ${JSON.stringify(kw.keyword)}`);
    assert.equal(await b.eval(field), '', 'the keyword left the field');
    await b.type('kiwi pear');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].some((t) => t.url === ${JSON.stringify(expected)} || t.pendingUrl === ${JSON.stringify(expected)})`, 10000);

    // Arc's way: the keyword, a space and the words, then Return (this went to the default search).
    await b.eval(`[...app.$.tabstrip.tabs_.values()].filter((t) => t.url === ${JSON.stringify(expected)}).forEach((t) => app.$.tabstrip.handler_.closeTab(t.id))`).catch(() => {});
    await openBar();
    await b.type(`${kw.keyword} kiwi pear`);
    await b.key('ArrowRight', 'ArrowRight', 39);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${BAR}.open`);
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].some((t) => t.url === ${JSON.stringify(expected)} || t.pendingUrl === ${JSON.stringify(expected)})`, 10000);

    // Backspace in the empty field leaves a mode; Tab after a word that isn't one is the usual Tab.
    await openBar();
    await b.type('claude');
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`${CB}.getElementById('mode')?.dataset.provider === 'claude-code'`);
    await b.key('Backspace', 'Backspace', 8);
    await b.waitFor(`!${CB}.getElementById('mode')`);

    // claude ⇥ question: Claude Code answers in Ask (without the page).
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!${BAR}.open`);
    await b.eval(`app.$.tabstrip.activateTab([...app.$.tabstrip.tabs_.values()].find((t) => t.url.includes('127.0.0.1')).id)`);
    await openBar();
    await b.type('claude');
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`!!${CB}.getElementById('mode')`);
    await b.type('what is a kiwi?');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`app.$.ask.open && [...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent.includes('Claude answer 0')`, 20000);
    assert.equal(await b.eval(`[...${AK}.querySelectorAll('.msg.user')].pop().textContent.trim()`), 'what is a kiwi?');
    assert.doesNotMatch(fs.readFileSync(path.join(log, '0.stdin'), 'utf8'), /Kiwis grow on vines/, 'no page');

    // summarize ⇥ ↵: the page, summed up.
    await openBar();
    await b.type('summarize');
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`!!${CB}.getElementById('mode')`);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent.includes('Claude answer 1')`, 20000);
    const asked = fs.readFileSync(path.join(log, '1.stdin'), 'utf8');
    assert.match(asked, /Summarize this page/);
    assert.match(asked, /Kiwis grow on vines/, 'with the page');
  } finally { await b.close(); site.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
