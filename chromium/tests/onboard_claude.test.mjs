// A manager's first run with Claude: Claude Desktop (her main tool) and a Claude Code she never
// signed in to. Every step says what really happened, with one button to fix what didn't. Claude
// Desktop is a config file here (and a bridge this test starts the way Claude does), Claude Code a
// stand-in: never the real ones, nor the real home folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { launch, APP } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const OB = 'app.$.onboarding.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const H = 'app.$.tabstrip.handler_';
const ST = 'app.$.settings.shadowRoot';
const BE = 'app.$.boostEditor.shadowRoot';
const SC = 'app.$.siteControl.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The stand-in Claude Code in `dir` as Meridian finds it (claude.exe on Windows) and as a command
// names it: a shell's single quotes, the Windows command prompt's double quotes.
const WIN = process.platform === 'win32';
const claudeIn = (dir) => path.join(dir, WIN ? 'claude.exe' : 'claude');
const quoted = (dir) => WIN ? `"${claudeIn(dir)}"` : `'${claudeIn(dir)}'`;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PAGE = `<!doctype html><title>News</title><body>
<div id=promo style="height:120px;background:rgb(0,0,200)">Subscribe now!</div>
<main><h1>Story</h1><p>Text of the story.</p></main>`;

// A stand-in Claude Code: `--version`; `auth status` signed in when its account folder (its
// CLAUDE_CONFIG_DIR, else <home>/.claude) has a "signed-in" file (what `login` would leave);
// `mcp add` writes Meridian into that account's .claude.json, as Claude Code does; any other run
// answers Improve with AI.
function claude(bin, home, { version = '2.1.332', tooOld = false } = {}) {
  const runs = path.join(bin, 'runs.log');
  standIn(bin, 'claude', `const fs = require('fs'), path = require('path');
const home = ${JSON.stringify(home)};
// Only ever inside the test's home: a CLAUDE_CONFIG_DIR from anywhere else is a test leaking the
// person's real one, and fails loudly instead of writing there.
if (process.env.CLAUDE_CONFIG_DIR && !process.env.CLAUDE_CONFIG_DIR.startsWith(home + path.sep)) {
  console.error('stand-in: CLAUDE_CONFIG_DIR outside the test home'); process.exit(3);
}
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log(${JSON.stringify(version)} + ' (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') {
  if (${tooOld}) { console.error("error: unknown command 'auth'"); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: fs.existsSync(path.join(dir, 'signed-in')) })); process.exit(0);
}
if (a[0] === 'mcp' && a[1] === 'add') {
  const file = process.env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
  let j = {}; try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  j.mcpServers = { ...(j.mcpServers || {}), meridian: { type: 'stdio', command: a[a.indexOf('--') + 1], args: ['--mcp-bridge'] } };
  fs.writeFileSync(file, JSON.stringify(j));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(runs)}, ${JSON.stringify(version)} + '\\n');
let text = ''; process.stdin.on('data', (d) => { text += d; }); process.stdin.on('end', () => {
  // Improve's answer (the tour's setup then falls back to the one worked out locally).
  const out = JSON.stringify({ name: 'Calm News', css: '#promo { display: none !important; }', summary: 'Hid the banner.' });
  console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: out } } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: out }));
});`);
  return runs;
}

// A test home with Claude Code's own folder (and more account folders when asked).
function homeWith(...accounts) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-home-')));
  for (const dir of ['.claude', ...accounts]) {
    fs.mkdirSync(path.join(home, dir));
    fs.writeFileSync(path.join(home, dir, 'settings.json'), '{}');
  }
  return home;
}

function setup({ desktop = 'none', signedIn = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-onb-')));
  const bin = path.join(dir, 'bin');
  const claudeDir = path.join(dir, 'Claude');
  fs.mkdirSync(bin);
  const home = homeWith();
  if (signedIn) fs.writeFileSync(path.join(home, '.claude', 'signed-in'), '');
  const runs = claude(bin, home);
  const config = path.join(claudeDir, 'claude_desktop_config.json');
  if (desktop !== 'none') fs.mkdirSync(claudeDir);
  const signins = path.join(dir, 'signins.log');
  const args = ['--meridian-onboarding', `--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`,
    `--meridian-test-signin-log=${signins}`, '--meridian-test-ai-consent', '--lang=en-US'];
  if (desktop !== 'none') args.push(`--meridian-claude-desktop-config=${config}`);
  return { dir, bin, home, config, signins, runs, args,
    clean() { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } };
}

// Through the tour the way a person does, to `until`: Yes to the AI, Continue elsewhere.
async function walk(b, until) {
  for (let i = 0; i < 30; i++) {
    const at = await b.eval(step);
    if (at === until) return;
    if (at === 'ai') await b.click(`${OB}.getElementById('aiYes')`);
    else if (at === 'claude') await b.click(`${OB}.getElementById('restartClaude')`);
    else if (at === 'signin') throw new Error('the sign-in step is the test’s to take');
    else if (at !== 'tailor' && at) await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`(${step}) !== ${JSON.stringify(at)}`, 30000, step);
  }
  throw new Error(`never reached ${until}`);
}

