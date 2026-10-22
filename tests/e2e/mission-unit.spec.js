// Mission Control building blocks that don't need a window: Docker sandbox wiring (no Docker
// needed: the daemon status is stubbed), settings merge, redaction.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { MissionControl, mergeClaudeSettings, claudeHookSettings, CLAUDE_EVENTS } = require('../../src/agents/mission');
const { Sandbox } = require('../../src/dev/sandbox');
const { hookSettings } = require('../../src/dev/guard');
const { clean } = require('../../src/agents/redact');

function mission() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-mcu-'));
  const app = { isPackaged: false, getPath: () => dir, dock: null };
  return { m: new MissionControl({ app, getMainWindow: () => null }), dir };
}

test('Claude settings: the guard hook is kept and the observer hooks are async on every lifecycle event', () => {
  const guard = hookSettings('/usr/bin/node', '/app/secret-guard-hook.js');
  const merged = mergeClaudeSettings(guard, claudeHookSettings('"/usr/bin/node" "/app/mission-hook.js"'));
  expect(Object.keys(merged.hooks).sort()).toEqual([...CLAUDE_EVENTS].sort());
  expect(merged.hooks.PreToolUse).toHaveLength(2);
  expect(merged.hooks.PreToolUse[0]).toEqual(guard.hooks.PreToolUse[0]);
  expect(merged.hooks.PreToolUse[1]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', async: true, timeout: 5 }] });
  expect(merged.hooks.SubagentStart[0].matcher).toBeUndefined();
  expect(JSON.stringify(merged)).not.toMatch(/TOKEN|token/);
});

test('sandbox: the session dir is mounted, the token goes only into the private env file, Claude gets --settings', async () => {
  const { m, dir } = mission();
  try {
    const reg = await m.registerTerminal({ kind: 'sandbox-claude', project: 'p', ownerWcId: 1, sandbox: true });
    expect(reg.env.MERIDIAN_MISSION_SOCKET).toBeUndefined();
    const mount = m.sandboxMount(reg.token, 'sandbox-claude');
    if (process.platform === 'linux' && process.getuid() !== 1000) { expect(mount).toBeNull(); return; }
    expect(fs.existsSync(path.join(mount.dir, 'mission-hook.js'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(mount.dir, 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('node /meridian/mission-hook.js');
    const sb = new Sandbox({ getEnv: async () => ({}), getSearchPath: async () => '' });
    sb.status = async () => ({ installed: true, running: true, docker: '/usr/local/bin/docker', image: 'meridian-sandbox:test', imagePresent: true, available: true });
    const spec = await sb.launchSpec('sandbox-claude', { root: dir, secrets: {}, network: true, mission: { ...mount, token: reg.token } });
    const a = spec.args;
    expect(a).toContain(`type=bind,source=${mount.dir},target=/meridian`);
    expect(a).toContain('MERIDIAN_MISSION_FILE=/meridian/events.jsonl');
    // The token never appears on the docker command line or as a container env var…
    expect(a.join(' ')).not.toContain(reg.token);
    expect(a).not.toContain('MERIDIAN_MISSION_TOKEN');
    // …only in the 0600 env file mounted read-only at /run/meridian/env (exported by the entrypoint).
    const envMount = a.find((x) => /target=\/run\/meridian\/env,readonly$/.test(x));
    const envFile = /source=([^,]+),/.exec(envMount)[1];
    expect(fs.statSync(envFile).mode & 0o777).toBe(process.platform === 'linux' && process.getuid() !== 1000 ? 0o644 : 0o600);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`MERIDIAN_MISSION_TOKEN=${Buffer.from(reg.token).toString('base64')}`);
    expect(spec.secretNames).not.toContain('MERIDIAN_MISSION_TOKEN');
    expect(a.slice(-3)).toEqual(['claude', '--settings', '/meridian/settings.json']);
    // The container appends to the events file; Meridian follows it with the same validation.
    const line = (o) => JSON.stringify({ v: 1, token: reg.token, kind: 'claude', ...o }) + '\n';
    fs.appendFileSync(path.join(mount.dir, 'events.jsonl'), line({ event: 'SessionStart', model: 'claude-opus-5-5' }) + line({ event: 'PreToolUse', tool: 'Bash', summary: '$ ls' }) + JSON.stringify({ token: 'bad', event: 'Stop' }) + '\n');
    await expect.poll(() => m.nodes.get(reg.nodeId).toolCalls, { timeout: 5000 }).toBe(1);
    expect(m.nodes.get(reg.nodeId)).toMatchObject({ where: 'sandbox', status: 'tool', sublabel: 'claude-opus-5-5' });
  } finally { m.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox Codex gets the notify override pointing at the mounted hook', async () => {
  const { m, dir } = mission();
  try {
    const reg = await m.registerTerminal({ kind: 'sandbox-codex', project: 'p', ownerWcId: 1, sandbox: true });
    const mount = m.sandboxMount(reg.token, 'sandbox-codex');
    if (!mount) return;
    expect(mount.args).toEqual(['-c', 'notify=["node", "/meridian/mission-hook.js", "--codex"]']);
  } finally { m.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redaction of summaries', () => {
  const vault = [{ name: 'DB_PASSWORD', value: 'correct-horse-battery' }];
  expect(clean('$ API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz npm test')).toBe('$ API_KEY=••• npm test');
  expect(clean('psql postgres://admin:hunter2@db/x')).toBe('psql postgres://admin:•••@db/x');
  expect(clean('curl https://x.com/a?token=abc123&page=2')).toBe('curl https://x.com/a?token=•••&page=2');
  expect(clean('echo correct-horse-battery', 160, vault)).toBe('echo $DB_PASSWORD');
  expect(clean('export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('export GITHUB_TOKEN=•••');
  expect(clean('src/app.js')).toBe('src/app.js');
  expect(clean('a‮b\nc')).toBe('a b c');
});
