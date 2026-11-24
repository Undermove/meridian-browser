// Context Insights for agents other than Claude Code: Codex, OpenCode, Qwen Code, Gemini and Copilot
// each keep their own record of a session (files, or OpenCode's database); Meridian finds the one
// the terminal started and shows its context, its tokens over time and why they went where they
// went. An agent with nothing readable (Amp) says so and never shows another agent's session.
//
// The stand-in agents write sessions copied from the readers' fixtures, which came from the real
// CLIs (run against a local stand-in model): chrome/browser/meridian/workbench/test_data/agent_sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROMIUM = process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium');
const FIXTURES = path.join(CHROMIUM, 'src/chrome/browser/meridian/workbench/test_data/agent_sessions');

// One stand-in for every agent (its name says which): it writes the agent's session record into
// the agents' home, as if its first answer came now, from this folder. With MERIDIAN_WAIT_FILE in
// the folder it waits for that file first (a session that hasn't begun yet).
const FAKE_AGENT = (home) => `#!/usr/bin/python3 -I
import datetime, json, os, re, sqlite3, sys, time, uuid
kind = os.path.basename(sys.argv[0])
HOME, FIX, T0 = ${JSON.stringify(home)}, ${JSON.stringify(FIXTURES)}, 1795600000
cwd = os.getcwd()
while os.path.exists(os.path.join(cwd, 'wait-' + kind)) and not os.path.exists(os.path.join(cwd, 'go')):
    time.sleep(0.2)
delta = time.time() + 1 - T0
utc = datetime.timezone.utc
def iso(m):
    t = datetime.datetime.strptime(m.group(0), '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=utc).timestamp() + delta
    return datetime.datetime.fromtimestamp(t, utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
def text(name):
    s = open(os.path.join(FIX, name)).read()
    s = re.sub(r'20\\d\\d-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z', iso, s)
    s = re.sub(r'\\b1795\\d{9}\\b', lambda m: str(int(m.group(0)) + int(delta * 1000)), s)
    s = re.sub(r'\\b1795\\d{6}\\b', lambda m: str(int(m.group(0)) + int(delta)), s)
    return s.replace('/work/shop', cwd)
def put(rel, s):
    p = os.path.join(HOME, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(s)
sid = str(uuid.uuid4())
if kind == 'codex':
    put(time.strftime('.codex/sessions/%Y/%m/%d/rollout-%Y-%m-%dT%H-%M-%S-') + sid + '.jsonl', text('codex-rollout.jsonl'))
elif kind == 'qwen':
    put('.qwen/projects/' + re.sub('[^A-Za-z0-9]', '-', cwd) + '/chats/' + sid + '.jsonl', text('qwen-chat.jsonl'))
elif kind == 'gemini':
    put('.gemini/projects.json', json.dumps({'projects': {cwd: 'shop'}}))
    put('.gemini/tmp/shop/chats/session-' + sid[:8] + '.jsonl', text('gemini-session.jsonl'))
elif kind == 'copilot':
    put('.copilot/session-state/' + sid + '/events.jsonl', text('copilot-events.jsonl'))
elif kind == 'opencode':
    put('.cache/opencode/models.json', json.dumps({'mock': {'models': {'mock-model': {'limit': {'context': 128000}, 'cost': {'input': 3, 'output': 15, 'cache_read': 0.3, 'cache_write': 3.75}}}}}))
    os.makedirs(os.path.join(HOME, '.local/share/opencode'), exist_ok=True)
    db = sqlite3.connect(os.path.join(HOME, '.local/share/opencode/opencode.db'))
    db.executescript(text('opencode.sql'))
    db.commit()
    db.close()
print('ready', flush=True)
sys.stdin.readline()
`;

async function setup() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-ai-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-agent-home-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  for (const name of ['codex', 'opencode', 'qwen', 'gemini', 'copilot', 'amp']) fs.writeFileSync(path.join(bin, name), FAKE_AGENT(home), { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, `--meridian-agent-home=${home}`, '--meridian-no-notify'] });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor('!!S.project');
  const done = async () => { wb.close(); await b.close(); for (const d of [project, home, bin]) fs.rmSync(d, { recursive: true, force: true }); };
  return { b, wb, project, home, done };
}

// A real click in the Workbench page.
async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
const termText = `S.activeTerm ? [...Array(S.activeTerm.xterm.buffer.active.length).keys()].map((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true)).join('\\n') : ''`;
const panel = `(document.querySelector('#side-body')?.innerText || '')`;

async function start(wb, kind) {
  await wb.eval(`launch('${kind}').then((t) => !!t)`);
  await wb.waitFor(`S.activeTerm?.kind === '${kind}' && ${termText}.includes('ready')`, 15000);
}

async function shot(wb, name) {
  if (!process.env.SHOTS) return;
  await sleep(300);
  const { data } = await wb.cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}