const checks = (b) => b.eval(`[...${OB}.querySelectorAll('.check')].map((c) => ({ id: c.dataset.id, state: c.className.replace('check', '').trim(), text: c.textContent.replace(/\\s+/g, ' ').trim(), fix: c.querySelector('.check-fix')?.textContent.trim() || '' }))`);
const checkOf = async (b, id) => (await checks(b)).find((c) => c.id === id);
const waitCheck = (b, id, state) => b.waitFor(`[...${OB}.querySelectorAll('.check')].some((c) => c.dataset.id === ${JSON.stringify(id)} && c.classList.contains(${JSON.stringify(state)}))`, 20000, `[...${OB}.querySelectorAll('.check')].map((c) => c.dataset.id + ':' + c.className).join()`);
const clickFix = (b, id) => b.click(`${OB}.querySelector('.check-fix[data-id="${id}"]')`);

// Claude Desktop starting Meridian's MCP server: it says hello as "claude-ai".
async function desktopSaysHello(profile) {
  const proc = spawn(APP, ['--mcp-bridge', `--user-data-dir=${profile}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: proc.stdout });
  const answered = new Promise((r) => lines.once('line', r));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai', version: '1.0' }, capabilities: {} } }) + '\n');
  await answered;
  proc.kill();
}

test('first run, Claude Desktop open with other servers: Yes keeps them, the end says "needs a restart" until Claude really loads Meridian', async () => {
  const f = setup({ desktop: 'config' });
  const before = { mcpServers: { files: { command: 'npx', args: ['-y', 'files'] } }, preferences: { menuBarEnabled: true } };
  fs.writeFileSync(f.config, JSON.stringify(before));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch(['about:blank'], { profile, args: [...f.args, '--meridian-test-claude-needs-restart'] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await walk(b, 'done');
    const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
    assert.deepEqual(config.mcpServers.files, before.mcpServers.files, 'the other server stays');
    assert.deepEqual(config.preferences, before.preferences, 'Claude’s own settings stay');
    assert.deepEqual(config.mcpServers.meridian.args, ['--mcp-bridge']);
    assert.ok(fs.existsSync(`${f.config}.meridian-backup`), 'the old file is kept');

    // Honest: written is not working yet. Claude Desktop was open, so it must restart.
    await waitCheck(b, 'claude-desktop', 'restart');
    const desktop = await checkOf(b, 'claude-desktop');
    assert.match(desktop.text, /needs a restart/);
    assert.equal(desktop.fix, 'Restart Claude');
    const code = await checkOf(b, 'claude-code');
    assert.equal(code.state, 'ok');
    assert.match(code.text, /signed in and connected/);

    // Claude restarts and starts Meridian's server: now it's connected for real.
    await desktopSaysHello(profile);
    await clickFix(b, 'claude-desktop');
    await waitCheck(b, 'claude-desktop', 'ok');
    assert.match((await checkOf(b, 'claude-desktop')).text, /Claude Desktop is connected/);
    assert.equal((await checkOf(b, 'claude-desktop')).fix, '');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); f.clean(); }
});

test('first run, Claude Desktop’s config file missing: Yes makes it; the end says Claude loads it when it opens; a lost entry shows Connect, which puts it back', async () => {
  const f = setup({ desktop: 'folder' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch(['about:blank'], { profile, args: f.args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    assert.equal(fs.existsSync(f.config), false);
    await walk(b, 'done');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f.config, 'utf8')).mcpServers), ['meridian'], 'a new file with Meridian');
    await waitCheck(b, 'claude-desktop', 'waiting');
    const desktop = await checkOf(b, 'claude-desktop');
    assert.match(desktop.text, /loads Meridian when it opens/);
    assert.equal(desktop.fix, 'Open Claude');

    // Something took the entry out again (Claude rewrote its file): said, with the fix.
    fs.writeFileSync(f.config, JSON.stringify({ mcpServers: {} }));
    await b.eval('app.$.onboarding.runChecks_()');
    await waitCheck(b, 'claude-desktop', 'failed');
    assert.equal((await checkOf(b, 'claude-desktop')).fix, 'Connect');
    await clickFix(b, 'claude-desktop');
    await waitCheck(b, 'claude-desktop', 'waiting');
    assert.ok(JSON.parse(fs.readFileSync(f.config, 'utf8')).mcpServers.meridian);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); f.clean(); }
});

test('first run, no Claude Desktop, Claude Code signed out: the tour signs it in right there, then Improve with AI works', async () => {
  const f = setup({ desktop: 'none', signedIn: false });
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/news`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch([url], { profile, args: f.args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 10000);
    await b.click(`${OB}.getElementById('aiYes')`);
    // Not "Sign in…" for later in Settings: a step of its own, right after Yes.
    await b.waitFor(`${step} === 'signin'`, 15000, step);
    assert.match(await b.eval(`${OB}.querySelector('.signin-step').textContent`), /isn’t signed\s+in yet/);
    assert.equal((await b.eval(`${OB}.getElementById('signIn').textContent`)).trim(), 'Sign in to Claude');
    await b.click(`${OB}.getElementById('signIn')`);
    await b.waitFor(`/Waiting for you to sign in/.test(${OB}.getElementById('signIn').textContent)`);
    for (let i = 0; i < 50 && !fs.existsSync(f.signins); i++) await sleep(100);
    // The copy Meridian found (not whichever the Terminal's profile finds first).
    assert.equal(fs.readFileSync(f.signins, 'utf8').trim(), quoted(f.bin));
    assert.equal(await b.eval(step), 'signin', 'it waits for the sign-in');

    // The person signs in in Terminal: the tour goes on by itself, and Claude suggests the setup.
    fs.writeFileSync(path.join(f.home, '.claude', 'signed-in'), '');
    await b.waitFor(`['tailor', 'preview'].includes(${step})`, 20000, step);
    await walk(b, 'done');
    assert.equal((await b.eval(`${H}.getSettings()`)).settings.aiProvider, 'claude-code');
    await waitCheck(b, 'claude-code', 'ok');
    assert.equal(await checkOf(b, 'claude-desktop'), undefined, 'no Claude Desktop here: nothing promised about it');
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor('!app.$.onboarding.open');

    // Improve with AI, right after the tour.
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`, 15000);
    await b.click('app.$.locationIconButton');
    await b.waitFor(`app.$.siteControl.open && !!${SC}.querySelector('#boostRow, .boost-row')`);
    await b.click(`${SC}.querySelector('#boostRow')`);
    await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('improveToggle')`);
    await b.eval(`${BE}.getElementById('improveToggle').click()`);
    await b.waitFor(`${BE}.getElementById('improve')?.textContent.trim() === 'Improve with Claude Code' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve')?.textContent`);
    await b.eval(`${BE}.getElementById('improve').click()`);
    await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the banner.')`, 20000, `${BE}.getElementById('note')?.textContent`);
  } finally { await b.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); f.clean(); }
});

