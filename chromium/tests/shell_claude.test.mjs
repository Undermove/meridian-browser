// Claude Code started by hand in a Workbench shell tab (`claude --dangerously-skip-permissions`)
// gets what a Claude Code tab gets: Meridian's hooks and status line, so the tab shows the session's
// name and its context, Mission Control shows it in its permission mode, and after a restart it
// comes back resumed in that mode. When it quits, the tab is a shell again. The person's own zsh
// startup files still run first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: says how it was started, reports through the hooks and status line of
// the --settings it got (if any), then waits; a line ends the session (SessionEnd) and it quits.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
print('ARGS ' + ' '.join(a if not a.startswith('/') else os.path.basename(a) for a in args[1:]), flush=True)
cwd = os.getcwd()
sid = args[args.index('--resume') + 1] if '--resume' in args else 'sh1'
mode = 'bypassPermissions' if '--dangerously-skip-permissions' in args else (args[args.index('--permission-mode') + 1] if '--permission-mode' in args else 'default')
if '--settings' not in args:
    print('NO MERIDIAN SETTINGS', flush=True)
    sys.stdin.readline(); sys.exit(0)
settings = json.load(open(args[args.index('--settings') + 1]))
def hook(event, **f):
    for entry in settings['hooks'].get(event, []):
        for h in entry['hooks']:
            if h.get('async') or event != 'PermissionRequest':
                subprocess.run(h['command'], shell=True, input=json.dumps(dict(hook_event_name=event, session_id=sid, cwd=cwd, permission_mode=mode, **f)), text=True, capture_output=True)
hook('SessionStart', model='claude-opus-5-5', source='startup')
hook('UserPromptSubmit', prompt='hi')
status = {'session_id': sid, 'session_name': 'Shell session', 'model': {'display_name': 'Opus 5.5'},
          'workspace': {'project_dir': cwd, 'current_dir': cwd}, 'context_window': {'context_window_size': 200000, 'used_percentage': 37}}
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
hook('Stop')
print('CLAUDE READY ' + sid + ' ' + mode, flush=True)
sys.stdin.readline()
hook('SessionEnd', reason='prompt_input_exit')
print('CLAUDE BYE', flush=True)
`;

const termText = (i) => `(() => { const t = S.terms[${i}]; if (!t) return ''; const b = t.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('\\n'); })()`;

test('Claude Code typed in a shell tab: its name and context on the tab, Mission Control, back after a restart in its mode; a shell again when it quits', { skip: process.platform === 'win32' && 'zsh startup files (macOS, Linux)' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sc-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  // The person's own zsh startup files (in a home of the test's own), with an alias of their own
  // for claude.
  const zdot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-home-')));
  fs.writeFileSync(path.join(zdot, '.zshrc'), `export MY_ZSHRC_RAN=yes\nexport PATH=${bin}:$PATH\nalias claude='claude --dangerously-skip-permissions'\n`);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const args = [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'];
  const savedHome = process.env.HOME;
  process.env.HOME = zdot;
  let b, wb;
  const state = () => b.eval(`app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))`);
  try {
    b = await launch(['about:blank'], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor('S.terms.length === 1 && !!S.activeTerm');
    const write = (text) => wb.eval(`(() => { window.workbench.ptyWrite(S.terms[0].id, ${JSON.stringify(text)}); return true; })()`);
    // The person's own .zshrc ran.
    await write('echo "zshrc: $MY_ZSHRC_RAN"\r');
    await wb.waitFor(`${termText(0)}.includes('zshrc: yes')`, 8000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(termText(0))); });
    // A shell: no gauge, nothing in Mission Control.
    assert.ok(!(await wb.eval(`!!document.querySelector('#term-tab-list .ttab .ctx-badge')`)));
    assert.equal((await state()).nodes.filter((n) => n.kind === 'session').length, 0);

    // claude, typed (their alias adds --dangerously-skip-permissions).
    await write('claude\r');
    await wb.waitFor(`${termText(0)}.includes('CLAUDE READY sh1 bypassPermissions')`, 15000).catch(async (e) => { throw new Error(e.message + '\n' + await wb.eval(termText(0))); });
    const started = await wb.eval(termText(0));
    assert.match(started, /ARGS --dangerously-skip-permissions --settings settings\.json --mcp-config mcp\.json/);
    // Its name and its context on the tab, the Claude Code mark.
    await wb.waitFor(`document.querySelector('#term-tab-list .ttab .name')?.textContent === 'Shell session'`, 15000);
    assert.equal(await wb.eval(`document.querySelector('#term-tab-list .ttab .ctx-badge')?.textContent`), '37%');
    // Mission Control: the session, in bypass.
    let s;
    for (let i = 0; i < 40; i++) { s = (await state()).nodes.find((n) => n.kind === 'session'); if (s?.permissionMode) break; await sleep(150); }
    assert.equal(s?.label, 'Shell session');
    assert.equal(s?.permissionMode, 'bypassPermissions');
    await sleep(1500);  // saved

    // A restart: it comes back as a Claude Code tab, resumed, in bypass.
    await b.quit();
    b = await launch(['about:blank'], { profile, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
    try { wb = await b.page('chrome://workbench', 4000); } catch {
      await b.eval('app.$.tabstrip.runCommand(16, 0)');
      wb = await b.page('chrome://workbench');
    }
    await wb.waitFor(`S.terms.some((t) => t.kind === 'claude')`, 20000);
    await wb.waitFor(`${termText(0)}.includes('CLAUDE READY sh1 bypassPermissions')`, 15000);
    assert.match(await wb.eval(termText(0)), /ARGS --permission-mode bypassPermissions --resume sh1/);

    // In a new shell tab: claude runs, then quits: the tab is a shell again, and it's gone from
    // Mission Control.
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor(`S.terms.length === 2`);
    const shell = `S.terms.find((t) => t.kind === 'shell')`;
    const writeShell = (text) => wb.eval(`(() => { window.workbench.ptyWrite(${shell}.id, ${JSON.stringify(text)}); return true; })()`);
    const shellText = `(() => { const b = ${shell}.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('\\n'); })()`;
    await writeShell('claude --resume sh2\r');
    await wb.waitFor(`${shellText}.includes('CLAUDE READY sh2')`, 15000);
    await wb.waitFor(`[...document.querySelectorAll('#term-tab-list .ttab .ctx-badge')].length === 2`, 15000);
    await writeShell('\r');
    await wb.waitFor(`${shellText}.includes('CLAUDE BYE')`, 10000);
    await wb.waitFor(`[...document.querySelectorAll('#term-tab-list .ttab .ctx-badge')].length === 1`, 10000);
    for (let i = 0; i < 40; i++) { s = await state(); if (s.nodes.filter((n) => n.kind === 'session' && !n.endedAt).length === 1) break; await sleep(150); }
    assert.equal(s.nodes.filter((n) => n.kind === 'session' && !n.endedAt).length, 1, 'only the restored tab’s session');
  } finally {
    process.env.HOME = savedHome;
    try { await wb?.eval(`(() => { for (const t of S.terms) window.workbench.ptyWrite(t.id, '\\r'); return true; })()`); } catch {}
    wb?.close();
    await b?.close();
    for (const d of [project, bin, profile, zdot]) fs.rmSync(d, { recursive: true, force: true });
  }
});
