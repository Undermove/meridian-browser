// Workbench Pro: run coding agents in a Docker / OrbStack container.
//
// What the container gets
//  - the project folder, read-write, at /workspace (nothing else from the host: no home, no SSH
//    keys, no Docker socket);
//  - a per-project named volume as /home/node so the agent's own settings survive restarts;
//  - the unprivileged `node` user, all capabilities dropped, no-new-privileges, pid/memory/CPU limits;
//  - optionally no network at all (--network none);
//  - vault secrets as environment variables. They are passed as bare `-e NAME` flags, so values never
//    appear on a command line (ps); the docker CLI copies them from its own environment.
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
  // mission (optional, Mission Control): { dir, target, env, args } from MissionControl.sandboxMount():
  // a per-session dir with the event hook, mounted read-write; the channel token is passed like a
  // secret (bare `-e MERIDIAN_MISSION_TOKEN`, value in the docker CLI's environment).
  async launchSpec(kind, { root, secretNames = [], network = true, mission = null }) {
    const k = KINDS[kind];
    if (!k) throw new Error('unknown sandbox');
    const st = await this.status({ fresh: true });
    if (!st.installed) throw new Error('Docker isn’t installed. Install OrbStack or Docker Desktop to run agents in a sandbox.');
    if (!st.running) throw new Error(`Docker isn’t running — start OrbStack or Docker Desktop. (${st.error || ''})`);
    if (!st.available) throw new Error('The sandbox Dockerfile is missing from this build.');
    if (!path.isAbsolute(root) || /[,\n\r\0]/.test(root)) throw new Error('This project path can’t be mounted into a container (it contains a comma or a line break).');

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
    const args = [
      'run', '--rm', '-it', '--init',
      '--name', name, '--hostname', 'sandbox',
      '--label', 'dev.meridian.sandbox=1',
      '--user', 'node',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', LIMITS.pids, '--memory', LIMITS.memory, '--memory-swap', LIMITS.memory, '--cpus', LIMITS.cpus,
      '--mount', `type=bind,source=${root},target=/workspace`,
      '--mount', `type=volume,source=${volume},target=/home/node`,
      '--workdir', '/workspace',
      '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor',
    ];
    const names = secretNames.filter((n) => NAME_RE.test(n));
    for (const n of names) args.push('-e', n); // value comes from the docker CLI's environment
    if (!network) args.push('--network', 'none');
    if (mission && path.isAbsolute(mission.dir) && !/[,\n\r\0]/.test(mission.dir)) {
      args.push('--mount', `type=bind,source=${mission.dir},target=${mission.target}`);
      for (const [n, v] of Object.entries(mission.env || {})) args.push('-e', `${n}=${v}`);
      args.push('-e', 'MERIDIAN_MISSION_TOKEN');
      args.push(st.image, ...k.cmd, ...(mission.args || []));
    } else args.push(st.image, ...k.cmd);

    const notes = [`Sandbox: only this project is mounted (at /workspace); ${network ? 'network on' : 'no network'}; limits ${LIMITS.cpus} CPUs, ${LIMITS.memory} RAM.`];
    const missing = k.needs.filter((n) => !names.includes(n));
    if (missing.length) notes.push(`${missing.join(', ')} is not in the vault, so ${k.label.replace(' (sandbox)', '')} can’t sign in inside the container. Add it in Secrets (lock icon) and restart.`);
    if (!network && kind !== 'sandbox-shell') notes.push('Network is off: the agent can’t reach its API. Turn network on in the sandbox menu.');
    if (process.platform === 'linux' && process.getuid?.() !== 1000) notes.push('Files the sandbox creates are owned by uid 1000 on this host.');
    this.containers.add(name);
    return {
      title: k.label,
      file: st.docker,
      args,
      cleanup: [],
      notes,
      container: name,
      onExit: () => this.containers.delete(name),
      onKill: () => this.removeContainer(st.docker, name),
    };
  }

  async removeContainer(docker, name) {
    this.containers.delete(name);
    await run(docker, ['rm', '-f', name], await this.getEnv(), 15000);
  }

  // App quit: make sure no sandbox keeps running in the background.
  disposeSync() {
    const docker = this.cache?.docker;
    if (!docker) return;
    for (const name of this.containers) { try { execFile(docker, ['rm', '-f', name], { timeout: 5000 }, () => {}); } catch {} }
    this.containers.clear();
  }
}

module.exports = { Sandbox, SANDBOX_KINDS: KINDS, imageTag };
