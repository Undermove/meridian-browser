// AI subscriptions (1.5.2): Settings › AI shows each subscription by the person's own name with one
// true status, "+ Add Claude" (a name only: Meridian makes the folder and opens the CLI's own
// sign-in), and "Claude in each space" with "New spaces" (the main subscription, which spaces that
// never chose follow). Everything lives in the test's own home and profile: the stand-in CLIs run
// with the tests' environment, never the person's login shell, and no real Claude is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AK = 'app.$.ask.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const POSIX = process.platform !== 'win32';

// A temp home with Claude Code's folders, marked by a file name (never read by Meridian).
function homeWith(...dirs) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-subs-')));
  for (const d of dirs) { fs.mkdirSync(path.join(home, d), { recursive: true }); fs.writeFileSync(path.join(home, d, 'settings.json'), ''); }
  return home;
}

// A stand-in `claude`. Signed in = a "signed-in" file in its config folder (CLAUDE_CONFIG_DIR, else
// <home>/.claude). Run with no arguments and no terminal (its sign-in, as the test runs it), it
// "signs in": it writes .claude.json and that file. As Ask runs it, it says whose folder it got and
// writes that down; in a terminal it prints it and waits.
function fakeClaude(bin, home) {
  const log = path.join(bin, 'log');
  fs.mkdirSync(log);
  standIn(bin, 'claude', `const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const conf = process.env.CLAUDE_CONFIG_DIR || ${JSON.stringify(path.join(home, '.claude'))};
const env = process.env.CLAUDE_CONFIG_DIR ?? '<unset>';
if (args[0] === 'auth' && args[1] === 'status') {
  const ok = fs.existsSync(path.join(conf, 'signed-in'));
  console.log(JSON.stringify({ loggedIn: ok, authMethod: ok ? 'claude.ai' : 'none' }));
  process.exit(ok ? 0 : 1);
}
if (args.length === 0 && process.env.MERIDIAN_TEST_SIGNIN === '1') {
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(path.join(conf, '.claude.json'), '{}');
  fs.writeFileSync(path.join(conf, 'signed-in'), '');
  console.log('signed in to ' + conf);
  process.exit(0);
}
if (process.stdin.isTTY) { console.log('ready CLAUDE_CONFIG_DIR=' + env + ' args=' + args.join(' ')); process.stdin.once('data', () => process.exit(0)); return; }
const n = fs.readdirSync(${JSON.stringify(log)}).length;
fs.writeFileSync(path.join(${JSON.stringify(log)}, n + '.env'), env);
process.stdin.resume();
process.stdin.on('end', () => {
  const out = (o) => console.log(JSON.stringify(o));
  const text = 'from ' + path.basename(process.env.CLAUDE_CONFIG_DIR || 'default');
  out({ type: 'system', subtype: 'init', session_id: 's-' + n, model: 'claude-opus-5-5' });
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text });
});
`);
  return () => { const files = fs.readdirSync(log).sort((a, c) => parseInt(a) - parseInt(c)); return fs.readFileSync(path.join(log, files.pop()), 'utf8'); };
}

function profileDir() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { ai_provider: 'claude-code' } }));
  return profile;
}

async function openAi(b) {
  if (!(await b.eval('app.$.settings.open'))) await b.eval('app.$.tabstrip.runCommand(13, 0)');
  await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
  await b.eval(`${ST}.querySelector('[data-id="ai"]').click()`);
  await b.waitFor(`!!${ST}.getElementById('aiRows')`);
}

