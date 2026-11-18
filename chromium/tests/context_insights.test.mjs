// Workbench and Claude Code's numbers: the session's name on its terminal tab (or a name given by
// hand), the context gauge on the tab, the usage limits in the topbar, and Context Insights: what the
// context holds and where the tokens went, read from the session's transcript. Claude Code hands
// these to its status line, which Meridian runs for Workbench sessions; the person's own status
// line still shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: runs the status line from the --settings it was given, as Claude Code
// does after each answer, with the person's home (and their own status line) in HOME.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys, time
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
now = time.time()
status = {
  'session_id': 's1', 'session_name': 'Fix the login page', 'transcript_path': os.path.join(cwd, 'session.jsonl'),
  'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'}, 'workspace': {'project_dir': cwd, 'current_dir': cwd},
  'context_window': {'context_window_size': 200000, 'used_percentage': 46,
                     'current_usage': {'input_tokens': 10, 'cache_creation_input_tokens': 2000, 'cache_read_input_tokens': 89990, 'output_tokens': 300}},
  'rate_limits': {'five_hour': {'used_percentage': 41.5, 'resets_at': now + 7200}, 'seven_day': {'used_percentage': 12, 'resets_at': now + 3 * 86400}},
  'prompt_cache': {'requests': 12, 'misses': 1, 'hit_ratio': 0.87, 'warm': True, 'ttl': '5m', 'expires_at': now + 200, 'miss_causes': {'ttl_expired_5m': 1}},
  'cost': {'total_cost_usd': 1.23},
}
sys.stdout.write('\\x1b]0;\\u2733 terminal title\\x07')
out = subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env).stdout
print('STATUS: ' + out, flush=True)
sys.stdin.readline()
`;

// The same stand-in on Windows: claude.exe (a few lines of C#, built by the C# compiler every
// Windows has) runs node with this script; the status line goes through cmd, as Claude Code's does.
const WIN = process.platform === 'win32';
const FAKE_CLAUDE_JS = String.raw`const fs = require('fs'), path = require('path'), cp = require('child_process');
const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const cwd = process.cwd(), now = Date.now() / 1000;
const env = { ...process.env, HOME: path.join(cwd, 'home'), USERPROFILE: path.join(cwd, 'home') };
delete env.CLAUDE_CONFIG_DIR;
const status = {
  session_id: 's1', session_name: 'Fix the login page', transcript_path: path.join(cwd, 'session.jsonl'),
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, workspace: { project_dir: cwd, current_dir: cwd },
  context_window: { context_window_size: 200000, used_percentage: 46,
    current_usage: { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 89990, output_tokens: 300 } },
  rate_limits: { five_hour: { used_percentage: 41.5, resets_at: now + 7200 }, seven_day: { used_percentage: 12, resets_at: now + 3 * 86400 } },
  prompt_cache: { requests: 12, misses: 1, hit_ratio: 0.87, warm: true, ttl: '5m', expires_at: now + 200, miss_causes: { ttl_expired_5m: 1 } },
  cost: { total_cost_usd: 1.23 },
};
process.stdout.write('\x1b]0;✳ terminal title\x07');
const out = cp.execSync(settings.statusLine.command, { input: JSON.stringify(status), env, encoding: 'utf8' });
process.stdout.write('STATUS: ' + out + '\r\n');
process.stdin.once('data', () => process.exit(0));
`;
const SHIM_CS = `using System; using System.Diagnostics; using System.IO; using System.Linq;
class Claude { static int Main(string[] args) {
  string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
  Func<string, string> q = (a) => "\\"" + a.Replace("\\"", "\\\\\\"") + "\\"";
  var p = Process.Start(new ProcessStartInfo(Environment.GetEnvironmentVariable("FAKE_CLAUDE_NODE"),
    q(Path.Combine(dir, "claude.js")) + " " + string.Join(" ", args.Select(q))) { UseShellExecute = false });
  p.WaitForExit(); return p.ExitCode; } }`;
function fakeClaudeWin(bin) {
  fs.writeFileSync(path.join(bin, 'claude.js'), FAKE_CLAUDE_JS);
  fs.writeFileSync(path.join(bin, 'claude.cs'), SHIM_CS);
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(csc, ['/nologo', '/out:' + path.join(bin, 'claude.exe'), path.join(bin, 'claude.cs')], { stdio: 'pipe' });
}

// A transcript in Claude Code's format: the request's system prompt and tools, CLAUDE.md, skills; a
// prompt; app.js read twice (≈10k tokens each) and a screenshot; a 10-minute pause that left the cache
// cold; a compaction.
function transcript() {
  const t0 = Date.parse('2026-11-18T10:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const lines = [];
  const L = (o) => lines.push(JSON.stringify(o));
  L({ type: 'api-request-blob', body: 'x'.repeat(5000) });
  L({ type: 'api-request-shape', shape: {
    system: [{ type: 'text', text: 's'.repeat(8000) }],
    tools: [
      { name: 'Read', description: 'r'.repeat(4000), input_schema: {} },
      { name: 'mcp__meridian__screenshot', description: 'm'.repeat(6000), input_schema: {} },
      { name: 'mcp__meridian__click', description: 'm'.repeat(1600), input_schema: {} },
    ] } });
  L({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/project/CLAUDE.md', type: 'Project', content: 'c'.repeat(4000) }] } });
  L({ type: 'attachment', attachment: { type: 'skill_listing', content: 'k'.repeat(2400), isInitial: true } });
  L({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Fix the login page' } });
  let n = 0;
  const req = (s, usage, content = []) => L({ type: 'assistant', requestId: `r${++n}`, timestamp: at(s), isSidechain: false,
    message: { id: `m${n}`, model: 'claude-opus-5-5', role: 'assistant', content, usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200, ...usage } } });
  const result = (id, content) => L({ type: 'user', timestamp: at(0), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  req(1, { cache_creation_input_tokens: 9000 }, [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/project/src/app.js' } }]);
  result('u1', 'a'.repeat(40000));
  req(5, { cache_read_input_tokens: 9000, cache_creation_input_tokens: 10200 }, [{ type: 'tool_use', id: 'u2', name: 'mcp__meridian__screenshot', input: {} }]);
  result('u2', [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }]);
  for (let i = 0; i < 8; i++) req(10 + i * 5, { cache_read_input_tokens: 21000 + i * 300, cache_creation_input_tokens: 300 });
  req(60, { cache_read_input_tokens: 23400, cache_creation_input_tokens: 400 }, [{ type: 'tool_use', id: 'u3', name: 'Read', input: { file_path: '/project/src/app.js' } }]);
  result('u3', 'a'.repeat(40000));
  // Ten minutes later: everything written to the cache again.
  req(660, { cache_read_input_tokens: 0, cache_creation_input_tokens: 34000 });
  for (let i = 0; i < 5; i++) req(670 + i * 5, { cache_read_input_tokens: 34000 + i * 200, cache_creation_input_tokens: 200 });
  L({ type: 'system', subtype: 'compact_boundary', timestamp: at(700), compactMetadata: { trigger: 'auto', preTokens: 35000, postTokens: 6000 } });
  req(710, { cache_creation_input_tokens: 9000 });
  L({ type: 'cost-state', totalCostUSD: 1.23, modelUsage: { 'claude-opus-5-5': { costUSD: 1.23 } } });
  return lines.join('\n') + '\n';
}

async function setup({ ownStatusLine }) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ci-')));
  fs.writeFileSync(path.join(project, 'session.jsonl'), transcript());
  if (ownStatusLine) {
    fs.mkdirSync(path.join(project, 'home', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(project, 'home', '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'cat > /dev/null; echo MY-OWN-LINE' } }));
  }
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  if (WIN) {
    fakeClaudeWin(bin);
    process.env.FAKE_CLAUDE_NODE = process.execPath;
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  }
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor('!!S.project');
  const done = async () => { wb.close(); await b.close(); for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true }); };
  return { b, wb, project, done };
}

// A real click in the Workbench page.
async function click(wb, expr, { count = 1 } = {}) {
  const p = await wb.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  for (let i = 1; i <= count; i++) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: i });
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: i });
  }
}
const termText = `S.activeTerm ? [...Array(S.activeTerm.xterm.buffer.active.length).keys()].map((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : ''`;
const tabName = `document.querySelector('#term-tab-list .ttab.active .name')?.textContent`;

test('a Claude Code tab takes the session\'s name and shows its context; the topbar shows the usage limits; Context Insights explains the session', async () => {
  const { wb, done } = await setup({ ownStatusLine: true });
  try {
    await wb.eval(`launch('claude').then((t) => !!t)`);
    // The person's own status line still shows in the terminal (on Windows, Meridian's: theirs is
    // run along on macOS and Linux only).
    await wb.waitFor(`${termText}.includes('STATUS: ${WIN ? 'context 46%' : 'MY-OWN-LINE'}')`, 15000);
    // The session's name beats the terminal title; the context gauge is on the tab.
    await wb.waitFor(`${tabName} === 'Fix the login page'`, 15000);
    assert.equal(await wb.eval(`document.querySelector('#term-tab-list .ttab.active .ctx-badge').textContent`), '46%');
    // The limits, in the topbar.
    await wb.waitFor(`document.getElementById('limits-chip')?.textContent.includes('5h 42%')`);
    assert.ok((await wb.eval(`document.getElementById('limits-chip').textContent`)).includes('week 12%'));

    // A click on the limits: Context Insights.
    await click(wb, `document.getElementById('limits-chip')`);
    await wb.waitFor(`!document.getElementById('side-pane').hidden && !!document.querySelector('#side-body .ci-big')`);
    const panel = `document.querySelector('#side-body').innerText`;
    // (Section titles show in capitals.)
    await wb.waitFor(`${panel}.includes('WHERE THE USAGE WENT')`, 20000);
    const text = await wb.eval(panel);
    if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, Buffer.from((await wb.cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    for (const s of ['USAGE LIMITS', 'CONTEXT WINDOW', 'INSIGHTS', '5-hour window', 'Resets in 2 h', 'Week', '46% used', '92k / 200k', 'System prompt', 'System tools', 'MCP tools', 'Memory files', 'Skills', 'Messages', 'Free space',
      'Compacted 1×', 'Prompt cache: 87%', 'ttl expired 5m ×1', 'The cache went cold 1 time', 'Read /project/src/app.js']) {
      assert.ok(text.includes(s), `the panel says “${s}”:\n${text}`);
    }
    // The folds: the MCP server's tools with their sizes, the file read twice.
    await click(wb, `document.querySelector('.ci-fold[data-id="mcp"] > button')`);
    await wb.waitFor(`document.querySelector('.ci-fold[data-id="mcp"]').classList.contains('open')`);
    const mcp = await wb.eval(`document.querySelector('.ci-fold[data-id="mcp"] .ci-fold-body').innerText`);
    assert.match(mcp, /meridian[\s\S]*screenshot[\s\S]*1\.5k[\s\S]*click/);
    await click(wb, `document.querySelector('.ci-fold[data-id="rereads"] > button')`);
    assert.match(await wb.eval(`document.querySelector('.ci-fold[data-id="rereads"] .ci-fold-body').innerText`), /app\.js\s+2×/);

    // A name by hand: a double click on the tab.
    await click(wb, `document.querySelector('#term-tab-list .ttab.active .name')`, { count: 2 });
    await wb.waitFor(`!!document.querySelector('#term-tab-list .ttab.active input.rename')`);
    await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
    await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 });
    await wb.cdp.send('Input.insertText', { text: 'Login bug' });
    await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wb.waitFor(`${tabName} === 'Login bug'`);
  } finally { await done(); }
});

test('without a status line of their own, Meridian\'s shows the context and limits; a shell tab takes its title', async () => {
  const { wb, done } = await setup({ ownStatusLine: false });
  try {
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`${termText}.includes('STATUS: context 46% · 5h limit 42% · week 12%')`, 15000);
    // A shell: the title it sets names the tab.
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'shell'`);
    await sleep(800);
    if (WIN) {
      // The shell's own title (cmd's `title`, PowerShell's WindowTitle); ConPTY hands it on as
      // ESC ] 0 ; … BEL.
      const cmd = /^cmd/i.test(await wb.eval('S.activeTerm.title'));
      const line = cmd ? 'title deploy-logs & ping -n 9 127.0.0.1 >nul' : "$Host.UI.RawUI.WindowTitle = 'deploy-logs'; Start-Sleep 8";
      await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, ${JSON.stringify(line + '\r')}); return true; })()`);
    } else {
      await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, "printf '\\\\033]0;deploy-logs\\\\007'; sleep 8\\r"); return true; })()`);
    }
    await wb.waitFor(`${tabName} === 'deploy-logs'`, 10000).catch(async (e) => { console.log('DIAG ' + JSON.stringify(await wb.eval(`[${tabName}, S.activeTerm.auto, S.activeTerm.title, ${termText}.slice(-400)]`))); throw e; });
  } finally { await done(); }
});
