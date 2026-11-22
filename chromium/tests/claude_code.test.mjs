// Claude Code on the person's own Claude plan answers ⌘J / Ask: Meridian starts their unmodified
// `claude` (signed in by themselves; Meridian never touches the sign-in) with every tool off, and
// shows its answer. Signed out, Ask says what to do in plain words. A stand-in `claude` here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const AK = 'app.$.ask.shadowRoot';
const ST = 'app.$.settings.shadowRoot';

// A stand-in `claude`: `auth status` from a file; a run records its arguments and prompt and
// answers in Claude Code's stream-json (or as a signed-out Claude Code does).
function fakeClaude(dir) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  fs.writeFileSync(path.join(dir, 'signed-in'), 'yes');
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const dir = ${JSON.stringify(dir)}, log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
const signedIn = fs.readFileSync(path.join(dir, 'signed-in'), 'utf8') === 'yes';
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
  if (!signedIn) {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    return;
  }
  // A sub-agent's text never shows; the top-level answer streams in pieces.
  out({ type: 'stream_event', parent_tool_use_id: 'sub-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SUBAGENT ' } } });
  for (const t of ['Claude Code ', 'says hi ', String(n)]) out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Claude Code says hi ' + n, total_cost_usd: 0.01 });
});
`);
  return log;
}

test('Claude Code (your plan) answers Ask with every tool off; signed out, Ask says how to sign in', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeClaude(bin);
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`] });
  const ask = async (text) => {
    if (!(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    const before = await b.eval(`${AK}.querySelectorAll('.msg.assistant').length`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`${AK}.querySelectorAll('.msg.assistant').length > ${before} && !${AK}.querySelector('#stop')`, 20000);
    return b.eval(`[...${AK}.querySelectorAll('.msg.assistant')].pop().textContent.replace(/\\s+/g, ' ').trim()`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Offered without "Other agents": signed in, ready.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`${ST}.getElementById('ai-claude-code')?.textContent.includes('Ready')`, 15000);
    assert.match(await b.eval(`${ST}.getElementById('ai-claude-code').textContent`), /Claude Code[\s\S]*your Claude plan/);
    await b.eval(`${ST}.getElementById('ai-claude-code').click()`);
    await b.waitFor(`${ST}.getElementById('ai-claude-code').classList.contains('on')`);
    await b.eval('app.$.settings.hide()');

    const first = await ask('What is this page?');
    assert.match(first, /Claude Code says hi 0/);
    assert.doesNotMatch(first, /SUBAGENT/, 'a sub-agent\'s text stays out');
    const args = JSON.parse(fs.readFileSync(path.join(log, '0.args'), 'utf8'));
    // Every tool off, nothing of the person's own setup, nothing kept.
    for (const [flag, value] of [['--tools', ''], ['--permission-mode', 'dontAsk'], ['--setting-sources', ''], ['--output-format', 'stream-json']]) {
      assert.equal(args[args.indexOf(flag) + 1], value, flag);
    }
    for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--include-partial-messages']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.ok(!args.includes('--mcp-config') && !args.includes('--resume'), 'no tools, no stored session');
    assert.match(fs.readFileSync(path.join(log, '0.stdin'), 'utf8'), /What is this page\?/);

    // The next question carries the conversation so far (nothing is stored by Claude Code).
    assert.match(await ask('And in one word?'), /Claude Code says hi 1/);
    const second = fs.readFileSync(path.join(log, '1.stdin'), 'utf8');
    assert.match(second, /What is this page\?[\s\S]*Claude Code says hi 0[\s\S]*And in one word\?/);

    // Signed out: said in plain words, with what to do.
    fs.writeFileSync(path.join(bin, 'signed-in'), 'no');
    assert.match(await ask('Still there?'), /Claude Code isn’t signed in\. Run claude in Terminal to sign in/);
  } finally { await b.close(); fs.rmSync(bin, { recursive: true, force: true }); }
});
