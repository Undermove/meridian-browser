// The secret-file guard, asked less: "Don't ask again for this file in this project" (in the native
// dialog and in Mission Control's row) is remembered for the project — every later session there
// reads the file without a question, another project is still asked, Settings › AI › Workbench lists
// the file and Remove brings the question back. A command that only loads a secret file into the
// environment (`set -a; source .env.local; set +a; curl -H "Authorization: Bearer $TOKEN" …`) isn't
// held at all: Mission Control's activity notes it. Printing the environment after loading still asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const MC = 'app.$.mission.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DONT_ASK = 'Don’t ask again for this file in this project';

// A stand-in Claude Code: runs the guard like the real one for each step in steps.json (in its
// folder), one after another, and prints what the guard said. A restored tab (--resume) does nothing.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
if '--resume' in args:
    print('RESUMED', flush=True)
    sys.stdin.readline()
    sys.exit(0)
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
tdir = os.path.join(cwd, '.transcripts')
os.makedirs(tdir, exist_ok=True)
def ev(event, session, **f):
    return json.dumps(dict(hook_event_name=event, session_id=session, transcript_path=os.path.join(tdir, session + '.jsonl'), cwd=cwd, **f))
def hook(event, session, **f):
    out = ''
    tool = f.get('tool_name', '')
    hs = [h for e in settings['hooks'].get(event, []) if e.get('matcher', '*') == '*' or tool in e.get('matcher', '').split('|') for h in e['hooks']]
    for h in sorted(hs, key=lambda h: not h.get('async')):
        out += subprocess.run(h['command'], shell=True, input=ev(event, session, **f), text=True, capture_output=True).stdout
    return out
hook('SessionStart', 's1', model='claude-opus-5-5', source='startup')
hook('UserPromptSubmit', 's1', prompt='go')
for step in json.load(open(os.path.join(cwd, 'steps.json'))):
    s = step['session']
    out = hook('PreToolUse', s, tool_name='Bash', tool_input={'command': step['command']}, tool_use_id='u-' + step['label'])
    print(step['label'] + ' [' + out.strip() + ']', flush=True)
    hook('PostToolUse', s, tool_name='Bash', tool_input={'command': step['command']}, tool_use_id='u-' + step['label'], tool_response={})
print('ALL DONE', flush=True)
sys.stdin.readline()
`;

function makeProject(prefix) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, '.env'), 'API_TOKEN=sk-test-0123456789abcdef0123456789\n');
  fs.writeFileSync(path.join(project, '.env.local'), 'KAITEN_TOKEN=kt-test-0123456789abcdef0123456789\n');
  return project;
}

// One browser run on `profile` with the Workbench on `project`; the stand-in runs `steps`.
async function session(profile, bin, project, steps, dialogAnswer) {
  fs.writeFileSync(path.join(project, 'steps.json'), JSON.stringify(steps));
  const b = await launch(['about:blank'], { profile, args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', `--meridian-test-dialog-answer=${dialogAnswer}`] });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`typeof pickProject === 'function' && (!!S.project || !document.querySelector('#welcome').hidden)`, 15000);
    // (A restarted Workbench may reopen the last project: "Open folder…" picks this one.)
    await wb.eval(`S.project?.root === ${JSON.stringify(project)} || pickProject()`);
    await wb.waitFor(`S.project?.root === ${JSON.stringify(project)}`, 15000);
    await wb.eval(`launch('claude').then((t) => { window.__so = t; return !!t; })`);
  } catch (e) {
    try { wb?.close(); } catch {}
    await b.quit();
    throw e;
  }
  const term = () => wb.eval(`window.__so ? (() => { const x = window.__so.xterm.buffer.active; return [...Array(x.length).keys()].map((i) => x.getLine(i)?.translateToString(true)).join('\\n'); })() : ''`);
  const out = async (label, ms = 20000) => {
    const re = new RegExp(`${label} \\[(.*?)\\]`);
    const end = Date.now() + ms;
    for (;;) {
      const t = (await term()).replace(/\n/g, '');
      const m = t.match(re);
      if (m) return m[1];
      if (Date.now() > end) throw new Error(`terminal never said ${label}:\n${t}`);
      await sleep(150);
    }
  };
  const state = () => b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))');
  const waitState = async (pred, what, ms = 20000) => {
    const end = Date.now() + ms; let s;
    while (Date.now() < end) { s = await state(); if (pred(s)) return s; await sleep(200); }
    throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ asks: s?.asks, logs: s?.nodes?.map((n) => n.log) })}`);
  };
  const shot = async (name) => {
    if (!process.env.MERIDIAN_SHOTS) return;
    await sleep(500);
    const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.MERIDIAN_SHOTS, name), Buffer.from(data, 'base64'));
  };
  const openSettingsAi = async () => {
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('member')`);
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'ai')`);
    await b.waitFor(`!!${ST}.getElementById('workbenchGroup')`);
    await b.eval(`${ST}.getElementById('workbenchGroup').scrollIntoView({ block: 'center' })`);
  };
  const optouts = () => b.eval(`[...${ST}.querySelectorAll('#workbenchGroup .secret-optout')].map((r) => r.querySelector('.row-label').textContent.trim() + ' | ' + r.querySelector('.row-desc').textContent.trim())`);
  const row = (sel) => `${MC}.querySelector('#tree .row .ask ${sel}')`;
  return { b, wb, out, state, waitState, shot, openSettingsAi, optouts, row,
    async end() { try { wb.close(); } catch {} await b.quit(); } };
}

