// AI subscriptions per space: a person with two Claude Code accounts (work and personal) and two
// Codex accounts picks one per space. Each account is that CLI's own config folder, chosen by the
// CLI's documented variable (CLAUDE_CONFIG_DIR, CODEX_HOME…); Meridian never signs in and never
// reads a sign-in. Found by folder names only. Stand-in CLIs here report which folder they were
// given; the accounts' folders are in a temp home (--meridian-accounts-home), never the person's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { launch, APP, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AK = 'app.$.ask.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const SHOTS = process.env.MERIDIAN_SHOTS || '';
const CHROMIUM = process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium');
const FIXTURES = path.join(CHROMIUM, 'src/chrome/browser/meridian/workbench/test_data/agent_sessions');

// A temp home with Claude Code's and Codex's config folders, marked by the names of files they keep
// (empty here: Meridian never opens them).
function accountsHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-accounts-')));
  const mark = (dir, file) => { fs.mkdirSync(path.join(home, dir), { recursive: true }); fs.writeFileSync(path.join(home, dir, file), ''); };
  mark('.claude', 'settings.json');
  mark('.claude-work', 'settings.json');
  mark('.claude-personal', 'history.jsonl');
  mark('.codex', 'config.toml');
  mark('.codex-work', 'config.toml');
  // Named like one, but nothing of Claude Code's inside: not an account.
  fs.mkdirSync(path.join(home, '.claude-backup'));
  return home;
}

// A stand-in `claude` that answers Ask and writes down the CLAUDE_CONFIG_DIR it got.
function fakeClaude(dir) {
  const log = path.join(dir, 'log');
  fs.mkdirSync(log);
  standIn(dir, 'claude', `const fs = require('fs'), path = require('path');
const log = ${JSON.stringify(log)};
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const n = fs.readdirSync(log).filter((f) => f.endsWith('.env')).length;
fs.writeFileSync(path.join(log, n + '.env'), process.env.CLAUDE_CONFIG_DIR ?? '<unset>');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'system', subtype: 'init', session_id: 's-' + n, model: 'claude-opus-5-5' });
  const text = 'from ' + path.basename(process.env.CLAUDE_CONFIG_DIR || 'default');
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
});
`);
  return log;
}

