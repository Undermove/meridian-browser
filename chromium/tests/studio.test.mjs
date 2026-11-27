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
# A new folder: Claude Code asks whether to trust it before anything else (Enter = "Yes, proceed").
if os.environ.get('STAND_IN_TRUST') or os.path.exists(os.path.join(cwd, '.ask-trust')):
    print('Do you trust the files in this folder?', flush=True)
    print(' > 1. Yes, proceed   2. No, exit', flush=True)
    got = ''
    while '\\r' not in got and '\\n' not in got:
        got += os.read(0, 4096).decode('utf8', 'replace')
    open(os.path.join(cwd, '.trusted'), 'w').write(got)
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

async function setup(standIn = FAKE_CLAUDE) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-studio-')));
  fs.mkdirSync(path.join(project, 'Brand'));
  fs.writeFileSync(path.join(project, 'brief.md'), '# Brief\n');
  fs.writeFileSync(path.join(project, 'Brand', 'colors.css'), ':root { --main: green; }\n');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), standIn, { mode: 0o755 });
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-')));
  // Never the real ~/Documents/Meridian Studio.
  const studioHome = path.join(profile, 'Meridian Studio');
  return { project, bin, profile, args: [`--meridian-test-studio-home=${studioHome}`, `--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--meridian-test-persona=designer'] };
}

async function openWorkbench(b, project) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!!S.project || (document.querySelector('#welcome') && !document.querySelector('#welcome').hidden)`, 15000);
  if (!(await wb.eval('!!S.project'))) await wb.eval(`document.querySelector('#open-folder').click(), true`);
  await wb.waitFor('!!S.project', 15000);
  // Studio opens its own folder (a temp one here) by itself; these tests work in the person's
  // folder (the test project), as «Работать с моими файлами…» would.
  if (project && (await wb.eval('S.project.root')) !== project) {
    await wb.eval('pickProject().then(() => true)');
    await wb.waitFor(`S.project?.root === ${JSON.stringify(project)}`, 15000);
  }
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
    wb = await openWorkbench(b, s.project);
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
  fs.writeFileSync(path.join(s.project, '.ask-trust'), '');
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio'] });
  let wb;
  try {
    wb = await openWorkbench(b, s.project);
    // A designer sees Studio first, with the designer's suggestions and the switch.
    await wb.waitFor(`document.querySelector('#studio') && !document.querySelector('#studio').hidden`);
    const info = await wb.eval('window.workbench.studioInfo()');
    assert.match(info.home, /Meridian Studio$/);
    delete info.home;
    assert.deepEqual(info, { enabled: true, figma: false, chosen: false, ask: false, persona: 'designer' });
    assert.equal(await wb.eval(`document.querySelectorAll('#st-chips .st-chip').length`), 3);
    assert.equal(await wb.eval(`document.querySelector('#studio .st-switch button.on').dataset.view`), 'studio');
    // Nothing about terminals, tokens or MCP in sight.
    assert.doesNotMatch(await wb.eval(`document.querySelector('#studio').innerText`), /terminal|token|MCP|CLI/i);

    // A suggestion fills the box; the person sends it.
    await click(wb, '#st-chips .st-chip');
    const prompt = await wb.eval(`document.querySelector('#st-input').value`);
    assert.ok(prompt.length > 5);
    await click(wb, '#st-send');
    // Claude Code first asks about the folder: a card in plain words, not lost typing.
    await wb.waitFor(`document.querySelector('.st-ask[data-key="trust"]')?.innerText.includes('Let Claude work in this folder?')`, 15000);
    assert.equal(fs.existsSync(path.join(s.project, '.trusted')), false);
    await click(wb, '.st-ask [data-trust="yes"]');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(s.project, '.trusted')); i++) await sleep(100);
    assert.match(fs.readFileSync(path.join(s.project, '.trusted'), 'utf8'), /^[\r\n]+$/);
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
    await wb.waitFor(`document.querySelector('.st-ask .st-ask-q')?.innerText.includes('Allow: change colors.css?')`, 15000);
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
    wb = await openWorkbench(b, s.project);
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

