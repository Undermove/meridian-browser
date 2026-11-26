// Every AI feature answers through the AI that answers Ask, not only through an Anthropic API key:
// with Claude Code signed in (a stand-in here) and no key, Tidy proposes a plan that applies and a
// link preview gets its summary. With nothing connected, Tidy, link previews and Ask all say how
// to connect an AI, never "add your API key"; with Claude Code signed out, they say to sign in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const TD = 'app.$.tidy.shadowRoot';
const AK = 'app.$.ask.shadowRoot';
const NOT_SET_UP = 'Install Claude Code or connect an AI in Settings › AI.';

// A stand-in `claude`, signed in or not: it records each run's arguments and prompt and answers
// in Claude Code's stream-json. A Tidy question gets a plan in a ```json fence (as a CLI answers
// in words); a page gets a summary.
function fakeClaude(dir, signedIn) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)}, signedIn = ${signedIn};
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none' }));
  process.exit(signedIn ? 0 : 1);
}
const n = fs.readdirSync(log).filter((f) => f.endsWith('.args')).length;
fs.writeFileSync(path.join(log, n + '.args'), JSON.stringify(args));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(log, n + '.stdin'), stdin);
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: 's-' + n, model: 'claude-opus-5-5' });
  let answer;
  if (stdin.includes('<untrusted_tabs>')) {
    const key = (title) => new RegExp('(t\\\\d+)\\\\t' + title).exec(stdin)[1];
    const plan = {
      folders: [{ name: 'Tbilisi Trip', tabs: [key('Flights'), key('Hotels')] }],
      renames: [{ tab: key('Inbox'), title: 'Gmail' }],
    };
    answer = 'Here is the plan:\\n\`\`\`json\\n' + JSON.stringify(plan) + '\\n\`\`\`';
  } else {
    answer = 'A page about ' + (/title="([^"]*)"/.exec(stdin) || [])[1] + '.';
  }
  for (let i = 0; i < answer.length; i += 20) out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer.slice(i, i + 20) } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer });
});
`);
  return log;
}

// Pages with titles for the Today tabs, and an article to preview.
async function site() {
  const server = http.createServer((req, res) => {
    const titles = { '/f': 'Flights to Tbilisi | Kayak', '/h': 'Hotels in Tbilisi | Booking.com', '/m': 'Inbox (3) - Mail' };
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/article') return res.end('<title>Khachapuri Guide</title><meta name="description" content="How to bake it"><p>Cheese, egg, dough.</p>');
    res.end(`<title>${titles[req.url] || 'x'}</title>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// A profile with link previews on (they are off by default).
function profileWithPreviews() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { ai_link_preview: true } }));
  return profile;
}

async function start({ agents, s }) {
  const profile = profileWithPreviews();
  const b = await launch([`${s.base}/f`, `${s.base}/h`, `${s.base}/m`], {
    profile,
    args: [
      ...(agents ? [`--meridian-agents-path=${agents}`] : []),
      `--meridian-preview-allow-hosts=${new URL(s.base).host}`, '--meridian-test-keys',
    ],
  });
  await b.waitFor(`[...${SB}.querySelectorAll('#today meridian-tab-row')].filter((r) => r.tab?.title && r.tab.title !== r.tab.url).length === 3`);
  return { b, profile };
}

async function tidyError(b) {
  await b.click(`${SB}.getElementById('tidyToday')`);
  await b.waitFor(`!!${TD}.getElementById('error')?.textContent.trim()`, 20000);
  const text = await b.eval(`${TD}.getElementById('error').textContent.replace(/\\s+/g, ' ').trim()`);
  await b.eval('app.$.tidy.hide()');
  return text;
}

