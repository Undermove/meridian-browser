// Agents in the Workbench keep going: closing the Workbench's tab leaves them running (the reopened
// Workbench shows the same terminal, with what it printed meanwhile), and after the browser restarts
// each agent tab opens again resumed by its session id, with the same flags (bypass only when the
// person chose it, the model, Remote Control) — and waits with "Restored — continue?" instead of
// sending anything by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A stand-in Claude Code: writes the arguments it got (.argv-claude-<n>) and its pid, says whether it
// is a new session (s1, s2, …) or one resumed (--resume <id>), reports the session, its model and its
// permission mode as Claude Code's status line and hooks do, prints a tick every 0.3 s, and echoes
// each line typed into it.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys, threading, time
args = sys.argv
cwd = os.getcwd()
n = len([f for f in os.listdir(cwd) if f.startswith('.argv-claude-')]) + 1
json.dump(args[1:], open(os.path.join(cwd, '.argv-claude-%d' % n), 'w'))
open(os.path.join(cwd, '.pid-claude-%d' % n), 'w').write(str(os.getpid()))
settings = json.load(open(args[args.index('--settings') + 1]))
counter = os.path.join(cwd, '.sessions')
if '--resume' in args:
  sid = args[args.index('--resume') + 1]
  print('RESUMED ' + sid, flush=True)
else:
  k = int(open(counter).read()) + 1 if os.path.exists(counter) else 1
  open(counter, 'w').write(str(k))
  sid = 's%d' % k
  print('NEW ' + sid, flush=True)
mode = args[args.index('--permission-mode') + 1] if '--permission-mode' in args else 'default'
for entry in settings.get('hooks', {}).get('UserPromptSubmit', []):
  for h in entry['hooks']:
    subprocess.run(h['command'], shell=True, input=json.dumps({'hook_event_name': 'UserPromptSubmit', 'session_id': sid, 'cwd': cwd, 'permission_mode': mode, 'prompt': 'hi'}), text=True)
status = {'session_id': sid, 'session_name': 'Session ' + sid, 'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'},
          'workspace': {'project_dir': cwd, 'current_dir': cwd}, 'context_window': {'context_window_size': 200000, 'used_percentage': 10}}
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
def ticks():
  i = 0
  while True:
    print('tick-%d' % i, flush=True)
    i += 1
    time.sleep(0.3)
if os.environ.get('FAKE_TICKS') or os.path.exists(os.path.join(cwd, '.ticks')):
  threading.Thread(target=ticks, daemon=True).start()
for line in sys.stdin:
  print('GOT ' + line.strip(), flush=True)
`;

// A stand-in Codex: writes its arguments (.argv-codex-<n>), starts or resumes (codex resume <id>) a
// thread, and tells Meridian its thread id through the notify program it was given, as Codex does
// after a turn.
const CODEX_THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const FAKE_CODEX = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv[1:]
cwd = os.getcwd()
n = len([f for f in os.listdir(cwd) if f.startswith('.argv-codex-')]) + 1
json.dump(args, open(os.path.join(cwd, '.argv-codex-%d' % n), 'w'))
if args[:1] == ['resume']:
  sid = args[1]
  print('RESUMED ' + sid, flush=True)
else:
  sid = '${CODEX_THREAD}'
  print('NEW ' + sid, flush=True)
for i, a in enumerate(args):
  if a == '-c' and i + 1 < len(args) and args[i + 1].startswith('notify='):
    prog = json.loads(args[i + 1][len('notify='):])
    subprocess.run(prog + [json.dumps({'type': 'agent-turn-complete', 'thread-id': sid, 'cwd': cwd})])
for line in sys.stdin:
  print('GOT ' + line.strip(), flush=True)
`;

async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
const tabNames = `[...document.querySelectorAll('#term-tab-list .ttab .name')].map((e) => e.textContent)`;
const termText = (i) => `(() => { const t = S.terms[${i}]; if (!t) return ''; const b = t.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('\\n'); })()`;
const lastTick = (text) => Math.max(-1, ...[...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1])));
const argvOf = (project, kind, n) => JSON.parse(fs.readFileSync(path.join(project, `.argv-${kind}-${n}`), 'utf8'));
const argvCount = (project, kind) => fs.readdirSync(project).filter((f) => f.startsWith(`.argv-${kind}-`)).length;

