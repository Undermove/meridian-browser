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

// ---- security review (Mission Control round): hostile sandbox dir, floods, self-reported names ----

test('sandbox events file: symlinks, hard links and FIFOs planted by the container are never read; truncation restarts', async () => {
  test.skip(process.platform === 'win32', 'POSIX file semantics');
  const { m, dir } = mission();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-mcu-host-'));
  try {
    const reg = await m.registerTerminal({ kind: 'sandbox-claude', project: 'p', ownerWcId: 1, sandbox: true });
    const mount = m.sandboxMount(reg.token, 'sandbox-claude');
    if (!mount) return;
    const ev = path.join(mount.dir, 'events.jsonl');
    const line = (o) => JSON.stringify({ v: 1, token: reg.token, kind: 'claude', ...o }) + '\n';
    const calls = () => m.nodes.get(reg.nodeId).toolCalls;
    // A host file the container can't read itself (it even holds valid lines, to prove we don't follow).
    const hostFile = path.join(outside, 'secret.jsonl');
    fs.writeFileSync(hostFile, line({ event: 'PreToolUse', tool: 'Read', summary: 'FROM-HOST-FILE' }).repeat(3));
    fs.rmSync(ev);
    fs.symlinkSync(hostFile, ev);
    await new Promise((r) => setTimeout(r, 1600));
    expect(calls()).toBe(0);
    // Hard link to a file in the dir that has another name: nlink 2, refused.
    fs.rmSync(ev);
    fs.writeFileSync(path.join(mount.dir, 'other'), line({ event: 'PreToolUse', tool: 'Read', summary: 'HARDLINK' }));
    fs.linkSync(path.join(mount.dir, 'other'), ev);
    await new Promise((r) => setTimeout(r, 1600));
    expect(calls()).toBe(0);
    // A FIFO must not park the main process (O_NONBLOCK + fstat).
    fs.rmSync(ev);
    require('child_process').execFileSync('mkfifo', [ev]);
    await new Promise((r) => setTimeout(r, 1600));
    expect(calls()).toBe(0);
    // A fresh regular file is followed again; truncation restarts from the top.
    fs.rmSync(ev);
    fs.writeFileSync(ev, line({ event: 'PreToolUse', tool: 'Bash', summary: '$ one' }));
    await expect.poll(calls, { timeout: 5000 }).toBe(1);
    fs.writeFileSync(ev, line({ event: 'PreToolUse', tool: 'Bash', summary: '$ 2' })); // shorter: truncated + rewritten
    await expect.poll(calls, { timeout: 5000 }).toBe(2);
    expect(JSON.stringify(m.snapshot())).not.toMatch(/FROM-HOST-FILE|HARDLINK/);
    // On exit the dir is removed without following the planted symlink.
    fs.symlinkSync(outside, path.join(mount.dir, 'link-to-host'));
    m.terminalExit(reg.token, reg.nodeId, { code: 0 });
    expect(fs.existsSync(mount.dir)).toBe(false);
    expect(fs.existsSync(hostFile)).toBe(true);
  } finally { m.dispose(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('hook floods: subagent nodes are capped per session and waiting notifications are throttled', async () => {
  const { m, dir } = mission();
  m.quiet = true;
  try {
    const reg = await m.registerTerminal({ kind: 'claude', project: 'p', ownerWcId: 1 });
    const session = { nodeId: reg.nodeId, kind: 'claude' };
    for (let i = 0; i < 400; i++) m.onHookEvent(session, { event: 'SubagentStart', agent_id: `a${i}`, agent_type: 'x' });
    for (let i = 0; i < 400; i++) m.onHookEvent(session, { event: 'PreToolUse', tool: 'Agent', tool_use_id: `t${i}`, description: 'spawn' });
    const root = m.nodes.get(reg.nodeId);
    expect(m.descendants(root).length).toBeLessThanOrEqual(100);
    expect(m.nodes.size).toBeLessThanOrEqual(301);
    for (let i = 0; i < 30; i++) {
      m.onHookEvent(session, { event: 'PermissionRequest', tool: 'Bash' });
      m.onHookEvent(session, { event: 'PostToolUse', tool: 'Bash' });
    }
    expect(m.notified).toHaveLength(1);
  } finally { m.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MCP client names are shown as self-reported; only a session token hash nests a bridge', async () => {
  const { m, dir } = mission();
  try {
    m.hubCallStart('c1', 'list_tabs', {}, { source: 'mcp', client: { id: 'client-aaaaaa', name: 'Claude Code', session: 'f'.repeat(32) } });
    const n = m.snapshot().nodes.find((x) => x.source === 'mcp');
    expect(n).toMatchObject({ parentId: null, label: 'Claude Code', where: 'mcp', selfReported: true });
    expect(n.sublabel).toMatch(/self-reported/);
  } finally { m.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redaction: curl -u, mysql -p, registry logins, Stripe keys', () => {
  expect(clean('curl -u admin:hunter2 https://x')).toBe('curl -u admin:••• https://x');
  expect(clean('mysql -uroot -phunter2 db')).toBe('mysql -uroot -p••• db');
  expect(clean('docker login -u me -p hunter2 ghcr.io')).toBe('docker login -u me -p ••• ghcr.io');
  expect(clean('docker run -p 8080:80 img')).toBe('docker run -p 8080:80 img');
  expect(clean('mkdir -p src/a')).toBe('mkdir -p src/a');
  expect(clean('stripe sk_live_' + 'a'.repeat(24))).toBe('stripe •••');
});

test('link preview SSRF guard: only public http(s) targets', async () => {
  const { isPrivateIp, assertPublicUrl } = require('../../src/ai/features');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe']) expect(isPrivateIp(ip), ip).toBe(true);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateIp(ip), ip).toBe(false);
  for (const u of ['http://localhost:3000/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://printer.local/', 'http://intranet/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://u:p@example.com/']) {
    await expect(assertPublicUrl(u), u).rejects.toThrow();
  }
  await expect(assertPublicUrl('http://localhost:3000/', new Set(['localhost:3000']))).resolves.toBeTruthy();
});
