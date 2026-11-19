// Demo media for posts, from a test profile and made-up data (no one's paths, accounts or sites):
// a demo project "acme-shop", a stand-in Claude Code with a staged session.
// Usage: node tools/linkedin_media.mjs <out folder> [scene…]   scenes: insights, ask, workbench, restore
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from '../tests/harness.mjs';

const [out, ...only] = process.argv.slice(2);
if (!out) { console.error('usage: node tools/linkedin_media.mjs <out folder> [scene…]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTH = 1600;

// ------------------------------------------------------------------ recording

// Frames of the whole window (the browser's own page holds the pages too), timed as they were taken.
function recorder(browser, name) {
  const self = { b: browser };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `meridian-rec-${name}-`));
  const frames = [];
  let on = false;
  let loop;
  return Object.assign(self, {
    start() {
      on = true;
      loop = (async () => {
        while (on) {
          const t = Date.now();
          try {
            const { data } = await self.b.cdp.send('Page.captureScreenshot', { format: 'png' });
            const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.png`);
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            frames.push({ file, t });
          } catch {}
          await sleep(Math.max(0, 90 - (Date.now() - t)));
        }
      })();
    },
    async stop() { on = false; await loop; },
    // A GIF at WIDTH px, each frame shown as long as it lasted.
    gif(file) {
      const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 1500) - f.t) / 1000).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
      const concat = path.join(dir, 'frames.txt');
      fs.writeFileSync(concat, list);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
        '-vf', `fps=12,scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
        file]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}

async function png(b, file) {
  const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
  const tmp = file + '.full.png';
  fs.writeFileSync(tmp, Buffer.from(data, 'base64'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-vf', `scale=${WIDTH}:-1:flags=lanczos`, file]);
  fs.rmSync(tmp);
}

// A real click on the browser's own page or a page in it (by a JS expression there).
async function click(page, expr) {
  const p = await page.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await sleep(250);
  for (const type of ['mousePressed', 'mouseReleased']) await page.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

// ------------------------------------------------------------------ the demo project and agent

function demoProject() {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-demo-')));
  const dir = path.join(parent, 'acme-shop');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme-shop', version: '1.4.0', scripts: { dev: 'vite', test: 'vitest' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'src', 'login.ts'), `import { api } from './api';

export async function login(email: string, password: string) {
  const res = await api.post('/session', { email, password });
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Wrong email or password' : 'Login failed, try again');
  }
  return res.json();
}
`);
  fs.writeFileSync(path.join(dir, 'src', 'api.ts'), `export const api = {\n  post: (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) }),\n};\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# acme-shop\n\nThe Acme store front.\n');
  return { parent, dir };
}

// A Claude Code session's transcript in Claude Code's format (as the Context Insights test has it).
function transcript(cwd) {
  const t0 = Date.parse('2026-11-18T10:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const lines = [];
  const L = (o) => lines.push(JSON.stringify(o));
  L({ type: 'api-request-shape', shape: {
    system: [{ type: 'text', text: 's'.repeat(8000) }],
    tools: [
      { name: 'Read', description: 'r'.repeat(4000), input_schema: {} },
      { name: 'mcp__meridian__screenshot', description: 'm'.repeat(6000), input_schema: {} },
      { name: 'mcp__meridian__click', description: 'm'.repeat(1600), input_schema: {} },
    ] } });
  L({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: `${cwd}/CLAUDE.md`, type: 'Project', content: 'c'.repeat(4000) }] } });
  L({ type: 'attachment', attachment: { type: 'skill_listing', content: 'k'.repeat(2400), isInitial: true } });
  L({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'Fix the login page' } });
  let n = 0;
  const req = (s, usage, content = []) => L({ type: 'assistant', requestId: `r${++n}`, timestamp: at(s), isSidechain: false,
    message: { id: `m${n}`, model: 'claude-opus-5-5', role: 'assistant', content, usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200, ...usage } } });
  const result = (id, content) => L({ type: 'user', timestamp: at(0), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  req(1, { cache_creation_input_tokens: 9000 }, [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: `${cwd}/src/login.ts` } }]);
  result('u1', 'a'.repeat(40000));
  req(5, { cache_read_input_tokens: 9000, cache_creation_input_tokens: 10200 }, [{ type: 'tool_use', id: 'u2', name: 'mcp__meridian__screenshot', input: {} }]);
  result('u2', [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }]);
  for (let i = 0; i < 8; i++) req(10 + i * 5, { cache_read_input_tokens: 21000 + i * 300, cache_creation_input_tokens: 300 });
  req(60, { cache_read_input_tokens: 23400, cache_creation_input_tokens: 400 }, [{ type: 'tool_use', id: 'u3', name: 'Read', input: { file_path: `${cwd}/src/login.ts` } }]);
  result('u3', 'a'.repeat(40000));
  req(660, { cache_read_input_tokens: 0, cache_creation_input_tokens: 34000 });
  for (let i = 0; i < 5; i++) req(670 + i * 5, { cache_read_input_tokens: 34000 + i * 200, cache_creation_input_tokens: 200 });
  L({ type: 'system', subtype: 'compact_boundary', timestamp: at(700), compactMetadata: { trigger: 'auto', preTokens: 35000, postTokens: 6000 } });
  req(710, { cache_creation_input_tokens: 9000 });
  return lines.join('\n') + '\n';
}

// A stand-in Claude Code that looks like one: its banner, a short exchange, its status line run
// from the --settings it got; then it waits (a line on stdin ends it).
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys, time
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
state = os.path.join(os.path.dirname(cwd), 'sessions')
if '--resume' in args:
  sid = args[args.index('--resume') + 1]
else:
  n = int(open(state).read()) + 1 if os.path.exists(state) else 1
  open(state, 'w').write(str(n))
  sid = 'demo-session-%d' % n
NAMES = {'demo-session-1': 'Fix the login page', 'demo-session-2': 'Write the release notes', 'demo-session-3': 'Speed up the cart'}
mode = 'bypassPermissions' if '--dangerously-skip-permissions' in args else (args[args.index('--permission-mode') + 1] if '--permission-mode' in args else 'default')
name = NAMES.get(sid, 'Fix the login page')
pct = {'demo-session-1': 46, 'demo-session-2': 23, 'demo-session-3': 71}.get(sid, 46)
ask = os.path.exists(os.path.join(os.path.dirname(cwd), 'ask'))
D = '\\x1b[2m'; B = '\\x1b[1m'; R = '\\x1b[0m'; O = '\\x1b[38;5;173m'; G = '\\x1b[32m'
def hook(event, **f):
  for entry in settings.get('hooks', {}).get(event, []):
    for h in entry['hooks']:
      subprocess.run(h['command'], shell=True, input=json.dumps(dict(hook_event_name=event, session_id=sid, cwd=cwd, permission_mode=mode, **f)), text=True, capture_output=True)
print(f'{O}╭───────────────────────────────────────────────╮{R}')
print(f'{O}│{R} {B}✻ Claude Code{R}                                 {O}│{R}')
print(f'{O}│{R}   {D}/help for help · cwd: acme-shop{R}             {O}│{R}')
print(f'{O}╰───────────────────────────────────────────────╯{R}')
print()
hook('SessionStart', model='claude-opus-5-5', source='resume' if '--resume' in args else 'startup')
if '--resume' in args:
  print(f'{D}  Resumed: {name}{R}')
elif ask:
  import queue, threading
  print(f'> Run the tests and fix what fails')
  print()
  hook('UserPromptSubmit', prompt='tests')
  inp = {'command': 'npm test', 'description': 'Run the test suite'}
  hook('PreToolUse', tool_name='Bash', tool_input=inp, tool_use_id='u1')
  print(f'{G}⏺{R} Bash(npm test)')
  print()
  print(f'{O}╭───────────────────────────────────────────────╮{R}')
  print(f'{O}│{R} {B}Bash command{R}                                  {O}│{R}')
  print(f'{O}│{R}   npm test                                    {O}│{R}')
  print(f'{O}│{R}   {D}Run the test suite{R}                          {O}│{R}')
  print(f'{O}│{R} Do you want to proceed?                       {O}│{R}')
  print(f'{O}│{R} {B}❯ 1. Yes{R}                                      {O}│{R}')
  print(f'{O}│{R}   2. No, and tell Claude what to do           {O}│{R}')
  print(f'{O}╰───────────────────────────────────────────────╯{R}', flush=True)
  q = queue.Queue()
  for entry in settings['hooks'].get('PermissionRequest', []):
    for h in entry['hooks']:
      p = subprocess.Popen(h['command'], shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, start_new_session=True)
      p.stdin.write(json.dumps(dict(hook_event_name='PermissionRequest', session_id=sid, cwd=cwd, permission_mode=mode, tool_name='Bash', tool_input=inp, permission_suggestions=[{'type': 'addRules', 'rules': [{'toolName': 'Bash', 'ruleContent': 'npm test'}], 'behavior': 'allow', 'destination': 'localSettings'}]))); p.stdin.close()
      def watch(p=p):
        try: q.put(json.loads(p.stdout.read())['hookSpecificOutput']['decision'])
        except Exception: pass
      threading.Thread(target=watch, daemon=True).start()
  d = q.get()
  print()
  if d.get('behavior') == 'allow':
    print(f'  {D}⎿  Allowed in Meridian{R}')
    time.sleep(0.6)
    print(f'  {D}⎿  ✓ 48 tests passed (3.2s){R}')
    hook('PostToolUse', tool_name='Bash', tool_input=inp, tool_use_id='u1', tool_response={})
    print(f'{G}⏺{R} All 48 tests pass. Nothing to fix.')
  hook('Stop')
else:
  print(f'> Fix the login page: the error message says "Login failed" for a wrong password')
  print()
  hook('UserPromptSubmit', prompt='fix')
  print(f'{G}⏺{R} Read(src/login.ts)')
  print(f'  {D}⎿  Read 9 lines{R}')
  print(f'{G}⏺{R} Update(src/login.ts)')
  print(f'  {D}⎿  Updated src/login.ts with 1 addition and 1 removal{R}')
  print(f'{G}⏺{R} The login form now says "Wrong email or password" on a 401,')
  print(f'  and keeps "Login failed, try again" for other errors.')
  hook('Stop')
print()
now = time.time()
status = {'session_id': sid, 'session_name': name, 'transcript_path': os.path.join(os.path.dirname(cwd), 'demo-session.jsonl'),
  'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'}, 'workspace': {'project_dir': cwd, 'current_dir': cwd},
  'context_window': {'context_window_size': 200000, 'used_percentage': pct,
                     'current_usage': {'input_tokens': 10, 'cache_creation_input_tokens': 2000, 'cache_read_input_tokens': 89990, 'output_tokens': 300}},
  'rate_limits': {'five_hour': {'used_percentage': 41.5, 'resets_at': now + 7200}, 'seven_day': {'used_percentage': 12, 'resets_at': now + 3 * 86400}},
  'prompt_cache': {'requests': 12, 'misses': 1, 'hit_ratio': 0.87, 'warm': True, 'ttl': '5m', 'expires_at': now + 200, 'miss_causes': {'ttl_expired_5m': 1}},
  'cost': {'total_cost_usd': 1.23}}
