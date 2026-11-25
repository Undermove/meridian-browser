// Permission questions, answered where the person looks. The secret-file guard asks only about
// files a command really reads (a heredoc or a quoted string that mentions .env is text), its
// "Allow for this session" covers the session's subagents and ends with the session, and Mission
// Control's rows answer both kinds of question in place (Allow once / Allow for this session /
// Block / Show). Subagents stopped by their parent, or interrupted, stop showing as working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const MC = 'app.$.mission.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: runs its hooks like the real one (Mission Control's async ones, then the
// blocking guard), one step after another, and prints what the guard said.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
tdir = os.path.join(cwd, '.transcripts')
os.makedirs(os.path.join(tdir, 's1', 'subagents'), exist_ok=True)
def ev(event, session='s1', **f):
    return json.dumps(dict(hook_event_name=event, session_id=session, transcript_path=os.path.join(tdir, session + '.jsonl'), cwd=cwd, **f))
def hook(event, session='s1', **f):
    out = ''
    entries = settings['hooks'].get(event, [])
    tool = f.get('tool_name', '')
    hs = [h for e in entries if e.get('matcher', '*') == '*' or tool in e.get('matcher', '').split('|') for h in e['hooks']]
    for h in sorted(hs, key=lambda h: not h.get('async')):
        out += subprocess.run(h['command'], shell=True, input=ev(event, session, **f), text=True, capture_output=True).stdout
    return out
def status(session='s1'):
    cmd = settings['statusLine']['command']
    # (A home of its own: never the person's status line.)
    env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
    env.pop('CLAUDE_CONFIG_DIR', None)
    subprocess.run(cmd, shell=True, input=json.dumps(dict(session_id=session, transcript_path=os.path.join(tdir, session + '.jsonl'), model={'display_name': 'Opus'}, workspace={'project_dir': cwd})), text=True, capture_output=True, env=env)
def bash(label, command, session='s1', **f):
    out = hook('PreToolUse', session, tool_name='Bash', tool_input={'command': command, 'description': 'Look at .env and credentials'}, tool_use_id='u-' + label, **f)
    print(label + ' [' + out.strip() + ']', flush=True)
    hook('PostToolUse', session, tool_name='Bash', tool_input={'command': command}, tool_use_id='u-' + label, tool_response={}, **f)
