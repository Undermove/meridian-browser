// An agent needs the person while they are elsewhere (another space, another page): a card over the
// page says which session wants what. Allow / Deny / Always allow answer Claude Code right there;
// Open goes to the session's terminal, in its space. The terminal still asks too: answered there
// first, the card goes away. A question only the terminal can answer (AskUserQuestion) has Open only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const T = 'app.$.tabstrip';
const AA = 'app.$.agentAsks.shadowRoot';

// A stand-in Claude Code, as the real one asks: the question in the terminal and the
// PermissionRequest hooks at the same time; the first answer counts, the hooks still running are
// dropped. Then PostToolUse (allowed) or Stop (denied), as Mission Control expects.
const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, queue, subprocess, sys, threading
args = sys.argv
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
def ev(event, **f):
    return json.dumps(dict(hook_event_name=event, session_id='s1', cwd=cwd, **f))
def hook(event, **f):
    for entry in settings['hooks'].get(event, []):
        for h in entry['hooks']:
            subprocess.run(h['command'], shell=True, input=ev(event, **f), text=True, capture_output=True)
current = [None]
def terminal():
    for line in sys.stdin:
        q = current[0]
        if q: q.put(('terminal', {'behavior': 'allow' if line.strip() == 'y' else 'deny'}))
threading.Thread(target=terminal, daemon=True).start()
def permission(tool, inp, suggestions):
    q = queue.Queue()
    current[0] = q
    hook('PreToolUse', tool_name=tool, tool_input=inp, tool_use_id='u-' + tool)
    procs = []
    for entry in settings['hooks'].get('PermissionRequest', []):
        for h in entry['hooks']:
            p = subprocess.Popen(h['command'], shell=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, start_new_session=True)
            p.stdin.write(ev('PermissionRequest', tool_name=tool, tool_input=inp, permission_suggestions=suggestions)); p.stdin.close()
            procs.append(p)
    def watch(p):
        out = p.stdout.read()
        try: q.put(('meridian', json.loads(out)['hookSpecificOutput']['decision']))
        except Exception: pass
    for p in procs: threading.Thread(target=watch, args=(p,), daemon=True).start()
    print('QUESTION ' + tool, flush=True)
    by, d = q.get()
    current[0] = None
    for p in procs:
        if p.poll() is None:
            try:
                if hasattr(os, 'killpg'): os.killpg(p.pid, 9)
                else: p.kill()
            except Exception: pass
    print('DECIDED %s %s %s' % (d['behavior'], by, json.dumps(d.get('updatedPermissions', []))), flush=True)
    if d['behavior'] == 'allow': hook('PostToolUse', tool_name=tool, tool_input=inp, tool_use_id='u-' + tool, tool_response={})
    else: hook('Stop')