test('secret files: don’t ask again in this project; loading into the environment isn’t asked', { skip: process.platform === 'win32' && 'the stand-in Claude Code is a Python script' }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const projectA = makeProject('meridian-so-a-');
  const projectB = makeProject('meridian-so-b-');
  const ownersCommand = 'set -a; source .env.local 2>/dev/null; set +a; curl -s -H "Authorization: Bearer $KAITEN_TOKEN" "https://example.invalid/api/latest/cards?limit=5"';
  let s;
  try {
    // 1. Project A. The native dialog never answers: Mission Control's row does.
    s = await session(profile, bin, projectA, [
      { label: 'S1', session: 's1', command: 'cat .env' },
      { label: 'S2', session: 's2', command: 'cat .env | head -3' },
      { label: 'S3', session: 's2', command: ownersCommand },
      { label: 'S4', session: 's2', command: 'source .env.local && env' },
    ], '<wait>');
    let st = await s.waitState((x) => x.asks?.some((a) => a.kind === 'secret'), 'the first question');
    const ask = st.asks.find((a) => a.kind === 'secret');
    assert.equal(ask.summary, 'cat .env');
    assert.ok(ask.canProject, 'a question about a file offers “Don’t ask again in this project”');
    await s.b.eval('app.$.tabstrip.runCommand(17, 0)');
    await s.b.waitFor(`!!${s.row('.ask-project')}`);
    assert.deepEqual(await s.b.eval(`[...${MC}.querySelectorAll('#tree .row .ask button')].map((x) => x.textContent.trim())`),
      ['Allow once', 'Allow for this session', 'Don’t ask again in this project', 'Block', 'Show']);
    await s.shot('so-mission-row.png');
    await sleep(700);
    await s.b.click(s.row('.ask-project'));
    assert.match(await s.out('S1'), /"permissionDecision":"allow".*won't be asked about this file in this project again/);

    // Another session in the same project: not asked (the dialog would wait forever).
    assert.match(await s.out('S2'), /"permissionDecision":"allow".*chose not to be asked about this file in this project/);
    // The owner's command: only loads .env.local into the environment. No question, no opinion
    // (Claude Code's own permissions decide), a quiet line in the session's activity.
    assert.equal(await s.out('S3'), '');
    st = await s.waitState((x) => x.nodes.some((n) => n.log?.some((e) => e.summary === 'Loaded .env.local into the environment')), 'the activity note');
    assert.ok(!st.asks?.some((a) => a.kind === 'secret' && a.summary.includes('KAITEN')), 'loading wasn’t asked');
    // Loading, then printing the environment: asked. Block.
    st = await s.waitState((x) => x.asks?.some((a) => a.kind === 'secret' && a.summary === 'source .env.local && env'), 'the env question');
    assert.ok(st.asks.find((a) => a.kind === 'secret').canProject);
    await s.b.waitFor(`!!${s.row('.ask-deny')}`);
    await sleep(700);
    await s.b.click(s.row('.ask-deny'));
    assert.match(await s.out('S4'), /"permissionDecision":"deny"/);
    await s.b.key('Escape', 'Escape', 27);

    // Settings › AI › Workbench lists the file, in its project.
    await s.openSettingsAi();
    assert.deepEqual(await s.optouts(), [`.env | in ${path.basename(projectA)}`]);
    await s.shot('so-settings-list.png');
    await s.end(); s = null;

    // 2. Project B: its .env is another file, asked about. Block. Then Remove in Settings.
    s = await session(profile, bin, projectB, [{ label: 'B1', session: 's1', command: 'cat .env' }], '<wait>');
    await s.waitState((x) => x.asks?.some((a) => a.kind === 'secret' && a.summary === 'cat .env'), 'project B’s question');
    await s.b.eval('app.$.tabstrip.runCommand(17, 0)');
    await s.b.waitFor(`!!${s.row('.ask-deny')}`);
    await sleep(700);
    await s.b.click(s.row('.ask-deny'));
    assert.match(await s.out('B1'), /"permissionDecision":"deny"/);
    await s.b.key('Escape', 'Escape', 27);
    await s.openSettingsAi();
    assert.deepEqual(await s.optouts(), [`.env | in ${path.basename(projectA)}`]);
    await s.b.click(`${ST}.querySelector('#workbenchGroup .secret-optout-remove')`);
    await s.b.waitFor(`!${ST}.querySelector('#workbenchGroup .secret-optout') && !!${ST}.getElementById('secretOptOutsEmpty')`);
    await s.b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.secretFileOptouts.length === 0)`);
    await s.shot('so-settings-empty.png');
    await s.end(); s = null;

    // 3. Project A again: asked again. This time the native dialog's own option answers.
    s = await session(profile, bin, projectA, [{ label: 'A1', session: 's3', command: 'cat .env' }], DONT_ASK);
    assert.match(await s.out('A1'), /"permissionDecision":"allow".*won't be asked about this file in this project again/);
    await s.openSettingsAi();
    assert.deepEqual(await s.optouts(), [`.env | in ${path.basename(projectA)}`]);
  } finally {
    if (s) await s.end();
    for (const d of [profile, bin, projectA, projectB]) fs.rmSync(d, { recursive: true, force: true });
  }
});
