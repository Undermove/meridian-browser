// Workbench: terminals (node-pty).
//
// A pty is arbitrary code execution, so this module is only reachable through the workbench IPC
// handlers, which only answer the internal workbench page. Every terminal belongs to the webContents
// that created it; it is killed when that page goes away or the app quits. Output is kept in a small
// ring buffer so the page can re-attach after a reload without losing the agent session.

const fs = require('fs');

const MAX_TERMINALS = 12;
const SCROLLBACK_BYTES = 256 * 1024;

let ptyModule = null;
let ptyLoadError = null;
function loadPty() {
  if (ptyModule || ptyLoadError) return ptyModule;
  try { ptyModule = require('node-pty'); } catch (err) { ptyLoadError = err; console.error('workbench: node-pty failed to load', err); }
  return ptyModule;
}

class Terminal {
  constructor({ id, owner, kind, title, file, args, cwd, env, cols, rows, cleanup, meta, onExit, onKill }) {
    const pty = loadPty();
    if (!pty) throw new Error(`Terminals are unavailable: ${ptyLoadError?.message || 'node-pty missing'}`);
    this.id = id;
    this.owner = owner;
    this.kind = kind;
    this.title = title;
    this.cleanup = cleanup || [];
    this.meta = meta || {};     // Workbench Pro: { secrets: [names], guard, sandbox, then } — names only, never values
    this.onExitHook = onExit;
    this.onKillHook = onKill;
    this.chunks = [];
    this.size = 0;
    this.exited = null;
    this.outbox = '';
    this.flushQueued = false;
    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: clampInt(cols, 2, 500, 80),
      rows: clampInt(rows, 2, 300, 24),
      cwd,
      env,
      useConpty: true,
    });
    this.proc.onData((data) => this.onData(data));
    this.proc.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));
  }

  onData(data) {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > SCROLLBACK_BYTES && this.chunks.length > 1) this.size -= this.chunks.shift().length;
    // Coalesce bursts (agents print a lot) into one IPC message per tick.
    this.outbox += data;
    if (!this.flushQueued) {
      this.flushQueued = true;
      setTimeout(() => this.flush(), 8);
    }
  }

  flush() {
    this.flushQueued = false;
    if (!this.outbox) return;
    const data = this.outbox;
    this.outbox = '';
    send(this.owner, 'wb:pty-data', { id: this.id, data });
  }

  onExit(code, signal) {
    this.flush();
    this.exited = { code, signal: signal || null };
    send(this.owner, 'wb:pty-exit', { id: this.id, ...this.exited });
    this.runCleanup();
    try { this.onExitHook?.(this.exited); } catch {}
  }

  runCleanup() {
    for (const file of this.cleanup.splice(0)) fs.rm(file, { force: true, recursive: true }, () => {});
  }

  info() {
    return { id: this.id, kind: this.kind, title: this.title, exited: this.exited, scrollback: this.chunks.join(''), ...this.meta };
  }

  kill() {
    const running = !this.exited;
    if (running) { try { this.proc.kill(); } catch {} }
    this.runCleanup();
    if (running) { try { this.onKillHook?.(); } catch {} }
  }
}

function send(wc, channel, payload) {
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

class PtyManager {
  constructor() {
    this.terms = new Map(); // id -> Terminal
    this.seq = 0;
  }

  available() { return !!loadPty(); }
  loadError() { loadPty(); return ptyLoadError ? ptyLoadError.message : null; }

  create(owner, spec) {
    const mine = [...this.terms.values()].filter((t) => t.owner === owner && !t.exited);
    if (mine.length >= MAX_TERMINALS) throw new Error(`At most ${MAX_TERMINALS} terminals per workbench`);
    const id = `t${++this.seq}`;
    const term = new Terminal({ id, owner, ...spec });
    this.terms.set(id, term);
    return term.info();
  }

  get(owner, id) {
    const t = this.terms.get(String(id));
    if (!t || t.owner !== owner) throw new Error('no such terminal');
    return t;
  }

  write(owner, id, data) {
    if (typeof data !== 'string' || data.length > 1_000_000) return;
    const t = this.get(owner, id);
    if (!t.exited) t.proc.write(data);
  }

  resize(owner, id, cols, rows) {
    const t = this.get(owner, id);
    if (!t.exited) { try { t.proc.resize(clampInt(cols, 2, 500, 80), clampInt(rows, 2, 300, 24)); } catch {} }
  }

  kill(owner, id) {
    const t = this.get(owner, id);
    t.kill();
    this.terms.delete(t.id);
  }

  list(owner) {
    return [...this.terms.values()].filter((t) => t.owner === owner).map((t) => t.info());
  }

  killAllFor(owner) {
    for (const t of [...this.terms.values()]) if (t.owner === owner) { t.kill(); this.terms.delete(t.id); }
  }

  killAll() {
    for (const t of this.terms.values()) t.kill();
    this.terms.clear();
  }
}

module.exports = { PtyManager };