hook('SessionStart', model='claude-opus-5-5', source='startup')
status()
hook('UserPromptSubmit', prompt='go')
# Text that only mentions secret files: no question.
bash('G1', "cd sub && python3 - <<'EOF'\\nimport json\\nd = {'hint': 'never cat .env or credentials.json or key.pem'}\\nprint(json.dumps(d))\\nEOF")
bash('G1b', "cat >> upload.test.mjs <<'EOF'\\ntest('skips .env', () => { /* cat .env */ });\\nEOF")
# A real read: the person answers in Mission Control.
bash('G2', 'cat .env | head -3')
# A subagent of the same session reads it another way: allowed for the session.
bash('G3', 'grep PORT ./.env', agent_id='a1', agent_type='general-purpose')
# Another session (after /clear): asked again.
bash('G4', 'cat .env', session='s2')
# Claude Code's own permission question, answered in the row.
p = subprocess.Popen(settings['hooks']['PermissionRequest'][0]['hooks'][0]['command'], shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
for e in settings['hooks']['PermissionRequest'][1:]:
    for h in e['hooks']:
        subprocess.run(h['command'], shell=True, input=ev('PermissionRequest', tool_name='Bash', tool_input={'command': 'npm test'}), text=True)
p.stdin.write(ev('PermissionRequest', tool_name='Bash', tool_input={'command': 'npm test'}, permission_suggestions=[{'type': 'addRules', 'rules': [{'toolName': 'Bash', 'ruleContent': 'npm test'}], 'behavior': 'allow', 'destination': 'localSettings'}])); p.stdin.close()
print('P1 <' + p.stdout.read().strip() + '>', flush=True)
hook('PostToolUse', tool_name='Bash', tool_input={'command': 'npm test'}, tool_use_id='u-p1', tool_response={})
# A background subagent, stopped by its parent.
hook('PreToolUse', tool_name='Agent', tool_input={'description': 'Background digger', 'subagent_type': 'general-purpose', 'prompt': 'x'}, tool_use_id='t-bg')
hook('SubagentStart', agent_id='a2', agent_type='general-purpose')
hook('PostToolUse', tool_name='Agent', tool_input={'description': 'Background digger', 'subagent_type': 'general-purpose'}, tool_use_id='t-bg', tool_response={'isAsync': True, 'status': 'async_launched', 'agentId': 'a2'})
hook('PreToolUse', agent_id='a2', agent_type='general-purpose', tool_name='Read', tool_input={'file_path': cwd + '/README.md'}, tool_use_id='r-a2')
hook('PreToolUse', tool_name='TaskStop', tool_input={'task_id': 'a2'}, tool_use_id='t-stop')
hook('PostToolUse', tool_name='TaskStop', tool_input={'task_id': 'a2'}, tool_use_id='t-stop', tool_response={})
# A background subagent whose transcript says it was interrupted (no hook says so).
hook('PreToolUse', tool_name='Agent', tool_input={'description': 'Quiet one', 'subagent_type': 'Explore', 'run_in_background': True}, tool_use_id='t-quiet')
hook('SubagentStart', agent_id='a4', agent_type='Explore')
with open(os.path.join(tdir, 's1', 'subagents', 'agent-a4.jsonl'), 'w') as f:
    f.write(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'stop_reason': 'tool_use', 'content': [{'type': 'tool_use'}]}}) + '\\n')
    f.write(json.dumps({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'text', 'text': '[Request interrupted by user for tool use]'}]}}) + '\\n')