env = dict(os.environ, HOME=os.path.join(os.path.dirname(cwd), 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
sys.stdout.write(f'{D}>{R} ')
sys.stdout.flush()
sys.stdin.readline()
`;

function demoBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-demo-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  return bin;
}

async function openWorkbench(b, project) {
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden || !!S.project`, 15000);
  if (!(await wb.eval('!!S.project'))) {
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
  }
  return wb;
}

// ------------------------------------------------------------------ scenes

async function insights() {
  const { parent, dir } = demoProject();
  fs.writeFileSync(path.join(parent, 'demo-session.jsonl'), transcript(dir));
  const bin = demoBin();
  const site = await demoSite();
  const b = await launch([site.url('/')], { args: [`--meridian-test-project=${dir}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--window-size=1600,1000'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const wb = await openWorkbench(b, dir);
    await wb.eval(`openFile('src/login.ts', { focus: false }).then(() => true)`);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`document.querySelector('#term-tab-list .ttab.active .ctx-badge')?.textContent === '46%'`, 15000);
    await wb.waitFor(`document.getElementById('limits-chip')?.textContent.includes('5h 42%')`, 10000);
    await sleep(800);
    const rec = recorder(b, 'insights');
    rec.start();
    await sleep(2000);
    // The gauge on the tab, then the usage in the top bar: Context Insights.
    await click(wb, `document.querySelector('#term-tab-list .ttab.active .ctx-badge')`);
    await wb.waitFor(`!document.getElementById('side-pane').hidden && document.querySelector('#side-body').innerText.includes('WHERE THE USAGE WENT')`, 20000);
    await sleep(3500);
    await wb.eval(`document.querySelector('#side-body').scrollTo({ top: 420, behavior: 'smooth' }), true`);
    await sleep(3000);
    await wb.eval(`document.querySelector('#side-body').scrollTo({ top: 900, behavior: 'smooth' }), true`);
    await sleep(3000);
    await rec.stop();
    rec.gif(path.join(out, '01-context-insights.gif'));
    await wb.eval(`document.querySelector('#side-body').scrollTo({ top: 0 }), true`);
    await sleep(500);
    await png(b, path.join(out, '01-context-insights.png'));
    await wb.eval(`document.querySelector('#side-body').scrollTo({ top: 520 }), true`);
    await sleep(500);
    await png(b, path.join(out, '01-context-insights-2.png'));
    console.log('insights: panel text:\n' + (await wb.eval(`document.querySelector('#side-body').innerText`)).slice(0, 1500));
    await wb.eval(`(() => { for (const t of S.terms) window.workbench.ptyWrite(t.id, '\\r'); return true; })()`);
    wb.close();
  } finally { await b.close(); site.server.close(); fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
}

// A demo site: the store's front page on localhost.
async function demoSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url.startsWith('/docs')) {
      res.end(`<title>Handbook — Testing</title><style>body{font:16px/1.6 -apple-system,system-ui;margin:0;color:#1f2328}header{background:#f6f8fa;border-bottom:1px solid #e5e7eb;padding:18px 48px;font-weight:700}main{max-width:760px;margin:40px auto;padding:0 24px}code,pre{background:#f6f8fa;border-radius:6px}pre{padding:14px 18px}h1{font-size:34px}</style>
<header>Acme engineering handbook</header><main><h1>Testing</h1><p>Every change comes with a test. Write the test next to your code and run the whole suite with one command.</p><pre><code>npm test</code></pre><h2>Writing tests</h2><p>A test checks one thing. Group related tests together, and say what you expect.</p><pre><code>test('a wrong password says so', async () => {
  await expect(login('ada@example.com', 'nope')).rejects.toThrow('Wrong email or password')
})</code></pre><h2>Before you push</h2><p>Run the suite. The CI runs it again on every pull request.</p></main>`);
      return;
    }
    res.end(`<title>Acme Shop</title><style>body{font:16px/1.5 -apple-system,system-ui;margin:0;background:#fafaf7;color:#222}nav{display:flex;gap:24px;align-items:center;padding:18px 40px;background:#fff;border-bottom:1px solid #eee}nav b{font-size:20px;margin-right:auto}.hero{padding:56px 40px;background:linear-gradient(120deg,#ffe4d1,#e7e4ff)}.hero h1{font-size:44px;margin:0 0 8px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:32px 40px}.card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 3px #0001}.img{height:120px;border-radius:10px;margin-bottom:12px}form{max-width:340px;margin:24px 40px;background:#fff;padding:20px;border-radius:14px;box-shadow:0 1px 3px #0001}input{width:100%;padding:9px;margin:6px 0 10px;border:1px solid #ddd;border-radius:8px;box-sizing:border-box}.err{color:#c0392b;font-size:14px}button{background:#222;color:#fff;border:0;border-radius:8px;padding:10px 16px}</style>
<nav><b>Acme Shop</b><span>New</span><span>Kitchen</span><span>Outdoor</span><span>Sign in</span></nav>
<div class="hero"><h1>Autumn sale</h1><p>Up to 30% off on everything for the kitchen.</p></div>
<form><b>Sign in</b><br><input value="ada@example.com"><input type="password" value="password"><div class="err">Wrong email or password</div><button type="button">Sign in</button></form>
<div class="grid"><div class="card"><div class="img" style="background:#f4c7a1"></div>Ceramic mug · $14</div><div class="card"><div class="img" style="background:#b8d8c8"></div>Linen apron · $32</div><div class="card"><div class="img" style="background:#c9c3ef"></div>Oak board · $45</div></div>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: (p = '/') => `http://localhost:${server.address().port}${p}` };
}

// A demo profile: the one-time notices already seen.
function demoProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ meridian: { mission_notify_intro: true } }));
  return dir;
}

