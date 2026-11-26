// Studio: the Workbench's Claude Code session as a chat for designers, behind a flag that is off by
// default. Off, the Workbench is as it was (no Studio, its calls refused, Claude Code started as
// before). On: a task typed in Studio reaches the same Claude Code terminal (with Studio's rules),
// its steps show in plain words, its permission question is a card answered with a button, only
// the files it created or changed get cards, and «Студия | Workbench» shows the same session.
// A stand-in Claude Code: nothing reaches a real AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs its hooks like the real one (Mission Control's, then the permission hook, which blocks until
// someone answers), writes its transcript, and reads what is typed into it.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys, time, base64
args = sys.argv
cwd = os.getcwd()
open(os.path.join(cwd, '.argv'), 'w').write(json.dumps(args[1:]))
settings = json.load(open(args[args.index('--settings') + 1]))
tdir = os.path.join(cwd, '.transcripts'); os.makedirs(tdir, exist_ok=True)
tpath = os.path.join(tdir, 's1.jsonl')
def ev(event, **f):
    return json.dumps(dict(hook_event_name=event, session_id='s1', transcript_path=tpath, cwd=cwd, **f))
def hook(event, **f):
    tool = f.get('tool_name', '')
    for e in settings['hooks'].get(event, []):
        if e.get('matcher', '*') != '*' and tool not in e.get('matcher', '').split('|'): continue
        for h in e['hooks']:
            if 'secret-guard --permission' in h['command']: continue
            subprocess.run(h['command'], shell=True, input=ev(event, **f), text=True, capture_output=True)
n = [0]
def line(kind, content):
    n[0] += 1
    with open(tpath, 'a') as f:
        f.write(json.dumps({'type': kind, 'uuid': 'l%d' % n[0], 'sessionId': 's1', 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'message': {'role': kind, 'content': content}}) + '\\n')
def tool(tid, name, inp, result='ok'):
    line('assistant', [{'type': 'tool_use', 'id': tid, 'name': name, 'input': inp}])
    hook('PreToolUse', tool_name=name, tool_input=inp, tool_use_id=tid)
    time.sleep(0.3)
    line('user', [{'type': 'tool_result', 'tool_use_id': tid, 'content': result}])
    hook('PostToolUse', tool_name=name, tool_input=inp, tool_use_id=tid, tool_response={})
open(tpath, 'w').close()
hook('SessionStart', model='claude-opus-5-5', source='startup')
print('READY', flush=True)
buf = ''
while '\\n' not in buf.replace('\\r', '\\n'):
    buf += os.read(0, 4096).decode('utf8', 'replace')
prompt = buf.replace('\\x1b[200~', '').replace('\\x1b[201~', '').strip()
open(os.path.join(cwd, '.prompt'), 'w').write(prompt)
hook('UserPromptSubmit', prompt=prompt)
line('user', prompt)
line('assistant', [{'type': 'text', 'text': 'Look at the brief first.'}])
tool('t1', 'Read', {'file_path': cwd + '/brief.md'})
os.makedirs(os.path.join(cwd, 'Drafts'), exist_ok=True)
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==')
open(os.path.join(cwd, 'Drafts', 'palette.png'), 'wb').write(png)
tool('t2', 'Write', {'file_path': cwd + '/Drafts/palette.png', 'content': '…'})
# Claude Code's own permission question: Meridian's hook holds it until it is answered.
inp = {'file_path': cwd + '/Brand/colors.css', 'old_string': 'green', 'new_string': 'violet'}
line('assistant', [{'type': 'tool_use', 'id': 't3', 'name': 'Edit', 'input': inp}])
hook('PreToolUse', tool_name='Edit', tool_input=inp, tool_use_id='t3')
cmd = settings['hooks']['PermissionRequest'][0]['hooks'][0]['command']
out = subprocess.run(cmd, shell=True, input=ev('PermissionRequest', tool_name='Edit', tool_input=inp, permission_suggestions=[{'type': 'addRules', 'rules': [{'toolName': 'Edit'}], 'behavior': 'allow', 'destination': 'session'}]), text=True, capture_output=True).stdout.strip()
open(os.path.join(cwd, '.answer'), 'w').write(out)
print('ANSWER ' + out, flush=True)
line('user', [{'type': 'tool_result', 'tool_use_id': 't3', 'content': 'ok'}])
hook('PostToolUse', tool_name='Edit', tool_input=inp, tool_use_id='t3', tool_response={})
line('assistant', [{'type': 'text', 'text': 'Done: the palette is in Drafts.'}])
hook('Stop')
print('DONE', flush=True)
while True:
    time.sleep(1)
