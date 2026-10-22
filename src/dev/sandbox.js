// Workbench Pro: run coding agents in a Docker / OrbStack container.
//
// What the container gets
//  - the project folder, read-write, at /workspace (nothing else from the host: no home, no SSH
//    keys, no Docker socket) — EXCEPT the files that tools on the host run automatically: .git,
//    .claude, .mcp.json, .vscode, .envrc, .idea, .husky (+ a few more when present) are mounted
//    read-only on top. Missing ones get an empty placeholder for the session, so the agent can't
//    create them either (no planting .git/hooks, .claude/settings.json, …). A protected entry that is
//    a symlink refuses the launch (docker would follow it and mount whatever it points at).
//    Whatever can't be pinned this way (the same names deeper in the tree, newly created
//    pre-commit/lefthook configs) is snapshotted before the session; the Workbench shows the
//    differences and asks before the next host terminal/agent starts in that project (index.js).
//  - a per-project named volume as /home/node so the agent's own settings survive restarts;
//  - the unprivileged `node` user, all capabilities dropped, no-new-privileges, pid/memory/CPU limits;
//  - optionally no network at all (--network none);
//  - only the vault secrets picked for this session, in a 0600 file inside a private 0700 temp dir,
//    bind-mounted read-only at /run/meridian/env. The image's entrypoint exports them for the agent.
//    They are NOT container environment (that would show in `docker inspect`) and never on a command
//    line. The file is deleted when the container exits and when Meridian quits.
// Every docker invocation is an argv array (execFile / node-pty), never a shell string.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { which } = require('./env');
const { NAME_RE } = require('../renderer/dev/secret-detect');

const DOCKERFILE = path.join(__dirname, '..', '..', 'build', 'sandbox', 'Dockerfile');
const KINDS = {
  'sandbox-claude': { label: 'Claude Code (sandbox)', cmd: ['claude'], needs: ['ANTHROPIC_API_KEY'] },
  'sandbox-codex': { label: 'Codex (sandbox)', cmd: ['codex'], needs: ['OPENAI_API_KEY'] },
  'sandbox-shell': { label: 'Shell (sandbox)', cmd: ['bash', '-l'], needs: [] },
};
const LIMITS = { memory: '4g', cpus: '2', pids: '512' };

// Host-executed config inside a project. PROTECT_*: always read-only (placeholder when missing).
// PROTECT_IF_PRESENT: read-only when they exist; creating them is caught by the snapshot diff.
const PROTECT_DIRS = ['.git', '.claude', '.vscode', '.idea', '.husky'];
const PROTECT_FILES = ['.mcp.json', '.envrc'];
const PROTECT_IF_PRESENT = ['.devcontainer', '.gemini', '.codex', '.cursor', '.githooks', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml'];
const AUTOEXEC_NAMES = new Set([...PROTECT_DIRS, ...PROTECT_FILES, ...PROTECT_IF_PRESENT]);
const PLACEHOLDER = {
  '.mcp.json': '{"mcpServers":{}}\n',
  '.envrc': '# Placeholder made by Meridian while a sandboxed agent runs in this folder; removed when it stops.\n',
};
const placeholderRefs = new Map(); // abs -> number of running sandboxes using this placeholder
const ENV_PREFIX = 'meridian-sbx-env-';
const BAD_MOUNT_PATH = /[,\n\r\0"]/;

let dockerfileText = null;
function dockerfile() {
  if (dockerfileText === null) { try { dockerfileText = fs.readFileSync(DOCKERFILE, 'utf8'); } catch { dockerfileText = ''; } }
  return dockerfileText;
}
// The tag follows the Dockerfile: change the recipe and a new image is built next time.
function imageTag() { return `meridian-sandbox:${crypto.createHash('sha256').update(dockerfile()).digest('hex').slice(0, 12)}`; }

function run(file, args, env, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, code: err?.code, stdout: stdout || '', stderr: stderr || '' }));
  });
}

