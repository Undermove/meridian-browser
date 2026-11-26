// Remote Control on a Claude Code tab: "RC" filled when it's connected, an outline when off, told by
// what Claude Code prints ("/remote-control is active · Continue here, on your phone, or at …",
// "Remote Control disconnected."); one switch in the tab's settings types /remote-control.
// And "Restore as it was": a session picked up again with Resume (the picker, so Meridian didn't
// start it with its flags) gets one button that brings back its name, permission mode, model and
// Remote Control as they last were.
// The stand-in prints Claude Code's lines; nothing reaches a real service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `--resume` alone is the picker: the stand-in "picks" s1.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv[1:]
open('argv.log', 'a').write(json.dumps(args) + '\\n')
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
sid = 's1'
if '--resume' in args:
  i = args.index('--resume')
  if i + 1 < len(args) and not args[i + 1].startswith('-'): sid = args[i + 1]
model = args[args.index('--model') + 1] if '--model' in args else 'claude-sonnet-5'
def status():
  s = {'session_id': sid, 'session_name': 'Session ' + sid, 'transcript_path': os.path.join(cwd, 'session.jsonl'),
    'model': {'id': model, 'display_name': model}, 'workspace': {'project_dir': cwd, 'current_dir': cwd},
    'context_window': {'context_window_size': 200000, 'used_percentage': 5, 'current_usage': {'input_tokens': 10, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0, 'output_tokens': 1}},
    'cost': {'total_cost_usd': 0.4}}
  subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(s), text=True, capture_output=True, env=env)
rc = '--remote-control' in args
def say_rc():
  if rc: print('/remote-control is active \\u00b7 Continue here, on your phone, or at https://claude.ai/code/session_test', flush=True)
  else: print('Remote Control disconnected.', flush=True)
status()
print('READY ' + sid, flush=True)
if rc: say_rc()
for line in sys.stdin:
  line = line.strip()
  open('typed.log', 'a').write(line + '\\n')
  if line == '/remote-control':
    rc = not rc
    say_rc()
  status()
`;

async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
async function shot(wb, name) {
  if (!process.env.MERIDIAN_SHOTS) return;
  const { data } = await wb.cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.MERIDIAN_SHOTS, name), Buffer.from(data, 'base64'));
}

async function setup() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-rc-')));
  fs.mkdirSync(path.join(project, 'home'));
  fs.writeFileSync(path.join(project, 'session.jsonl'), '');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor('!!S.project');
  const runs = () => fs.readFileSync(path.join(project, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const typed = () => { try { return fs.readFileSync(path.join(project, 'typed.log'), 'utf8'); } catch { return ''; } };
  const done = async () => { wb.close(); await b.close(); for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true }); };
  return { wb, runs, typed, done };
}

const tab = `document.querySelector('#term-tab-list .ttab.active')`;

test('Remote Control shows on the tab and is switched on and off from the tab\'s settings', { skip: process.platform === 'win32' && 'the stand-in is a POSIX script' }, async () => {
  const { wb, typed, done } = await setup();
  try {
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.sessionId === 's1' && !!${tab}?.querySelector('.tab-rc')`, 15000);
    // Off: an outline, saying how to turn it on.
    assert.equal(await wb.eval(`${tab}.querySelector('.tab-rc').className`), 'tab-rc off');
    assert.match(await wb.eval(`${tab}.querySelector('.tab-rc').title`), /Remote Control: off/);

    await click(wb, `${tab}.querySelector('.tab-settings')`);
    await wb.waitFor(`!!document.querySelector('#popover [data-row="remote"] [data-a="rc"]')`);
    assert.match(await wb.eval(`document.querySelector('#popover [data-row="remote"]').innerText`), /Remote Control\s+Off/);
    await click(wb, `document.querySelector('#popover [data-a="rc"]')`);
    // Claude Code's own command, typed in; "is active" fills the RC.
    await wb.waitFor(`${tab}?.querySelector('.tab-rc.on') && S.activeTerm.remote === true`, 20000);
    assert.match(typed(), /^\/remote-control$/m);
    assert.match(await wb.eval(`${tab}.querySelector('.tab-rc').title`), /Remote Control: on/);
    await sleep(300);
    await shot(wb, 'tab-rc-on.png');
    // Remembered for a restart: it comes back with --remote-control.
    await wb.waitFor(`wb.claudeSessions().then((l) => l.some((s) => s.id === 's1' && s.remote === true))`);

    // Off again.
    await click(wb, `${tab}.querySelector('.tab-settings')`);
    await wb.waitFor(`document.querySelector('#popover [data-row="remote"]')?.innerText.includes('On')`);
    await click(wb, `document.querySelector('#popover [data-a="rc"]')`);
    await wb.waitFor(`${tab}?.querySelector('.tab-rc.off') && S.activeTerm.remote === false && S.activeTerm.rc === 'off'`, 20000);
    for (let i = 0; i < 50 && (typed().match(/^\/remote-control$/gm) || []).length < 2; i++) await sleep(200);
    assert.equal((typed().match(/^\/remote-control$/gm) || []).length, 2);
    // What Claude Code prints wins over a stale line (here, after the hold: still off).
    await sleep(500);
    assert.equal(await wb.eval(`S.activeTerm.rc`), 'off');
  } finally { await done(); }
});