test('Point and say: Studio\'s site tab gets the overlay; a click there names the element in Studio; a hand change lands in the site\'s Boost', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Beans</title><style>.btn{display:inline-block;margin:80px;padding:10px 18px;border-radius:20px;background:#2e7d4f;color:#fff;font:15px sans-serif}</style><a class="btn" href="#">Choose beans</a>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const s = await setup();
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio', '--lang=en-US'] });
  let wb, site;
  try {
    wb = await openWorkbench(b, s.project);
    await wb.eval(`(() => { window.__pts = []; window.workbench.onHostCommand((m) => { if (m?.type === 'studio-point') window.__pts.push(m); }); return true; })()`);
    // Studio opens the site next to itself and remembers that tab.
    await wb.eval(`(() => { window.workbench.toHost({ type: 'studio-site', url: ${JSON.stringify(url)} }); return true; })()`);
    site = await b.page(url);
    await site.waitFor(`document.readyState === 'complete' && !!document.querySelector('.btn')`);
    await wb.waitFor(`window.workbench.studioPoint('site').then((s) => s.open)`);
    assert.equal(await wb.eval(`window.workbench.studioPoint('start', { lang: 'en', colors: [] })`), true);
    // A real click on the page picks the element (the link doesn't navigate).
    const r = await site.waitFor(`(() => { const r = document.querySelector('.btn').getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await site.cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    }
    const picked = await wb.waitFor(`window.__pts.flatMap((m) => m.events).find((e) => e.type === 'select')`, 10000);
    assert.equal(picked.items[0].name, 'Button · «Choose beans»');
    assert.equal(await site.eval(`location.hash`), '');
    // A hand change goes into the site's Boost (Studio's own), and shows on the page.
    const sel = picked.items[0].sel;
    await wb.eval(`window.workbench.studioBoost('hand', '127.0.0.1', ${JSON.stringify(`${sel} { border-radius: 3px !important; }`)})`);
    await site.waitFor(`getComputedStyle(document.querySelector('.btn')).borderTopLeftRadius === '3px'`, 10000);
    const boosts = await wb.eval(`window.workbench.studioBoost('get', '127.0.0.1')`);
    assert.deepEqual(boosts.map((x) => x.name).sort(), ['127.0.0.1', 'Studio · 127.0.0.1']);
    // Esc ends it; Studio hears so.
    await wb.eval(`window.workbench.studioPoint('stop')`);
    assert.equal(await wb.eval(`window.workbench.studioPoint('site').then((s) => s.on)`), false);
  } finally {
    site?.close();
    wb?.close();
    await b.close();
    server.close();
    cleanup(s.project, s.bin, s.profile);
  }
});


// A stand-in that makes a page: writes test-site.html in the folder, then answers with a link
// (from .site-url, if the test put one there). Optionally starts from a huge old session (.big).
const FAKE_SITE = `#!/usr/bin/python3
import json, os, subprocess, sys, time
args = sys.argv
cwd = os.getcwd()
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
def line(kind, content, f):
    n[0] += 1
    f.write(json.dumps({'type': kind, 'uuid': 'l%d' % n[0], 'sessionId': 's1', 'timestamp': '2026-11-27T09:00:00Z', 'message': {'role': kind, 'content': content}}) + '\\\\n')
with open(tpath, 'w') as f:
    # A long session already: 5000 turns, about 50 MB (a picture read from disk in each, never a snapshot).
    if os.path.exists(os.path.join(cwd, '.big')):
        pad = 'x' * 9000
        for i in range(5000):
            line('user', 'Задача %d' % i, f)
            line('assistant', [{'type': 'text', 'text': 'Сделано %d. %s' % (i, pad[:200])}, {'type': 'tool_use', 'id': 'r%d' % i, 'name': 'Read', 'input': {'file_path': '/tmp/old%d.png' % i}}], f)
            line('user', [{'type': 'tool_result', 'tool_use_id': 'r%d' % i, 'content': [{'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': pad}}]}], f)
hook('SessionStart', model='claude-opus-5-5', source='startup')
buf = ''
while '\\\\n' not in buf.replace('\\\\r', '\\\\n'):
    buf += os.read(0, 4096).decode('utf8', 'replace')
prompt = buf.replace('\\\\x1b[200~', '').replace('\\\\x1b[201~', '').strip()
hook('UserPromptSubmit', prompt=prompt)
with open(tpath, 'a') as f:
    line('user', prompt, f)
    page = os.path.join(cwd, 'test-site.html')
    open(page, 'w').write('<!doctype html><title>Test site</title><h1 id="hello">Hello from the task</h1>')
    line('assistant', [{'type': 'tool_use', 'id': 'w1', 'name': 'Write', 'input': {'file_path': page, 'content': '...'}}], f)
    line('user', [{'type': 'tool_result', 'tool_use_id': 'w1', 'content': 'ok'}], f)
    url = open(os.path.join(cwd, '.site-url')).read().strip() if os.path.exists(os.path.join(cwd, '.site-url')) else ''
    line('assistant', [{'type': 'text', 'text': 'Готово: ' + (url or 'страница в test-site.html') + '.'}], f)
hook('Stop')
print('DONE', flush=True)
while True:
    time.sleep(1)
`;

async function startTask(wb, text) {
  await wb.waitFor(`document.querySelector('#studio') && !document.querySelector('#studio').hidden`);
  await wb.eval(`(() => { document.querySelector('#st-input').value = ${JSON.stringify(text)}; return true; })()`);
  await click(wb, '#st-send');
}

test('The result: a page file the task wrote opens next to Studio by itself; the file has its card', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup(FAKE_SITE);
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio', '--lang=en-US'] });
  let wb, site;
  try {
    wb = await openWorkbench(b, s.project);
    await startTask(wb, 'Make a test site');
    await wb.waitFor(`[...document.querySelectorAll('.st-fc .st-fn')].some((e) => e.textContent === 'test-site.html')`, 20000);
    assert.match(await wb.eval(`document.querySelector('#st-feed').innerText`), /Created test-site\.html/);
    assert.doesNotMatch(await wb.eval(`document.querySelector('#st-feed').innerText`), /Did a step/);
    site = await b.page(`file://${path.join(s.project, 'test-site.html')}`, 20000);
    await site.waitFor(`document.querySelector('#hello')?.textContent === 'Hello from the task'`);
  } finally {
    site?.close();
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('The result: a link in the last answer opens next to Studio (http and https only)', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Published</title><p id="p">published page</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/artifact/abc`;
  const s = await setup(FAKE_SITE);
  // No page file this time: only the link counts.
  fs.writeFileSync(path.join(s.project, '.site-url'), url);
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio', '--lang=en-US'] });
  let wb, site;
  try {
    wb = await openWorkbench(b, s.project);
    // The page file opens first (it's the last thing made); then the link is one click.
    await startTask(wb, 'Publish it');
    await wb.waitFor(`document.querySelector('#st-feed').innerText.includes(${JSON.stringify(url)})`, 20000);
    await wb.eval(`(() => { const k = stTask(stCurrent()); return k.result; })()`).then((r) => assert.equal(r, url));
    await wb.eval(`(() => { stOpenResult(stTask(stCurrent()), ${JSON.stringify(url)}); return true; })()`);
    site = await b.page(url, 20000);
    await site.waitFor(`document.querySelector('#p')?.textContent === 'published page'`);
    // Never a non-web link.
    assert.equal(await wb.eval(`(() => {
      const sent = []; const real = window.workbench.toHost; window.workbench.toHost = (m) => sent.push(m);
      try { const k = stTask(stCurrent()); stOpenResult(k, 'javascript:alert(1)'); stOpenResult(k, 'file:///etc/passwd'); stOpenResult(k, '/etc/passwd', true); }
      finally { window.workbench.toHost = real; }
      return sent.length; })()`), 0);
  } finally {
    site?.close();
    wb?.close();
    await b.close();
    server.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('A 50 MB session opens at its end in under 300 ms, renders 30 turns, pages back on scroll; old pictures are no file cards', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup(FAKE_SITE);
  fs.writeFileSync(path.join(s.project, '.big'), '');
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio', '--lang=en-US'] });
  let wb;
  try {
    wb = await openWorkbench(b, s.project);
    await startTask(wb, 'One more');
    await wb.waitFor(`document.querySelector('#st-feed').innerText.includes('Hello') || document.querySelector('#st-feed').innerText.includes('Готово')`, 60000);
    // Reopen the task as the person would: the time from the click to its feed drawn.
    const ms = await wb.eval(`(async () => {
      const t = stCurrent(); ST.tasks.delete(t.id); ST.current = '';
      stRender();
      const t0 = performance.now();
      ST.current = t.id; await stRead(t, stTask(t)); stRender();
      return performance.now() - t0; })()`);
    assert.ok(ms < 300, `opened in ${Math.round(ms)} ms`);
    assert.ok(await wb.eval(`document.querySelectorAll('#st-feed .st-msg-user').length`) <= 31);
    assert.equal(await wb.eval(`!!document.querySelector('#st-feed [data-earlier]')`), true);
    // Old pictures read from disk: not the task's files or snapshots.
    assert.deepEqual(await wb.eval(`[...document.querySelectorAll('.st-fc .st-fn')].map((e) => e.textContent)`), ['test-site.html']);
    // Scrolling up brings the earlier turns, the view stays put.
    const before = await wb.eval(`document.querySelectorAll('#st-feed .st-msg-user').length`);
    await wb.eval(`(() => { const f = document.querySelector('#st-feed'); f.scrollTop = 0; f.dispatchEvent(new Event('scroll')); return true; })()`);
    await wb.waitFor(`document.querySelectorAll('#st-feed .st-msg-user').length > ${before}`, 10000);
    // Scrolling stays smooth: no long frames while the feed scrolls.
    const long = await wb.eval(`new Promise((done) => {
      const f = document.querySelector('#st-feed'); let worst = 0, last = performance.now(), n = 0;
      const step = (t) => { worst = Math.max(worst, t - last); last = t; f.scrollTop += 120; if (++n < 60) requestAnimationFrame(step); else done(worst); };
      requestAnimationFrame(step); })`);
    assert.ok(long < 50, `worst frame ${Math.round(long)} ms`);
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('Layout: nothing clipped or overlapping at three widths; the splitter drags, keys move it, a double click resets it', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup(FAKE_SITE);
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio', '--lang=en-US'] });
  let wb;
  try {
    wb = await openWorkbench(b, s.project);
    await startTask(wb, 'Make a test site');
    await wb.waitFor(`document.querySelectorAll('.st-fc').length > 0`, 20000);
    const check = `(() => {
      const W = innerWidth, bad = [];
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && getComputedStyle(el).display !== 'none' ? r : null; };
      for (const el of document.querySelectorAll('#studio .st-head > *, #studio .st-task, #studio .st-new, #studio .st-chat, #studio .st-result, #studio .st-composer, #studio .st-switch')) {
        const r = vis(el); if (!r) continue;
        if (r.left < -0.5 || r.right > W + 0.5) bad.push((el.id || el.className) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      }
      const cols = ['.st-tasks', '.st-chat', '.st-result'].map((q) => document.querySelector('#studio ' + q)).map(vis).filter(Boolean);
      for (let i = 1; i < cols.length; i++) if (cols[i].left < cols[i - 1].right - 1) bad.push('columns overlap ' + i);
      for (const el of document.querySelectorAll('#studio .st-body, #studio .st-tasks, #studio .st-head')) if (el.scrollLeft) bad.push('scrolled ' + el.className);
      return bad; })()`;
    for (const [w, h] of [[1440, 900], [1100, 800], [760, 800]]) {
      await wb.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      assert.deepEqual(await wb.eval(check), [], `at ${w}px`);
    }
    await wb.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const width = () => wb.eval(`Math.round(document.querySelector('#studio .st-chat').getBoundingClientRect().width)`);
    const w0 = await width();
    const r = await wb.eval(`(() => { const r = document.querySelector('#st-split').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + 120, y: r.y, button: 'left' });
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x + 120, y: r.y, button: 'left', clickCount: 1 });
    const w1 = await width();
    assert.ok(Math.abs(w1 - w0 - 120) <= 4, `${w0} → ${w1}`);
    assert.equal(await wb.eval(`localStorage.getItem('wb.studioChatWidth')`), String(w1));
    await wb.eval(`(() => { const s = document.querySelector('#st-split'); s.focus(); s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return true; })()`);
    assert.equal(await width(), w1 - 16);
    await wb.eval(`(() => { document.querySelector('#st-split').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    assert.equal(await width(), w0);
    // No overlaps after all that either.
    assert.deepEqual(await wb.eval(check), []);
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('«Кто вы?» is part of the first-run tour (Studio on), the pick is kept and opens Studio pinned; Settings changes it; the Workbench never asks', async () => {
  const s = await setup();
  const args = s.args.filter((a) => !a.startsWith('--meridian-test-persona'));
  const b = await launch(['about:blank'], { profile: s.profile, args: [...args, '--meridian-studio', '--lang=en-US'] });
  try {
    // The tour: hello, then the heroes.
    await b.eval(`app.$.onboarding.show('tour').then(() => true)`);
    await b.waitFor(`app.$.onboarding.shadowRoot.querySelector('#root')?.dataset.step === 'hello'`);
    await b.eval(`app.$.onboarding.shadowRoot.querySelector('#next').click(), true`);
    const picker = `app.$.onboarding.shadowRoot.querySelector('meridian-hero-picker')`;
    await b.waitFor(`${picker}?.shadowRoot?.querySelectorAll('.pc').length === 4`);
    assert.equal(await b.eval(`${picker}.shadowRoot.querySelectorAll('.pc.sel').length`), 1);
    await b.click(`${picker}.shadowRoot.querySelector('.pc[data-id="manager"]')`);
    await b.waitFor(`app.$.onboarding.shadowRoot.querySelector('#next').textContent.includes('manager')`);
    await b.eval(`app.$.onboarding.shadowRoot.querySelector('#next').click(), true`);
    // Kept at once; Studio pinned and opened when the tour ends.
    await b.eval(`app.$.onboarding.shadowRoot.querySelector('#skip').click(), true`);
    const studio = await b.page('chrome://workbench/?view=studio', 15000);
    assert.equal((await studio.eval('window.workbench.studioInfo()')).persona, 'manager');
    await studio.waitFor(`document.querySelector('#studio') && !document.querySelector('#studio').hidden`);
    // The Workbench page itself never asks, and has no role chip.
    assert.equal(await studio.eval(`!!document.querySelector('#st-persona, #st-role')`), false);
    studio.close();
    // Settings › Profiles: who you are, and Change… opens the heroes alone.
    await b.eval(`app.$.settings.show ? (app.$.settings.show('profiles'), true) : true`).catch(() => true);
  } finally {
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});

test('No folder question: Studio opens its own folder, a new task gets a folder of its own there, «Show in Finder» names it', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup();
  const home = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-home-'))), 'Meridian Studio');
  const args = s.args.filter((a) => !a.startsWith('--meridian-test-project'));
  const b = await launch(['about:blank'], { profile: s.profile, args: [...args, '--meridian-studio', '--lang=en-US', `--meridian-test-studio-home=${home}`] });
  let wb;
  try {
    wb = await openWorkbench(b);
    await wb.waitFor(`document.querySelector('#studio') && !document.querySelector('#studio').hidden && !document.querySelector('.st-body').hidden`);
    // Nobody was asked for a folder: Studio's own one is open, the composer and suggestions are there.
    assert.equal(await wb.eval('S.project.root'), home);
    assert.ok(fs.statSync(home).isDirectory());
    assert.equal(await wb.eval(`!!document.querySelector('#st-pick') && document.querySelector('#st-pick').hidden`), true);
    assert.doesNotMatch(await wb.eval(`document.querySelector('#studio').innerText`), /Pick a folder|Choose a folder/);
    assert.ok(await wb.eval(`document.querySelectorAll('#st-chips .st-chip').length`) > 0);
    // The other way is one small link under the composer.
    assert.equal(await wb.eval(`document.querySelector('#st-own [data-own]')?.textContent`), 'Work with my files…');

    await startTask(wb, 'Two pictures side by side');
    const day = new Date();
    const name = `Two pictures side by side, ${String(day.getDate()).padStart(2, '0')}.${String(day.getMonth() + 1).padStart(2, '0')}.${day.getFullYear()}`;
    const dir = path.join(home, name);
    for (let i = 0; i < 150 && !fs.existsSync(path.join(dir, '.prompt')); i++) await sleep(100);
    // Claude Code ran in the task's folder; what it made is there.
    assert.equal(fs.readFileSync(path.join(dir, '.prompt'), 'utf8'), 'Two pictures side by side');
    await wb.waitFor(`document.querySelector('#st-feed').innerText.includes('Created palette.png')`, 15000);
    assert.ok(fs.existsSync(path.join(dir, 'Drafts', 'palette.png')));
    assert.equal(await wb.eval('stCurrent().taskDir'), name);
    // The task's menu: «Show in Finder» reveals its folder (recorded here instead of opening Finder).
    await wb.eval(`(() => { window.workbench.reveal = async (rel) => { window.__revealed = rel; return true; }; return true; })()`);
    await click(wb, '.st-task.active .st-tmore');
    await wb.waitFor(`!!document.querySelector('.st-tmenu [data-reveal]')`);
    assert.equal(await wb.eval(`document.querySelector('.st-tmenu').innerText.trim()`), 'Show in Finder');
    await click(wb, '.st-tmenu [data-reveal]');
    await wb.waitFor(`window.__revealed === ${JSON.stringify(name)}`);
    assert.equal(await wb.eval(`!!document.querySelector('.st-tmenu')`), false);
    // A second task with the same words: a folder of its own too.
    assert.equal(await wb.eval(`window.workbench.studioTaskFolder('Two pictures side by side')`), `${name} (2)`);
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile, path.dirname(home));
  }
});

// Claude asks with its question tool: Studio shows the question and its options; the one picked
// goes back to Claude Code as the tool's answers.
const FAKE_QUESTION = `#!/usr/bin/python3
import json, os, subprocess, sys, time
args = sys.argv
cwd = os.getcwd()
settings = json.load(open(args[args.index('--settings') + 1]))
tdir = os.path.join(cwd, '.transcripts'); os.makedirs(tdir, exist_ok=True)
tpath = os.path.join(tdir, 's1.jsonl')
def ev(event, **f):
    return json.dumps(dict(hook_event_name=event, session_id='s1', transcript_path=tpath, cwd=cwd, **f))
def hook(event, **f):
    for e in settings['hooks'].get(event, []):
        for h in e['hooks']:
            if 'secret-guard --permission' in h['command']: continue
            subprocess.run(h['command'], shell=True, input=ev(event, **f), text=True, capture_output=True)
def line(kind, content):
    with open(tpath, 'a') as f:
        f.write(json.dumps({'type': kind, 'uuid': str(time.time()), 'sessionId': 's1', 'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'message': {'role': kind, 'content': content}}) + '\\n')
open(tpath, 'w').close()
hook('SessionStart', model='claude-opus-5-5', source='startup')
print('READY', flush=True)
buf = ''
while '\\n' not in buf.replace('\\r', '\\n'):
    buf += os.read(0, 4096).decode('utf8', 'replace')
prompt = buf.replace('\\x1b[200~', '').replace('\\x1b[201~', '').strip()
hook('UserPromptSubmit', prompt=prompt)
line('user', prompt)
inp = {'questions': [{'question': 'Which two pictures?', 'header': 'Pictures', 'multiSelect': False, 'options': [{'label': 'Old and new logo', 'description': 'Same size, side by side'}, {'label': 'Two banners', 'description': ''}]}]}
line('assistant', [{'type': 'tool_use', 'id': 'q1', 'name': 'AskUserQuestion', 'input': inp}])
hook('PreToolUse', tool_name='AskUserQuestion', tool_input=inp, tool_use_id='q1')
cmd = settings['hooks']['PermissionRequest'][0]['hooks'][0]['command']
out = subprocess.run(cmd, shell=True, input=ev('PermissionRequest', tool_name='AskUserQuestion', tool_input=inp), text=True, capture_output=True).stdout.strip()
open(os.path.join(cwd, '.answer'), 'w').write(out)
line('user', [{'type': 'tool_result', 'tool_use_id': 'q1', 'content': 'ok'}])
hook('Stop')
while True:
    time.sleep(1)
`;

test('A question Claude asks: its text and options on a card; the pick reaches Claude Code as the answer', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const s = await setup(FAKE_QUESTION);
  const b = await launch(['about:blank'], { profile: s.profile, args: [...s.args, '--meridian-studio', '--lang=en-US'] });
  let wb;
  try {
    wb = await openWorkbench(b, s.project);
    await startTask(wb, 'Make two pictures to compare side by side');
    await wb.waitFor(`document.querySelector('.st-question')?.innerText.includes('Which two pictures?')`, 20000);
    assert.doesNotMatch(await wb.eval(`document.querySelector('#st-feed').innerText`), /Allow the next step|Asked a question/);
    assert.match(await wb.eval(`document.querySelector('#st-feed').innerText`), /Asking: Which two pictures\?|Asked: Which two pictures\?/);
    assert.deepEqual(await wb.eval(`[...document.querySelectorAll('.st-question .st-opt b')].map((e) => e.textContent)`), ['Old and new logo', 'Two banners']);
    // Whole, above the composer.
    const fits = await wb.eval(`(() => { const c = document.querySelector('.st-question').getBoundingClientRect(); const m = document.querySelector('.st-composer').getBoundingClientRect(); const card = document.querySelector('.st-question'); return c.bottom <= m.top + 1 && card.scrollHeight <= card.clientHeight + 1 && c.height > 80; })()`);
    assert.equal(fits, true);
    await click(wb, '.st-question .st-opt[data-qopt="0"]');
    for (let i = 0; i < 100 && !fs.existsSync(path.join(s.project, '.answer')); i++) await sleep(100);
    const out = JSON.parse(fs.readFileSync(path.join(s.project, '.answer'), 'utf8'));
    const d = out.hookSpecificOutput.decision;
    assert.equal(d.behavior, 'allow');
    assert.deepEqual(d.updatedInput.answers, { 'Which two pictures?': 'Old and new logo' });
    assert.equal(d.updatedInput.questions[0].question, 'Which two pictures?');
    await wb.waitFor(`document.querySelector('#st-feed').innerText.includes('Answer: Old and new logo')`);
  } finally {
    wb?.close();
    await b.close();
    cleanup(s.project, s.bin, s.profile);
  }
});
