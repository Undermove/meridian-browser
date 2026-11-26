// The welcome tour: first start of a profile. Arc is always a fixture here (or an empty folder),
// never the real Arc data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const OB = `app.$.onboarding.shadowRoot`;
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const C = { welcomeTour: 11, importArc: 12 };

test('without Arc: hello → a setup from the apps → preview → links → done, once', async () => {
  const noArc = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-noarc-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  // (No Chrome either: the tour would offer to move in from it.)
  const args = ['--meridian-onboarding', `--meridian-arc-dir=${noArc}`, `--meridian-chrome-dir=${noArc}`, '--lang=en-US'];
  let b = await launch(['about:blank'], { profile, args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'tailor'`);
    // Without looking at the apps: the everyday setup (the same on every machine).
    await b.click(`${OB}.getElementById('useApps')`);
    await b.waitFor(`!${OB}.getElementById('useApps').classList.contains('on')`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'preview'`, 15000);
    assert.equal(await b.eval(`${OB}.querySelector('.persona').textContent`), 'Set up for everyday browsing');
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.pv-fav')].map((f) => f.title)`), ['Gmail', 'YouTube', 'Google Maps', 'WhatsApp']);
    // Leave Maps out.
    await b.click(`[...${OB}.querySelectorAll('.pv-fav')][2]`);
    await b.waitFor(`[...${OB}.querySelectorAll('.pv-fav')][2].classList.contains('off')`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`); // Not now
    await b.waitFor(`${step} === 'done'`);
    await b.click(`${OB}.getElementById('next')`); // Start browsing
    await b.waitFor(`!app.$.onboarding.open`);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Personal']);
    assert.deepEqual((await b.favorites()).map((f) => f.title), ['Gmail', 'YouTube', 'WhatsApp']);
    await b.quit();
    // Finished: the next start goes straight to the browser.
    b = await launch([], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-fav').length === 3`);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await b.eval('app.$.onboarding.open'), false);
    // Help > Welcome Tour opens it again; Skip closes it.
    await b.eval(`app.$.tabstrip.runCommand(${C.welcomeTour}, 0)`);
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('skip')`);
    await b.waitFor(`!app.$.onboarding.open`);
  } finally {
    await b.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(noArc, { recursive: true, force: true });
  }
});

test('with Arc: Bring everything, after saying macOS will ask; File > Import from Arc opens that step', async () => {
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arcDir, 'StorableSidebar.json'));
  // A cookies database the importer finds (empty is enough: the step offers sign-ins).
  fs.mkdirSync(path.join(arcDir, 'User Data', 'Default', 'Network'), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(arcDir, 'User Data', 'Default', 'Network', 'Cookies'));
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, source_scheme INTEGER)");
  db.close();
  // And Arc's archive: the rest of Arc comes along without asking.
  fs.writeFileSync(path.join(arcDir, 'StorableArchiveItems.json'), JSON.stringify({ version: 1, items: [
    'a1', { sidebarItem: { id: 'a1', data: { tab: { savedURL: 'https://example.com/old', savedTitle: 'Old Arc tab' } } },
      source: { space: { _0: 's-work' } }, archivedAt: Date.now() / 1000 - 978307200 - 3600, reason: 'manual' },
  ] }));
  const b = await launch(['about:blank'], { args: ['--meridian-onboarding', `--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'arc'`);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`), ['2 spaces', '5 tabs', '3 favorites']);
    assert.ok(await b.eval(`${OB}.getElementById('logins').classList.contains('on')`));
    await b.click(`${OB}.getElementById('next')`); // Bring everything
    // First: macOS will ask for permission.
    // macOS asks before Meridian reads the keychain; Windows asks nothing.
    if (process.platform === 'darwin') {
      await b.waitFor(`!!${OB}.querySelector('.confirm')`);
      await b.click(`${OB}.getElementById('confirmContinue')`);
    } else {
      assert.equal(await b.eval(`!!${OB}.querySelector('.confirm')`), false, 'no Mac dialog');
    }
    await b.waitFor(`${step} === 'default'`, 15000);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Work', 'Home']);
    const work = (await b.state()).spaces.find((s) => s.name === 'Work');
    assert.deepEqual((await b.eval(`app.$.tabstrip.handler_.searchArchive('Old Arc')`)).tabs.map((t) => [t.title, t.spaceId]), [['Old Arc tab', work.id]]);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    assert.match(await b.eval(`[...${OB}.querySelectorAll('.whisper')].map((e) => e.textContent).join(' ')`), /Your history and the rest came too\./);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`!app.$.onboarding.open`);
    // File > Import from Arc: straight to the Arc step.
    await b.eval(`app.$.tabstrip.runCommand(${C.importArc}, 0)`);
    await b.waitFor(`${step} === 'arc'`);
    assert.equal(await b.eval(`!!${OB}.getElementById('fresh')`), false);
    await b.click(`${OB}.getElementById('skip')`);
    await b.waitFor(`!app.$.onboarding.open`);
    // Home came from Arc's second profile: in this window, in a profile made by the import, and
    // no second tour (nor window) for it.
    const H = `app.$.tabstrip.handler_`;
    const home = (await b.state()).spaces.find((s) => s.name === 'Home');
    await b.eval(`${H}.activateSpace(${JSON.stringify(home.id)})`);
    await b.waitFor(`app.$.tabstrip.state_.profileId === 'Meridian Profile Arc 2'`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await b.eval(`app.$.onboarding.open`), false);
    assert.equal((await (await fetch(`${b.base}/json/list`)).json()).filter((t) => t.url.startsWith('chrome://webui-browser')).length, 1);
  } finally { await b.close(); fs.rmSync(arcDir, { recursive: true, force: true }); }
});

