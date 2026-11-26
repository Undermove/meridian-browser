// Meridian > Settings (⌘,): General, Links (Air Traffic Control), Advanced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const ST = 'app.$.settings.shadowRoot';

// Connect… on a row; on one already connected, Reconnect… from its menu.
async function clickConnect(b, row) {
  if (await b.eval(`!!${row}.querySelector('.connect-menu')`)) {
    await b.eval(`${row}.querySelector('.connect-menu .btn').click()`);
    await b.waitFor(`!!${row}.querySelector('.connect-menu .menu button')`);
    await b.eval(`${row}.querySelector('.connect-menu .menu button').click()`);
  } else {
    await b.eval(`${row}.querySelector('.btn').click()`);
  }
}
const C = { showSettings: 13 };
// Settings opens on the member's tab (Arc's); most tests then go to General.
const open = async (b, section = 'general') => {
  await b.eval(`app.$.tabstrip.runCommand(${C.showSettings}, 0)`);
  await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('member')`);
  if (section !== 'member') {
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === ${JSON.stringify(section)})`);
    await b.waitFor(`!!${ST}.getElementById(${JSON.stringify(section)})`);
  }
};
const settings = (b) => b.eval(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings)`);

test('General: sidebar side, theme and archive time apply and are kept', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['about:blank'], { profile });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b);
    await b.click(`${ST}.getElementById('sidebarRight')`);
    await b.waitFor(`app.hasAttribute('sidebar-right')`);
    // The sidebar is now right of the page.
    await b.waitFor(`app.shadowRoot.getElementById('sidebar').getBoundingClientRect().left >= app.$.contentRegion.getBoundingClientRect().right`);
    await b.click(`[...${ST}.querySelectorAll('.seg')].find((s) => s.dataset.value === 'dark')`);
    await b.waitFor(`matchMedia('(prefers-color-scheme: dark)').matches`);
    await b.eval(`(() => { const s = ${ST}.getElementById('archiveAfter'); s.value = '24'; s.dispatchEvent(new Event('change')); })()`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.archiveAfterHours === 24)`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.settings.open`);
    await b.quit();

    b = await launch([], { profile });
    await b.waitFor(`app.hasAttribute('sidebar-right')`);
    const s = await settings(b);
    assert.equal(s.appearance, 'dark');
    assert.equal(s.archiveAfterHours, 24);
    // Back to the defaults.
    await open(b);
    await b.click(`${ST}.getElementById('sidebarLeft')`);
    await b.waitFor(`!app.hasAttribute('sidebar-right')`);
    await b.click(`[...${ST}.querySelectorAll('.seg')].find((s) => s.dataset.value === 'system')`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.appearance === 'system')`);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('Links: a rule, then Try it says where a link goes; Chromium settings open in a tab', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const space = (await b.state()).spaces[0].name;
    await open(b);
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'links')`);
    await b.waitFor(`!!${ST}.getElementById('addRule')`);
    await b.click(`${ST}.getElementById('addRule')`);
    await b.waitFor(`!!${ST}.querySelector('.rule-pattern')`);
    await b.click(`${ST}.querySelector('.rule-pattern')`);
    await b.type('github.com');
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.atc.rules[0]?.pattern === 'github.com')`);
    // The new rule sends links to the first space.
    assert.match((await settings(b)).atc.rules[0].target, /^space:/);
    await b.click(`${ST}.getElementById('tryUrl')`);
    await b.type('gist.github.com/x');
    await b.waitFor(`${ST}.getElementById('tryResult').textContent.includes('${space}')`);
    assert.match(await b.eval(`${ST}.getElementById('tryResult').textContent`), /rule “github\.com”/);
    await b.eval(`(() => { const i = ${ST}.getElementById('tryUrl'); i.value = 'example.org'; i.dispatchEvent(new Event('input')); })()`);
    await b.waitFor(`${ST}.getElementById('tryResult').textContent.includes('Little Window (no rule matched)')`);
    // Deleting it.
    await b.click(`${ST}.querySelector('.rule .icon-btn.danger')`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.atc.rules.length === 0)`);

    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'general')`);
    await b.eval(`${ST}.getElementById('allSettings').scrollIntoView()`);
    await b.click(`${ST}.getElementById('allSettings')`);
    await b.waitFor(`!app.$.settings.open`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.url.startsWith('chrome://settings'))`);
  } finally { await b.close(); }
});

test('AI: choosing an access level starts the agent socket; Connect shows the exact command first', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  // Never the person's real Claude Desktop config.
  const b = await launch(['about:blank'], { profile, args: [`--meridian-claude-desktop-config=${path.join(profile, 'none', 'c.json')}`] });
  const endpoint = path.join(profile, 'Meridian Agent.json');
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Off until the person decides, but a connected agent can ask (the private socket is up).
    assert.equal((await settings(b)).agentAccess, 'off');
    await open(b);
    await b.eval(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'ai').click()`);
    await b.waitFor(`!!${ST}.getElementById('agentsAsk')`);
    await b.eval(`${ST}.getElementById('agentsAsk').click()`);
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(endpoint), 'the socket is up');
    assert.equal((await settings(b)).agentAccess, 'ask');
    // The CLIs, with the command Connect would run (never run here).
    await b.waitFor(`${ST}.querySelectorAll('.row-desc.mono').length === 4`);
    assert.match(await b.eval(`${ST}.querySelector('.row-desc.mono').textContent`), /mcp add -s user meridian -- .*(Meridian|chrome\.exe'?) --mcp-bridge/i);
    // An installed CLI's Connect… (the rows with a command), not the other AI buttons.
    const connect = `[...${ST}.querySelectorAll('.row-desc.mono')].map((d) => d.closest('.row').querySelector('.btn')).find((x) => x && !x.disabled)`;
    if (await b.eval(`!!${connect}`)) {
      await b.eval(`${connect}.click()`);
      await b.waitFor(`!!${ST}.querySelector('.command')`);
      assert.match(await b.eval(`${ST}.querySelector('.command').textContent`), /--mcp-bridge/);
      await b.eval(`[...${ST}.querySelectorAll('.confirm .btn')].find((x) => x.textContent.trim() === 'Cancel').click()`);
      await b.waitFor(`!${ST}.querySelector('.command')`);
    }
    // Off again: the socket and its token file go.
    await b.eval(`[...${ST}.querySelectorAll('.seg')].find((x) => x.dataset.name === 'agents' && x.dataset.value === 'off').click()`);
    for (let i = 0; i < 50 && fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(endpoint), false);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('AI › Connect Claude Desktop: adds "meridian" to its config, keeps the other keys and a backup, refuses broken JSON', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const dir = path.join(profile, 'Claude');
  const config = path.join(dir, 'claude_desktop_config.json');
  fs.mkdirSync(dir);
  const before = { globalShortcut: 'Alt+Space', preferences: { seenAt: 1763600000000, split: 0.42, on: true }, mcpServers: { files: { command: 'npx', args: ['-y', 'fs-server'] } } };
  fs.writeFileSync(config, JSON.stringify(before, null, 2));
  const b = await launch(['about:blank'], { profile, args: [`--meridian-claude-desktop-config=${config}`] });
  const row = `[...${ST}.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent.trim() === 'Claude Desktop')`;
  const connect = async () => {
    await clickConnect(b, row);
    await b.waitFor(`!!${ST}.querySelector('.command')`);
    assert.match(await b.eval(`${ST}.querySelector('.confirm-card').textContent`), /claude_desktop_config\.json[\s\S]*copy of the old file/);
    assert.match(await b.eval(`${ST}.querySelector('.command').textContent`), /"meridian": \{[\s\S]*"command": "[^"]+(Meridian|chrome\.exe)"[\s\S]*--mcp-bridge/i);
    await b.eval(`${ST}.getElementById('connectRun').click()`);
    await b.waitFor(`!${ST}.querySelector('.command') && !/Connecting/.test(${ST}.querySelector('#ai .group:last-child .note').textContent)`);
    return b.eval(`${ST}.querySelector('#ai .group:last-child .note').textContent`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b, 'ai');
    await b.waitFor(`!!${row} && !${row}.querySelector('.btn').disabled`);
    assert.match(await connect(), /Claude Desktop is connected[\s\S]*Quit and reopen Claude Desktop/);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentAccess === 'full')`);
    const after = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.equal(after.globalShortcut, 'Alt+Space', 'other keys stay');
    assert.deepEqual(after.preferences, before.preferences, 'numbers survive (big ones are doubles in Chromium)');
    assert.deepEqual(after.mcpServers.files, before.mcpServers.files, 'other servers stay');
    assert.deepEqual(after.mcpServers.meridian.args, ['--mcp-bridge']);
    assert.match(after.mcpServers.meridian.command, /(Meridian|chrome)(\.exe)?$/i);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${config}.meridian-backup`, 'utf8')), before, 'the old file is kept');
    // Again: nothing to change.
    assert.match(await connect(), /already connected/);
    // A file it can't read back is never overwritten.
    fs.writeFileSync(config, '{ "mcpServers": ');
    assert.match(await connect(), /wasn’t connected: .*isn’t valid JSON/);
    assert.equal(fs.readFileSync(config, 'utf8'), '{ "mcpServers": ');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('AI › Connect OpenCode: adds "meridian" to opencode.json, never touches opencode.jsonc, refuses a commented opencode.json', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  // OpenCode's config folder ($XDG_CONFIG_HOME/opencode), with the models in opencode.jsonc.
  const dir = path.join(profile, 'xdg', 'opencode');
  const json = path.join(dir, 'opencode.json');
  const jsonc = path.join(dir, 'opencode.jsonc');
  fs.mkdirSync(dir, { recursive: true });
  const models = '{\n  "$schema": "https://opencode.ai/config.json",\n  // keys are in auth.json\n  "model": "anthropic/claude-sonnet-4-5",\n  "provider": { "anthropic": { "options": { "timeout": 600000 } } },\n}\n';
  fs.writeFileSync(jsonc, models);
  const b = await launch(['about:blank'], { profile, args: [`--meridian-opencode-config=${dir}`] });
  const row = `[...${ST}.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent.trim() === 'OpenCode')`;
  const connect = async () => {
    await clickConnect(b, row);
    await b.waitFor(`!!${ST}.querySelector('.command')`);
    assert.match(await b.eval(`${ST}.querySelector('.confirm-card').textContent`), /OpenCode's MCP\s+servers in[\s\S]*opencode\.json[\s\S]*copy of the old file/);
    assert.match(await b.eval(`${ST}.querySelector('.command').textContent`), /"mcp": \{[\s\S]*"meridian": \{[\s\S]*"type": "local"[\s\S]*"command": \["[^"]+(Meridian|chrome\.exe)", "--mcp-bridge"\]/i);
    await b.eval(`${ST}.getElementById('connectRun').click()`);
    await b.waitFor(`!${ST}.querySelector('.command') && !/Connecting/.test(${ST}.querySelector('#ai .group:last-child .note').textContent)`);
    return b.eval(`${ST}.querySelector('#ai .group:last-child .note').textContent`);
  };
  const meridian = (config) => {
    assert.equal(config.mcp.meridian.type, 'local');
    assert.equal(config.mcp.meridian.enabled, true);
    assert.equal(config.mcp.meridian.command.length, 2);
    assert.match(config.mcp.meridian.command[0], /(Meridian|chrome)(\.exe)?$/i);
    assert.equal(config.mcp.meridian.command[1], '--mcp-bridge');
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b, 'ai');
    // Found by its config folder (no opencode on this PATH).
    await b.waitFor(`!!${row} && !${row}.querySelector('.btn').disabled`);
    assert.match(await b.eval(`${row}.querySelector('.row-desc.mono').textContent`), /opencode\.json$/);

    // No opencode.json yet: a new one, next to the untouched .jsonc.
    assert.match(await connect(), /OpenCode is connected \(a new config file\)[\s\S]*Restart OpenCode/);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentAccess === 'full')`);
    let config = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    meridian(config);
    assert.equal(fs.readFileSync(jsonc, 'utf8'), models, 'opencode.jsonc is byte for byte the same');
    assert.equal(fs.existsSync(`${json}.meridian-backup`), false);

    // Again: nothing to change.
    const once = fs.readFileSync(json, 'utf8');
    assert.match(await connect(), /already connected/);
    assert.equal(fs.readFileSync(json, 'utf8'), once);

    // A plain opencode.json of the person's: merged, other keys kept, the old file backed up.
    const before = { $schema: 'https://opencode.ai/config.json', theme: 'tokyonight', mcp: { files: { type: 'local', command: ['npx', 'fs-server'] } } };
    fs.writeFileSync(json, JSON.stringify(before, null, 2));
    assert.match(await connect(), /OpenCode is connected \(the old file is saved as opencode\.json\.meridian-backup\)/);
    config = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.equal(config.theme, 'tokyonight');
    assert.deepEqual(config.mcp.files, before.mcp.files, 'other servers stay');
    meridian(config);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${json}.meridian-backup`, 'utf8')), before);

    // With comments it isn't rewritten: the person is told what to add.
    const commented = '{\n  // mine\n  "theme": "tokyonight"\n}\n';
    fs.writeFileSync(json, commented);
    const said = await connect();
    assert.match(said, /OpenCode wasn’t connected: .*opencode\.json isn’t plain JSON[\s\S]*"meridian"[\s\S]*--mcp-bridge/);
    assert.equal(fs.readFileSync(json, 'utf8'), commented);
    assert.equal(fs.readFileSync(jsonc, 'utf8'), models, 'opencode.jsonc is still the same');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('AI › Connect the other agents: Cursor by its folder, Goose into its YAML, VS Code and Gemini CLI by their own command; the rest are named, not listed', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  // Config folders (never the person's real ones): Cursor's and Goose's exist, Windsurf's doesn't.
  const cursor = path.join(profile, 'home', '.cursor');
  const goose = path.join(profile, 'xdg', 'goose');
  const windsurf = path.join(profile, 'home', '.codeium', 'windsurf');
  fs.mkdirSync(cursor, { recursive: true });
  fs.mkdirSync(goose, { recursive: true });
  const yaml = 'GOOSE_PROVIDER: anthropic\nextensions:\n  developer:\n    enabled: true\n    name: developer\n    type: builtin\nGOOSE_MODE: smart_approve\n';
  fs.writeFileSync(path.join(goose, 'config.yaml'), yaml);
  // `code` and `gemini` stand-ins that record how they are run.
  const bin = path.join(profile, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(profile, 'runs.log');
  for (const name of ['code', 'gemini']) {
    standIn(bin, name, `require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + '\\n' + process.argv.slice(2).join('\\n') + '\\n\\n');`);
  }
  const b = await launch(['about:blank'], { profile, args: [`--meridian-cursor-config=${cursor}`, `--meridian-goose-config=${goose}`, `--meridian-windsurf-config=${windsurf}`, `--meridian-agents-path=${bin}`] });
  const row = (name) => `[...${ST}.querySelectorAll('.row')].find((r) => r.querySelector('.row-label')?.textContent.trim() === ${JSON.stringify(name)})`;
  const connect = async (name, card, command) => {
    await clickConnect(b, row(name));
    await b.waitFor(`!!${ST}.querySelector('.command')`);
    assert.match(await b.eval(`${ST}.querySelector('.confirm-card').textContent`), card);
    assert.match(await b.eval(`${ST}.querySelector('.command').textContent`), command);
    await b.eval(`${ST}.getElementById('connectRun').click()`);
    await b.waitFor(`!${ST}.querySelector('.command') && !/Connecting/.test(${ST}.querySelector('#ai .group:last-child .note').textContent)`);
    return b.eval(`${ST}.querySelector('#ai .group:last-child .note').textContent`);
  };
  const program = /(Meridian|chrome)(\.exe)?$/i;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b, 'ai');
    for (const name of ['Cursor', 'Goose', 'VS Code', 'Gemini CLI']) {
      await b.waitFor(`!!${row(name)} && !${row(name)}.querySelector('.btn').disabled`);
    }
    // Not installed: not a row of its own, but named.
    for (const name of ['Windsurf', 'Amp', 'Factory Droid', 'Qwen Code', 'GitHub Copilot CLI']) {
      assert.equal(await b.eval(`!!${row(name)}`), false, name);
    }
    const more = await b.eval(`${ST}.getElementById('agentsMore').textContent.replace(/\\s+/g, ' ')`);
    assert.match(more, /Also connects Windsurf, GitHub Copilot CLI, Qwen Code, Amp, Factory Droid once you install them/);
    assert.doesNotMatch(more, /Cursor|Goose|VS Code|Gemini/);
    assert.match(await b.eval(`${row('Cursor')}.querySelector('.row-desc.mono').textContent`), /\.cursor[\\/]mcp\.json$/);

    // Cursor: a new ~/.cursor/mcp.json.
    assert.match(await connect('Cursor', /Cursor's MCP\s+servers in[\s\S]*mcp\.json/, /"mcpServers": \{[\s\S]*"meridian": \{[\s\S]*"command": "[^"]+", *\n? *"args": \["--mcp-bridge"\]/),
      /Cursor is connected \(a new config file\)\. Restart Cursor to use Meridian\./);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.agentAccess === 'full')`);
    const mcp = JSON.parse(fs.readFileSync(path.join(cursor, 'mcp.json'), 'utf8'));
    assert.match(mcp.mcpServers.meridian.command, program);
    assert.deepEqual(mcp.mcpServers.meridian.args, ['--mcp-bridge']);
    assert.match(await connect('Cursor', /Cursor/, /meridian/), /already connected/);

    // Goose: added to its extensions, the rest of the file as it was.
    assert.match(await connect('Goose', /Goose's MCP\s+servers in[\s\S]*config\.yaml/, /extensions:\n  meridian:\n    enabled: true\n    type: stdio[\s\S]*cmd: "[^"]+"\n    args: \["--mcp-bridge"\]/),
      /Goose is connected \(the old file is saved as config\.yaml\.meridian-backup\)\. Restart Goose/);
    const after = fs.readFileSync(path.join(goose, 'config.yaml'), 'utf8');
    assert.ok(after.startsWith(yaml.replace('GOOSE_MODE: smart_approve\n', '') + '  meridian:\n    enabled: true\n'), after);
    assert.ok(after.endsWith('    timeout: 300\nGOOSE_MODE: smart_approve\n'), after);
    assert.match(after, /\n    cmd: "[^"\n]+"\n/);
    assert.equal(fs.readFileSync(path.join(goose, 'config.yaml.meridian-backup'), 'utf8'), yaml);

    // VS Code: its own `code --add-mcp`, shown first.
    assert.match(await connect('VS Code', /run this command/, /^code --add-mcp '\{"name":"meridian","type":"stdio","command":"[^"]+","args":\["--mcp-bridge"\]\}'$/),
      /VS Code is connected\. Restart VS Code to use Meridian\./);
    // Gemini CLI: for the person (user scope); Meridian's own flag after "--".
    assert.match(await connect('Gemini CLI', /run this command/, /^gemini mcp add -s user meridian \S+ -- --mcp-bridge$/),
      /Gemini CLI is connected\. Start a new Gemini CLI session to use Meridian\./);
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n\n').map((r) => r.split('\n'));
    assert.equal(runs.length, 2);
    assert.equal(runs[0][0], 'code');
    assert.equal(runs[0][1], '--add-mcp');
    const added = JSON.parse(runs[0][2]);
    assert.equal(added.name, 'meridian');
    assert.equal(added.type, 'stdio');
    assert.match(added.command, program);
    assert.deepEqual(added.args, ['--mcp-bridge']);
    assert.deepEqual(runs[1].slice(0, 6), ['gemini', 'mcp', 'add', '-s', 'user', 'meridian']);
    assert.match(runs[1][6], program);
    assert.deepEqual(runs[1].slice(7), ['--', '--mcp-bridge']);
    assert.equal(fs.existsSync(windsurf), false, 'nothing made for what isn’t installed');
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('The member tab: the card shows the name and since when; clicking the name changes it, and it stays', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['about:blank'], { profile });
  const MC = `${ST}.querySelector('meridian-member-card').shadowRoot`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b, 'member');
    await b.waitFor(`${MC}.querySelector('.since').textContent.startsWith('Member since')`);
    assert.match(await b.eval(`${MC}.querySelector('.no').textContent`), /^No\. \d{4} \d{4}$/);
    await b.click(`${MC}.getElementById('name')`);
    await b.waitFor(`${MC}.querySelector('input.name-input')`);
    await b.eval(`(() => { const i = ${MC}.querySelector('input.name-input'); i.value = 'Ada Lovelace'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await b.waitFor(`${MC}.getElementById('name')?.textContent.trim() === 'Ada Lovelace'`);
    // The first tab and the title carry the first name, like Arc.
    await b.waitFor(`${ST}.querySelector('.tab[data-id="member"]').textContent.trim() === 'Ada'`);
    assert.equal(await b.eval(`${ST}.querySelector('#toolbar .title').textContent.trim()`), 'Ada');
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.memberName === 'Ada Lovelace')`);
    await b.quit();
    b = await launch(['about:blank'], { profile });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await open(b, 'member');
    await b.waitFor(`${MC}.getElementById('name')?.textContent.trim() === 'Ada Lovelace'`);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('the sidebar toggle: after the traffic lights in a window, at the sidebar edge in full screen', { skip: process.platform === 'win32' ? 'Windows has its own top bar' : false }, async () => {
  const b = await launch(['about:blank']);
  const left = (id) => `app.shadowRoot.getElementById('${id}').getBoundingClientRect().left`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.ok(await b.eval(`${left('sidebarToggle')} > ${left('urlPill')} + 60`), 'room for the traffic lights');
    await b.eval(`(() => { app.fullscreenMode_ = 'browser'; return true; })()`);
    await b.waitFor(`Math.abs(${left('sidebarToggle')} - ${left('urlPill')}) < 1`);
  } finally { await b.close(); }
});