function bridge(profile) {
  const proc = spawn(APP, ['--mcp-bridge', `--user-data-dir=${profile}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = (await request('tools/call', { name, arguments: args })).result;
    const c = r.content[0];
    const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
    return { error: r.isError ? c.text : null, value: !r.isError ? parse(c.text) : null };
  };
  return { request, call, close: () => proc.kill() };
}

async function shot(b, name) {
  if (!SHOTS) return;
  await sleep(400);
  await b.screenshot(path.join(SHOTS, `${name}.png`));
}

test('Two Claude accounts: Meridian offers Work in Work and Personal in Personal; Ask runs Claude Code as the space’s account; add, sign in, remove; MCP lists and sets', async () => {
  const home = accountsHome();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = fakeClaude(bin);
  const signins = path.join(bin, 'signins.log');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'full' } }));
  const b = await launch(['about:blank'], { profile, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`, `--meridian-test-signin-log=${signins}`] });
  const accounts = async () => JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json);
  const idOf = (all, vendor, label) => all.vendors.find((v) => v.id === vendor).accounts.find((a) => a.label === label).id;
  const ask = async (text) => {
    if (!(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    const before = await b.eval(`${AK}.querySelectorAll('.msg.assistant').length`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`${AK}.querySelectorAll('.msg.assistant').length > ${before} && !${AK}.querySelector('#stop')`, 20000);
    const answer = await b.eval(`[...${AK}.querySelectorAll('.msg.assistant')].pop().textContent.replace(/\\s+/g, ' ').trim()`);
    return answer;
  };
  const lastEnv = () => { const files = fs.readdirSync(log).filter((f) => f.endsWith('.env')).sort((a, c) => parseInt(a) - parseInt(c)); return fs.readFileSync(path.join(log, files.pop()), 'utf8'); };
  const openAi = async () => {
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('aiRows')`);
  };
  let mcp;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Two spaces named like the accounts.
    const { state } = await b.eval(`${H}.getState()`);
    const first = state.activeSpaceId;
    await b.eval(`${H}.updateSpace(${JSON.stringify(first)}, 'Work', '', '#8a8fe0', '#8a8fe0')`);
    const { spaceId: personal } = await b.eval(`${H}.createSpace('Personal', '', '', '')`);

    // Found by folder names, never called a bare "Default" (not the empty backup folder); two Codex.
    let all = await accounts();
    assert.deepEqual(all.vendors.find((v) => v.id === 'claude').accounts.map((a) => a.label), ['Claude (~/.claude)', 'Claude Personal', 'Claude Work']);
    assert.deepEqual(all.vendors.find((v) => v.id === 'codex').accounts.map((a) => a.label), ['Codex (~/.codex)', 'Codex Work']);
    assert.equal(all.vendors.find((v) => v.id === 'claude').accounts[0].default, true);
    const work = idOf(all, 'claude', 'Claude Work');
    const pers = idOf(all, 'claude', 'Claude Personal');
    const own = idOf(all, 'claude', 'Claude (~/.claude)');

    // Settings › AI: only what's here, with its accounts; the rest folded; the offer on top.
    await openAi();
    await b.waitFor(`${ST}.getElementById('ai-claude-code')?.textContent.includes('Ready')`, 15000);
    // Claude Code answers Ask (picked here; onboarding would offer it).
    await b.eval(`${ST}.getElementById('ai-claude-code').click()`);
    await b.waitFor(`${ST}.getElementById('ai-claude-code').classList.contains('on') && ${ST}.getElementById('askWith').value === 'claude-code'`);
    await b.waitFor(`!!${ST}.getElementById('accounts-claude') && !!${ST}.getElementById('accountsHint')`);
    const chips = await b.eval(`[...${ST}.querySelectorAll('#accounts-claude .sub-name')].map((e) => e.textContent.trim())`);
    assert.deepEqual(chips, ['Claude (~/.claude)', 'Claude Personal', 'Claude Work']);
    assert.equal(await b.eval(`!!${ST}.getElementById('ai-cursor')`), false, 'not installed: not a row');
    assert.equal(await b.eval(`${ST}.getElementById('moreAi').open`), false, 'More AI tools is folded');
    assert.match(await b.eval(`${ST}.getElementById('moreAi').textContent`), /Cursor/);
    const hint = await b.eval(`${ST}.getElementById('accountsHint').textContent.replace(/\\s+/g, ' ')`);
    assert.match(hint, /Different subscriptions in different spaces\?/);
    assert.match(hint, /You have three Claude and two Codex accounts\. Use .* and .*\?/);
    for (const pair of ['Claude Work in Work', 'Codex Work in Work', 'Claude Personal in Personal']) assert.ok(hint.includes(pair), `${pair}: ${hint}`);
    await shot(b, 'acc-settings-ai');

    // One click: Work runs as Work, Personal as Personal.
    await b.click(`${ST}.getElementById('accountsHintApply')`);
    await b.waitFor(`!${ST}.getElementById('accountsHint')`);
    all = await accounts();
    assert.equal(all.spaces[first].claude, work);
    assert.equal(all.spaces[personal].claude, pers);
    assert.equal(all.hint, 'applied');
    await b.waitFor(`${ST}.querySelector('#accounts-claude .row.sub .row-desc')?.textContent.trim() === 'New spaces'`);
    const where = await b.eval(`[...${ST}.querySelectorAll('#accounts-claude .row.sub')].map((e) => e.querySelector('.sub-name').textContent.trim() + ': ' + e.querySelector('.row-desc').textContent.trim())`);
    assert.deepEqual(where, ['Claude (~/.claude): New spaces', 'Claude Personal: Used in Personal', 'Claude Work: Used in Work'], 'in plain words');
    await b.eval('app.$.settings.hide()');

    // Ask in Work: Claude Code started with the Work folder; in Personal, the Personal one.
    assert.match(await ask('Hello?'), /from \.claude-work/);
    assert.equal(lastEnv(), path.join(home, '.claude-work'));
    await b.eval(`${H}.activateSpace(${JSON.stringify(personal)})`);
    await b.waitFor(`${H}.getState().then((r) => r.state.activeSpaceId === ${JSON.stringify(personal)})`);
    assert.match(await ask('And here?'), /from \.claude-personal/);
    assert.equal(lastEnv(), path.join(home, '.claude-personal'));

    // The space's menu: AI Accounts ▸ Claude (~/.claude), Claude Code's own folder: the variable is
    // taken away (its Keychain entry is keyed to it), not set to ~/.claude.
    await sleep(300);
    await b.menu(`${SB}.querySelector('.space-header')`, 'AI Accounts > Claude (~/.claude)');
    await b.waitFor(`${H}.getAiAccounts().then((r) => JSON.parse(r.json).spaces[${JSON.stringify(personal)}]?.claude === ${JSON.stringify(own)})`);
    assert.match(await ask('Default now?'), /from default/);
    assert.equal(lastEnv(), '<unset>');
    // The menu shows the choice.
    const r = await b.point(`${SB}.querySelector('.space-header')`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 });
    const menuRow = `[...${SB}.querySelector('#menu meridian-menu').shadowRoot.querySelectorAll('.menu-item')].find((m) => m.querySelector('.menu-label').textContent.trim() === 'AI Accounts')`;
    await b.waitFor(`!!${menuRow}`);
    await b.click(menuRow);
    await b.waitFor(`!!${SB}.querySelector('#submenu meridian-menu')`);
    await shot(b, 'acc-space-menu');
    const sub = await b.eval(`[...${SB}.querySelector('#submenu meridian-menu').shadowRoot.querySelectorAll('.menu-header, .menu-item')].map((m) => m.textContent.replace(/\\s+/g, ' ').trim())`);
    assert.deepEqual(sub.slice(0, 4), ['Claude', 'Claude (~/.claude)', 'Claude Personal', 'Claude Work']);
    const checked = await b.eval(`[...${SB}.querySelector('#submenu meridian-menu').shadowRoot.querySelectorAll('.menu-item')].filter((m) => m.querySelector('.menu-check')).map((m) => m.textContent.trim())`);
    assert.deepEqual(checked, ['Claude (~/.claude)', 'Codex (~/.codex)'], 'Claude: its choice; Codex: the main one');
    assert.ok(sub.includes('Codex') && sub.includes('Manage AI Accounts…'), sub.join(' | '));
    await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);

    // + Add Claude: a name only. Meridian makes a private folder of its own (beside its profiles, under
    // AI Accounts) and opens Claude Code's own sign-in for it right away (in Terminal; here written
    // down); Remove takes it off the list only.
    await openAi();
    await b.waitFor(`!!${ST}.getElementById('addAccount-claude')`);
    await b.click(`${ST}.getElementById('addAccount-claude')`);
    await b.waitFor(`!!${ST}.querySelector('.account-add input')`);
    await b.eval(`(() => { const i = ${ST}.querySelector('.account-add input'); i.value = 'Client A'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await b.waitFor(`[...${ST}.querySelectorAll('#accounts-claude .sub-name')].some((e) => e.textContent.trim() === 'Client A')`);
    const client = path.join(fs.realpathSync(profile), 'AI Accounts', 'claude-client-a');
    assert.ok(fs.statSync(client).isDirectory());
    if (process.platform !== 'win32') assert.equal(fs.statSync(client).mode & 0o777, 0o700); // no POSIX modes on Windows
    assert.ok(!fs.existsSync(path.join(home, '.claude-client-a')), 'nothing new in the home folder');
    await shot(b, 'acc-settings-add');
    for (let i = 0; i < 50 && !fs.existsSync(signins); i++) await sleep(100);
    // In the command prompt's words on Windows (it reads no single quotes).
    assert.equal(fs.readFileSync(signins, 'utf8').trim(), process.platform === 'win32'
      ? `set "CLAUDE_CONFIG_DIR=${client}" && "${path.join(bin, 'claude.exe')}"`
      : `CLAUDE_CONFIG_DIR='${client}' '${path.join(bin, 'claude')}'`, 'the copy Meridian runs');
    // Renamed in place: a click on its name.
    await b.click(`[...${ST}.querySelectorAll('#accounts-claude .sub-name')].find((e) => e.textContent.trim() === 'Client A')`);
    await b.waitFor(`!!${ST}.querySelector('.sub-name-input')`);
    await b.eval(`(() => { const i = ${ST}.querySelector('.sub-name-input'); i.value = 'Acme'; i.dispatchEvent(new Event('change')); })()`);
    await b.waitFor(`[...${ST}.querySelectorAll('#accounts-claude .sub-name')].some((e) => e.textContent.trim() === 'Acme')`);
    // ⋯ › Remove from Meridian — the folder stays.
    const acmeRow = `[...${ST}.querySelectorAll('#accounts-claude .row.sub')].find((r) => r.querySelector('.sub-name')?.textContent.trim() === 'Acme')`;
    await b.click(`${acmeRow}.querySelector('.sub-more')`);
    await b.waitFor(`!!${acmeRow}.querySelector('.sub-menu .danger')`);
    assert.match(await b.eval(`${acmeRow}.querySelector('.sub-menu .danger').textContent.replace(/\\s+/g, ' ').trim()`), /^Remove from Meridian — the folder stays$/);
    await b.click(`${acmeRow}.querySelector('.sub-menu .danger')`);
    await b.waitFor(`![...${ST}.querySelectorAll('#accounts-claude .sub-name')].some((e) => e.textContent.trim() === 'Acme')`);
    assert.ok(fs.existsSync(client), 'its folder stays');
    // Not under a hidden name: a folder outside the home is refused.
    await b.waitFor(`!!${ST}.getElementById('addAccount-codex')`);
    await b.eval(`${ST}.getElementById('addAccount-codex').click()`);
    await b.waitFor(`!!${ST}.querySelector('.account-add[data-vendor="codex"] input')`);
    await b.eval(`(() => { const i = ${ST}.querySelector('.account-add input'); i.value = '/etc/codex'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await b.waitFor(`${ST}.getElementById('aiMessage').textContent.includes('inside your home folder')`);
    await b.eval('app.$.settings.hide()');

    // MCP: names and spaces, no folders; a write sets the space's account.
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    mcp = bridge(profile);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-client', version: '1' }, capabilities: {} });
    const names = (await mcp.request('tools/list')).result.tools.map((t) => t.name);
    assert.ok(names.includes('list_ai_accounts') && names.includes('set_space_ai_account'));
    const listed = await mcp.call('list_ai_accounts');
    assert.equal(listed.error, null);
    const text = JSON.stringify(listed.value);
    assert.doesNotMatch(text, /claude-work|"dir"|\/Users\/|\/private\/|\/var\//, 'no folders or paths');
    const claude = listed.value.vendors.find((v) => v.id === 'claude');
    assert.deepEqual(claude.accounts.find((a) => a.label === 'Claude Work').spaces, [first]);
    const set = await mcp.call('set_space_ai_account', { space_id: personal, vendor: 'claude', account_id: work });
    assert.equal(set.error, null, set.error);
    assert.equal(set.value.label, 'Claude Work');
    assert.match(await ask('Via MCP?'), /from \.claude-work/);
    const bad = await mcp.call('set_space_ai_account', { space_id: personal, vendor: 'claude', account_id: 'nope' });
    assert.match(bad.error, /no such account/);
    // Back to the default through MCP.
    assert.equal((await mcp.call('set_space_ai_account', { space_id: personal, vendor: 'claude' })).error, null);
    assert.equal((await accounts()).spaces[personal]?.claude, undefined);
  } finally {
    mcp?.close();
    await b.close();
    for (const d of [home, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// A stand-in Codex that writes its session where its CODEX_HOME says (else ~/.codex) and prints it.
const FAKE_CODEX = (home) => `#!/usr/bin/python3 -I
import datetime, os, re, sys, time, uuid
HOME, FIX, T0 = ${JSON.stringify(home)}, ${JSON.stringify(FIXTURES)}, 1795600000
cwd = os.getcwd()
delta = time.time() + 1 - T0
utc = datetime.timezone.utc
def iso(m):
    t = datetime.datetime.strptime(m.group(0), '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=utc).timestamp() + delta
    return datetime.datetime.fromtimestamp(t, utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
s = open(os.path.join(FIX, 'codex-rollout.jsonl')).read()
s = re.sub(r'20\\d\\d-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z', iso, s).replace('/work/shop', cwd)
base = os.environ.get('CODEX_HOME') or os.path.join(HOME, '.codex')
p = os.path.join(base, time.strftime('sessions/%Y/%m/%d/rollout-%Y-%m-%dT%H-%M-%S-') + str(uuid.uuid4()) + '.jsonl')
os.makedirs(os.path.dirname(p), exist_ok=True)
open(p, 'w').write(s)
print('ready CODEX_HOME=' + (os.environ.get('CODEX_HOME') or '<none>'), flush=True)
sys.stdin.readline()
`;

test('Workbench: a Codex terminal in a space with a Codex account runs with its CODEX_HOME; its tab and Context Insights name the account and read its sessions; filter by account', { skip: process.platform === 'win32' && 'the stand-in agent is a Python script' }, async () => {
  const home = accountsHome();
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ai-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX(home), { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, `--meridian-agent-home=${home}`, `--meridian-accounts-home=${home}`, '--meridian-no-notify'] });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { state } = await b.eval(`${H}.getState()`);
    const space = state.activeSpaceId;
    const all = JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json);
    const workId = all.vendors.find((v) => v.id === 'codex').accounts.find((a) => a.label === 'Codex Work').id;
    await b.eval(`${H}.setSpaceAiAccount(${JSON.stringify(space)}, 'codex', ${JSON.stringify(workId)})`);

    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    const termText = `(S.activeTerm ? [...Array(S.activeTerm.xterm.buffer.active.length).keys()].map((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : '')`;
    await wb.eval(`launch('codex').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'codex' && ${termText}.includes('ready CODEX_HOME=')`, 15000);
    assert.match((await wb.eval(termText)).replace(/\n/g, ''), new RegExp(`ready CODEX_HOME=${path.join(home, '.codex-work').replace(/[.]/g, '\\.')}`));
    // The account is in the tab's settings (not on the tab).
    assert.equal(await wb.eval(`!!document.querySelector('#term-tab-list .ttab.active .acct')`), false);
    await wb.eval(`(document.querySelector('#term-tab-list .ttab.active .tab-settings').click(), true)`);
    assert.match(await wb.eval(`document.querySelector('#popover [data-row="account"]')?.innerText || ''`), /Account\s+Codex Work/);
    await wb.eval(`(document.getElementById('popover').hidden = true, true)`);

    // Its session is read from the Work account's folder, and the panel says whose it is.
    const panel = `(document.querySelector('#side-body')?.innerText || '')`;
    await wb.eval(`openPanel('insights')`);
    await wb.waitFor(`${panel}.includes('Tokens over time') && ${panel}.includes('Work account')`, 20000);

    // The space back on the default: the next Codex has no CODEX_HOME (its own ~/.codex).
    await b.eval(`${H}.setSpaceAiAccount(${JSON.stringify(space)}, 'codex', '')`);
    await wb.eval(`launch('codex').then((t) => !!t)`);
    await wb.waitFor(`S.terms.filter((t) => t.kind === 'codex').length === 2 && ${termText}.includes('ready CODEX_HOME=')`, 15000);
    assert.match((await wb.eval(termText)).replace(/\n/g, ''), /ready CODEX_HOME=<none>/);
    await wb.eval(`(document.querySelector('#term-tab-list .ttab.active .tab-settings').click(), true)`);
    assert.match(await wb.eval(`document.querySelector('#popover [data-row="account"]')?.innerText || ''`), /Account\s+Default/);
    await wb.eval(`(document.getElementById('popover').hidden = true, true)`);
    // Two accounts among the sessions: a filter. "Work" shows the Work session.
    await wb.waitFor(`!!document.querySelector('.ci-accounts [data-account="Codex Work"]')`, 20000);
    if (SHOTS) { await sleep(400); const { data } = await wb.cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, 'acc-insights.png'), Buffer.from(data, 'base64')); }
    await wb.eval(`document.querySelector('.ci-accounts [data-account="Codex Work"]').click()`);
    await wb.waitFor(`${panel}.includes('Work account') && ${panel}.includes('Tokens over time')`, 20000);
    assert.equal(await wb.eval('CI.account'), 'Codex Work');
  } finally {
    wb?.close();
    await b.close();
    for (const d of [home, project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// The owner's setup: the login environment points Claude Code at ~/.claude-personal
// (CLAUDE_CONFIG_DIR in .zshrc), and ~/.claude is a second account. ~/.claude isn't called a second
// "Default"; Settings › AI picks it for a space; Ask, a Claude Code tab and a shell there run as it
// (the variable taken away, also after the .zshrc set it again).
test('Settings › AI picks ~/.claude for a space when CLAUDE_CONFIG_DIR points elsewhere; Ask, a Claude Code tab and a shell use it', { skip: process.platform === 'win32' && 'zsh startup files (macOS, Linux)' }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-accounts-')));
  for (const dir of ['.claude', '.claude-personal']) { fs.mkdirSync(path.join(home, dir)); fs.writeFileSync(path.join(home, dir, 'settings.json'), ''); }
  const personalDir = path.join(home, '.claude-personal');
  fs.writeFileSync(path.join(home, '.zshrc'), `export CLAUDE_CONFIG_DIR=${personalDir}\n`);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ai-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = path.join(bin, 'log');
  fs.mkdirSync(log);
  // Ask runs it with the prompt on stdin; in a terminal it says what it got and waits.
  standIn(bin, 'claude', `const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? '<unset>';
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
if (process.stdin.isTTY) { console.log('ready CLAUDE_CONFIG_DIR=' + dir); process.stdin.once('data', () => process.exit(0)); return; }
const n = fs.readdirSync(${JSON.stringify(log)}).length;
fs.writeFileSync(path.join(${JSON.stringify(log)}, n + '.env'), dir);
process.stdin.resume();
process.stdin.on('end', () => {
  const out = (o) => console.log(JSON.stringify(o));
  const text = 'from ' + path.basename(process.env.CLAUDE_CONFIG_DIR || 'default');
  out({ type: 'system', subtype: 'init', session_id: 's-' + n, model: 'claude-opus-5-5' });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
});
`);
  const lastEnv = () => { const files = fs.readdirSync(log).sort((a, c) => parseInt(a) - parseInt(c)); return fs.readFileSync(path.join(log, files.pop()), 'utf8'); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { ai_provider: 'claude-code' } }));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`, `--meridian-test-login-env=CLAUDE_CONFIG_DIR=${personalDir}`, `--meridian-test-project=${project}`, `--meridian-agent-home=${home}`, '--meridian-no-notify'] });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { state } = await b.eval(`${H}.getState()`);
    const work = state.activeSpaceId;
    await b.eval(`${H}.updateSpace(${JSON.stringify(work)}, 'Work', '', '#8a8fe0', '#8a8fe0')`);
    const { spaceId: personal } = await b.eval(`${H}.createSpace('Personal', '', '', '')`);

    // The default is ~/.claude-personal ("Claude Personal"); ~/.claude is "Claude (~/.claude)", not "Default".
    const all = JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json);
    const claude = all.vendors.find((v) => v.id === 'claude').accounts;
    assert.deepEqual(claude.map((a) => [a.label, a.default]), [['Claude Personal', true], ['Claude (~/.claude)', false]]);
    const own = claude.find((a) => a.label === 'Claude (~/.claude)').id;
    const pers = claude.find((a) => a.label === 'Claude Personal').id;

    // Settings › AI: a picker per space under Claude's accounts; Work picks ~/.claude.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.eval(`${ST}.querySelector('[data-id="ai"]').click()`);
    const pick = (space) => `${ST}.querySelector('#accountSpaces-claude select[data-space="${space}"]')`;
    await b.waitFor(`!!${pick(work)} && !!${pick(personal)}`, 15000);
    assert.deepEqual(await b.eval(`[...${pick(work)}.options].map((o) => o.textContent.trim())`), ['Claude Personal', 'Claude (~/.claude)']);
    assert.equal(await b.eval(`${pick(work)}.value`), pers, 'never chose: the main one');
    await b.eval(`(() => { const s = ${pick(work)}; s.value = ${JSON.stringify(own)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await b.waitFor(`${H}.getAiAccounts().then((r) => JSON.parse(r.json).spaces[${JSON.stringify(work)}]?.claude === ${JSON.stringify(own)})`);
    await b.waitFor(`${pick(work)}.value === ${JSON.stringify(own)} && ${pick(personal)}.value === ${JSON.stringify(pers)}`);
    await b.eval('app.$.settings.hide()');

    // Ask in Work: Claude Code without CLAUDE_CONFIG_DIR (its own ~/.claude); in Personal, the default.
    const ask = async (text) => {
      if (!(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
      await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
      const before = await b.eval(`${AK}.querySelectorAll('.msg.assistant').length`);
      await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); })()`);
      await b.waitFor(`${AK}.querySelectorAll('.msg.assistant').length > ${before} && !${AK}.querySelector('#stop')`, 20000);
      return b.eval(`[...${AK}.querySelectorAll('.msg.assistant')].pop().textContent.replace(/\\s+/g, ' ').trim()`);
    };
    assert.match(await ask('Hello?'), /from default/);
    assert.equal(lastEnv(), '<unset>');
    await b.eval(`${H}.activateSpace(${JSON.stringify(personal)})`);
    await b.waitFor(`${H}.getState().then((r) => r.state.activeSpaceId === ${JSON.stringify(personal)})`);
    assert.match(await ask('And here?'), /from \.claude-personal/);
    assert.equal(lastEnv(), personalDir);
    await b.eval('app.$.ask.open = false');
    await b.eval(`${H}.activateSpace(${JSON.stringify(work)})`);
    await b.waitFor(`${H}.getState().then((r) => r.state.activeSpaceId === ${JSON.stringify(work)})`);

    // Workbench in Work: a Claude Code tab, and a shell whose .zshrc sets CLAUDE_CONFIG_DIR again.
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    const termText = `(S.activeTerm ? [...Array(S.activeTerm.xterm.buffer.active.length).keys()].map((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : '')`;
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'claude' && ${termText}.includes('ready CLAUDE_CONFIG_DIR=')`, 15000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(termText)); });
    assert.match((await wb.eval(termText)).replace(/\n/g, ''), /ready CLAUDE_CONFIG_DIR=<unset>/);
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'shell'`, 15000);
    const id = await wb.eval('S.activeTerm.id');
    await sleep(1000);
    await wb.eval(`(() => { window.workbench.ptyWrite(${JSON.stringify(id)}, 'echo "CC=\${CLAUDE_CONFIG_DIR:-none}"\\r'); return true; })()`);
    await wb.waitFor(`${termText}.includes('CC=none')`, 10000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(termText)); });
    assert.ok(!(await wb.eval(termText)).includes(`CC=${personalDir}`));
  } finally {
    process.env.HOME = savedHome;
    wb?.close();
    await b?.close();
    for (const d of [home, project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