test('Improve with AI, Claude Code signed out: "Sign in to Claude to use AI" starts the sign-in, then the same button improves', async () => {
  const f = setup({ desktop: 'none', signedIn: false });
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/news`;
  // (No consent question in this one: the tour isn't where the person said yes to Claude Code.)
  const b = await launch([url], { args: f.args.filter((a) => a !== '--meridian-onboarding' && a !== '--meridian-test-ai-consent') });
  try {
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`, 15000);
    await b.click('app.$.locationIconButton');
    await b.waitFor(`app.$.siteControl.open && !!${SC}.querySelector('#boostRow, .boost-row')`);
    await b.click(`${SC}.querySelector('#boostRow')`);
    await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('improveToggle')`);
    await b.eval(`${BE}.getElementById('improveToggle').click()`);
    await b.waitFor(`${BE}.getElementById('improve')?.textContent.trim() === 'Sign in to Claude to use AI' && !${BE}.getElementById('improve').disabled`, 15000, `${BE}.getElementById('improve')?.textContent`);
    await b.eval(`${BE}.getElementById('improve').click()`);
    for (let i = 0; i < 50 && !fs.existsSync(f.signins); i++) await sleep(100);
    assert.equal(fs.readFileSync(f.signins, 'utf8').trim(), quoted(f.bin));
    assert.match(await b.eval(`${BE}.getElementById('note').textContent`), /Finish signing in/);
    fs.writeFileSync(path.join(f.home, '.claude', 'signed-in'), '');
    await b.waitFor(`${BE}.getElementById('improve').textContent.trim() === 'Improve with Claude Code'`, 20000, `${BE}.getElementById('improve').textContent`);
    await b.eval(`${BE}.getElementById('improve').click()`);
    await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the banner.')`, 20000, `${BE}.getElementById('note')?.textContent + ' / ' + ${BE}.getElementById('improve')?.textContent + ' / ' + app.$.boostEditor.open`);
    // Ask says the same, never a dead "Set up an AI".
    assert.ok(!(await b.eval(`${BE}.getElementById('improve').textContent`)).includes('Set up an AI'));
  } finally { await b.close(); server.close(); f.clean(); }
});

