// Mission Control: the local, one-way event channel from agent hooks to Meridian.
//
// Same shape as the secret guard (src/dev/guard.js), but fire-and-forget:
//  - a unix socket in a fresh 0700 temp dir (socket itself 0600), or a random named pipe on Windows.
//    No TCP port, so nothing outside this user account can reach it.
//  - every line must carry a per-session token (32 random bytes, handed to the agent process in its
//    environment and never written to disk by us); unknown tokens are dropped silently.
//  - one JSON object per line, at most 16 KB per line and 64 KB per connection; connections that
//    dawdle are cut after 3 s; each session is rate-limited. Nothing is ever sent back, so a hook
//    can't learn anything from the channel and never waits on Meridian.
//  - Docker sandboxes can't reach the socket, so they append lines to a file in a per-session temp
//    dir that is mounted into the container (tail()). Same validation, same token.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const MAX_LINE = 16 * 1024;
const MAX_CONN = 64 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_READ = 256 * 1024;
const RATE = { burst: 200, perSecond: 60 };
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);

class EventChannel {
  // onEvent(session, event) — session is whatever register() was given.
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.sessions = new Map(); // token -> { session, bucket, at }
    this.tails = new Map();    // token -> { file, offset, watcher, timer }
    this.server = null;
    this.dir = null;
    this.socketPath = null;
    this.starting = null;
  }

  start() {
    if (this.server) return Promise.resolve(this.socketPath);
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      if (process.platform === 'win32') this.socketPath = `\\\\.\\pipe\\meridian-mission-${crypto.randomBytes(12).toString('hex')}`;
      else {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
        fs.chmodSync(this.dir, 0o700);
        this.socketPath = path.join(this.dir, 'events.sock');
      }
      const server = net.createServer((sock) => this.onConnection(sock));
      server.maxConnections = 64; // hooks connect, write one line and leave
      const restoreMask = process.platform === 'win32' ? () => {} : ((old) => () => process.umask(old))(process.umask(0o177));
      server.on('error', (err) => { restoreMask(); this.starting = null; console.error('mission control: socket error', err.message); reject(err); });
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
    this.sessions.set(token, { session, bucket: RATE.burst, at: Date.now() });
    return token;
  }

  unregister(token) {
    this.sessions.delete(token);
    this.untail(token);
  }

  lookup(given) {
    const g = Buffer.from(String(given || ''));
    if (g.length !== 64) return null;
    for (const [t, entry] of this.sessions) {
      const want = Buffer.from(t);
      if (want.length === g.length && crypto.timingSafeEqual(g, want)) return entry;
    }
    return null;
  }

  // One line of JSON from a hook. Returns true if it was accepted.
  accept(line) {
    if (!line || line.length > MAX_LINE) return false;
    let ev;
    try { ev = JSON.parse(line); } catch { return false; }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return false;
    const entry = this.lookup(ev.token);
    if (!entry) return false;
    // token bucket per session
    const t = Date.now();
    entry.bucket = Math.min(RATE.burst, entry.bucket + ((t - entry.at) / 1000) * RATE.perSecond);
    entry.at = t;
    if (entry.bucket < 1) return false;
    entry.bucket -= 1;
    delete ev.token;
    try { this.onEvent(entry.session, ev); } catch (err) { console.error('mission control: event error', err.message); }
    return true;
  }

  onConnection(sock) {
    let buf = '';
    let total = 0;
    sock.setEncoding('utf8');
    sock.setTimeout(3000, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_CONN) { sock.destroy(); return; }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.accept(line);
      }
      if (buf.length > MAX_LINE) sock.destroy();
    });
    sock.on('end', () => { if (buf) this.accept(buf); sock.end(); });
  }

  // ----- sandbox: a per-session directory with an append-only events file -----

  // Creates the dir (returned) and starts following <dir>/events.jsonl for this token.
  //
  // The dir is mounted read-write into the container, so everything in it is hostile: events.jsonl
  // may be swapped for a symlink (to any host file), a FIFO, a device, a directory, a hard link, or
  // truncated/recreated at any time. We only ever read through an fd opened with O_NOFOLLOW (and
  // O_NONBLOCK, so a FIFO can't park the open), and only if fstat says it's a regular file with a
  // single link that lives on the same device as the dir we created. Reads are bounded per tick and
  // in total; a shrunk or replaced file restarts from 0 (only its own session's token is accepted).
  tailDir(token) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mission-'));
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
    const dev = fs.lstatSync(dir).dev;
    const st = { file, dir, offset: 0, total: 0, ino: null, partial: '', decoder: new StringDecoder('utf8'), reading: false, stopped: false };
    const read = () => {
      if (st.reading || st.stopped) return;
      st.reading = true;
      let fd = null;
      try {
        fd = fs.openSync(file, OPEN_FLAGS);
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.dev !== dev) return;
        if (st.ino !== s.ino || s.size < st.offset) { st.ino = s.ino; st.offset = 0; st.partial = ''; st.decoder = new StringDecoder('utf8'); } // replaced or truncated
        if (s.size <= st.offset || st.total >= MAX_FILE) return;
        const len = Math.min(s.size - st.offset, MAX_READ, MAX_FILE - st.total);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, st.offset);
        if (n <= 0) return;
        st.offset += n;
        st.total += n;
        const lines = (st.partial + st.decoder.write(buf.subarray(0, n))).split('\n');
        st.partial = lines.pop().slice(0, MAX_LINE + 1);
        for (const l of lines) this.accept(l);
      } catch { /* missing, a symlink (ELOOP), a dir, … : ignore */ } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
        st.reading = false;
      }
    };
    // Coalesced: the container can generate fs events as fast as it likes.
    const soon = () => { if (!st.soon && !st.stopped) st.soon = setTimeout(() => { st.soon = null; read(); }, 50); };
    try { st.watcher = fs.watch(dir, soon); st.watcher.on('error', () => {}); } catch {}
    st.timer = setInterval(read, 700); // fs.watch misses writes made through some VM file-sharing layers
    st.timer.unref?.();
    this.tails.set(token, st);
    return dir;
  }

  untail(token) {
    const st = this.tails.get(token);
    if (!st) return;
    this.tails.delete(token);
    st.stopped = true;
    try { st.watcher?.close(); } catch {}
    clearInterval(st.timer);
    clearTimeout(st.soon);
    // rmSync never follows symlinks the container planted in the dir.
    try { fs.rmSync(st.dir, { recursive: true, force: true }); } catch {}
  }

  stop() {
    try { this.server?.close(); } catch {}
    this.server = null;
    this.starting = null;
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch {} this.dir = null; }
    for (const token of [...this.tails.keys()]) this.untail(token);
    this.sessions.clear();
  }
}

module.exports = { EventChannel };
