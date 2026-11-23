// A Claude Code tab restarts with bypass permissions from a button: asked first, the same session,
// the same place on the tab bar and the same name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys, time
args = sys.argv
open('argv.log', 'a').write(json.dumps(args[1:]) + '\\n')
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
status = {'session_id': 's1', 'session_name': 'Fix the login page', 'transcript_path': os.path.join(cwd, 'session.jsonl'),
  'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'}, 'workspace': {'project_dir': cwd, 'current_dir': cwd},
  'context_window': {'context_window_size': 200000, 'used_percentage': 10, 'current_usage': {'input_tokens': 10, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0, 'output_tokens': 1}}}
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
print('READY', flush=True)
sys.stdin.readline()
`;

test('a Claude Code tab restarts with bypass permissions, after asking, in the same session', { skip: process.platform === 'win32' && 'the stand-in is a POSIX script' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-bypass-')));
  fs.mkdirSync(path.join(project, 'home'));
  fs.writeFileSync(path.join(project, 'session.jsonl'), '');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  const runs = () => fs.readFileSync(path.join(project, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`!!document.querySelector('.ttab.active .tab-bypass')`, 15000);
    await wb.eval(`(() => { S.activeTerm.custom = 'Login bug'; saveClaudeSessions(); renderTermTabs(); })()`);
    // Move it first, so "the same place" means something.
    await wb.eval(`(() => { const t = S.terms.pop(); S.terms.unshift(t); renderTermTabs(); })()`);
    assert.equal(runs().length, 1);

    // Cancel changes nothing.
    await wb.eval(`document.querySelector('.ttab.active .tab-bypass').click()`);
    await wb.waitFor(`!!document.querySelector('[data-a="ok"]')`);
    assert.match(await wb.eval(`document.querySelector('#modal-overlay').innerText`), /stops asking/);
    await wb.eval(`document.querySelector('[data-a="cancel"]').click()`);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(runs().length, 1, 'not restarted');

    // Yes: the same session, bypass, same place and name.
    await wb.eval(`document.querySelector('.ttab.active .tab-bypass').click()`);
    await wb.waitFor(`!!document.querySelector('[data-a="ok"]')`);
    await wb.eval(`document.querySelector('[data-a="ok"]').click()`);
    await wb.waitFor(`!!document.querySelector('.ttab.active .bypass-on')`, 15000);
    const again = runs().at(-1);
    assert.equal(runs().length, 2);
    assert.equal(again[again.indexOf('--resume') + 1], 's1');
    assert.equal(again[again.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.equal(await wb.eval(`S.terms.length`), 2);
    assert.equal(await wb.eval(`S.terms[0] === S.activeTerm && S.terms[0].kind`), 'claude');
    assert.match(await wb.eval(`document.querySelector('.ttab.active .name').textContent`), /Login bug/);
    assert.equal(await wb.eval(`!!document.querySelector('.ttab.active .tab-bypass')`), false);
    // It's remembered for the next browser restart.
    await wb.waitFor(`wb.claudeSessions().then((l) => l.some((s) => s.id === 's1' && s.mode === 'bypassPermissions'))`);
  } finally {
    wb?.close(); await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