async function askError(b) {
  await b.eval('app.$.tabstrip.runCommand(14, 0)');
  await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
  await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'Hello?'; ${AK}.getElementById('send').click(); })()`);
  await b.waitFor(`!${AK}.querySelector('#stop') && ${AK}.textContent.includes('Settings › AI')`, 20000);
  return b.eval(`${AK}.textContent.replace(/\\s+/g, ' ')`);
}

test('Claude Code signed in, no API key: Tidy proposes a plan that applies, and a link preview is summarized', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeClaude(bin, true);
  const s = await site();
  const { b, profile } = await start({ agents: bin, s });
  try {
    assert.equal((await b.eval('app.$.tabstrip.handler_.hasAiKey()')).hasKey, false, 'no API key');

    await b.click(`${SB}.getElementById('tidyToday')`);
    await b.waitFor(`${TD}.querySelectorAll('.group').length === 2 || !!${TD}.getElementById('error')`, 20000);
    assert.equal(await b.eval(`${TD}.getElementById('error')?.textContent.trim() || ''`), '');
    assert.equal(await b.eval(`${TD}.querySelector('.group .name').textContent`), 'Tbilisi Trip');
    // Claude Code was asked as Ask asks it (every tool off), for JSON in words.
    const runs = fs.readdirSync(log).filter((f) => f.endsWith('.stdin'));
    const tidyRun = runs.find((f) => fs.readFileSync(path.join(log, f), 'utf8').includes('<untrusted_tabs>'));
    assert.ok(tidyRun, 'the Tidy question went to Claude Code');
    const args = JSON.parse(fs.readFileSync(path.join(log, tidyRun.replace('.stdin', '.args')), 'utf8'));
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.match(args.join('\n'), /Answer with only one JSON object/);
    await b.click(`${TD}.getElementById('apply')`);
    await b.waitFor(`${SB}.querySelectorAll('#pinned meridian-item').length === 1`);
    const state = await b.eval('app.$.tabstrip.handler_.getState().then(({state}) => state)');
    const folder = state.spaces[0].pinned[0];
    assert.equal(folder.isFolder, true);
    assert.equal(folder.title, 'Tbilisi Trip');
    assert.equal(folder.children.length, 2);
    await b.waitFor(`[...${SB}.querySelectorAll('#today meridian-tab-row')].some((r) => r.shadowRoot.querySelector('.title').textContent === 'Gmail')`);

    // The link preview of an article: Claude Code's summary of the page loaded without cookies.
    const preview = await b.eval(`app.$.tabstrip.handler_.testPreviewLink(${JSON.stringify(`${s.base}/article`)})`);
    assert.equal(preview.error, '');
    assert.equal(preview.title, 'Khachapuri Guide');
    assert.equal(preview.summary, 'A page about Khachapuri Guide.');
    const pageRun = fs.readdirSync(log).filter((f) => f.endsWith('.stdin'))
      .map((f) => fs.readFileSync(path.join(log, f), 'utf8')).find((t) => t.includes('<untrusted_page_content'));
    assert.match(pageRun, /<untrusted_page_content url="http:\/\/127\.0\.0\.1:\d+\/article" title="Khachapuri Guide">\nHow to bake it/);

    // Settings › AI › AI features names who answers, not an API key.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!app.$.settings.shadowRoot.querySelector('[data-id="ai"]')`);
    await b.click(`app.$.settings.shadowRoot.querySelector('[data-id="ai"]')`);
    await b.waitFor(`app.$.settings.shadowRoot.getElementById('aiFeaturesNote')?.textContent.includes('These use Claude Code')`, 15000);
  } finally {
    await b.close(); s.server.close();
    fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('nothing connected: Tidy, link previews and Ask say how to connect an AI, never "API key"', async () => {
  const s = await site();
  const { b, profile } = await start({ agents: null, s });
  try {
    const tidy = await tidyError(b);
    assert.equal(tidy, NOT_SET_UP);
    const preview = await b.eval(`app.$.tabstrip.handler_.testPreviewLink(${JSON.stringify(`${s.base}/article`)})`);
    assert.equal(preview.error, NOT_SET_UP);
    const ask = await askError(b);
    assert.ok(ask.includes(NOT_SET_UP), ask);
    for (const text of [tidy, preview.error, ask]) assert.doesNotMatch(text, /API key/);
  } finally { await b.close(); s.server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('Claude Code installed but signed out: Tidy and link previews say to sign in to it', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeClaude(bin, false);
  const s = await site();
  const { b, profile } = await start({ agents: bin, s });
  try {
    const signIn = 'Claude Code isn’t signed in yet. Open Settings › AI and sign in to it.';
    assert.equal(await tidyError(b), signIn);
    const preview = await b.eval(`app.$.tabstrip.handler_.testPreviewLink(${JSON.stringify(`${s.base}/article`)})`);
    assert.equal(preview.error, signIn);
    assert.equal(fs.readdirSync(log).filter((f) => f.endsWith('.stdin')).length, 0, 'nothing was sent');
  } finally {
    await b.close(); s.server.close();
    fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true });
  }
});
