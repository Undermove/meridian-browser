// Mission Control: a Claude Code session started in the Workbench reports through the hooks in its
// own --settings (Meridian --mission-hook); subagents nest; summaries are redacted; a wait shows;
// the session's browser-tools client nests under it; ⇧⌘M opens the view; "Open terminal" goes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const MC = 'app.$.mission.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: runs its hooks like the real one would, waits for Enter at a permission
// prompt, then uses Meridian's browser tools through the MCP config it was given.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
mcp = json.load(open(args[args.index('--mcp-config') + 1]))['mcpServers']['meridian']
cwd = os.getcwd()
def hook(event, **fields):
    for entry in settings['hooks'].get(event, []):
        for h in entry['hooks']:
            subprocess.run(h['command'], shell=True, input=json.dumps(dict(hook_event_name=event, session_id='s1', cwd=cwd, **fields)), text=True)
hook('SessionStart', model='claude-opus-5-5', source='startup')
hook('UserPromptSubmit')
hook('PreToolUse', tool_name='Bash', tool_use_id='t1', tool_input={'command': 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 npm test'})
hook('PostToolUse', tool_name='Bash', tool_use_id='t1', tool_input={})
hook('PreToolUse', tool_name='Agent', tool_use_id='t2', tool_input={'description': 'Find the bug', 'subagent_type': 'debugger', 'prompt': 'SECRET PROMPT'})
hook('SubagentStart', agent_id='a1', agent_type='debugger')
hook('PreToolUse', tool_name='Read', tool_use_id='t3', agent_id='a1', tool_input={'file_path': os.path.join(cwd, 'src', 'app.js')})
hook('PostToolUse', tool_name='Read', tool_use_id='t3', agent_id='a1', tool_input={})
hook('PermissionRequest', tool_name='Bash', tool_use_id='t4', tool_input={'command': 'rm -rf build'})
print('WAITING FOR YOU', flush=True)
sys.stdin.readline()
hook('SubagentStop', agent_id='a1')
hook('PostToolUse', tool_name='Agent', tool_use_id='t2', tool_input={})
p = subprocess.Popen([mcp['command']] + mcp['args'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'claude-code'}}}) + '\\n')
p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'list_tabs', 'arguments': {}}}) + '\\n')
p.stdin.flush(); p.stdout.readline(); p.stdout.readline(); p.kill()
hook('Stop')
print('DONE', flush=True)
sys.stdin.readline()
`;

test('Mission Control: a Workbench session with a subagent, a wait, browser tools and history', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mc-')));
  fs.mkdirSync(path.join(project, 'src'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'read' } }));
  const b = await launch(['about:blank'], { profile, args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  const state = () => b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))');
  const waitState = async (pred, what, ms = 15000) => {
    const end = Date.now() + ms; let s;
    while (Date.now() < end) { s = await state(); if (pred(s)) return s; await sleep(200); }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s?.nodes?.map((n) => [n.label, n.status, n.statusText]))}`);
  };
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Nothing yet: the view says how to start.
    await b.eval('app.$.tabstrip.runCommand(17, 0)');
    await b.waitFor(`app.$.mission.open && !!${MC}.getElementById('empty')`);
    await b.eval('app.$.mission.hide()');

    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('claude').then((t) => !!t)`);

    // The first agent session: a heads-up that macOS will ask about notifications.
    await b.waitFor(`app.shadowRoot.getElementById('missionToast')?.textContent.includes('Your Mac will ask once')`);
    const s = await waitState((x) => x.nodes.some((n) => n.status === 'waiting'), 'the wait');
    const root = s.nodes.find((n) => n.kind === 'session');
    assert.equal(root.label, 'Claude Code');
    assert.equal(root.sublabel, 'claude-opus-5-5');
    assert.equal(root.project, path.basename(project));
    assert.match(root.statusText, /Needs permission: Bash/);
    const sub = s.nodes.find((n) => n.kind === 'subagent');
    assert.equal(sub.parentId, root.id);
    assert.equal(sub.label, 'Find the bug');
    assert.deepEqual(sub.log.map((l) => [l.name, l.summary, l.ok]), [['Read', 'src/app.js', true]]);
    const bash = root.log.find((l) => l.name === 'Bash');
    assert.ok(!JSON.stringify(s).includes('sk-ant-api03'), 'the key never reaches Mission Control');
    assert.ok(!JSON.stringify(s).includes('SECRET PROMPT'));
    assert.match(bash.summary, /^\$ ANTHROPIC_API_KEY=••• npm test$/);
    assert.equal(s.counts.waiting, 1);
    assert.equal(s.notified.length, 1);
    assert.match(s.notified[0].title, /Claude Code · .* is waiting for you/);
    // The sidebar indicator and the Workbench chip show it.
    await b.waitFor(`${SB}.querySelector('#missionButton .mission-badge')?.textContent.trim() === '1'`);
    await wb.waitFor(`document.querySelector('#mission-chip .mtext')?.textContent.includes('1 waiting for you')`);

    // ⇧⌘M: the tree and the details.
    await b.eval('app.$.tabstrip.runCommand(17, 0)');
    await b.waitFor(`${MC}.querySelectorAll('#tree .row').length === 2`);
    assert.equal(await b.eval(`${MC}.querySelector('#tree .row[data-status="waiting"] .label').textContent`), 'Claude Code');
    assert.match(await b.eval(`${MC}.querySelector('#detail .d-title').textContent`), /Claude Code/);
    // "Open terminal" goes back to the Workbench, on that terminal.
    await b.eval('app.$.tabstrip.openUrl("about:blank")');
    await sleep(400);
    await b.click(`${MC}.getElementById('reveal')`);
    await b.waitFor('!app.$.mission.open');
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.url.startsWith('chrome://workbench')`);

    // Enter answers the prompt; the session's browser tools nest under it.
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, '\\r'); return true; })()`);
    const after = await waitState((x) => x.nodes.some((n) => n.source === 'mcp') && x.nodes.find((n) => n.kind === 'session')?.statusText === 'Turn finished', 'the turn end');
    const client = after.nodes.find((n) => n.source === 'mcp');
    assert.equal(client.parentId, root.id, 'nested under its session (proved by the token hash)');
    assert.equal(client.label, 'Meridian browser tools');
    assert.equal(client.log[0].name, 'list_tabs');
    assert.equal(after.nodes.find((n) => n.kind === 'subagent').status, 'done');

    // The agent exits: done, then dismissed into history (and kept on disk).
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, '\\r'); return true; })()`);
    await waitState((x) => x.nodes.find((n) => n.id === root.id)?.status === 'done', 'the exit');
    await b.eval(`(() => { app.$.tabstrip.handler_.dismissMission(${JSON.stringify(root.id)}); return true; })()`);
    const done = await waitState((x) => x.history.length === 1, 'history');
    assert.equal(done.history[0].label, 'Claude Code');
    assert.equal(done.history[0].subagents, 1);
    for (let i = 0; i < 30 && !fs.existsSync(path.join(profile, 'Default', 'Meridian Mission History.json')); i++) await sleep(200);
    const file = path.join(profile, 'Default', 'Meridian Mission History.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].label, 'Claude Code');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