async function ask(b, text) {
  if (!(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
  await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
  const before = await b.eval(`${AK}.querySelectorAll('.msg.assistant').length`);
  await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = ${JSON.stringify(text)}; ${AK}.getElementById('send').click(); })()`);
  await b.waitFor(`${AK}.querySelectorAll('.msg.assistant').length > ${before} && !${AK}.querySelector('#stop')`, 20000);
  const answer = await b.eval(`[...${AK}.querySelectorAll('.msg.assistant')].pop().textContent.replace(/\\s+/g, ' ').trim()`);
  await b.eval('app.$.ask.open = false');
  return answer;
}

async function activate(b, space) {
  await b.eval(`${H}.activateSpace(${JSON.stringify(space)})`);
  await b.waitFor(`${H}.getState().then((r) => r.state.activeSpaceId === ${JSON.stringify(space)})`);
}

const rowOf = (label) => `[...${ST}.querySelectorAll('#accounts-claude .row.sub')].find((r) => r.querySelector('.sub-name')?.textContent.trim() === ${JSON.stringify(label)})`;

async function rename(b, from, to) {
  await b.click(`${rowOf(from)}.querySelector('.sub-name')`);
  await b.waitFor(`!!${ST}.querySelector('.sub-name-input')`);
  await b.eval(`(() => { const i = ${ST}.querySelector('.sub-name-input'); i.value = ${JSON.stringify(to)}; i.dispatchEvent(new Event('change')); i.blur(); return true; })()`);
  await b.waitFor(`!!${rowOf(to)}`);
}

// The owner's setup: CLAUDE_CONFIG_DIR=~/.claude-personal in the login environment, and ~/.claude
// (his work plan) next to it, both signed in.
test('Owner’s setup: imported with sensible names, renamed in place; one picker per space and New spaces; Ask, Workbench and the space menu follow', { skip: !POSIX && 'zsh startup files (macOS, Linux)' }, async () => {
  const home = homeWith('.claude', '.claude-personal');
  const personalDir = path.join(home, '.claude-personal');
  for (const d of ['.claude', '.claude-personal']) fs.writeFileSync(path.join(home, d, 'signed-in'), '');
  fs.writeFileSync(path.join(home, '.zshrc'), `export CLAUDE_CONFIG_DIR=${personalDir}\n`);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ai-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const lastEnv = fakeClaude(bin, home);
  const profile = profileDir();
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`, `--meridian-test-login-env=CLAUDE_CONFIG_DIR=${personalDir}`, `--meridian-test-project=${project}`, `--meridian-agent-home=${home}`, '--meridian-no-notify'] });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { state } = await b.eval(`${H}.getState()`);
    const work = state.activeSpaceId;
    await b.eval(`${H}.updateSpace(${JSON.stringify(work)}, 'Work', '', '#8a8fe0', '#8a8fe0')`);
    const { spaceId: personal } = await b.eval(`${H}.createSpace('Personal Space', '', '', '')`);

    // Imported: the default first, by its folder's name; nothing is a bare "Default".
    const accounts = async () => JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json).vendors.find((v) => v.id === 'claude');
    let claude = await accounts();
    assert.deepEqual(claude.accounts.map((a) => [a.label, a.default, a.main]), [['Claude Personal', true, true], ['Claude (~/.claude)', false, false]]);
    const pers = claude.accounts[0].id;
    const own = claude.accounts[1].id;
    assert.equal(claude.main, pers, 'no main kept: the CLI’s default is main, as before');

    // Settings › AI: both rows signed in, each with its folder; rename both in place.
    await openAi(b);
    await b.waitFor(`!!${rowOf('Claude Personal')} && !!${rowOf('Claude (~/.claude)')}`, 15000);
    await b.waitFor(`${rowOf('Claude Personal')}.querySelector('.sub-state')?.textContent.includes('Signed in') && ${rowOf('Claude (~/.claude)')}.querySelector('.sub-state')?.textContent.includes('Signed in')`, 15000);
    assert.equal(await b.eval(`${rowOf('Claude (~/.claude)')}.querySelector('.sub-dir').textContent`), '~/.claude');
    const text = await b.eval(`${ST}.getElementById('accounts-claude').textContent`);
    assert.doesNotMatch(text, /\bDefault\b|other spaces|no space yet/);
    await rename(b, 'Claude Personal', 'Personal Claude');
    await rename(b, 'Claude (~/.claude)', 'Work Claude');
    claude = await accounts();
    assert.deepEqual(claude.accounts.map((a) => [a.label, a.id]), [['Personal Claude', pers], ['Work Claude', own]], 'renamed, same ids');

    // Claude in each space: Work and Personal Space follow the main one; Work picks Work Claude.
    const pick = (space) => `${ST}.querySelector('#accountSpaces-claude select[data-space="${space}"]')`;
    const main = `${ST}.getElementById('mainAccount-claude')`;
    await b.waitFor(`!!${pick(work)} && !!${pick(personal)} && !!${main}`);
    assert.deepEqual(await b.eval(`[...${pick(work)}.options].map((o) => o.textContent.trim())`), ['Personal Claude', 'Work Claude']);
    assert.deepEqual(await b.eval(`[${pick(work)}.value, ${pick(personal)}.value, ${main}.value]`), [pers, pers, pers]);
    assert.deepEqual(await b.eval(`[...${ST}.querySelectorAll('#accountSpaces-claude .acc-space span')].map((s) => s.textContent.trim())`), ['Work', 'Personal Space', 'New spaces']);
    await b.eval(`(() => { const s = ${pick(work)}; s.value = ${JSON.stringify(own)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await b.waitFor(`${H}.getAiAccounts().then((r) => JSON.parse(r.json).spaces[${JSON.stringify(work)}]?.claude === ${JSON.stringify(own)})`);
    await b.waitFor(`${rowOf('Work Claude')}?.querySelector('.row-desc').textContent.trim() === 'Used in Work'`);
    assert.equal(await b.eval(`${rowOf('Personal Claude')}.querySelector('.row-desc').textContent.trim()`), 'Used in Personal Space · New spaces');
    await b.eval('app.$.settings.hide()');

    // Ask: Work runs ~/.claude (the variable taken away), Personal Space the personal folder.
    assert.match(await ask(b, 'Hello from Work?'), /from default/);
    assert.equal(lastEnv(), '<unset>');
    await activate(b, personal);
    assert.match(await ask(b, 'And here?'), /from \.claude-personal/);
    assert.equal(lastEnv(), personalDir);

    // New spaces: Work Claude. Personal Space never chose, so it follows; so does a new space.
    await openAi(b);
    await b.waitFor(`!!${main}`);
    await b.eval(`(() => { const s = ${main}; s.value = ${JSON.stringify(own)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await b.waitFor(`${H}.getAiAccounts().then((r) => JSON.parse(r.json).vendors.find((v) => v.id === 'claude').main === ${JSON.stringify(own)})`);
    await b.waitFor(`${pick(personal)}?.value === ${JSON.stringify(own)}`);
    await b.eval('app.$.settings.hide()');
    assert.match(await ask(b, 'Personal Space now?'), /from default/);
    assert.equal(lastEnv(), '<unset>');
    const { spaceId: fresh } = await b.eval(`${H}.createSpace('Side', '', '', '')`);
    await activate(b, fresh);
    assert.match(await ask(b, 'A new space?'), /from default/);
    assert.equal(lastEnv(), '<unset>');

    // The space menu: the same choice, by the names given. Side picks Personal Claude there; Settings
    // shows it.
    await sleep(300);
    await b.menu(`${SB}.querySelector('.space-header')`, 'AI Accounts > Personal Claude');
    await b.waitFor(`${H}.getAiAccounts().then((r) => JSON.parse(r.json).spaces[${JSON.stringify(fresh)}]?.claude === ${JSON.stringify(pers)})`);
    assert.match(await ask(b, 'Side again?'), /from \.claude-personal/);
    await openAi(b);
    await b.waitFor(`${pick(fresh)}?.value === ${JSON.stringify(pers)}`);
    await b.eval('app.$.settings.hide()');

    // Back to the 1.5 behaviour for New spaces (the CLI's default): the main pref goes away.
    await b.eval(`${H}.setMainAiAccount('claude', ${JSON.stringify(pers)})`);
    await b.waitFor(`${H}.getAiAccounts().then((r) => { const j = JSON.parse(r.json); return j.vendors.find((v) => v.id === 'claude').main === ${JSON.stringify(pers)} && j.spaces[${JSON.stringify(work)}]?.claude === ${JSON.stringify(own)}; })`);
    assert.match(await ask(b, 'Side follows its own choice?'), /from \.claude-personal/);

    // Workbench in Work: a Claude Code tab runs as Work Claude (~/.claude), named on its tab.
    await activate(b, work);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    const termText = `(S.activeTerm ? [...Array(S.activeTerm.xterm.buffer.active.length).keys()].map((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : '')`;
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'claude' && ${termText}.includes('ready CLAUDE_CONFIG_DIR=')`, 15000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(termText)); });
    assert.match((await wb.eval(termText)).replace(/\n/g, ''), /ready CLAUDE_CONFIG_DIR=<unset>/);
    // The account is in the tab's settings (not on the tab).
    await wb.eval(`(document.querySelector('#term-tab-list .ttab.active .tab-settings').click(), true)`);
    assert.match(await wb.eval(`document.querySelector('#popover [data-row="account"]')?.innerText || ''`), /Account\s+Work Claude/);
    await wb.eval(`(document.getElementById('popover').hidden = true, true)`);
  } finally {
    process.env.HOME = savedHome;
    wb?.close();
    await b?.close();
    for (const d of [home, project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('+ Add Claude: a name only; Meridian makes its folder, its sign-in runs, the row turns ✓ and it can be picked for a space', { skip: !POSIX && 'the sign-in command is a POSIX shell line' }, async () => {
  const home = homeWith('.claude');
  fs.writeFileSync(path.join(home, '.claude', 'signed-in'), '');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const lastEnv = fakeClaude(bin, home);
  const signins = path.join(bin, 'signins.log');
  const profile = profileDir();
  const b = await launch(['about:blank'], { profile, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`, `--meridian-test-signin-log=${signins}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { state } = await b.eval(`${H}.getState()`);
    const space = state.activeSpaceId;
    await openAi(b);
    // One Claude: just its status and + Add Claude, no names and no pickers.
    await b.waitFor(`${ST}.querySelector('#accounts-claude .row.sub.single .sub-state')?.textContent.includes('Signed in')`, 15000);
    await b.click(`${ST}.getElementById('addAccount-claude')`);
    await b.waitFor(`!!${ST}.querySelector('.account-add input')`);
    assert.match(await b.eval(`${ST}.querySelector('.account-add').textContent`), /Create and sign in/);
    await b.eval(`(() => { const i = ${ST}.querySelector('.account-add input'); i.value = 'Client X'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await b.waitFor(`!!${rowOf('Client X')}`);
    const folder = path.join(profile, 'AI Accounts', 'claude-client-x');
    assert.ok(fs.statSync(folder).isDirectory());
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(folder)).mode & 0o777, 0o700);
    await b.waitFor(`${rowOf('Client X')}.querySelector('.sub-state')?.textContent.includes('Needs sign-in')`, 15000);

    // Its sign-in was started at once (in Terminal; here written down): the newest claude, with the
    // new folder. The test runs that line the way Terminal would, as a "person" signing in.
    for (let i = 0; i < 50 && !fs.existsSync(signins); i++) await sleep(100);
    const line = fs.readFileSync(signins, 'utf8').trim();
    assert.match(line, /^CLAUDE_CONFIG_DIR='[^']*\/AI Accounts\/claude-client-x' '[^']*\/claude'$/);
    execFileSync('/bin/sh', ['-c', line], { env: { PATH: '/usr/bin:/bin', HOME: home, MERIDIAN_TEST_SIGNIN: '1' }, stdio: 'ignore' });
    assert.ok(fs.existsSync(path.join(folder, 'signed-in')));
    // Polled: ✓ without a reload.
    await b.waitFor(`${rowOf('Client X')}?.querySelector('.sub-state')?.textContent.includes('Signed in')`, 20000, `${rowOf('Client X')}?.textContent`);
    await b.waitFor(`${ST}.getElementById('aiMessage').textContent.includes('Client X is signed in')`);

    // Selectable for the space, and Ask runs as it.
    const id = await b.eval(`${rowOf('Client X')}.dataset.id`);
    const pick = `${ST}.querySelector('#accountSpaces-claude select[data-space="${space}"]')`;
    await b.waitFor(`!!${pick} && [...${pick}.options].some((o) => o.value === ${JSON.stringify(id)})`);
    await b.eval(`(() => { const s = ${pick}; s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); return true; })()`);
    await b.waitFor(`${H}.getAiAccounts().then((r) => JSON.parse(r.json).spaces[${JSON.stringify(space)}]?.claude === ${JSON.stringify(id)})`);
    await b.eval('app.$.settings.hide()');
    assert.match(await ask(b, 'As the client?'), /from claude-client-x/);
    assert.equal(fs.realpathSync(lastEnv()), fs.realpathSync(folder));

    // A name with nothing usable in it is refused with plain words.
    await openAi(b);
    await b.waitFor(`!!${ST}.getElementById('addAccount-claude')`);
    await b.click(`${ST}.getElementById('addAccount-claude')`);
    await b.waitFor(`!!${ST}.querySelector('.account-add input')`);
    await b.eval(`(() => { const i = ${ST}.querySelector('.account-add input'); i.value = '!!!'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await b.waitFor(`${ST}.getElementById('aiMessage').textContent.includes('letters or digits')`);
  } finally {
    await b.close();
    for (const d of [home, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('One Claude: Settings says just “Claude ✓ Signed in”, with no picker, and the space menu has no AI Accounts', async () => {
  const home = homeWith('.claude');
  fs.writeFileSync(path.join(home, '.claude', 'signed-in'), '');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fakeClaude(bin, home);
  const profile = profileDir();
  const b = await launch(['about:blank'], { profile, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`${H}.createSpace('Personal', '', '', '')`);
    await openAi(b);
    await b.waitFor(`${ST}.querySelector('#accounts-claude .row.sub.single .sub-state')?.textContent.includes('Signed in')`, 15000);
    const row = await b.eval(`${ST}.querySelector('#accounts-claude .row.sub.single').textContent.replace(/\\s+/g, ' ').trim()`);
    assert.match(row, /^Claude ✓ Signed in/);
    assert.equal(await b.eval(`!!${ST}.getElementById('accountSpaces-claude')`), false, 'no picker');
    assert.equal(await b.eval(`${ST}.querySelectorAll('#accounts-claude .sub-name, #accounts-claude .sub-more').length`), 0, 'no names, no ⋯');
    await b.eval('app.$.settings.hide()');
    await sleep(300);
    const r = await b.point(`${SB}.querySelector('.space-header')`);
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'right', clickCount: 1 });
    await b.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'right', clickCount: 1 });
    await b.waitFor(`!!${SB}.querySelector('#menu meridian-menu')`);
    const items = await b.eval(`[...${SB}.querySelector('#menu meridian-menu').shadowRoot.querySelectorAll('.menu-item .menu-label')].map((m) => m.textContent.trim())`);
    assert.ok(items.length > 2 && !items.includes('AI Accounts'), items.join(' | '));
    await b.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  } finally {
    await b.close();
    for (const d of [home, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

// Sessions are kept per Claude account. The owner's Work space now runs ~/.claude, while his earlier
// sessions of the project are under ~/.claude-personal: Resume lists both, each under its account's
// name, and one picked from Personal Claude goes on under Personal Claude.
test('Resume lists the project’s sessions under every Claude account; a session goes on under its own account', { skip: !POSIX && 'zsh startup files (macOS, Linux)' }, async () => {
  const home = homeWith('.claude', '.claude-personal');
  const personalDir = path.join(home, '.claude-personal');
  for (const d of ['.claude', '.claude-personal']) fs.writeFileSync(path.join(home, d, 'signed-in'), '');
  fs.writeFileSync(path.join(home, '.zshrc'), `export CLAUDE_CONFIG_DIR=${personalDir}\n`);
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ai-')));
  const slug = project.replace(/[^A-Za-z0-9]/g, '-');
  const session = (dir, id, text, ago) => {
    const f = path.join(home, dir, 'projects', slug, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    const t = new Date(Date.now() - ago);
    fs.utimesSync(f, t, t);
  };
  session('.claude-personal', 'old-1', 'Fix the checkout', 3 * 3600_000);
  session('.claude-personal', 'old-2', 'Add a price test', 26 * 3600_000);
  session('.claude', 'new-1', 'Work: the new report', 60_000);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fakeClaude(bin, home);
  const profile = profileDir();
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`, `--meridian-test-login-env=CLAUDE_CONFIG_DIR=${personalDir}`, `--meridian-test-project=${project}`, `--meridian-agent-home=${home}`, '--meridian-no-notify'] });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const { state } = await b.eval(`${H}.getState()`);
    const work = state.activeSpaceId;
    const all = JSON.parse((await b.eval(`${H}.getAiAccounts()`)).json).vendors.find((v) => v.id === 'claude').accounts;
    const pers = all.find((a) => a.default).id;
    const own = all.find((a) => !a.default).id;
    await b.eval(`${H}.renameAiAccount('claude', ${JSON.stringify(pers)}, 'Personal Claude')`);
    await b.eval(`${H}.renameAiAccount('claude', ${JSON.stringify(own)}, 'Work Claude')`);
    await b.eval(`${H}.setSpaceAiAccount(${JSON.stringify(work)}, 'claude', ${JSON.stringify(own)})`);

    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    const termText = `(S.activeTerm ? [...Array(S.activeTerm.xterm.buffer.active.length).keys()].map((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : '')`;

    // The list: the space's account first, then "Earlier sessions under Personal Claude", newest first.
    await wb.eval('void resumeClaude()');
    await wb.waitFor(`document.querySelectorAll('#modal .resume-group').length === 2`, 15000);
    const groups = await wb.eval(`[...document.querySelectorAll('#modal .resume-group')].map((g) => [g.querySelector('.resume-head').textContent, [...g.querySelectorAll('.resume-title')].map((t) => t.textContent)])`);
    assert.deepEqual(groups, [['Work Claude', ['Work: the new report']], ['Earlier sessions under Personal Claude', ['Fix the checkout', 'Add a price test']]]);
    assert.match(await wb.eval(`document.querySelector('#modal').textContent`), /3 h ago[\s\S]*yesterday/);

    // Picked from Personal Claude: runs with that account's folder, and says so.
    await wb.eval(`document.querySelector('#modal .resume-item[data-id="old-1"]').click()`);
    await wb.waitFor(`S.activeTerm?.kind === 'claude' && ${termText}.includes('ready CLAUDE_CONFIG_DIR=')`, 15000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(termText)); });
    const first = (await wb.eval(termText)).replace(/\n/g, '');
    assert.ok(first.includes(`ready CLAUDE_CONFIG_DIR=${personalDir} args=--resume old-1`), first);
    assert.match(first, /Resumed with Personal Claude/);
    // The account is in the tab's settings (not on the tab).
    await wb.eval(`(document.querySelector('#term-tab-list .ttab.active .tab-settings').click(), true)`);
    assert.match(await wb.eval(`document.querySelector('#popover [data-row="account"]')?.innerText || ''`), /Account\s+Personal Claude/);
    await wb.eval(`(document.getElementById('popover').hidden = true, true)`);
    // Kept with its account for the next start.
    await wb.waitFor(`wb.claudeSessions().then((l) => l.some((s) => s.id === 'old-1' && s.account === ${JSON.stringify(pers)}))`, 10000);

    // One of the space's own: its own account (~/.claude: the variable taken away), no note.
    await wb.eval('void resumeClaude()');
    await wb.waitFor(`!!document.querySelector('#modal .resume-item[data-id="new-1"]')`, 15000);
    await wb.eval(`document.querySelector('#modal .resume-item[data-id="new-1"]').click()`);
    await wb.waitFor(`S.terms.filter((t) => t.kind === 'claude').length === 2 && ${termText}.includes('ready CLAUDE_CONFIG_DIR=')`, 15000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(`JSON.stringify(S.terms.map((t) => [t.kind, t.sessionId, t.closed])) + ' | ' + document.querySelector('#toasts').textContent + ' | ' + ${termText}`)); });
    const second = (await wb.eval(termText)).replace(/\n/g, '');
    assert.ok(second.includes('ready CLAUDE_CONFIG_DIR=<unset> args=--resume new-1'), second);
    assert.doesNotMatch(second, /Resumed with/);
  } finally {
    process.env.HOME = savedHome;
    wb?.close();
    await b?.close();
    for (const d of [home, project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