test('two Claude Codes, the old one first on the PATH: the newest is run, signed in is told right, Settings says which one', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-two-')));
  const oldBin = path.join(dir, 'usr-local-bin');
  const newBin = path.join(dir, 'local-bin');
  for (const d of [oldBin, newBin]) fs.mkdirSync(d);
  const home = homeWith();
  fs.writeFileSync(path.join(home, '.claude', 'signed-in'), '');
  // The old one can't read the new sign-in: it would say signed out.
  claude(oldBin, path.join(dir, 'nowhere'), { version: '2.1.41' });
  claude(newBin, home, { version: '2.1.332' });
  const signins = path.join(dir, 'signins.log');
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${oldBin}${path.delimiter}${newBin}`, `--meridian-accounts-home=${home}`, `--meridian-test-signin-log=${signins}`] });
  try {
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    const { providers } = await b.eval(`${H}.getAiProviders(true)`);
    const code = providers.find((p) => p.id === 'claude-code');
    assert.equal(code.signedIn, 1, 'signed in, as the newest says');
    assert.equal(code.path, claudeIn(newBin));
    assert.equal(code.copiesNote, `An older Claude Code (2.1.41) is also in ${oldBin}. Meridian uses 2.1.332 from ${newBin}.`);
    assert.match(code.loginCommand, new RegExp(`^${escaped(quoted(newBin))}`));

    // Settings › AI: signed in, and the quiet note.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`${ST}.getElementById('ai-claude-code')?.textContent.includes('Meridian uses 2.1.332')`, 15000);
    const row = await b.eval(`${ST}.getElementById('ai-claude-code').textContent.replace(/\\s+/g, ' ')`);
    assert.ok(!/Not signed in/.test(row), row);

    // Each account's chip asks the newest copy, and its sign-in runs it.
    const { accounts } = { accounts: JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json) };
    const def = accounts.vendors.find((v) => v.id === 'claude').accounts[0];
    const states = JSON.parse((await b.eval(`${H}.getAiAccountStates()`)).json);
    assert.equal(states[`claude/${def.id}`].signedIn, 1, 'the account chip says signed in too');
    await b.eval(`${H}.signInAiAccount('claude', ${JSON.stringify(def.id)})`);
    for (let i = 0; i < 50 && !fs.existsSync(signins); i++) await sleep(100);
    assert.match(fs.readFileSync(signins, 'utf8'), new RegExp(escaped(quoted(newBin))), 'its sign-in runs the newest too');
  } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a Claude Code too old for `auth status`: "Update needed" with a button, never "Not signed in"', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-old-')));
  const home = homeWith();
  claude(dir, home, { version: '1.0.3', tooOld: true });
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${dir}`, `--meridian-accounts-home=${home}`] });
  try {
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    const code = (await b.eval(`${H}.getAiProviders(true)`)).providers.find((p) => p.id === 'claude-code');
    assert.equal(code.needsUpdate, true);
    assert.equal(code.signedIn, -1, 'can’t tell, so it never says signed out');
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`!!${ST}.getElementById('ai-claude-code')`, 15000);
    const row = await b.eval(`${ST}.getElementById('ai-claude-code').textContent.replace(/\\s+/g, ' ')`);
    assert.match(row, /Update needed/);
    assert.match(row, /Update…/);
    assert.ok(!/Not signed in|Needs sign-in/.test(row), row);
  } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});