async function ask() {
  const { parent, dir } = demoProject();
  fs.writeFileSync(path.join(parent, 'demo-session.jsonl'), transcript(dir));
  fs.writeFileSync(path.join(parent, 'ask'), '');
  const bin = demoBin();
  const site = await demoSite();
  const profile = demoProfile();
  const b = await launch([site.url('/')], { profile, args: [`--meridian-test-project=${dir}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--window-size=1600,1000'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const T = 'app.$.tabstrip';
    await b.eval(`${T}.handler_.renameSpace ? true : true`);
    const home = await b.eval(`${T}.state_.spaces[0]`);
    const wb = await openWorkbench(b, dir);
    await wb.eval(`openFile('src/login.ts', { focus: false }).then(() => true)`);
    // Elsewhere: reading the docs in another space.
    const { spaceId: reading } = await b.eval(`${T}.handler_.createSpace('Reading', '📚', '#5aa9e6', '')`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(reading)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(reading)}`);
    await b.eval(`${T}.openUrl(${JSON.stringify(site.url('/docs'))})`);
    await sleep(1500);
    const rec = recorder(b, 'ask');
    rec.start();
    await sleep(1500);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await b.waitFor(`app.$.agentAsks.shadowRoot.querySelectorAll('.card').length === 1`, 15000);
    await sleep(3000);
    // Open: back to the session, in its space; then Allow on the card.
    await click(b, `app.$.agentAsks.shadowRoot.querySelector('.card .open')`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(home.id)}`);
    await sleep(2500);
    if (await b.eval(`app.$.agentAsks.shadowRoot.querySelectorAll('.card').length === 1`)) {
      await click(b, `app.$.agentAsks.shadowRoot.querySelector('.card .allow')`);
    }
    await wb.waitFor(`(() => { const t = S.terms.find((t) => t.kind === 'claude'); const x = t.xterm.buffer.active; return [...Array(x.length).keys()].map((i) => x.getLine(i)?.translateToString(true)).join('\\n').includes('48 tests passed'); })()`, 15000);
    await sleep(3000);
    await rec.stop();
    rec.gif(path.join(out, '02-agent-notification.gif'));
    await wb.eval(`(() => { for (const t of S.terms) window.workbench.ptyWrite(t.id, '\\r'); return true; })()`);
    wb.close();
  } finally { await b.close(); site.server.close(); fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
}

async function workbench() {
  const { parent, dir } = demoProject();
  fs.writeFileSync(path.join(parent, 'demo-session.jsonl'), transcript(dir));
  const bin = demoBin();
  const site = await demoSite();
  const b = await launch([site.url('/sale')], { args: [`--meridian-test-project=${dir}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--window-size=1600,1000'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const wb = await openWorkbench(b, dir);
    await wb.eval(`openFile('src/login.ts', { focus: false }).then(() => true)`);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`document.querySelector('#term-tab-list .ttab.active .ctx-badge')?.textContent === '46%'`, 15000);
    // The app on localhost beside it, in split view (the Workbench's Preview).
    await wb.eval(`(() => { document.getElementById('preview-url').value = ${JSON.stringify(site.url('/'))}; document.getElementById('preview-url').closest('form')?.requestSubmit?.(); return true; })()`);
    await sleep(500);
    if (!(await b.eval(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Acme Shop')`))) {
      await wb.eval(`(() => { window.workbench.toHost({ type: 'preview', url: ${JSON.stringify(site.url('/'))} }); return true; })()`);
    }
    await sleep(3000);
    await png(b, path.join(out, '03-workbench.png'));
    await wb.eval(`(() => { for (const t of S.terms) window.workbench.ptyWrite(t.id, '\\r'); return true; })()`);
    wb.close();
  } finally { await b.close(); site.server.close(); fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); }
}

async function restore() {
  const { parent, dir } = demoProject();
  fs.writeFileSync(path.join(parent, 'demo-session.jsonl'), transcript(dir));
  const bin = demoBin();
  const profile = demoProfile();
  const args = [`--meridian-test-project=${dir}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--window-size=1600,1000'];
  let b = await launch(['about:blank'], { profile, args });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    let wb = await openWorkbench(b, dir);
    await wb.eval(`openFile('src/login.ts', { focus: false }).then(() => true)`);
    for (const n of [1, 2, 3]) {
      await wb.eval(`launch('claude').then((t) => !!t)`);
      await wb.waitFor(`document.querySelectorAll('#term-tab-list .ttab .ctx-badge').length === ${n}`, 15000);
    }
    await sleep(2000);
    const rec = recorder(b, 'restore');
    rec.start();
    await sleep(2500);
    await rec.stop();
    await b.quit();
    b = await launch([], { profile, args });
    rec.b = b;
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
    rec.start();
    try { wb = await b.page('chrome://workbench', 4000); } catch { await b.eval('app.$.tabstrip.runCommand(16, 0)'); wb = await b.page('chrome://workbench'); }
    await wb.waitFor(`document.querySelectorAll('#term-tab-list .ttab .ctx-badge').length === 3`, 20000);
    await sleep(3500);
    await rec.stop();
    rec.gif(path.join(out, '04-claude-restore.gif'));
    console.log('restore: tabs', JSON.stringify(await wb.eval(`[...document.querySelectorAll('#term-tab-list .ttab')].map((t) => t.querySelector('.name').textContent + ' ' + (t.querySelector('.ctx-badge')?.textContent || ''))`)));
    await wb.eval(`(() => { for (const t of S.terms) window.workbench.ptyWrite(t.id, '\\r'); return true; })()`);
    wb.close();
  } finally { await b.close(); fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
}

const SCENES = { insights, ask, workbench, restore };
for (const name of (only.length ? only : Object.keys(SCENES))) {
  console.log('scene', name);
  await SCENES[name]();
}