hook('SessionStart', model='claude-opus-5-5', source='startup')
hook('UserPromptSubmit', prompt='go')
permission('Bash', {'command': 'npm test'}, [{'type': 'addRules', 'rules': [{'toolName': 'Bash', 'ruleContent': 'npm test'}], 'behavior': 'allow', 'destination': 'localSettings'}])
hook('UserPromptSubmit', prompt='go on')
permission('Edit', {'file_path': cwd + '/app.js'}, [{'type': 'setMode', 'mode': 'acceptEdits', 'destination': 'session'}])
hook('UserPromptSubmit', prompt='go on')
permission('Bash', {'command': 'rm -rf build'}, [])
hook('UserPromptSubmit', prompt='go on')
permission('WebFetch', {'url': 'https://example.com/'}, [])
hook('UserPromptSubmit', prompt='go on')
permission('AskUserQuestion', {'questions': [{'question': 'Which one?'}]}, [])
print('ALL DONE', flush=True)
sys.stdin.readline()
`;

test('an agent’s permission question: a card over any space’s page; Allow, Always, Deny, the terminal first, Open', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-aa-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  let wb;
  const term = () => wb.eval(`S.terms.find((t) => t.kind === 'claude') ? (() => { const x = S.terms.find((t) => t.kind === 'claude').xterm.buffer.active; return [...Array(x.length).keys()].map((i) => x.getLine(i)?.translateToString(true)).join('\\n'); })() : ''`);
  const waitTerm = async (text, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = await term();
      // (Long lines wrap at the terminal's width.)
      if (t.replace(/\n/g, '').includes(text)) return t;
      if (Date.now() > end) throw new Error(`terminal never said ${text}:\n${t}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const cards = `${AA}.querySelectorAll('.card')`;
  const card = (sel) => `${AA}.querySelector('.card ${sel}')`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const home = await b.eval(`${T}.state_.spaces[0]`);
    await b.eval(`${T}.runCommand(16, 0)`);
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    // Away in another space, on a page there.
    const { spaceId: away } = await b.eval(`${T}.handler_.createSpace('Elsewhere', '', '', '')`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(away)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(away)}`);
    await wb.eval(`launch('claude').then((t) => !!t)`);

    // 1. Run a command: Allow, from the other space.
    await b.waitFor(`${cards}.length === 1`, 15000);
    assert.match(await b.eval(`${card('.title')}.textContent`), /Claude Code/);
    assert.notEqual(home.name, 'Elsewhere');
    assert.match(await b.eval(`${card('.where')}.textContent`), new RegExp('^' + home.name + ' · meridian-aa-'));
    assert.equal(await b.eval(`${card('.what')}.textContent`), 'Run a command');
    assert.equal(await b.eval(`${card('.summary')}.textContent`), 'npm test');
    assert.equal(await b.eval(`${T}.state_.activeSpaceId`), away, 'nothing moved under the person');
    await waitTerm('QUESTION Bash');
    // MERIDIAN_SHOTS=<folder>: a picture for the changelog.
    if (process.env.MERIDIAN_SHOTS) {
            await new Promise((r) => setTimeout(r, 400));
      const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(process.env.MERIDIAN_SHOTS, 'agent-ask.png'), Buffer.from(data, 'base64'));
    }
    await b.click(card('.allow'));
    await waitTerm('DECIDED allow meridian []');
    await b.waitFor(`![...${cards}].some((c) => c.textContent.includes('npm test'))`, 10000);

    // 2. Change a file: Always allow passes Claude Code's own suggestion back.
    await b.waitFor(`${cards}.length === 1 && ${card('.what')}.textContent === 'Change a file'`, 15000);
    await b.click(card('.always'));
    await waitTerm('DECIDED allow meridian [{"destination": "session", "mode": "acceptEdits", "type": "setMode"}]');
    await b.waitFor(`![...${cards}].some((c) => c.textContent.includes('Change a file'))`, 10000);

    // 3. Deny.
    await b.waitFor(`${cards}.length === 1 && ${card('.summary')}.textContent === 'rm -rf build'`, 15000);
    assert.ok(!(await b.eval(`!!${card('.always')}`)), 'no suggestion, no Always allow');
    await b.click(card('.deny'));
    await waitTerm('DECIDED deny meridian');
    // The next question may already be here: this card is what has to go.
    await b.waitFor(`![...${cards}].some((c) => c.textContent.includes('rm -rf build'))`);

    // 4. Answered in the terminal first: the card goes away by itself.
    await b.waitFor(`${cards}.length === 1 && ${card('.what')}.textContent === 'Open a web page'`, 15000);
    await wb.eval(`(() => { window.workbench.ptyWrite(S.terms.find((t) => t.kind === 'claude').id, 'y\\r'); return true; })()`);
    await waitTerm('DECIDED allow terminal');
    await b.waitFor(`![...${cards}].some((c) => c.textContent.includes('Open a web page'))`, 10000);

    // 5. A question only the terminal can answer: Open only; Open goes there, in its space.
    await b.waitFor(`${cards}.length === 1 && ${card('.what')}.textContent === 'Has a question for you'`, 15000);
    assert.ok(!(await b.eval(`!!${card('.allow')}`)), 'no Allow for a question');
    await b.click(card('.open'));
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(home.id)}`);
    await b.waitFor(`app.url_.startsWith('chrome://workbench')`);
    assert.equal(await wb.eval(`S.activeTerm?.kind`), 'claude');
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, 'y\\r'); return true; })()`);
    await waitTerm('ALL DONE');
    await b.waitFor(`${cards}.length === 0`, 10000);
  } finally {
    try { await wb?.eval(`(() => { const t = S.terms.find((t) => t.kind === 'claude'); if (t) window.workbench.ptyWrite(t.id, '\\r'); return true; })()`); } catch {}
    wb?.close();
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