function findDocker(searchPath) {
  const home = os.homedir();
  const candidates = [
    which('docker', searchPath),
    path.join(home, '.orbstack', 'bin', 'docker'),
    '/usr/local/bin/docker', '/opt/homebrew/bin/docker',
    '/Applications/OrbStack.app/Contents/MacOS/xbin/docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

class Sandbox {
  constructor({ getEnv, getSearchPath }) {
    this.getEnv = getEnv;               // async () => env for docker CLI calls (login PATH, no secrets)
    this.getSearchPath = getSearchPath; // async () => login PATH
    this.cache = null;
    this.cacheAt = 0;
    this.containers = new Set();
    this.envDirs = new Set();
    sweepStaleEnvDirs();
  }

  // { installed, running, docker, version, image, imagePresent, error }
  async status({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cacheAt < 20_000) return this.cache;
    const docker = findDocker(await this.getSearchPath());
    const st = { installed: !!docker, running: false, docker, version: null, image: imageTag(), imagePresent: false, error: null, available: !!dockerfile() };
    if (docker) {
      const env = await this.getEnv();
      const info = await run(docker, ['info', '--format', '{{.ServerVersion}}'], env);
      st.running = info.ok && !!info.stdout.trim();
      st.version = st.running ? info.stdout.trim().slice(0, 40) : null;
      if (!st.running) st.error = (info.stderr || info.stdout).trim().split('\n').pop()?.slice(0, 300) || 'The Docker daemon is not running.';
      if (st.running) st.imagePresent = (await run(docker, ['image', 'inspect', '--format', '{{.Id}}', st.image], env)).ok;
    }
    this.cache = st;
    this.cacheAt = Date.now();
    return st;
  }

  invalidate() { this.cache = null; }

  // Launch spec for node-pty. Builds the image first (in the terminal, with progress) if needed.
  // secrets: { NAME: value } picked for this session (written to the env file, never to docker's env).
  // mission (optional, Mission Control): { dir, target, env, args, token } from MissionControl.sandboxMount():
  // a per-session dir with the event hook, mounted read-write; its token goes into the env file too.
  async launchSpec(kind, { root, secrets = {}, network = true, forbiddenRoots = [], mission = null }) {
    const k = KINDS[kind];
    if (!k) throw new Error('unknown sandbox');
    refuseRoot(root, forbiddenRoots);
    const st = await this.status({ fresh: true });
    if (!st.installed) throw new Error('Docker isn’t installed. Install OrbStack or Docker Desktop to run agents in a sandbox.');
    if (!st.running) throw new Error(`Docker isn’t running — start OrbStack or Docker Desktop. (${st.error || ''})`);
    if (!st.available) throw new Error('The sandbox Dockerfile is missing from this build.');
    if (!path.isAbsolute(root) || BAD_MOUNT_PATH.test(root)) throw new Error('This project path can’t be mounted into a container (it contains a comma, a quote or a line break).');

    if (!st.imagePresent) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sbx-build-'));
      fs.chmodSync(dir, 0o700);
      fs.writeFileSync(path.join(dir, 'Dockerfile'), dockerfile(), { mode: 0o600 });
      return {
        title: 'Building sandbox image',
        file: st.docker,
        args: ['build', '--progress=plain', '--label', 'dev.meridian.sandbox=1', '-t', st.image, dir],
        cleanup: [dir],
        notes: [`First run: building ${st.image} (Node LTS, git, ripgrep, Claude Code and Codex CLIs). This takes a few minutes once; the ${k.label} starts when it’s done.`],
        then: kind,
        onExit: () => this.invalidate(),
      };
    }

    const name = `meridian-sbx-${crypto.randomBytes(5).toString('hex')}`;
    const volume = `meridian-sbx-home-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
    const names = Object.keys(secrets).filter((n) => NAME_RE.test(n)).sort();
    const prot = protectMounts(root); // throws on a symlinked entry
    let envDir = null;
    try {
      const fileVars = { ...secrets };
      if (mission?.token) fileVars.MERIDIAN_MISSION_TOKEN = mission.token;
      envDir = writeEnvFile(fileVars, mission?.token ? [...names, 'MERIDIAN_MISSION_TOKEN'] : names);
    } catch (err) { releasePlaceholders(prot.created); throw err; }
    const args = [
      'run', '--rm', '-it', '--init',
      '--name', name, '--hostname', 'sandbox',
      '--label', 'dev.meridian.sandbox=1',
      '--user', 'node',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', LIMITS.pids, '--memory', LIMITS.memory, '--memory-swap', LIMITS.memory, '--cpus', LIMITS.cpus,
      '--mount', `type=bind,source=${root},target=/workspace`,
      ...prot.args,
      '--mount', `type=bind,source=${path.join(envDir, 'env')},target=/run/meridian/env,readonly`,
      '--mount', `type=volume,source=${volume},target=/home/node`,
      '--workdir', '/workspace',
      '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor',
    ];
    if (!network) args.push('--network', 'none');
    if (mission && path.isAbsolute(mission.dir) && !/[,\n\r\0]/.test(mission.dir)) {
      args.push('--mount', `type=bind,source=${mission.dir},target=${mission.target}`);
      for (const [n, v] of Object.entries(mission.env || {})) args.push('-e', `${n}=${v}`);
      args.push(st.image, ...k.cmd, ...(mission.args || []));
    } else args.push(st.image, ...k.cmd);

    const notes = [
      `Sandbox: only this project is mounted (at /workspace); ${network ? 'network ON (the agent can reach the internet, which it needs for its API)' : 'no network'}; limits ${LIMITS.cpus} CPUs, ${LIMITS.memory} RAM.`,
      `Read-only inside the sandbox: ${prot.names.join(', ')} (git works read-only: commit from a host terminal).`,
      names.length ? `Secrets in this sandbox: ${names.join(', ')} (values hidden).` : 'No vault secrets are passed into this sandbox.',
    ];
    const missing = k.needs.filter((n) => !names.includes(n));
    if (missing.length) notes.push(`${missing.join(', ')} is not passed in, so ${k.label.replace(' (sandbox)', '')} can’t sign in inside the container. Add it in Secrets (lock icon) and restart.`);
    if (!network && kind !== 'sandbox-shell') notes.push('Network is off: the agent can’t reach its API. Turn network on in the sandbox menu.');
    if (process.platform === 'linux' && process.getuid?.() !== 1000) notes.push('Files the sandbox creates are owned by uid 1000 on this host.');
    this.containers.add(name);
    this.envDirs.add(envDir);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.containers.delete(name);
      this.envDirs.delete(envDir);
      try { fs.rmSync(envDir, { recursive: true, force: true }); } catch {}
      releasePlaceholders(prot.created);
    };
    return {
      title: k.label,
      file: st.docker,
      args,
      cleanup: [envDir],
      notes,
      container: name,
      secretNames: names,
      onExit: finish,
      onKill: () => { this.removeContainer(st.docker, name).finally(finish); },
    };
  }

  async removeContainer(docker, name) {
    this.containers.delete(name);
    await run(docker, ['rm', '-f', name], await this.getEnv(), 15000);
  }

  // App quit: make sure no sandbox keeps running in the background.
  disposeSync() {
    for (const dir of this.envDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    this.envDirs.clear();
    for (const abs of [...placeholderRefs.keys()]) { placeholderRefs.set(abs, 1); releasePlaceholders([abs]); }
    const docker = this.cache?.docker;
    if (!docker) return;
    for (const name of this.containers) { try { execFile(docker, ['rm', '-f', name], { timeout: 5000 }, () => {}); } catch {} }
    this.containers.clear();
  }
}

// Folders that must never be mounted into a container: the filesystem root, the home folder, and
// Meridian's own data (vault, plugins, customizations) — or anything that contains them.
function refuseRoot(root, forbiddenRoots) {
  const home = safeReal(os.homedir());
  const contains = (outer, inner) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  if (root === path.parse(root).root || root === home) throw new Error('Meridian won’t mount your whole disk or home folder into a sandbox. Open a project folder instead.');
  for (const f of forbiddenRoots.filter(Boolean).map(safeReal)) {
    if (contains(root, f) || contains(f, root)) throw new Error('This folder holds Meridian’s own data (customizations, plugins or the vault), so it can’t be opened in a sandbox — a sandboxed agent could plant a plugin that runs with Workbench powers. Use a host terminal here.');
  }
}

function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

// --mount args that pin host-executed config read-only. Creates placeholders for missing ones.
function protectMounts(root) {
  const args = [];
  const created = [];
  const names = [];
  try {
    for (const name of [...PROTECT_DIRS, ...PROTECT_FILES, ...PROTECT_IF_PRESENT]) {
      const abs = path.join(root, name);
      let st = null;
      try { st = fs.lstatSync(abs); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (st?.isSymbolicLink()) throw new Error(`“${name}” in this project is a symlink. Meridian won’t start a sandbox here: docker would mount whatever it points at. Replace the symlink with a real ${PROTECT_FILES.includes(name) ? 'file' : 'folder'} (or remove it) and try again.`);
      if (st && !st.isFile() && !st.isDirectory()) throw new Error(`“${name}” in this project is not a regular file or folder.`);
      if (!st) {
        if (PROTECT_IF_PRESENT.includes(name)) continue;
        makePlaceholder(abs, PROTECT_DIRS.includes(name));
        created.push(abs);
      } else if (placeholderRefs.has(abs)) {
        placeholderRefs.set(abs, placeholderRefs.get(abs) + 1); // another running sandbox made it
        created.push(abs);
      }
      args.push('--mount', `type=bind,source=${abs},target=/workspace/${name},readonly`);
      names.push(name);
    }
  } catch (err) { releasePlaceholders(created); throw err; }
  return { args, created, names };
}

function makePlaceholder(abs, dir) {
  if (dir) fs.mkdirSync(abs, { mode: 0o755 });
  else fs.writeFileSync(abs, PLACEHOLDER[path.basename(abs)] || '', { flag: 'wx', mode: 0o644 });
  placeholderRefs.set(abs, 1);
}

// Remove placeholders nobody uses any more — only if they are still exactly what we created.
function releasePlaceholders(list) {
  for (const abs of list) {
    const n = (placeholderRefs.get(abs) || 1) - 1;
    if (n > 0) { placeholderRefs.set(abs, n); continue; }
    placeholderRefs.delete(abs);
    try {
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) fs.rmdirSync(abs); // fails (and stays) if anything was put inside
      else if (st.isFile() && fs.readFileSync(abs, 'utf8') === (PLACEHOLDER[path.basename(abs)] || '')) fs.unlinkSync(abs);
    } catch {}
  }
}

// The session's secrets as NAME=<base64 value> lines in <private 0700 dir>/env (0600). Returns the dir.
function writeEnvFile(secrets, names) {
  const dir = safeReal(fs.mkdtempSync(path.join(os.tmpdir(), ENV_PREFIX)));
  fs.chmodSync(dir, 0o700);
  if (BAD_MOUNT_PATH.test(dir)) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('The temp folder path can’t be mounted into a container.'); }
  const body = names.map((n) => `${n}=${Buffer.from(String(secrets[n]), 'utf8').toString('base64')}\n`).join('');
  // The container user is uid 1000. On Linux hosts with another uid a 0600 file would be unreadable
  // inside; there the private 0700 dir alone keeps other host users out.
  const mode = process.platform === 'linux' && process.getuid?.() !== 1000 ? 0o644 : 0o600;
  fs.writeFileSync(path.join(dir, 'env'), body, { mode, flag: 'wx' });
  fs.chmodSync(path.join(dir, 'env'), mode);
  return dir;
}

// Env dirs left behind by a crash (ours only).
function sweepStaleEnvDirs() {
  try {
    const tmp = os.tmpdir();
    for (const d of fs.readdirSync(tmp)) {
      if (!d.startsWith(ENV_PREFIX)) continue;
      const abs = path.join(tmp, d);
      try { const st = fs.lstatSync(abs); if (st.isDirectory() && st.uid === process.getuid?.()) fs.rmSync(abs, { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

// ---------- what a sandbox changed that the host would run ----------
// { "<rel path>": "<digest>" } for every AUTOEXEC_NAMES entry in the project (any depth; the root .git
// is skipped: it is mounted read-only). Directories get one digest over their files.
const SNAP_MAX_ENTRIES = 30000;
const SNAP_MAX_DEPTH = 8;
const SNAP_SKIP = new Set(['node_modules']);
const GIT_SKIP = new Set(['objects', 'logs', 'refs', 'lfs', 'index', 'packed-refs', 'ORIG_HEAD', 'FETCH_HEAD', 'COMMIT_EDITMSG']);
async function autoExecSnapshot(root) {
  const fsp = fs.promises;
  const out = {};
  let seen = 0;
  const digestOf = async (abs, st, insideGit) => {
    if (st.isSymbolicLink()) return 'link:' + await fsp.readlink(abs).catch(() => '?');
    if (st.isFile()) {
      if (st.size > 1024 * 1024) return `big:${st.size}:${st.mtimeMs}`;
      return 'file:' + crypto.createHash('sha256').update(await fsp.readFile(abs).catch(() => Buffer.alloc(0))).digest('hex');
    }
    if (!st.isDirectory()) return 'other';
    const h = crypto.createHash('sha256');
    const walkDir = async (dir, rel, depth) => {
      if (depth > 6 || ++seen > SNAP_MAX_ENTRIES) return;
      let entries = [];
      try { entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
      for (const d of entries) {
        if (insideGit && depth === 0 && GIT_SKIP.has(d.name)) continue;
        const a = path.join(dir, d.name);
        const r = rel ? `${rel}/${d.name}` : d.name;
        let s2;
        try { s2 = await fsp.lstat(a); } catch { continue; }
        if (s2.isDirectory()) { h.update(`d ${r}\n`); await walkDir(a, r, depth + 1); } else h.update(`${r} ${await digestOf(a, s2, false)}\n`);
      }
    };
    await walkDir(abs, '', 0);
    return 'dir:' + h.digest('hex');
  };
  const walk = async (dir, rel, depth) => {
    if (depth > SNAP_MAX_DEPTH || seen > SNAP_MAX_ENTRIES) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (++seen > SNAP_MAX_ENTRIES) return;
      const abs = path.join(dir, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (AUTOEXEC_NAMES.has(d.name)) {
        if (r === '.git') continue;
        let st;
        try { st = await fsp.lstat(abs); } catch { continue; }
        out[r] = await digestOf(abs, st, d.name === '.git');
        continue;
      }
      if (d.isDirectory() && !SNAP_SKIP.has(d.name)) await walk(abs, r, depth + 1);
    }
  };
  await walk(root, '', 0);
  return out;
}

// [{ path, change: 'added'|'removed'|'changed' }] between two snapshots. Placeholders Meridian made
// (an empty dir / the placeholder files) don't count as "added".
function snapshotDiff(before, after) {
  const out = [];
  const isPlaceholder = (rel, digest) => {
    if (!digest) return true;
    if (PROTECT_DIRS.includes(rel)) return digest === 'dir:' + crypto.createHash('sha256').digest('hex');
    if (PROTECT_FILES.includes(rel)) return digest === 'file:' + crypto.createHash('sha256').update(PLACEHOLDER[rel] || '').digest('hex');
    return false;
  };
  for (const [rel, d] of Object.entries(after)) {
    if (!(rel in before)) { if (!isPlaceholder(rel, d)) out.push({ path: rel, change: 'added' }); } else if (before[rel] !== d) out.push({ path: rel, change: 'changed' });
  }
  for (const rel of Object.keys(before)) if (!(rel in after)) out.push({ path: rel, change: 'removed' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { Sandbox, SANDBOX_KINDS: KINDS, imageTag, autoExecSnapshot, snapshotDiff, AUTOEXEC_NAMES };
