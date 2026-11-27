// The Workbench's Chats list (a preview, off by default: Customize › Advanced › "Chats list (preview)").
// On: the left pane switches "Chats | Files | Changes"; Chats lists the agent sessions (the terminals'
// tabs, in their order, never reordered); each row says what the session is doing, from Claude Code's
// own hooks only: needs you (a permission prompt), working (a turn runs), done (a turn ended while
// another session was on screen — until it's shown), idle. The strip over the terminal shows only the
// session on screen, with the same mark. The Workbench's row in the sidebar wears one mark for them
// all (orange + count > blue + count > spinner); a click on it while one needs you opens that one.
// Off: the Workbench is exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code: one session per run (Alpha, Beta, Gamma…), its hooks fired on commands
// typed into its terminal (no AI anywhere): `prompt` starts a turn running a command, `perm` asks to
// run `dotnet test`, an empty line answers it and ends the turn, `stop` ends the turn.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys, uuid
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
here = os.path.dirname(os.path.abspath(__file__))
counter = os.path.join(here, 'count')
n = int(open(counter).read()) if os.path.exists(counter) else 0
open(counter, 'w').write(str(n + 1))
name = ['Alpha', 'Beta', 'Gamma', 'Delta'][n % 4]
sid = str(uuid.uuid4())
transcript = os.path.join(here, sid + '.jsonl')
env = dict(os.environ, HOME=os.path.join(here, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
def hook(event, **fields):
    for entry in settings['hooks'].get(event, []):
        for h in entry['hooks']:
            data = json.dumps(dict(hook_event_name=event, session_id=sid, cwd=cwd, **fields))
            if event == 'PermissionRequest':
                p = subprocess.Popen(h['command'], shell=True, stdin=subprocess.PIPE, text=True, stdout=subprocess.DEVNULL, env=env)
                p.stdin.write(data); p.stdin.close()
            else:
                subprocess.run(h['command'], shell=True, input=data, text=True, env=env)
def status():
    st = {'session_id': sid, 'session_name': name, 'transcript_path': transcript,
      'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'}, 'workspace': {'project_dir': cwd, 'current_dir': cwd},
      'context_window': {'context_window_size': 200000, 'used_percentage': 12 + n * 30, 'current_usage': {'input_tokens': 10, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 28000, 'output_tokens': 1}}}
    subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(st), text=True, capture_output=True, env=env)