// The panel's text for an agent, once its session is read.
async function panelFor(wb, label, extra) {
  await wb.waitFor(`${panel}.includes(${JSON.stringify(label)}) && ${panel}.includes(${JSON.stringify(extra)})`, 20000);
  return wb.eval(panel);
}
const has = (text, list) => { for (const s of list) assert.ok(text.includes(s), `the panel says “${s}”:\n${text}`); };

test('Codex, OpenCode, Qwen Code, Gemini and Copilot sessions show in Context Insights, each its own; Amp says it isn’t available', async () => {
  const { wb, done } = await setup();
  try {
    // Codex: its rollout file. A click on the topbar's usage chip opens the panel on the active tab.
    await start(wb, 'codex');
    await click(wb, `document.getElementById('limits-chip')`);
    let text = await panelFor(wb, 'Codex', 'Tokens over time');
    has(text, ['gpt-5.5-codex', '6k / 258k', 'Codex’s plan', '5-hour window', '34%', 'Week', 'Compacted 1×',
      'Big file read', 'Big tool output', 'Cold cache', 'Compaction', 'The cache went cold 1 time', 'no money is shown', '9 requests']);
    assert.doesNotMatch(text, /\$\d/, 'tokens, not dollars, where no price is known');
    // The bars' turns say what made them cost.
    const why = await wb.eval(`CI.data.moneySeries.flatMap((b) => b.turns).map((t) => t.why).join('\\n')`);
    for (const s of ['Read $ cat src/cart.js', 'Output of exec_command $ npm test', '11 min pause', 'Compacted from 31.5k to 6k']) assert.ok(why.includes(s), `a turn says “${s}”:\n${why}`);
    // The gauge on its tab: 6k of 258k.
    await wb.waitFor(`document.querySelector('#term-tab-list .ttab.active .ctx-badge')?.textContent === '2%'`, 10000);
    await shot(wb, 'codex');

    // OpenCode: its database. The panel follows the new tab; OpenCode records each step's cost.
    await start(wb, 'opencode');
    text = await panelFor(wb, 'OpenCode', 'Cost over time');
    has(text, ['mock-model', '128k', '≈$0.05', 'own cost for each request', 'Big file read', 'Compaction', 'Subagents']);
    await shot(wb, 'opencode');

    // Qwen Code and Gemini: their chats; Copilot: its events.
    await start(wb, 'qwen');
    text = await panelFor(wb, 'Qwen Code', 'Tokens over time');
    has(text, ['qwen3-coder-plus', '131k', 'Compacted 1×', 'Files read more than once']);
    await start(wb, 'gemini');
    text = await panelFor(wb, 'Gemini', 'Tokens over time');
    has(text, ['gemini-2.5-pro', '28k / 1M', '6 requests']);
    await shot(wb, 'gemini');
    await start(wb, 'copilot');
    text = await panelFor(wb, 'Copilot', 'Tokens over time');
    has(text, ['gpt-5.5', '272k', 'Big tool output', 'pipe it through tail']);

    // Amp keeps nothing on this computer: said so, and no other agent's numbers.
    await start(wb, 'amp');
    text = await panelFor(wb, 'NOT AVAILABLE FOR AMP', 'Sourcegraph');
    for (const s of ['Tokens over time', 'Cost over time', 'CONTEXT WINDOW', 'gpt-5.5']) assert.ok(!text.includes(s), `nothing of another session (“${s}”):\n${text}`);
    await shot(wb, 'amp');

    // Every agent's tab with a session has its gauge; a click on Codex's: Codex's session again.
    const tab = (kind) => `document.querySelectorAll('#term-tab-list .ttab')[S.terms.findIndex((t) => t.kind === '${kind}')]`;
    for (const kind of ['codex', 'opencode', 'qwen', 'gemini', 'copilot']) await wb.waitFor(`!!${tab(kind)}?.querySelector('.ctx-badge')`, 20000);
    assert.equal(await wb.eval(`!!${tab('amp')}.querySelector('.ctx-badge')`), false);
    await click(wb, `${tab('codex')}.querySelector('.ctx-badge')`);
    await wb.waitFor(`S.activeTerm?.kind === 'codex'`);
    await panelFor(wb, 'gpt-5.5-codex', 'Tokens over time');
  } finally { await done(); }
});

test('an agent whose session hasn’t begun says so, then shows it once it has', async () => {
  const { wb, project, done } = await setup();
  try {
    fs.writeFileSync(path.join(project, 'wait-codex'), '');
    await wb.eval(`launch('codex').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'codex'`);
    await click(wb, `document.getElementById('limits-chip')`);
    await wb.waitFor(`${panel}.includes('No session data yet: it comes with Codex’s first answer.')`, 15000);
    // Its first answer.
    fs.writeFileSync(path.join(project, 'go'), '');
    await wb.waitFor(`${termText}.includes('ready')`, 15000);
    await click(wb, `document.getElementById('ci-refresh')`);
    await panelFor(wb, 'gpt-5.5-codex', 'Tokens over time');
  } finally { await done(); }
});