async function openWorkbench(b) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
  let wb;
  try { wb = await b.page('chrome://workbench', 4000); } catch {
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
  }
  return wb;
}
async function openProject(wb) {
  await wb.waitFor(`!document.querySelector('#welcome').hidden || !!S.project`, 15000);
  if (!(await wb.eval('!!S.project'))) {
    await click(wb, `document.querySelector('#open-folder')`);
    await wb.waitFor('!!S.project');
  }
}
async function closeWorkbenchTab(b) {
  const list = await (await fetch(`${b.base}/json/list`)).json();
  for (const t of list.filter((x) => x.type === 'page' && x.url.startsWith('chrome://workbench'))) await fetch(`${b.base}/json/close/${t.id}`);
  for (let i = 0; i < 50; i++) {
    const left = (await (await fetch(`${b.base}/json/list`)).json()).filter((x) => x.type === 'page' && x.url.startsWith('chrome://workbench'));
    if (!left.length) return;
    await sleep(100);
  }
  throw new Error('the Workbench tab did not close');
}

function setup() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wr-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const args = [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'];
  return { project, bin, profile, args };
}

test('closing the Workbench tab leaves its agent running; the reopened Workbench shows the same one, named as before', { skip: process.platform === 'win32' && 'stand-ins are Python scripts' }, async () => {
  const { project, bin, profile, args } = setup();
  fs.writeFileSync(path.join(project, '.ticks'), '');
  let b, wb, pid = 0;
  try {
    b = await launch(['about:blank'], { profile, args });
    wb = await openWorkbench(b);
    await openProject(wb);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`${termText(0)}.includes('tick-3')`, 15000);
    await wb.waitFor(`S.terms[0]?.sessionId === 's1'`, 10000);
    await wb.eval(`(saveTermName(S.terms[0], 'Login bug'), renderTermTabs(), true)`);
    await wb.waitFor(`JSON.stringify(${tabNames}) === JSON.stringify(['Login bug'])`);
    pid = Number(fs.readFileSync(path.join(project, '.pid-claude-1'), 'utf8'));
    await sleep(500);  // the name reaches the browser
    const before = lastTick(await wb.eval(termText(0)));

    // The Workbench's tab is closed; the agent goes on.
    wb.close();
    await closeWorkbenchTab(b);
    await sleep(2500);
    assert.ok(alive(pid), 'the agent still runs with its Workbench tab closed');

    // Opened again: the same terminal, with what it printed meanwhile, named as before.
    wb = await openWorkbench(b);
    await openProject(wb);
    await wb.waitFor('S.terms.length === 1', 15000);
    await wb.waitFor(`${termText(0)}.includes('kept running while the Workbench was closed')`, 10000);
    assert.ok(lastTick(await wb.eval(termText(0))) > before + 4, 'what it printed while the tab was closed is there');
    await wb.waitFor(`JSON.stringify(${tabNames}) === JSON.stringify(['Login bug'])`, 5000);
    assert.equal(await wb.eval('S.terms[0].sessionId'), 's1');
    assert.equal(await wb.eval(`!!document.querySelector('.restored-bar')`), false, 'nothing to continue: it never stopped');
    // Still listening.
    await wb.eval(`(window.workbench.ptyWrite(S.terms[0].id, 'still here\\r'), true)`);
    await wb.waitFor(`${termText(0)}.includes('GOT still here')`, 10000);
    assert.equal(argvCount(project, 'claude'), 1, 'it was not started again');
    assert.equal(fs.readFileSync(path.join(project, '.sessions'), 'utf8'), '1');
  } finally {
    try { wb?.close(); } catch {}
    await b?.close();
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('after a restart Claude Code and Codex come back resumed with the same flags, and wait for "Continue"', { skip: process.platform === 'win32' && 'stand-ins are Python scripts' }, async () => {
  const { project, bin, profile, args } = setup();
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args });
    wb = await openWorkbench(b);
    await openProject(wb);

    // Claude Code, then put in bypass by the person (its tab's Bypass button, confirmed).
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.terms[0]?.sessionId === 's1' && S.terms[0]?.model === 'claude-opus-5-5'`, 15000);
    await click(wb, `document.querySelector('#term-tab-list .ttab .tab-bypass')`);
    await wb.waitFor(`!!document.querySelector('#modal-overlay [data-a="ok"]')`);
    await click(wb, `document.querySelector('#modal-overlay [data-a="ok"]')`);
    await wb.waitFor(`${termText(0)}.includes('RESUMED s1') && S.terms[0]?.permissionMode === 'bypassPermissions'`, 15000);
    assert.deepEqual(argvOf(project, 'claude', 2).slice(0, 6), ['--model', 'claude-opus-5-5', '--permission-mode', 'bypassPermissions', '--resume', 's1']);
    // Remote Control switched on in it.
    await wb.eval(`(S.terms[0].xterm.focus(), true)`);
    await wb.cdp.send('Input.insertText', { text: '/remote-control' });
    await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await wb.waitFor(`${termText(0)}.includes('GOT /remote-control') && S.terms[0].remote === true`, 10000);

    // A Codex tab next to it, named by hand.
    await wb.eval(`launch('codex').then((t) => !!t)`);
    await wb.waitFor(`S.terms[1]?.sessionId === ${JSON.stringify(CODEX_THREAD)}`, 15000);
    await wb.eval(`(saveTermName(S.terms[1], 'Refactor'), renderTermTabs(), true)`);
    await sleep(1500);  // the sessions are saved

    // The browser quits (as for an update) and starts again.
    wb.close();
    await b.quit();
    const claudeRuns = argvCount(project, 'claude');
    b = await launch([], { profile, args });
    wb = await openWorkbench(b);
    await openProject(wb);
    await wb.waitFor(`S.terms.length === 2`, 20000);
    await wb.waitFor(`${termText(0)}.includes('RESUMED s1') && ${termText(1)}.includes('RESUMED ${CODEX_THREAD}')`, 15000);
    assert.equal(await wb.eval(`${tabNames}[1]`), 'Refactor');

    // Exactly the arguments each one was started with this time.
    const claude = argvOf(project, 'claude', claudeRuns + 1);
    assert.deepEqual(claude.slice(0, 7), ['--remote-control', '--model', 'claude-opus-5-5', '--permission-mode', 'bypassPermissions', '--resume', 's1']);
    assert.ok(claude.slice(7).every((a, i, all) => a.startsWith('--') || (i > 0 && all[i - 1].startsWith('--'))), `no prompt is passed: ${JSON.stringify(claude)}`);
    const codex = argvOf(project, 'codex', 2);
    assert.deepEqual(codex.slice(0, 2), ['resume', CODEX_THREAD]);
    assert.ok(codex.includes('-c'), 'Codex still reports to Mission Control');
    assert.equal(fs.readFileSync(path.join(project, '.sessions'), 'utf8'), '1', 'no new Claude Code session was started');

    // Both wait: a bar on each, nothing typed into them.
    await wb.waitFor(`S.terms.every((t) => !!t.el.querySelector('.restored-bar'))`, 5000);
    await sleep(1500);
    assert.ok(!(await wb.eval(termText(0))).includes('GOT continue'), 'nothing is sent by itself');
    assert.match(await wb.eval(`S.terms[0].el.querySelector('.restored-bar .msg').textContent`), /Restored — continue\?/);
    // "Continue" sends "continue" to that one only.
    await wb.eval(`(activateTerm(S.terms[0]), true)`);
    await click(wb, `S.terms[0].el.querySelector('.restored-bar [data-a="continue"]')`);
    await wb.waitFor(`${termText(0)}.includes('GOT continue')`, 10000);
    assert.equal(await wb.eval(`!!S.terms[0].el.querySelector('.restored-bar')`), false);
    assert.ok(!(await wb.eval(termText(1))).includes('GOT continue'), 'the other one still waits');
  } finally {
    try { wb?.close(); } catch {}
    await b?.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('with "continue by itself" on, a restored agent is told "continue" without a click', { skip: process.platform === 'win32' && 'stand-ins are Python scripts' }, async () => {
  const { project, bin, profile, args } = setup();
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args });
    wb = await openWorkbench(b);
    await openProject(wb);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.terms[0]?.sessionId === 's1'`, 15000);
    // The switch in Customize › Advanced.
    await wb.eval(`(openPanel('customize'), true)`);
    await wb.waitFor(`!!document.querySelector('#side-body details.advanced')`);
    await wb.eval(`(document.querySelector('#side-body details.advanced').open = true, true)`);
    await click(wb, `document.querySelector('#side-body .auto-continue input')`);
    await wb.waitFor(`localStorage.getItem('wb.autoContinue') === '1'`);
    await sleep(1500);
    wb.close();
    await b.quit();
    b = await launch([], { profile, args });
    wb = await openWorkbench(b);
    await openProject(wb);
    await wb.waitFor(`${termText(0)}.includes('RESUMED s1')`, 20000);
    await wb.waitFor(`${termText(0)}.includes('GOT continue')`, 15000);
    assert.equal(await wb.eval(`!!document.querySelector('.restored-bar')`), false);
    // Not in bypass: the person never chose it.
    assert.ok(!argvOf(project, 'claude', 2).includes('bypassPermissions'));
  } finally {
    try { wb?.close(); } catch {}
    await b?.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
