// Workbench Pro: secret-file guard for Claude Code sessions started from the workbench.
//
// How it works
//  - Each Claude Code session gets `--settings <file>` with ONE PreToolUse hook: a small node script
//    shipped with the app (src/dev/hooks/secret-guard-hook.js, unpacked from the asar). The settings
//    file contains only the node path and the script path — no secrets, no token. It lives in the
//    session's private 0700 temp dir and is deleted when the terminal ends.
//  - The hook decides locally whether a tool call touches a secret-looking file (.env, *.pem,
//    id_rsa, credentials…). Only then it asks Meridian over a private local socket: a unix socket in
//    a fresh 0700 temp dir (a random named pipe on Windows) — no TCP port. Requests must carry the
//    per-session token, passed to the agent process in its environment (MERIDIAN_GUARD_TOKEN).
//  - Meridian shows a native prompt (move the keys into the vault / block / allow) and answers with
//    a Claude Code permission decision. If Meridian can't be reached the hook answers "ask", so Claude
//    Code falls back to its own confirmation — never a silent allow.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_REQUEST = 64 * 1024;
const HOOK_SCRIPT = path.join(__dirname, 'hooks', 'secret-guard-hook.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

class SecretGuard {
  // onRequest(session, request) -> Promise<{ decision: 'allow'|'deny'|'ask', reason }>
  constructor({ onRequest }) {
    this.onRequest = onRequest;
    this.sessions = new Map(); // token -> session
    this.server = null;
    this.dir = null;
    this.socketPath = null;
    this.starting = null;
  }

  hookScript() { return fs.existsSync(HOOK_SCRIPT) ? HOOK_SCRIPT : null; }

  start() {
    if (this.server) return Promise.resolve(this.socketPath);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      if (process.platform === 'win32') this.socketPath = `\\\\.\\pipe\\meridian-guard-${crypto.randomBytes(12).toString('hex')}`;
      else {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
        fs.chmodSync(this.dir, 0o700);
        this.socketPath = path.join(this.dir, 'guard.sock');
      }
      const server = net.createServer((sock) => this.onConnection(sock));
      const restoreMask = process.platform === 'win32' ? () => {} : ((old) => () => process.umask(old))(process.umask(0o177));
      server.on('error', (err) => { restoreMask(); this.starting = null; console.error('workbench guard: socket error', err.message); reject(err); });
      server.listen(this.socketPath, () => {
        restoreMask();
        if (process.platform !== 'win32') { try { fs.chmodSync(this.socketPath, 0o600); } catch {} }
        this.server = server;
        resolve(this.socketPath);
      });
    });
    return this.starting;
  }

  register(session) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { ...session, allowed: new Set() });
    return token;
  }

  unregister(token) { this.sessions.delete(token); }

  onConnection(sock) {
    let buf = '';
    let done = false;
    sock.setEncoding('utf8');
    sock.setTimeout(150_000, () => sock.destroy());
    const reply = (obj) => { if (!done) { done = true; sock.end(JSON.stringify(obj) + '\n'); } };
    sock.on('error', () => {});
    sock.on('data', async (chunk) => {
      if (done) return;
      buf += chunk;
      if (buf.length > MAX_REQUEST) return reply({ decision: 'deny', reason: 'request too large' });
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { return reply({ decision: 'deny', reason: 'bad request' }); }
      const given = Buffer.from(String(req.token || ''));
      const session = [...this.sessions.entries()].find(([t]) => {
        const want = Buffer.from(t);
        return given.length === want.length && crypto.timingSafeEqual(given, want);
      })?.[1];
      if (!session) return reply({ decision: 'ask', reason: 'Unknown Meridian session.' });
      const request = {
        tool: String(req.tool || '').slice(0, 64),
        paths: (Array.isArray(req.paths) ? req.paths : []).map((p) => String(p).slice(0, 4096)).slice(0, 20),
        command: typeof req.command === 'string' ? req.command.slice(0, 2000) : null,
      };
      try { reply(await this.onRequest(session, request)); } catch (err) { reply({ decision: 'ask', reason: `Meridian error: ${err.message}` }); }
    });
  }

  stop() {
    try { this.server?.close(); } catch {}
    this.server = null;
    this.starting = null;
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} this.dir = null; }
    this.sessions.clear();
  }
}

// The --settings JSON for one Claude Code session (written by the caller into its private temp dir).
function hookSettings(nodePath, scriptPath) {
  // The command runs through a shell: refuse paths that would need anything beyond plain quoting.
  if (/["`$\\\n\r]/.test(nodePath + scriptPath) && process.platform !== 'win32') return null;
  if (/["\n\r]/.test(nodePath + scriptPath)) return null;
  return {
    hooks: {
      PreToolUse: [{
        matcher: 'Read|Grep|Glob|Bash|NotebookRead',
        hooks: [{ type: 'command', command: `"${nodePath}" "${scriptPath}"`, timeout: 140 }],
      }],
    },
  };
}

module.exports = { SecretGuard, hookSettings };
