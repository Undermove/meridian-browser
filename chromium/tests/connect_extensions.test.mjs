// Someone with only VS Code and its GitHub Copilot / Codex extensions, and no `code`, `codex` or
// `copilot` on the PATH: Connect still works, because Meridian writes the config files itself
// (merged, the old file kept): VS Code's mcp.json, Codex's config.toml, Copilot's mcp-config.json.
// Everything is in the test's own home; the rows read the same files back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const ST = 'app.$.settings.shadowRoot';
const H = 'app.$.tabstrip.handler_';

test('Only editor extensions: VS Code (Copilot), Codex (VS Code extension) and Copilot connect by file; the rows say so, and that Ask needs Claude Code', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-ext-')));
  const user = path.join(home, 'Library', 'Application Support', 'Code', 'User');
  const extensions = path.join(home, '.vscode', 'extensions');
  const copilot = path.join(home, '.copilot');
  for (const d of [user, path.join(extensions, 'github.copilot-chat-0.30.0'), path.join(extensions, 'openai.chatgpt-0.4.12'), copilot]) fs.mkdirSync(d, { recursive: true });
  const before = { servers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' } }, inputs: [] };
  fs.writeFileSync(path.join(user, 'mcp.json'), JSON.stringify(before, null, 2));
  fs.writeFileSync(path.join(copilot, 'mcp-config.json'), JSON.stringify({ mcpServers: { files: { type: 'local', command: 'npx' } } }));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const b = await launch(['about:blank'], { args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`,
    `--meridian-vscode-config=${user}`, `--meridian-vscode-extensions=${extensions}`, `--meridian-copilot-config=${copilot}`] });
  const state = (id) => `${ST}.getElementById('connect-${id}')?.dataset.state`;
  try {
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    const { clis } = await b.eval(`${H}.getAgentClis()`);
    const by = Object.fromEntries(clis.map((c) => [c.id, c]));
    assert.equal(by.vscode.found, true, 'found by its Copilot extension');
    assert.equal(by.vscode.via, 'GitHub Copilot in VS Code');
    assert.equal(by.codex.found, true);
    assert.equal(by.codex.name, 'Codex (VS Code extension)');
    assert.match(by.codex.file, /\.codex[\\/]config\.toml$/);
    assert.match(by.codex.command, /^\[mcp_servers\.meridian\]\ncommand = "[^"]+"\nargs = \["--mcp-bridge"\]\n$/);
    assert.equal(by.copilot.found, true);
    assert.equal(by.claude.found, false);

    // Settings: plain words, and Ask needs a CLI.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`${state('vscode')} === 'Not connected' && ${state('codex')} === 'Not connected'`, 20000, state('codex'));
    assert.match(await b.eval(`${ST}.querySelector('#connect-vscode .connect-desc').textContent`), /Through GitHub Copilot in VS Code/);
    assert.match(await b.eval(`${ST}.querySelector('#connect-codex .connect-needs-cli').textContent.replace(/\\s+/g, ' ')`), /To use Ask and Improve with AI, install Claude Code\. Install Claude Code/);

    // Connect each: files written, other servers kept, the first old file backed up.
    for (const id of ['vscode', 'codex', 'copilot']) {
      const { ok, output } = await b.eval(`${H}.connectAgentCli(${JSON.stringify(id)})`);
      assert.equal(ok, true, `${id}: ${output}`);
    }
    const vs = JSON.parse(fs.readFileSync(path.join(user, 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(vs.servers).sort(), ['github', 'meridian']);
    assert.deepEqual(vs.inputs, []);
    assert.equal(vs.servers.meridian.type, 'stdio');
    assert.deepEqual(vs.servers.meridian.args, ['--mcp-bridge']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(user, 'mcp.json.meridian-backup'), 'utf8')), before);
    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /^\[mcp_servers\.meridian\]\ncommand = "[^"]+"\nargs = \["--mcp-bridge"\]\n$/);
    const cp = JSON.parse(fs.readFileSync(path.join(copilot, 'mcp-config.json'), 'utf8'));
    assert.deepEqual(Object.keys(cp.mcpServers).sort(), ['files', 'meridian']);
    assert.deepEqual(cp.mcpServers.meridian.tools, ['*']);
    // Again: already there, nothing rewritten.
    assert.match((await b.eval(`${H}.connectAgentCli('codex')`)).output, /already connected/);

    // The rows read the same files: Connected.
    await b.eval('app.$.settings.hide()');
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`);
    await b.click(`${ST}.querySelector('[data-id="ai"]')`);
    await b.waitFor(`${state('vscode')} === 'Connected' && ${state('codex')} === 'Connected' && ${state('copilot')} === 'Connected'`, 20000, `${state('vscode')} + ' ' + ${state('codex')} + ' ' + ${state('copilot')}`);

    // Disconnect: only Meridian goes.
    for (const id of ['vscode', 'codex', 'copilot']) {
      const { ok, output } = await b.eval(`${H}.disconnectAgentCli(${JSON.stringify(id)}, '')`);
      assert.equal(ok, true, `${id}: ${output}`);
    }
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(user, 'mcp.json'), 'utf8')).servers), ['github']);
    assert.equal(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), '');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(copilot, 'mcp-config.json'), 'utf8')).mcpServers), ['files']);
  } finally {
    await b.close();
    for (const d of [home, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