# A foreground subagent the person interrupted (Esc): no SubagentStop, then the turn ends.
hook('PreToolUse', tool_name='Agent', tool_input={'description': 'Foreground helper', 'subagent_type': 'general-purpose'}, tool_use_id='t-fg')
hook('SubagentStart', agent_id='a3', agent_type='general-purpose')
hook('Stop')
print('ALL DONE', flush=True)
sys.stdin.readline()
`;

test('permission questions: real reads only, a session’s allowance, answers in Mission Control rows, stopped subagents', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pu-')));
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, 'sub'));
  fs.writeFileSync(path.join(project, '.env'), 'PORT=3000\n');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  // The native dialog never answers: Mission Control does.
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--meridian-test-dialog-answer=<wait>'] });
  const state = () => b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))');
  const waitState = async (pred, what, ms = 20000) => {
    const end = Date.now() + ms; let s;
    while (Date.now() < end) { s = await state(); if (pred(s)) return s; await sleep(200); }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ nodes: s?.nodes?.map((n) => [n.label, n.status, n.statusText]), asks: s?.asks })}`);
  };
  let wb;
  const term = () => wb.eval(`S.terms.find((t) => t.kind === 'claude') ? (() => { const x = S.terms.find((t) => t.kind === 'claude').xterm.buffer.active; return [...Array(x.length).keys()].map((i) => x.getLine(i)?.translateToString(true)).join('\\n'); })() : ''`);
  const waitTerm = async (re, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = (await term()).replace(/\n/g, '');
      const m = t.match(re);
      if (m) return m;
      if (Date.now() > end) throw new Error(`terminal never said ${re}:\n${t}`);
      await sleep(150);
    }
  };
  const row = (sel) => `${MC}.querySelector('#tree .row .ask ${sel}')`;
  const shot = async (name) => {
    if (!process.env.MERIDIAN_SHOTS) return;
    await sleep(400);
    const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.MERIDIAN_SHOTS, name), Buffer.from(data, 'base64'));
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('claude').then((t) => !!t)`);

    // 1. Heredocs that only mention secret files: no question at all.
    assert.equal((await waitTerm(/G1 \[(.*?)\]/))[1], '');
    assert.equal((await waitTerm(/G1b \[(.*?)\]/))[1], '');

    // 2. cat .env: the guard asks; Mission Control's row has the question's buttons.
    let s = await waitState((x) => x.asks?.some((a) => a.kind === 'secret'), 'the guard’s question');
    const ask = s.asks.find((a) => a.kind === 'secret');
    assert.equal(ask.summary, 'cat .env | head -3');
    assert.ok(ask.canAlways && ask.answerable);
    const root = s.nodes.find((n) => n.kind === 'session');
    assert.equal(ask.rowId, root.id);
    assert.equal(root.status, 'waiting');
    assert.match(root.statusText, /Needs permission: a command that may read a secret file/);
    assert.equal(s.counts.waiting, 1);
    await b.eval('app.$.tabstrip.runCommand(17, 0)');
    await b.waitFor(`!!${row('.ask-session')}`);
    assert.deepEqual(await b.eval(`[...${MC}.querySelectorAll('#tree .row .ask button')].map((x) => x.textContent.trim())`),
      ['Allow once', 'Allow for this session', 'Block', 'Show']);
    await shot('mission-secret-ask.png');
    await sleep(700);
    await b.click(row('.ask-session'));
    assert.match((await waitTerm(/G2 \[(.*?)\]/))[1], /"permissionDecision":"allow".*Allowed for this session/);
    s = await waitState((x) => !x.asks?.length && x.nodes.find((n) => n.kind === 'session')?.status !== 'waiting', 'the question to close');

    // 3. A subagent of that session reads the same file another way: no question.
    assert.match((await waitTerm(/G3 \[(.*?)\]/))[1], /"permissionDecision":"allow".*Allowed for this session/);

    // 4. Another session (/clear): asked again; Block.
    await waitState((x) => x.asks?.some((a) => a.kind === 'secret' && a.summary === 'cat .env'), 'the second session’s question');
    await b.waitFor(`!!${row('.ask-deny')}`);
    await sleep(700);
    await b.click(row('.ask-deny'));
    assert.match((await waitTerm(/G4 \[(.*?)\]/))[1], /"permissionDecision":"deny"/);

    // 5. Claude Code's own question: "Allow for this session" keeps its rule for the session only.
    await waitState((x) => x.asks?.some((a) => a.kind === 'permission'), 'Claude Code’s question');
    await b.waitFor(`!!${row('.ask-session')}`);
    await shot('mission-permission-ask.png');
    await sleep(700);
    await b.click(row('.ask-session'));
    const p1 = JSON.parse((await waitTerm(/P1 <(.*?)>/))[1]);
    assert.equal(p1.hookSpecificOutput.decision.behavior, 'allow');
    assert.deepEqual(p1.hookSpecificOutput.decision.updatedPermissions.map((r) => r.destination), ['session']);

    // 6. Subagents: stopped by the parent, interrupted (the turn ended), or their transcript says so.
    await waitTerm(/ALL DONE/);
    s = await waitState((x) => ['Background digger', 'Foreground helper'].every((l) => x.nodes.find((n) => n.label === l)?.statusText === 'Stopped'), 'stopped subagents');
    assert.ok(s.nodes.find((n) => n.label === 'Background digger').endedAt);
    const quiet = s.nodes.find((n) => n.label === 'Quiet one');
    assert.ok(quiet && !quiet.endedAt, 'a quiet background subagent still counts until its transcript is read');
    assert.equal(s.counts.working, 1, 'only the quiet one works');
    await shot('mission-stopped.png');
    s = await waitState((x) => x.nodes.find((n) => n.label === 'Quiet one')?.statusText === 'Stopped', 'the transcript check', 70000);
    assert.equal(s.counts.working, 0);
    await b.waitFor(`[...${MC}.querySelectorAll('#tree .row .pill-text')].filter((x) => x.textContent.trim() === 'Stopped').length === 3`);
  } finally {
    if (wb) wb.close();
    await b.quit();
  }
});
