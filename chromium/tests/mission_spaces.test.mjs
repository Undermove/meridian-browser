// Mission Control shows every space's agents, whatever profile the space has (a Workbench in a
// space with its own profile used to report to that profile's own, unseen Mission Control): grouped
// under their space, each named as its terminal tab is (the session's name, not "Claude Code"),
// with its context used; a space's chip shows only that space; Context Insights opens from there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const MC = 'app.$.mission.shadowRoot';
const T = 'app.$.tabstrip';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: reports through its hooks and its status line (session name, context),
// then works until stopped. Each new session gets the next id (s1, s2, …).
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
counter = os.path.join(cwd, '.sessions')
n = int(open(counter).read()) + 1 if os.path.exists(counter) else 1
open(counter, 'w').write(str(n))
sid = 's%d' % n
def hook(event, **fields):
    for entry in settings['hooks'].get(event, []):
        for h in entry['hooks']:
            subprocess.run(h['command'], shell=True, input=json.dumps(dict(hook_event_name=event, session_id=sid, cwd=cwd, **fields)), text=True)
hook('SessionStart', model='claude-opus-5-5', source='startup')
hook('UserPromptSubmit', prompt='hi')
names = {'s1': 'Fix the login bug', 's2': 'Write the release notes'}
status = {'session_id': sid, 'session_name': names.get(sid, sid), 'model': {'display_name': 'Opus 5.5'},
          'workspace': {'project_dir': cwd, 'current_dir': cwd},
          'context_window': {'context_window_size': 200000, 'used_percentage': 30 + 20 * n}}
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
print('WORKING ' + sid, flush=True)
sys.stdin.readline()
`;

test('Mission Control: every space’s agents, grouped by space, named by their session, with context; a space’s chip filters', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ms-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  const state = () => b.eval(`${T}.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))`);
  let wb1, wb2;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const home = await b.eval(`${T}.state_.spaces[0]`);
    // A second space with a profile of its own.
    const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
    const { spaceId: work } = await b.eval(`${T}.handler_.createSpace('Work', '', '', '')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(work)}, ${JSON.stringify(profileId)})`);
    await b.waitFor(`${T}.state_.spaces.find((s) => s.name === 'Work')?.profileId === ${JSON.stringify(profileId)}`);

    // A Claude Code session in the first space's Workbench…
    await b.eval(`${T}.runCommand(16, 0)`);
    wb1 = await b.page('chrome://workbench');
    await wb1.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb1.eval(`document.querySelector('#open-folder').click()`);
    await wb1.waitFor('!!S.project');
    await wb1.eval(`launch('claude').then((t) => !!t)`);
    await wb1.waitFor(`[...document.querySelectorAll('#term-tab-list .ttab .name')].map((e) => e.textContent).includes('Fix the login bug')`, 15000);
    wb1.close();

    // …and one in Work's (its profile's).
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(work)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(work)}`);
    await b.eval(`${T}.runCommand(16, 0)`);
    await b.waitFor(`[...${T}.tabs_.values()].filter((t) => t.url.startsWith('chrome://workbench')).length === 2`, 15000);
    wb2 = await b.page('chrome://workbench/$');
    assert.ok(wb2, 'the Work space’s Workbench');
    await wb2.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb2.eval(`document.querySelector('#open-folder').click()`);
    await wb2.waitFor('!!S.project');
    await wb2.eval(`launch('claude').then((t) => !!t)`);
    await wb2.waitFor(`[...document.querySelectorAll('#term-tab-list .ttab .name')].map((e) => e.textContent).includes('Write the release notes')`, 15000).catch(async (e) => {
      throw new Error(e.message + ' got=' + JSON.stringify(await wb2.eval(`[S.terms.map((t) => [t.kind, termName(t), t.exited]), JSON.stringify(CI.usage), (() => { const t = S.terms[0]; if (!t) return ''; const b = t.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('|').replace(/\\|+/g, '|').slice(0, 600); })()]`)));
    });

    // Both reach the one Mission Control, each with its space and its name.
    let s;
    for (let i = 0; i < 75; i++) {
      s = await state();
      const roots = s.nodes.filter((n) => n.kind === 'session');
      if (roots.length === 2 && roots.every((n) => n.label !== 'Claude Code' && n.spaceId)) break;
      await sleep(200);
    }
    const roots = s.nodes.filter((n) => n.kind === 'session');
    assert.deepEqual(roots.map((n) => n.label).sort(), ['Fix the login bug', 'Write the release notes']);
    assert.equal(roots.find((n) => n.label === 'Fix the login bug').spaceId, home.id);
    assert.equal(roots.find((n) => n.label === 'Write the release notes').spaceId, work);
    assert.ok(roots.every((n) => n.sublabel === 'Claude Code · claude-opus-5-5'), `the agent and model under the name: ${roots.map((n) => n.sublabel)}`);

    // ⇧⌘M, opened from Work: all spaces, grouped, with context.
    await b.eval(`(() => { try { localStorage.removeItem('meridian-mission-space'); } catch {} })()`);
    await b.eval(`${T}.runCommand(17, 0)`);
    await b.waitFor(`app.$.mission.open && ${MC}.querySelectorAll('#tree .row').length === 2`);
    const groups = await b.eval(`[...${MC}.querySelectorAll('#tree .group .g-name')].map((e) => e.textContent)`);
    assert.deepEqual(groups, [home.name, 'Work']);
    const rows = await b.eval(`[...${MC}.querySelectorAll('#tree .row')].map((r) => [r.querySelector('.label').textContent, r.querySelector('.ctx')?.textContent.trim()])`);
    assert.deepEqual(rows, [['Fix the login bug', '50%'], ['Write the release notes', '70%']]);

    // Work's chip, clicked: only Work's session; the others are a click away.
    await b.click(`[...${MC}.querySelectorAll('#spaces .space')].find((c) => c.textContent.includes('Work'))`);
    await b.waitFor(`${MC}.querySelectorAll('#tree .row').length === 1`);
    assert.equal(await b.eval(`${MC}.querySelector('#tree .row .label').textContent`), 'Write the release notes');
    assert.equal(await b.eval(`${MC}.querySelectorAll('#tree .group').length`), 0);
    assert.match(await b.eval(`${MC}.getElementById('otherSpaces').textContent`), /1 more at work in other spaces/);
    assert.match(await b.eval(`${MC}.getElementById('d-space').textContent`), /Work/);
    assert.match(await b.eval(`${MC}.getElementById('d-context').textContent`), /70%/);
    // It's remembered.
    await b.eval('app.$.mission.hide()');
    await b.eval(`${T}.runCommand(17, 0)`);
    await b.waitFor(`app.$.mission.open && ${MC}.querySelectorAll('#tree .row').length === 1`);

    // Context Insights: the Workbench's panel for that session.
    await b.click(`${MC}.getElementById('insights')`);
    await b.waitFor('!app.$.mission.open');
    await wb2.waitFor(`PRO.activePanel === 'insights' && S.activeTerm && termName(S.activeTerm) === 'Write the release notes'`, 10000);

    // All spaces again.
    await b.eval(`${T}.runCommand(17, 0)`);
    await b.click(`${MC}.getElementById('otherSpaces')`);
    await b.waitFor(`${MC}.querySelectorAll('#tree .row').length === 2`);
  } finally {
    try { wb1?.close(); } catch {}
    try { wb2?.close(); } catch {}
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