test('Settings › Connect shows what each config really has: Connected, per Claude account, Not installed; Connect and Disconnect change it', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-connect-')));
  const bin = path.join(dir, 'bin');
  const claudeDir = path.join(dir, 'Claude');
  const opencode = path.join(dir, 'opencode');
  for (const d of [bin, claudeDir, opencode]) fs.mkdirSync(d);
  const home = homeWith('.claude-work');
  fs.writeFileSync(path.join(home, '.claude', 'signed-in'), '');
  claude(bin, home);
  // Already connected before: Claude Code's own account, Claude Desktop and OpenCode.
  const entry = { command: '/Applications/Meridian.app/Contents/MacOS/Meridian', args: ['--mcp-bridge'] };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { meridian: { type: 'stdio', ...entry } } }));
  const desktop = path.join(claudeDir, 'claude_desktop_config.json');
  fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { meridian: entry, files: { command: 'npx' } } }));
  fs.writeFileSync(path.join(opencode, 'opencode.json'), JSON.stringify({ mcp: { meridian: { type: 'local', command: [entry.command, '--mcp-bridge'], enabled: true } } }));
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`,
    `--meridian-claude-desktop-config=${desktop}`, `--meridian-opencode-config=${opencode}`] });
  const state = (id) => b.eval(`${ST}.getElementById('connect-${id}')?.dataset.state`);
  try {
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`${ST}.getElementById('connect-claude')?.dataset.state === 'Connected for some accounts'`, 20000, `${ST}.getElementById('connect-claude')?.dataset.state`);
    assert.equal(await state('claude-desktop'), 'Connected');
    assert.equal(await state('opencode'), 'Connected');
    assert.equal(await state('codex'), 'Not installed');
    assert.match(await b.eval(`${ST}.querySelector('#connect-claude .connect-desc').textContent`), /Connected for Claude \(~\/\.claude\), not for Claude Work\./);
    // Plain words first; the file or command only behind Details.
    assert.equal(await b.eval(`${ST}.querySelector('#connect-claude-desktop details')?.open`), false);
    assert.equal(await b.eval(`${ST}.querySelector('#connect-claude-desktop .row-desc.mono')?.textContent`), desktop);

    // The Work account: its own Connect, run as that account.
    await b.eval(`${ST}.querySelector('#connect-claude .connect-account:not(.on) button').click()`);
    await b.waitFor(`${ST}.getElementById('connect-claude')?.dataset.state === 'Connected'`, 20000, `${ST}.getElementById('connect-claude')?.dataset.state + ' / ' + app.$.settings.connectResult_`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.claude-work', '.claude.json'), 'utf8')).mcpServers.meridian);

    // Disconnect, from the row's menu: only Meridian goes, the other server stays.
    await b.eval(`${ST}.querySelector('#connect-claude-desktop .connect-menu .btn').click()`);
    await b.waitFor(`!!${ST}.querySelector('#connect-claude-desktop .menu .danger')`);
    await b.eval(`${ST}.querySelector('#connect-claude-desktop .menu .danger').click()`);
    await b.waitFor(`${ST}.getElementById('connect-claude-desktop')?.dataset.state === 'Not connected'`, 15000);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(desktop, 'utf8')).mcpServers), ['files']);
    assert.equal(await b.eval(`${ST}.querySelector('#connect-claude-desktop .btn').textContent.trim()`), 'Connect…');

    // Each subscription's row: one true status (the Sign in on the one that needs it) and its
    // browser tools, the same as Connect's.
    await b.waitFor(`[...${ST}.querySelectorAll('#accounts-claude .row.sub')].every((r) => !!r.querySelector('.sub-state'))`, 15000);
    const rows = await b.eval(`[...${ST}.querySelectorAll('#accounts-claude .row.sub')].map((w) => w.textContent.replace(/\\s+/g, ' ').trim())`);
    assert.ok(rows.some((c) => /^Claude \(~\/\.claude\) .*New spaces ✓ Signed in Browser tools: connected/.test(c)), rows.join(' | '));
    assert.ok(rows.some((c) => /^Claude Work Not used in a space yet Needs sign-in Sign in Browser tools: connected/.test(c)), rows.join(' | '));
  } finally { await b.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