test('the very first launch: one window with the welcome tour, no Chromium first-run window', async () => {
  const b = await launch([], { firstRun: true, args: ['--meridian-onboarding'] });
  try {
    await b.waitFor(`app.$.onboarding.open`, 15000);
    await new Promise((r) => setTimeout(r, 2500));
    const targets = await (await fetch(`${b.base}/json/list`)).json();
    assert.equal(targets.filter((t) => t.url.startsWith('chrome://intro')).length, 0, 'no Chromium first-run window');
    assert.equal(targets.filter((t) => t.url.startsWith('chrome://webui-browser')).length, 1, 'one browser window');
  } finally { await b.close(); }
});

// ---- A person who has never opened Settings: what's on the computer is found and connected with one Yes.
const H = 'app.$.tabstrip.handler_';

function firstRun(answer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-firstrun-'));
  const bin = path.join(dir, 'bin');
  const empty = path.join(dir, 'none');
  const claudeDir = path.join(dir, 'Claude');
  for (const d of [bin, empty, claudeDir]) fs.mkdirSync(d);
  const log = path.join(dir, 'cli.log');
  const prompt = path.join(dir, 'prompt.txt');
  if (answer !== null) {
    standIn(bin, 'claude', `const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (a[0] === 'mcp') { fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n'); process.exit(0); }
let text = ''; process.stdin.on('data', (d) => { text += d; }); process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(prompt)}, text + '\\n' + a.join(' '));
  const out = ${JSON.stringify(answer)};
  console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: out } } }));
  console.log(JSON.stringify({ type: 'result', is_error: false, result: out }));
});`);
  }
  const config = path.join(claudeDir, 'claude_desktop_config.json');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>Docs</title><h1>${req.url}</h1>`); });
  return { dir, bin, empty, config, log, prompt, server,
    args: ['--meridian-onboarding', `--meridian-arc-dir=${empty}`, `--meridian-chrome-dir=${empty}`, `--meridian-agents-path=${bin}`, `--meridian-claude-desktop-config=${config}`, '--meridian-test-ai-consent', '--lang=en-US'],
    clean() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('first run: Claude is found, one Yes connects it, the AI suggests a setup, nothing applied until agreed, Undo', async () => {
  const answer = JSON.stringify({ title: 'Set up for your docs', spaces: [{ name: 'Reading', icon: '📚', color: '#7fbf8e' }], favorites: [{ title: 'Docs', host: 'HOST' }, { title: 'Evil', host: 'evil.example' }] });
  const f = firstRun('PLACEHOLDER');
  await new Promise((r) => f.server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${f.server.address().port}`;
  // The stand-in answers with the real host of the page.
  const script = path.join(f.bin, process.platform === 'win32' ? 'claude.cjs' : 'claude');
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('"PLACEHOLDER"', JSON.stringify(answer.replace('HOST', host))));
  fs.writeFileSync(f.config, JSON.stringify({ mcpServers: { files: { command: 'npx' } } }));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch([`http://${host}/secret-page-xyz`, `http://${host}/other`], { profile, args: f.args });
  const spaces = `${H}.getState().then(({state}) => state.spaces.map((s) => s.name))`;
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 10000);
    const said = await b.eval(`${OB}.querySelector('.step-ai').textContent`);
    assert.match(said, /We found Claude on your computer/);
    assert.match(said, /Claude Code[\s\S]*Claude Desktop/);
    assert.match(said, /signed in/, 'says what it will be able to do');
    assert.equal(fs.existsSync(f.log), false, 'nothing connected before Yes');
    const before = await b.eval(spaces);

    await b.click(`${OB}.getElementById('aiYes')`);
    await b.waitFor(`${step} === 'preview'`, 30000);
    assert.equal(await b.eval(`${OB}.querySelector('.persona').textContent`), 'Set up for your docs');
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.pv-fav')].map((x) => x.title)`), ['Docs'], 'only sites the person uses');
    assert.deepEqual(await b.eval(spaces), before, 'nothing applied yet');

    // Connected, in control, consent recorded, Ask answers with it.
    assert.match(fs.readFileSync(f.log, 'utf8'), /mcp add -s user meridian -- .*--mcp-bridge/);
    const config = JSON.parse(fs.readFileSync(f.config, 'utf8'));
    assert.ok(config.mcpServers.files && config.mcpServers.meridian, 'added next to what was there');
    const settings = await b.eval(`${H}.getSettings().then((r) => r.settings)`);
    assert.equal(settings.agentAccess, 'ask');
    assert.equal(settings.aiProvider, 'claude-code');
    assert.ok((await b.eval(`${H}.getAllowedAi().then((r) => r.allowed.map((a) => a.id))`)).includes('claude-code'));
    // Sites, never pages.
    const sent = fs.readFileSync(f.prompt, 'utf8');
    assert.ok(sent.includes(host));
    assert.ok(!sent.includes('secret-page-xyz'), 'no page address goes to the AI');

    await b.click(`${OB}.getElementById('next')`);
    if (process.platform !== 'win32') {
      // Claude Desktop reads its config when it starts: its restart and its "Allow" explained
      // first, then things to try with it (showcase.test.mjs runs them).
      await b.waitFor(`${step} === 'claude'`);
      assert.match(await b.eval(`${OB}.querySelector('.claude-step').textContent`), /isn’t saved, Claude asks\s+first/);
      await b.click(`${OB}.getElementById('restartClaude')`);
      await b.waitFor(`${step} === 'try'`);
      await b.click(`${OB}.getElementById('next')`); // Maybe later
    }
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    await b.waitFor(`${spaces}.then((n) => n.includes('Reading'))`);
    assert.equal(await b.eval(`${OB}.querySelectorAll('.try').length`), 3, 'three things to try');

    // Back to how it was.
    await b.click(`${OB}.getElementById('undoSetup')`);
    await b.waitFor(`${spaces}.then((n) => JSON.stringify(n) === ${JSON.stringify(JSON.stringify(before))})`);
    await b.waitFor(`!${OB}.getElementById('undoSetup')`);

    // Windows: Meridian can't reopen Claude there; it says what to do and promises nothing.
    if (process.platform === 'win32') {
      assert.match(await b.eval(`${OB}.querySelector('.ai-done').textContent`), /Close Claude and open it again/);
      assert.equal(await b.eval(`!!${OB}.getElementById('restartClaude')`), false);
    } else {
      assert.equal(await b.eval(`!!${OB}.querySelector('.ai-done')`), false, 'the restart was its own step');
    }

    // A hint is the real thing.
    await b.click(`${OB}.querySelector('.try[data-try="ask"]')`);
    await b.waitFor(`!app.$.onboarding.open && app.$.ask.hasAttribute('open')`);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); f.clean(); }
});