def answer(text):
    with open(transcript, 'a') as f:
        f.write(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': text}]}}) + '\\n')
hook('SessionStart', model='claude-opus-5-5', source='startup')
status()
print('READY ' + name, flush=True)
for line in sys.stdin:
    cmd = line.strip()
    if cmd == 'prompt':
        hook('UserPromptSubmit')
        hook('PreToolUse', tool_name='Bash', tool_use_id='t1', tool_input={'command': 'npm run e2e'})
    elif cmd == 'perm':
        hook('UserPromptSubmit')
        hook('PreToolUse', tool_name='Bash', tool_use_id='t2', tool_input={'command': 'dotnet test'})
        hook('PermissionRequest', tool_name='Bash', tool_use_id='t2', tool_input={'command': 'dotnet test'})
    elif cmd == 'stop':
        hook('PostToolUse', tool_name='Bash', tool_use_id='t1', tool_input={})
        answer('Push schedule updated, e2e green.')
        hook('Stop')
    elif cmd == '':
        hook('PostToolUse', tool_name='Bash', tool_use_id='t2', tool_input={})
        answer('Tests pass.')
        hook('Stop')
    status()
    print('OK ' + cmd, flush=True)
`;

const shots = process.env.MERIDIAN_SHOTS;
async function shot(page, name) {
  if (!shots) return;
  const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
}
async function sidebarShot(b, name) {
  if (!shots) return;
  const r = await b.eval(`(() => { const r = app.$.tabstrip.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 420) }; })()`);
  const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 2 } });
  fs.writeFileSync(path.join(shots, name), Buffer.from(data, 'base64'));
}
async function scheme(pages, value) {
  for (const p of pages) await p.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
}

// A real click in the Workbench page.
async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

function setup() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-chats-')));
  const bin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-')));
  fs.mkdirSync(path.join(bin, 'home'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  return { project, bin };
}

async function openWorkbench(b) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor('!!S.project');
  return wb;
}

// Starts a Claude Code session; resolves with its terminal id once its first status line named it.
async function startSession(wb, name) {
  const id = await wb.eval(`launch('claude').then((t) => t.id)`);
  await wb.waitFor(`(() => { const t = S.terms.find((x) => x.id === ${JSON.stringify(id)}); return t && termName(t) === ${JSON.stringify(name)}; })()`, 15000);
  return id;
}

const type = (wb, id, text) => wb.eval(`(() => { window.workbench.ptyWrite(${JSON.stringify(id)}, ${JSON.stringify(text + '\r')}); return true; })()`);
const row = (id) => `document.querySelector('#chats-view .chat-row[data-term=${JSON.stringify(id)}]')`;
const rowState = (wb, id) => wb.eval(`${row(id)}?.dataset.state`);
const wbRow = `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url.startsWith('chrome://workbench'))`;
const badge = `${wbRow}?.shadowRoot.querySelector('.wb-badge')`;
const badgeText = `(() => { const b = ${badge}; return b ? b.dataset.kind + ':' + b.textContent.trim() : 'none'; })()`;
const visibleTabs = `[...document.querySelectorAll('#term-tab-list .ttab')].filter((t) => getComputedStyle(t).display !== 'none').length`;

test('Chats list off (the default): the Workbench looks and works as before, and tells Meridian nothing', { skip: process.platform === 'win32' && 'the stand-in Claude Code is a Python script' }, async () => {
  const { project, bin } = setup();
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  let wb;
  try {
    wb = await openWorkbench(b);
    const a = await startSession(wb, 'Alpha');
    await startSession(wb, 'Beta');
    await type(wb, a, 'perm');
    const state = () => b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))');
    for (let i = 0; i < 75 && !(await state()).nodes.some((n) => n.status === 'waiting'); i++) await sleep(200);
    const s = await state();
    assert.ok(s.nodes.some((n) => n.status === 'waiting'), 'the stand-in asked');
    // Nothing of the list anywhere: no Chats view, the same two-way switch, every tab in the strip.
    assert.equal(await wb.eval(`document.querySelector('#view-chats, #chats-view, #chats-tools')`), null);
    assert.equal(await wb.eval(`document.body.dataset.chats ?? null`), null);
    assert.deepEqual(await wb.eval(`[...document.querySelectorAll('#left-views .left-view')].map((b) => b.id)`), ['view-files', 'view-scm']);
    assert.equal(await wb.eval(`document.querySelector('#view-files').classList.contains('on')`), true);
    assert.equal(await wb.eval(visibleTabs), 2);
    assert.equal(await wb.eval(`document.querySelectorAll('.ss-mark').length`), 0);
    // Meridian lists no Workbench as showing chats, and the sidebar's Workbench row has no mark.
    assert.deepEqual(s.chats, []);
    assert.equal(await b.eval(badgeText), 'none');
    // The switch is there, off.
    await wb.eval(`openPanel('customize')`);
    await wb.waitFor(`!!document.querySelector('.chats-list input')`);
    assert.equal(await wb.eval(`document.querySelector('.chats-list input').checked`), false);
    await shot(wb, 'chats-off-light.png');
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Chats list on: sessions with their status from hooks, done-unseen clears when shown, one mark in the sidebar, a click opens the one that needs you', { skip: process.platform === 'win32' && 'the stand-in Claude Code is a Python script' }, async () => {
  const { project, bin } = setup();
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  let wb;
  try {
    wb = await openWorkbench(b);
    // Turned on in Customize › Advanced, with a real click.
    await wb.eval(`openPanel('customize')`);
    await wb.waitFor(`!!document.querySelector('.chats-list input')`);
    await wb.eval(`(() => { document.querySelector('details.advanced').open = true; return true; })()`);
    await click(wb, `document.querySelector('.chats-list input')`);
    await wb.waitFor(`document.body.dataset.chats === 'on' && !!document.querySelector('#view-chats.on')`);
    assert.deepEqual(await wb.eval(`[...document.querySelectorAll('#left-views .left-view')].map((b) => b.id)`), ['view-chats', 'view-files', 'view-scm']);
    assert.equal(await wb.eval(`localStorage.getItem('wb.chatsList')`), '1');
    await wb.eval(`(() => { document.querySelector('#side-close').click(); return true; })()`);

    const a = await startSession(wb, 'Alpha');
    const bb = await startSession(wb, 'Beta');
    const c = await startSession(wb, 'Gamma');
    const order = [a, bb, c];
    const rows = () => wb.eval(`[...document.querySelectorAll('#chats-view .chat-row')].map((r) => r.dataset.term)`);
    await wb.waitFor(`document.querySelectorAll('#chats-view .chat-row').length === 3`);
    assert.deepEqual(await rows(), order, 'the terminals, in their order');
    assert.equal(await wb.eval(`document.querySelector('#chats-count').textContent`), '3');
    // The strip shows only the session on screen (the last started).
    assert.equal(await wb.eval(visibleTabs), 1);
    assert.equal(await wb.eval(`S.activeTerm.id`), c);
    assert.equal(await wb.eval(`${row(c)}.classList.contains('active')`), true);
    // Each row: name, context gauge; idle sessions have no mark.
    await wb.waitFor(`${row(a)}?.dataset.state === 'idle'`, 10000);
    assert.equal(await wb.eval(`${row(a)}.querySelector('.chat-name').textContent`), 'Alpha');
    assert.equal(await wb.eval(`${row(a)}.querySelector('.chat-words').textContent`), 'Idle');
    assert.match(await wb.eval(`${row(a)}.querySelector('.ctx-badge')?.textContent || ''`), /^12%$/);
    assert.equal(await wb.eval(`${row(a)}.querySelector('.ss-mark')`), null);
    assert.equal(await b.eval(badgeText), 'none');

    // Working: a turn runs in Alpha (not on screen) — a spinner on its row, the sidebar spins.
    await type(wb, a, 'prompt');
    await wb.waitFor(`${row(a)}?.dataset.state === 'working'`, 10000);
    assert.ok(await wb.eval(`!!${row(a)}.querySelector('.ss-mark.working')`));
    // "Working" comes with UserPromptSubmit, the tool with the next hook (PreToolUse): two hook processes.
    // Mission Control sends its changes at most every 80 ms, so when the second hook starts later than
    // that (a busy machine) the page first gets "Working" alone; the tool follows in the same state.
    await wb.waitFor(`${row(a)}.querySelector('.chat-words').textContent === 'Working · Bash(npm run e2e)'`);
    await b.waitFor(`${badgeText} === 'working:'`);

    // Done, not seen: Alpha's turn ends while Gamma is on screen — blue, the sidebar says 1.
    await type(wb, a, 'stop');
    await wb.waitFor(`${row(a)}?.dataset.state === 'done'`, 10000);
    assert.ok(await wb.eval(`!!${row(a)}.querySelector('.ss-mark.done')`));
    await wb.waitFor(`${row(a)}.querySelector('.chat-words').textContent.startsWith('Done')`);
    await b.waitFor(`${badgeText} === 'done:1'`);

    // Needs you: Beta asks to run dotnet test — orange, bolder, in words; it outranks done.
    await type(wb, bb, 'perm');
    await wb.waitFor(`${row(bb)}?.dataset.state === 'needs'`, 10000);
    assert.ok(await wb.eval(`!!${row(bb)}.querySelector('.ss-mark.needs')`));
    assert.equal(await wb.eval(`${row(bb)}.querySelector('.chat-words').textContent`), 'Needs you · Allow Bash(dotnet test)?');
    assert.equal(await wb.eval(`getComputedStyle(${row(bb)}.querySelector('.chat-name')).fontWeight`), '650');
    await b.waitFor(`${badgeText} === 'needs:1'`);
    // The order never follows the status.
    assert.deepEqual(await rows(), order);
    // The strip's tab (Gamma, idle) has no mark; marks show on the tab of a session on screen.
    assert.equal(await wb.eval(`document.querySelector('#term-tab-list .ttab.active .ss-mark')`), null);

    await shot(wb, 'chats-on-light.png');
    await sidebarShot(b, 'sidebar-badge-needs-light.png');
    await scheme([wb, b], 'dark');
    await sleep(300);
    await shot(wb, 'chats-on-dark.png');
    await sidebarShot(b, 'sidebar-badge-needs-dark.png');
    await scheme([wb, b], 'light');

    // A click on the Workbench's row in the sidebar, from another tab: the Workbench opens on Beta.
    await b.eval('app.$.tabstrip.openUrl("about:blank")');
    await b.waitFor(`!${wbRow}.tab.isActive`);
    await b.click(`${wbRow}.shadowRoot.querySelector('.title')`);
    await b.waitFor(`${wbRow}.tab.isActive`);
    await wb.waitFor(`S.activeTerm?.id === ${JSON.stringify(bb)}`, 10000);
    assert.equal(await wb.eval(`document.querySelector('#term-tab-list .ttab.active .ss-mark.needs') !== null`), true, 'the strip shows its mark');

    // Showing Alpha (a click on its row) clears its "done".
    await click(wb, row(a));
    await wb.waitFor(`S.activeTerm?.id === ${JSON.stringify(a)}`);
    await wb.waitFor(`${row(a)}?.dataset.state === 'idle'`, 10000);
    await b.waitFor(`${badgeText} === 'needs:1'`);

    // Beta answered (it's not on screen, so its turn's end is "done"); then shown: all quiet.
    await type(wb, bb, '');
    await wb.waitFor(`${row(bb)}?.dataset.state === 'done'`, 10000);
    await b.waitFor(`${badgeText} === 'done:1'`);
    await sidebarShot(b, 'sidebar-badge-done-light.png');
    await click(wb, row(bb));
    await wb.waitFor(`${row(bb)}?.dataset.state === 'idle'`, 10000);
    await b.waitFor(`${badgeText} === 'none'`);
    assert.deepEqual(await rows(), order);

    // A session on screen that finishes stays plain idle (it was seen).
    await type(wb, bb, 'prompt');
    await wb.waitFor(`${row(bb)}?.dataset.state === 'working'`, 10000);
    assert.ok(await wb.eval(`!!document.querySelector('#term-tab-list .ttab.active .ss-mark.working')`));
    await type(wb, bb, 'stop');
    await wb.waitFor(`${row(bb)}?.dataset.state === 'idle'`, 10000);
    await sleep(500);
    assert.equal(await rowState(wb, bb), 'idle');
    assert.equal(await b.eval(badgeText), 'none');

    // Files and Changes still switch; Chats comes back.
    await click(wb, `document.querySelector('#view-files')`);
    await wb.waitFor(`!document.querySelector('#tree').hidden && getComputedStyle(document.querySelector('#chats-view')).display === 'none'`);
    await click(wb, `document.querySelector('#view-chats')`);
    await wb.waitFor(`getComputedStyle(document.querySelector('#tree')).display === 'none' && getComputedStyle(document.querySelector('#chats-view')).display !== 'none'`);

    // Off again: the old Workbench, and Meridian stops counting.
    await type(wb, c, 'perm');
    await b.waitFor(`${badgeText} === 'needs:1'`);
    await wb.eval(`openPanel('customize')`);
    await wb.waitFor(`!!document.querySelector('.chats-list input')`);
    await wb.eval(`(() => { document.querySelector('details.advanced').open = true; return true; })()`);
    await click(wb, `document.querySelector('.chats-list input')`);
    await wb.waitFor(`!document.body.dataset.chats && !document.querySelector('#view-chats')`);
    assert.equal(await wb.eval(visibleTabs), 3);
    assert.equal(await wb.eval(`document.querySelectorAll('.ss-mark').length`), 0);
    assert.equal(await wb.eval(`document.querySelector('#view-files').classList.contains('on')`), true);
    await b.waitFor(`${badgeText} === 'none'`);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