test('a session picked up with Resume comes back as it was in one click', { skip: process.platform === 'win32' && 'the stand-in is a POSIX script' }, async () => {
  const { wb, runs, done } = await setup();
  try {
    // As it was: named, in bypass, on another model, with Remote Control.
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.sessionId === 's1'`, 15000);
    await wb.eval(`restartSession(S.activeTerm, { mode: 'bypassPermissions', model: 'claude-opus-5-5', remote: true, name: 'Login bug' }).then(Boolean)`);
    await wb.waitFor(`S.activeTerm?.permissionMode === 'bypassPermissions' && S.activeTerm.custom === 'Login bug' && !!${tab}?.querySelector('.tab-rc.on')`, 20000);
    await wb.waitFor(`(() => { const h = JSON.parse(localStorage.getItem('wb.sessions.' + S.project.root) || '{}').s1; return h && h.mode === 'bypassPermissions' && h.remote && h.name === 'Login bug' && h.model === 'claude-opus-5-5'; })()`);

    // The tab closed; the session picked from Claude Code's Resume list.
    await wb.eval(`killTerm(S.activeTerm, { quiet: true }).then(() => true)`);
    await wb.eval(`launch('claude', { resume: true }).then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.sessionId === 's1' && !!S.activeTerm.restoreBar`, 15000);
    const bar = await wb.eval(`S.activeTerm.restoreBar.innerText`);
    assert.match(bar, /Login bug/);
    assert.match(bar, /Bypass/);
    assert.match(bar, /claude-opus-5-5/);
    assert.match(bar, /Remote Control on/);
    // What it remembered is not overwritten by the state it was resumed in.
    assert.equal(await wb.eval(`JSON.parse(localStorage.getItem('wb.sessions.' + S.project.root)).s1.mode`), 'bypassPermissions');
    // The same offer in the tab's settings.
    await click(wb, `${tab}.querySelector('.tab-settings')`);
    await wb.waitFor(`!!document.querySelector('#popover [data-row="restore"] [data-a="restore"]')`);
    await sleep(300);
    await shot(wb, 'tab-restore-offer.png');
    await wb.eval(`(document.getElementById('popover').hidden = true, true)`);

    await click(wb, `S.activeTerm.restoreBar.querySelector('[data-a="restore"]')`);
    await wb.waitFor(`S.activeTerm?.permissionMode === 'bypassPermissions' && S.activeTerm.custom === 'Login bug' && !!${tab}?.querySelector('.tab-rc.on')`, 20000);
    const last = runs().at(-1);
    assert.equal(last[last.indexOf('--resume') + 1], 's1');
    assert.equal(last[last.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.equal(last[last.indexOf('--model') + 1], 'claude-opus-5-5');
    assert.ok(last.includes('--remote-control'));
    assert.match(await wb.eval(`${tab}.querySelector('.name').textContent`), /Login bug/);
    assert.equal(await wb.eval(`!!S.activeTerm.restoreBar || !!S.activeTerm.restoreOffer`), false);

    // Picked from the list again (without its flags): offered again; "keep it as it is now" dismisses it.
    await wb.eval(`killTerm(S.activeTerm, { quiet: true }).then(() => true)`);
    await wb.eval(`launch('claude', { resume: true }).then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.sessionId === 's1'`, 15000);
    await sleep(800);
    assert.equal(await wb.eval(`!!S.activeTerm.restoreBar`), true);
    await click(wb, `S.activeTerm.restoreBar.querySelector('[data-a="dismiss"]')`);
    await wb.waitFor(`!S.activeTerm.restoreBar && !S.activeTerm.restoreOffer`);
  } finally { await done(); }
});