test('first run: a broken Claude config is left alone, a failing AI falls back, the tour still ends well', async () => {
  const f = firstRun('this is not json');
  await new Promise((r) => f.server.listen(0, '127.0.0.1', r));
  const broken = '{ "mcpServers": ';
  fs.writeFileSync(f.config, broken);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch([`http://127.0.0.1:${f.server.address().port}/a`], { profile, args: f.args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 10000);
    await b.click(`${OB}.getElementById('aiYes')`);
    await b.waitFor(`${step} === 'preview'`, 30000);
    assert.ok(await b.eval(`${OB}.querySelectorAll('.pv-fav').length > 0`), 'the local suggestion');
    assert.equal(fs.readFileSync(f.config, 'utf8'), broken, 'never overwritten');
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    assert.match(await b.eval(`${OB}.querySelector('.step-done').textContent`), /Claude Desktop wasn’t connected/);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); f.clean(); }
});

test('first run: "Not now" connects nothing; with nothing found there is no question, and a way to get Claude', async () => {
  const f = firstRun('{}');
  fs.writeFileSync(f.config, '{}');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['about:blank'], { profile, args: f.args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 10000);
    await b.click(`${OB}.getElementById('aiNo')`);
    await b.waitFor(`${step} === 'tailor'`);
    assert.equal(fs.existsSync(f.log), false);
    assert.equal(fs.readFileSync(f.config, 'utf8'), '{}');
    assert.equal((await b.eval(`${H}.getSettings().then((r) => r.settings)`)).agentAccess, 'off');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); f.clean(); }

  const none = firstRun(null);
  const profile2 = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.rmSync(path.dirname(none.config), { recursive: true });
  b = await launch(['about:blank'], { profile: profile2, args: none.args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'tailor'`, 10000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'preview'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    assert.equal(await b.eval(`!!${OB}.getElementById('getClaude')`), true);
  } finally { await b.close(); fs.rmSync(profile2, { recursive: true, force: true }); none.clean(); }
});

test('first run: only OpenCode on the PATH: "We found OpenCode", one Yes writes its opencode.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-firstrun-'));
  const bin = path.join(dir, 'bin');
  const empty = path.join(dir, 'none');
  for (const d of [bin, empty]) fs.mkdirSync(d);
  const log = path.join(dir, 'opencode.log');
  // Records how it is run; Connect never needs to run it.
  standIn(bin, 'opencode', `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`);
  // Its config folder isn't there yet.
  const config = path.join(dir, 'xdg', 'opencode');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch(['about:blank'], { profile, args: ['--meridian-onboarding', `--meridian-arc-dir=${empty}`, `--meridian-chrome-dir=${empty}`, `--meridian-agents-path=${bin}`, `--meridian-opencode-config=${config}`, '--meridian-test-ai-consent', '--lang=en-US'] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 10000);
    const said = await b.eval(`${OB}.querySelector('.step-ai').textContent`);
    assert.match(said, /We found OpenCode on your computer/);
    assert.doesNotMatch(said, /Claude Code|Claude Desktop|Codex/);
    assert.equal(fs.existsSync(config), false, 'nothing written before Yes');
    await b.click(`${OB}.getElementById('aiYes')`);
    await b.waitFor(`${step} !== 'ai'`, 30000);
    const written = JSON.parse(fs.readFileSync(path.join(config, 'opencode.json'), 'utf8'));
    assert.equal(written.$schema, 'https://opencode.ai/config.json');
    assert.equal(written.mcp.meridian.type, 'local');
    assert.equal(written.mcp.meridian.enabled, true);
    assert.match(written.mcp.meridian.command[0], /(Meridian|chrome)(\.exe)?$/i);
    assert.equal(written.mcp.meridian.command[1], '--mcp-bridge');
    assert.equal(fs.existsSync(path.join(config, 'opencode.jsonc')), false, 'no .jsonc made');
    assert.equal((await b.eval(`${H}.getSettings().then((r) => r.settings)`)).agentAccess, 'ask');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('first run: Cursor and VS Code found: one Yes connects both, then says to restart them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-firstrun-'));
  const bin = path.join(dir, 'bin');
  const empty = path.join(dir, 'none');
  const cursor = path.join(dir, 'home', '.cursor');
  for (const d of [bin, empty, cursor]) fs.mkdirSync(d, { recursive: true });
  const log = path.join(dir, 'code.log');
  standIn(bin, 'code', `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch(['about:blank'], { profile, args: ['--meridian-onboarding', `--meridian-arc-dir=${empty}`, `--meridian-chrome-dir=${empty}`, `--meridian-agents-path=${bin}`, `--meridian-cursor-config=${cursor}`, '--meridian-test-ai-consent', '--lang=en-US'] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 10000);
    const said = await b.eval(`${OB}.querySelector('.step-ai').textContent`);
    assert.match(said, /We found Cursor on your computer/);
    assert.match(said, /Cursor[\s\S]*VS Code/);
    assert.doesNotMatch(said, /MCP|Claude|Codex|OpenCode/);
    assert.equal(fs.existsSync(path.join(cursor, 'mcp.json')), false, 'nothing written before Yes');
    await b.click(`${OB}.getElementById('aiYes')`);
    await b.waitFor(`${step} !== 'ai'`, 30000);
    const written = JSON.parse(fs.readFileSync(path.join(cursor, 'mcp.json'), 'utf8'));
    assert.match(written.mcpServers.meridian.command, /(Meridian|chrome)(\.exe)?$/i);
    assert.deepEqual(written.mcpServers.meridian.args, ['--mcp-bridge']);
    assert.match(fs.readFileSync(log, 'utf8'), /^--add-mcp \{"name":"meridian","type":"stdio","command":"[^"]+","args":\["--mcp-bridge"\]\}\n$/);
    assert.equal((await b.eval(`${H}.getSettings().then((r) => r.settings)`)).agentAccess, 'ask');
    await b.waitFor(`${step} === 'tailor'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'preview'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    const done = await b.eval(`${OB}.getElementById('restartApps').textContent.replace(/\\s+/g, ' ').trim()`);
    assert.equal(done, 'Restart Cursor and VS Code, then ask them to do something in Meridian.');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Bugs from a recording of a real first run.
const whispers = `[...${OB}.querySelectorAll('.whisper')].map((e) => e.textContent.replace(/\\s+/g, ' ')).join(' ')`;

// One Arc sign-in, encrypted the way Arc does it on macOS.
async function arcWithOneSignIn() {
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arcDir, 'StorableSidebar.json'));
  const net = path.join(arcDir, 'User Data', 'Default', 'Network');
  fs.mkdirSync(net, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(net, 'Cookies'));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('version', '24');
    CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT,
      encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
      last_access_utc INTEGER, has_expires INTEGER, is_persistent INTEGER, priority INTEGER, samesite INTEGER,
      source_scheme INTEGER, source_port INTEGER)`);
  const key = crypto.pbkdf2Sync('test-pass', 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([crypto.createHash('sha256').update('127.0.0.1').digest(), Buffer.from('signed-in')]);
  const enc = Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
  const chrome = (ms) => BigInt(ms) * 1000n + 11644473600000000n;
  db.prepare(`INSERT INTO cookies VALUES (?, '127.0.0.1', '', 'sid', '', ?, '/', ?, 0, 0, ?, 1, 1, 1, 1, 1, 8080)`)
    .run(chrome(Date.now() - 1000), enc, chrome(Date.now() + 86400000), chrome(Date.now()));
  db.close();
  return arcDir;
}

test('first run, on this computer only: the promise is true, and a Mac says click', async () => {
  const noArc = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-noarc-'));
  const args = ['--meridian-onboarding', `--meridian-arc-dir=${noArc}`, `--meridian-chrome-dir=${noArc}`, `--meridian-agents-path=${noArc}`, '--lang=en-US'];
  const b = await launch(['about:blank'], { args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'tailor'`, 10000);
    assert.match(await b.eval(whispers), /nothing is sent anywhere/);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`[...${OB}.querySelectorAll('.lines li')].length > 0 || ${step} === 'preview'`, 15000);
    assert.doesNotMatch(await b.eval(`${OB}.getElementById('root').textContent`), /Asking/);
    await b.waitFor(`${step} === 'preview'`, 15000);
    const said = await b.eval(whispers);
    assert.match(said, /Click anything to leave it out/);
    assert.doesNotMatch(said, /Tap/);
  } finally { await b.close(); fs.rmSync(noArc, { recursive: true, force: true }); }
});

test('first run with Arc and Claude: honest about what is sent, moved-in spaces stay in the preview, one sign-in reads right', async () => {
  const f = firstRun(JSON.stringify({ title: 'Set up for reading', spaces: [{ name: 'Reading', icon: '📚', color: '#7fbf8e' }], favorites: [] }));
  // Claude Code only (no Claude for Mac): no restart step in the way.
  fs.rmSync(path.dirname(f.config), { recursive: true });
  const arcDir = await arcWithOneSignIn();
  const args = [...f.args.filter((a) => !a.startsWith('--meridian-arc-dir=')), `--meridian-arc-dir=${arcDir}`, '--meridian-arc-safe-storage=test-pass'];
  const b = await launch(['about:blank'], { args });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'arc'`, 10000);
    await b.click(`${OB}.getElementById('next')`);
    // macOS asks before Meridian reads the keychain; Windows asks nothing.
    if (process.platform === 'darwin') {
      await b.waitFor(`!!${OB}.querySelector('.confirm')`);
      await b.click(`${OB}.getElementById('confirmContinue')`);
    } else {
      assert.equal(await b.eval(`!!${OB}.querySelector('.confirm')`), false, 'no Mac dialog');
    }
    await b.waitFor(`${step} === 'ai'`, 15000);
    await b.click(`${OB}.getElementById('aiYes')`);
    await b.waitFor(`${step} === 'tailor'`, 15000);
    const asking = await b.eval(whispers);
    assert.doesNotMatch(asking, /nothing is sent/, 'Claude is being asked');
    assert.match(asking, /Claude gets your space names and the sites you use/);
    assert.match(asking, /nothing changes until you say so/);
    await b.waitFor(`${step} === 'preview'`, 30000);
    const names = (sel) => b.eval(`[...${OB}.querySelectorAll('${sel}')].map((s) => s.textContent.trim())`).then((n) => n.map((x) => x.replace(/^[^\p{L}]*/u, '')));
    assert.deepEqual(await names('.pv-space.kept'), ['Work', 'Home']);
    assert.deepEqual(await names('button.pv-space'), ['Reading']);
    assert.match(await b.eval(whispers), /Your 2 spaces stay as they are/);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'default'`);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'done'`);
    assert.match(await b.eval(whispers), /\(1 sign-in brought over\)/);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Work', 'Home', 'Reading']);
  } finally { await b.close(); fs.rmSync(arcDir, { recursive: true, force: true }); f.clean(); }
});