`;

async function setup() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-studio-')));
  fs.mkdirSync(path.join(project, 'Brand'));
  fs.writeFileSync(path.join(project, 'brief.md'), '# Brief\n');
  fs.writeFileSync(path.join(project, 'Brand', 'colors.css'), ':root { --main: green; }\n');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  return { project, bin, profile, args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--meridian-test-persona=designer'] };
}

async function openWorkbench(b) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor('!!S.project', 15000);
  return wb;
}

// A real mouse click inside the Workbench page.
async function click(wb, sel) {
  const r = await wb.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

test('Studio off (the default): the Workbench is as before, Studio\'s calls are refused, Claude Code starts as before', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup();
  const b = await launch(['about:blank'], { profile: s.profile, args: s.args });
  let wb;
  try {
    wb = await openWorkbench(b);
    await sleep(500);
    assert.equal(await wb.eval(`!!document.querySelector('#studio, .st-switch')`), false);
    assert.equal(await wb.eval('document.body.classList.contains("studio-on")'), false);
    assert.deepEqual(await wb.eval('window.workbench.studioInfo()'), { enabled: false });
    for (const call of [`studioTranscript('t1', 0)`, `studioAnswer('x', 'allow')`, `studioBoost('get', 'example.com')`]) {
      assert.equal(await wb.eval(`window.workbench.${call}.then(() => 'ok', (e) => e.message)`), 'Studio is off.');
    }
    // Even asked for, Studio's rules don't reach Claude Code.
    await wb.eval(`launch('claude', { studio: true }).then((t) => !!t)`);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(s.project, '.argv')); i++) await sleep(100);
    const argv = JSON.parse(fs.readFileSync(path.join(s.project, '.argv'), 'utf8'));
    assert.ok(!argv.includes('--append-system-prompt'), argv.join(' '));
    assert.ok(argv.includes('--settings'));
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('Studio on: a task in plain words, a permission card answered with a button, file cards, the same session in the Workbench', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup();
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio'] });
  let wb;
  try {
    wb = await openWorkbench(b);
    // A designer sees Studio first, with the designer's suggestions and the switch.
    await wb.waitFor(`document.querySelector('#studio') && !document.querySelector('#studio').hidden`);
    assert.deepEqual(await wb.eval('window.workbench.studioInfo()'), { enabled: true, persona: 'designer' });
    assert.equal(await wb.eval(`document.querySelectorAll('#st-chips .st-chip').length`), 3);
    assert.equal(await wb.eval(`document.querySelector('#studio .st-switch button.on').dataset.view`), 'studio');
    // Nothing about terminals, tokens or MCP in sight.
    assert.doesNotMatch(await wb.eval(`document.querySelector('#studio').innerText`), /terminal|token|MCP|CLI/i);

    // A suggestion fills the box; the person sends it.
    await click(wb, '#st-chips .st-chip');
    const prompt = await wb.eval(`document.querySelector('#st-input').value`);
    assert.ok(prompt.length > 5);
    await click(wb, '#st-send');
    for (let i = 0; i < 150 && !fs.existsSync(path.join(s.project, '.prompt')); i++) await sleep(100);
    assert.equal(fs.readFileSync(path.join(s.project, '.prompt'), 'utf8'), prompt);
    const argv = JSON.parse(fs.readFileSync(path.join(s.project, '.argv'), 'utf8'));
    const rules = argv[argv.indexOf('--append-system-prompt') + 1] || '';
    assert.match(rules, /Never overwrite, move or delete the person's original files/);

    // Steps in plain words; the read file is a step, not a file card.
    await wb.waitFor(`document.querySelector('#st-feed').innerText.includes('Created palette.png')`, 15000);
    const feed = await wb.eval(`document.querySelector('#st-feed').innerText`);
    assert.match(feed, /Looked at brief\.md/);
    assert.match(feed, /Look at the brief first\./);
    assert.doesNotMatch(feed, /\bWrite\(|\bRead\(|tool_use/);

    // The permission question as a card; «Allow» answers it for the session.
    await wb.waitFor(`document.querySelector('.st-ask .st-ask-q')?.innerText.includes('Allow changing files in Brand?')`, 15000);
    assert.equal(await wb.eval(`document.querySelector('.st-task.needs') !== null`), true);
    await click(wb, '.st-ask [data-answer="session"]');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(s.project, '.answer')); i++) await sleep(100);
    assert.match(fs.readFileSync(path.join(s.project, '.answer'), 'utf8'), /allow/);
    await wb.waitFor(`!document.querySelector('.st-ask') && document.querySelector('.st-answered.yes')?.innerText.includes('Allowed')`, 10000);

    // Done: Claude's answer, and cards only for what it created or changed.
    await wb.waitFor(`document.querySelector('#st-feed').innerText.includes('Done: the palette is in Drafts.')`, 10000);
    await wb.waitFor(`[...document.querySelectorAll('.st-fc .st-fn')].map((e) => e.textContent).sort().join() === 'colors.css,palette.png'`, 10000);
    // The picture's card has its picture.
    await wb.waitFor(`document.querySelector('.st-fc[data-file="Drafts/palette.png"] img')?.src.startsWith('data:image/png')`, 10000);
    // The original was never touched by Studio itself.
    assert.equal(fs.readFileSync(path.join(s.project, 'Brand', 'colors.css'), 'utf8'), ':root { --main: green; }\n');

    // «Workbench»: the same session, in its terminal.
    const studioTask = await wb.eval('ST.current');
    await click(wb, '#studio .st-switch button[data-view="workbench"]');
    await wb.waitFor(`document.querySelector('#studio').hidden && S.activeTerm?.id === ${JSON.stringify(studioTask)}`);
    const text = await wb.eval(`Array.from({ length: S.activeTerm.xterm.buffer.active.length }, (_, i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true) || '').join('\\n')`);
    assert.match(text, /ANSWER/);
    assert.equal(await wb.eval(`S.terms.filter((t) => t.kind === 'claude').length`), 1);
    // And back: the chat is still there.
    await click(wb, '#topbar .st-switch button[data-view="studio"]');
    await wb.waitFor(`!document.querySelector('#studio').hidden && document.querySelector('#st-feed').innerText.includes('Done: the palette is in Drafts.')`);
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('Studio\'s Boost: what a site had is kept, Before/After switches it, Undo puts it back', async () => {
  const s = await setup();
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio'] });
  let wb;
  try {
    wb = await openWorkbench(b);
    const call = (code) => wb.eval(`${code}.then((r) => r, (e) => 'ERR ' + e.message)`);
    assert.deepEqual(await call(`window.workbench.studioBoost('get', 'studio.test')`), []);
    const after = await call(`window.workbench.studioBoost('restore', 'studio.test', [{ id: 'b1', host: 'studio.test', name: 'Brand', css: 'body { color: rebeccapurple; }', enabled: true }])`);
    assert.equal(after.length, 1);
    assert.equal(after[0].css, 'body { color: rebeccapurple; }');
    const off = await call(`window.workbench.studioBoost('enable', 'studio.test', 'b1', false)`);
    assert.equal(off[0].enabled, false);
    assert.deepEqual(await call(`window.workbench.studioBoost('restore', 'studio.test', [])`), []);
    // Only that site, only a site.
    assert.match(await call(`window.workbench.studioBoost('get', 'not a host')`), /^ERR Not a site/);
    assert.match(await call(`window.workbench.studioBoost('restore', 'studio.test', [{ host: 'other.test', css: 'x' }])`).then(JSON.stringify), /\[\]/);
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});
