// Meridian Beta (the owner's side-by-side build; Info.plist MeridianBeta = true): Connect and
// Disconnect write no agent config, the updater never asks a feed or swaps the app, and the new
// features are on without any switch (Studio, the chats list). Runs only with MERIDIAN_BETA_APP
// pointing at "Meridian Beta.app/Contents/MacOS/Meridian"; a normal build skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const BETA = process.env.MERIDIAN_BETA_APP;
const skip = !BETA ? 'MERIDIAN_BETA_APP not set (a normal build has no beta)' : false;
const H = 'app.$.tabstrip.handler_';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('Beta: Connect, Disconnect and "open in Claude" write no agent config; the updater stays silent', { skip }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-betahome-')));
  const user = path.join(home, 'Library', 'Application Support', 'Code', 'User');
  const codex = path.join(home, '.codex');
  const copilot = path.join(home, '.copilot');
  const extensions = path.join(home, '.vscode', 'extensions');
  for (const d of [user, codex, copilot, path.join(extensions, 'github.copilot-chat-0.30.0'), path.join(extensions, 'openai.chatgpt-0.4.12')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(user, 'mcp.json'), JSON.stringify({ servers: { github: { type: 'http', url: 'https://x/' } } }));
  fs.writeFileSync(path.join(codex, 'config.toml'), '[mcp_servers.meridian]\ncommand = "/Applications/Meridian.app/Contents/MacOS/Meridian"\nargs = ["--mcp-bridge"]\n');
  fs.writeFileSync(path.join(copilot, 'mcp-config.json'), JSON.stringify({ mcpServers: { files: { type: 'local', command: 'npx' } } }));
  const desktop = path.join(home, 'claude_desktop_config.json');
  fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { meridian: { command: '/Applications/Meridian.app/Contents/MacOS/Meridian', args: ['--mcp-bridge'] } } }));
  const before = snapshot(home);

  let asked = 0;
  const feed = http.createServer((req, res) => { asked++; res.writeHead(404); res.end(); });
  await new Promise((r) => feed.listen(0, '127.0.0.1', r));

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const b = await launch(['about:blank'], { app: BETA, args: [`--meridian-agents-path=${bin}`, `--meridian-accounts-home=${home}`,
    `--meridian-vscode-config=${user}`, `--meridian-vscode-extensions=${extensions}`, `--meridian-copilot-config=${copilot}`,
    `--meridian-claude-desktop-config=${desktop}`, `--meridian-update-feed=http://127.0.0.1:${feed.address().port}/feed`] });
  try {
    await b.waitFor(`!!app?.$?.tabstrip?.handler_`);
    for (const id of ['vscode', 'codex', 'copilot', 'claude-desktop', 'claude', 'opencode']) {
      const c = await b.eval(`${H}.connectAgentCli(${JSON.stringify(id)})`);
      assert.equal(c.ok, false, id);
      assert.match(c.output, /в бете подключение не меняет конфиги основного Meridian/, id);
      const d = await b.eval(`${H}.disconnectAgentCli(${JSON.stringify(id)}, '')`);
      assert.equal(d.ok, false, id);
    }
    assert.deepEqual(snapshot(home), before, 'nothing in the agents\' configs changed');

    await b.eval(`${H}.checkForUpdates()`);
    await sleep(3000);
    const s = (await b.eval(`${H}.getUpdateState()`)).state;
    assert.match(s.error || '', /Meridian Beta doesn’t update itself/);
    assert.equal(await b.eval(`${H}.installUpdate().then((r) => r.started)`), false);
    assert.equal(asked, 0, 'the beta never asked the update feed');
  } finally {
    await b.close();
    feed.close();
  }
});

test('Beta: Studio and the chats list are on without any switch', { skip }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-studio-')));
  fs.writeFileSync(path.join(project, 'brief.md'), '# Brief\n');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const b = await launch(['about:blank'], { app: BETA, args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    const wb = await b.page('chrome://workbench');
    await wb.waitFor('!!S.project', 15000);
    const info = await wb.eval('window.workbench.studioInfo()');
    assert.equal(info.enabled, true);
    assert.equal(info.beta, true);
    await wb.waitFor(`document.body.dataset.chats === 'on' && !!document.querySelector('#view-chats')`, 15000);
  } finally {
    await b.close();
  }
});
