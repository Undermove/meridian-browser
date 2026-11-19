// A Claude Code session that finished its turn but left a command running in the background (a long
// build, a test run) is at work, not idle: Mission Control says it runs a task in the background,
// and idle again once the command ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const MC = 'app.$.mission.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: a turn, a background command (as Claude Code runs one: a shell with -c
// that sources its snapshot first, so the shell stays), the end
// of the turn; Enter ends the background command, Enter again quits.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
def hook(event, **fields):
    for entry in settings['hooks'].get(event, []):
        for h in entry['hooks']:
            subprocess.run(h['command'], shell=True, input=json.dumps(dict(hook_event_name=event, session_id='s1', cwd=cwd, **fields)), text=True)
hook('SessionStart', model='claude-opus-5-5', source='startup')
hook('UserPromptSubmit', prompt='run the sweep')
bg = subprocess.Popen(['/bin/sh', '-c', 'true && sleep 600'], start_new_session=True)
hook('Stop')
print('TURN OVER', flush=True)
sys.stdin.readline()
os.killpg(bg.pid, 9); bg.wait()
print('BACKGROUND DONE', flush=True)
sys.stdin.readline()
`;

test('Mission Control: a session with a command running in the background is at work, not idle', { skip: process.platform === 'win32' && 'counts shells (macOS, Linux)' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mb-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  const state = () => b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))');
  const session = async () => (await state()).nodes.find((n) => n.kind === 'session');
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('claude').then((t) => !!t)`);
    let s;
    for (let i = 0; i < 60; i++) { s = await session(); if (s?.background === 1) break; await sleep(250); }
    assert.equal(s?.status, 'idle', 'the turn is over');
    assert.equal(s?.background, 1, `one command in the background: ${JSON.stringify(s)}`);
    // ⇧⌘M: at work.
    await b.eval('app.$.tabstrip.runCommand(17, 0)');
    await b.waitFor(`${MC}.querySelector('#tree .row')?.dataset.status === 'background'`);
    assert.match(await b.eval(`${MC}.querySelector('#tree .row .pill-text').textContent`), /Running 1 task in the background/);
    assert.ok(await b.eval(`${MC}.querySelector('#tree .row').classList.contains('live')`));
    // The command ends: idle.
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, '\\r'); return true; })()`);
    await b.waitFor(`${MC}.querySelector('#tree .row')?.dataset.status === 'idle'`, 15000);
  } finally {
    try { await wb?.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, '\\r'); return true; })()`); } catch {}
    wb?.close();
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
