// The Workbench's Claude Code tabs come back after the browser restarts (an update, say): each one
// opens again with `claude --resume <its session>`, in the same order, with a name given by hand;
// a tab closed by hand stays closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: prints how it was started, then runs the status line from the --settings
// it was given, as Claude Code does after each answer. A new session gets the next id (s1, s2, …);
// --resume <id> continues that one.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
counter = os.path.join(cwd, '.sessions')
if '--resume' in args and args.index('--resume') + 1 < len(args) and not args[args.index('--resume') + 1].startswith('-'):
  sid = args[args.index('--resume') + 1]
  print('RESUMED ' + sid, flush=True)
else:
  n = int(open(counter).read()) + 1 if os.path.exists(counter) else 1
  open(counter, 'w').write(str(n))
  sid = 's%d' % n
  print('NEW ' + sid, flush=True)
status = {'session_id': sid, 'session_name': 'Session ' + sid, 'model': {'display_name': 'Opus 5.5'},
          'workspace': {'project_dir': cwd, 'current_dir': cwd}, 'context_window': {'context_window_size': 200000, 'used_percentage': 10}}
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
sys.stdin.readline()
`;

async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
const key = (wb, k, code, vk, modifiers = 0) => Promise.all([]).then(async () => {
  await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
});
const tabNames = `[...document.querySelectorAll('#term-tab-list .ttab .name')].map((e) => e.textContent)`;
const termText = (i) => `(() => { const t = S.terms[${i}]; if (!t) return ''; const b = t.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('\\n'); })()`;

async function openWorkbench(b) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
  let wb;
  try { wb = await b.page('chrome://workbench', 4000); } catch {
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
  }
  return wb;
}

test('after a restart the Workbench opens its Claude Code tabs again, resumed, in order, with their names; one closed by hand stays closed', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-cr-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const args = [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'];
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args });
    wb = await openWorkbench(b);
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await click(wb, `document.querySelector('#open-folder')`);
    await wb.waitFor('!!S.project');
    // Three Claude Code sessions, each from the launcher.
    for (const n of [1, 2, 3]) {
      await wb.eval(`launch('claude').then((t) => !!t)`);
      await wb.waitFor(`${tabNames}.length === ${n} && ${tabNames}[${n - 1}] === 'Session s${n}'`, 15000);
    }
    // The second one renamed by hand.
    const p = await wb.eval(`(() => { const r = document.querySelectorAll('#term-tab-list .ttab')[1].querySelector('.name').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const c of [1, 2]) {
      await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: c });
      await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: c });
    }
    await wb.waitFor(`!!document.querySelector('#term-tab-list .ttab input.rename')`);
    await key(wb, 'a', 'KeyA', 65, 4);
    await wb.cdp.send('Input.insertText', { text: 'Login bug' });
    await key(wb, 'Enter', 'Enter', 13);
    await wb.waitFor(`JSON.stringify(${tabNames}) === JSON.stringify(['Session s1', 'Login bug', 'Session s3'])`);
    // The third one closed by hand: its ✕, then Stop.
    await click(wb, `document.querySelectorAll('#term-tab-list .ttab')[2].querySelector('.tab-close')`);
    await wb.waitFor(`!!document.querySelector('#modal-overlay [data-a="ok"]')`);
    await click(wb, `document.querySelector('#modal-overlay [data-a="ok"]')`);
    await wb.waitFor(`${tabNames}.length === 2`);
    // The tab's address names the project, so the restored tab opens it again.
    assert.ok((await wb.eval('location.href')).includes('project='), 'the Workbench address names its project');
    await sleep(1500);  // the session is saved

    // The browser quits (as for an update) and starts again.
    wb.close();
    await b.quit();
    b = await launch([], { profile, args });
    wb = await openWorkbench(b);
    await wb.waitFor('!!S.project', 15000);
    await wb.waitFor(`${tabNames}.length === 2`, 20000);
    await wb.waitFor(`JSON.stringify(${tabNames}) === JSON.stringify(['Session s1', 'Login bug'])`, 15000);
    await wb.waitFor(`${termText(0)}.includes('RESUMED s1')`, 10000);
    await wb.waitFor(`${termText(1)}.includes('RESUMED s2')`, 10000);
    assert.equal(fs.readFileSync(path.join(project, '.sessions'), 'utf8'), '3', 'no new session was started');
  } finally {
    try { wb?.close(); } catch {}
    await b?.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
