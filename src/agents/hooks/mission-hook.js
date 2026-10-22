#!/usr/bin/env node
// Meridian — Mission Control event hook for coding agents started from the Workbench.
//
// Claude Code: installed per session through `claude --settings <file>` as an *async* command hook
//   (it never blocks the agent) for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
//   PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SubagentStart,
//   SubagentStop, PreCompact and SessionEnd. stdin: the hook event JSON.
// Codex: installed per session as the `notify` program (`-c notify=[node, this, "--codex"]`);
//   the event JSON is the last argv entry ({ type: "agent-turn-complete", "thread-id", … }).
//
// What leaves this process: a small, fixed set of fields plus a short human summary of the tool
// call (file name, command head, host). Never the full tool input, tool output, prompts or messages.
// Meridian redacts the summary again before showing it.
//
// Transport (fire-and-forget, 1.5 s budget, always exit 0 with no output):
//   MERIDIAN_MISSION_SOCKET + MERIDIAN_MISSION_TOKEN → one JSON line over a private local socket;
//   MERIDIAN_MISSION_FILE   + MERIDIAN_MISSION_TOKEN → one JSON line appended to a session file
//   (Docker sandboxes, where the socket can't be shared).
// Standalone: plain Node, no dependencies, runs outside the app bundle (and inside containers).

'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

const done = () => process.exit(0);
setTimeout(done, 1500).unref?.();

const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : undefined);

function hostOf(u) { try { return new URL(String(u)).host; } catch { return undefined; } }

function rel(p, cwd) {
  if (typeof p !== 'string' || !p) return undefined;
  let r = p;
  try { if (cwd && path.isAbsolute(p)) { const x = path.relative(cwd, p); if (x && !x.startsWith('..')) r = x; else r = path.basename(p); } } catch {}
  return r.slice(-120);
}

// A short, human summary of a tool call. Deliberately lossy.
function summarize(tool, input, cwd) {
  input = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'Bash': case 'BashOutput': return input.command ? '$ ' + String(input.command).split('\n')[0].slice(0, 140) : undefined;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookRead': case 'NotebookEdit':
      return rel(input.file_path || input.notebook_path, cwd);
    case 'Grep': return input.pattern ? `“${String(input.pattern).slice(0, 60)}”${input.path ? ' in ' + rel(input.path, cwd) : ''}` : undefined;
    case 'Glob': return str(input.pattern, 100);
    case 'WebFetch': return hostOf(input.url);
    case 'WebSearch': return str(input.query, 100);
    case 'Agent': case 'Task': return str(input.description, 120);
    case 'TodoWrite': return Array.isArray(input.todos) ? `${input.todos.length} to-dos` : undefined;
    case 'Skill': return str(input.skill || input.command, 60);
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
      if (m) return `${m[1]} › ${m[2]}${input.url ? ' · ' + (hostOf(input.url) || '') : ''}`;
      return undefined;
    }
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 1_000_000) { process.stdin.destroy(); resolve(''); } });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function fromClaude(ev) {
  const tool = str(ev.tool_name, 80);
  const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : undefined;
  const out = {
    kind: 'claude',
    event: str(ev.hook_event_name, 40),
    session_id: str(ev.session_id, 80),
    agent_id: str(ev.agent_id, 80),
    agent_type: str(ev.agent_type, 60),
    tool,
    tool_use_id: str(ev.tool_use_id, 80),
    summary: tool ? summarize(tool, input, cwd) : undefined,
    source: str(ev.source, 20),
    reason: str(ev.reason, 40),
    trigger: str(ev.trigger, 20),
    notification_type: str(ev.notification_type, 40),
    message: ev.hook_event_name === 'Notification' ? str(ev.message, 200) : undefined,
    model: str(typeof ev.model === 'string' ? ev.model : ev.model?.id, 60),
    duration_ms: Number.isFinite(ev.duration_ms) ? Math.round(ev.duration_ms) : undefined,
    error: ev.hook_event_name === 'PostToolUseFailure' || ev.hook_event_name === 'StopFailure' ? true : undefined,
    interrupt: ev.is_interrupt === true ? true : undefined,
    cwd_name: cwd ? path.basename(cwd).slice(0, 80) : undefined,
  };
  if (tool === 'Agent' || tool === 'Task') {
    out.description = str(input.description, 120);
    out.subagent_type = str(input.subagent_type, 60);
    out.background = input.run_in_background === true ? true : undefined;
  }
  return out;
}

function fromCodex(arg) {
  let ev = {};
  try { ev = JSON.parse(arg); } catch {}
  return { kind: 'codex', event: ev.type === 'agent-turn-complete' ? 'TurnComplete' : str(ev.type, 40) || 'Notify', session_id: str(ev['thread-id'], 80), turn_id: str(ev['turn-id'], 80), cwd_name: typeof ev.cwd === 'string' ? path.basename(ev.cwd).slice(0, 80) : undefined };
}

function send(line) {
  const token = process.env.MERIDIAN_MISSION_TOKEN;
  if (!token) return done();
  const payload = JSON.stringify({ v: 1, token, ...line }) + '\n';
  if (payload.length > 16_000) return done();
  const socketPath = process.env.MERIDIAN_MISSION_SOCKET;
  const file = process.env.MERIDIAN_MISSION_FILE;
  if (socketPath) {
    const sock = net.createConnection(socketPath);
    sock.on('connect', () => sock.end(payload));
    sock.on('close', done);
    sock.on('error', done);
    return;
  }
  if (file) { try { fs.appendFileSync(file, payload); } catch {} }
  done();
}

async function main() {
  const i = process.argv.indexOf('--codex');
  if (i >= 0) return send(fromCodex(process.argv[process.argv.length - 1]));
  let ev;
  try { ev = JSON.parse(await readStdin()); } catch { return done(); }
  if (!ev || typeof ev !== 'object') return done();
  send(fromClaude(ev));
}

main().catch(done);
