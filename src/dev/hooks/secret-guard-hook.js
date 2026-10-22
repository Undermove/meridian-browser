#!/usr/bin/env node
// Meridian — Claude Code PreToolUse hook: ask Meridian before the agent reads a secret file.
//
// Installed per session by the Meridian Workbench through `claude --settings <file>` (see
// src/dev/guard.js). Standalone: plain Node, no dependencies, runs outside the app bundle.
//
// File tools (Read, Edit, NotebookEdit, LSP, Grep, Glob) are checked by path — both the path as given
// and its real path, so a symlink can't hide a secret file. Shell-like tools (Bash, PowerShell,
// Monitor, REPL) are checked heuristically: a secret file name appearing in the command text. A
// command that reads a secret without naming it (a variable, a symlink, a script) is NOT caught.
// Meridian's integrity check: src/dev/guard.js carries this file's SHA-256 — update it on any change.
//
// stdin:  the hook event JSON from Claude Code ({ tool_name, tool_input, cwd, ... }).
// stdout: nothing (no opinion) or { hookSpecificOutput: { hookEventName: 'PreToolUse',
//         permissionDecision: 'allow'|'deny'|'ask', permissionDecisionReason } }.

'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = /(^|[\\/])(\.env(\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?|\.envrc|([\w.-]*[-_.])?credentials(\.(json|ya?ml|toml|ini))?|service[-_]account[\w.-]*\.json|[^\\/]*\.pem|[^\\/]*\.p12|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|secrets?\.(json|ya?ml|toml))$/i;
// In shell commands: a secret file name as a word (cat .env, source .env.local, < ~/.ssh/id_rsa …).
const SECRET_IN_CMD = /(^|[\s'"=<>|;&(\\/])(\.env(\.(?!example\b|sample\b|template\b|dist\b|defaults\b)[\w-]+)?|\.envrc|credentials(\.json)?|[\w.-]+\.pem|id_(rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.git-credentials)(?=$|[\s'";|&)<>])/i;

function out(decision, reason) {
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; if (data.length > 2_000_000) { process.stdin.destroy(); resolve(''); } });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// The real path of p (symlinks resolved). For a path that doesn't exist yet: its parent's real path.
function realOf(p) {
  try { return fs.realpathSync.native(p); } catch {}
  try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch {}
  return p;
}
const isSecret = (p) => SECRET_FILE.test(String(p).replace(/\*+/g, 'x'));

// File tools: which input fields hold paths. Shell-like tools: every string field is command text.
const FILE_TOOLS = new Set(['Read', 'NotebookRead', 'NotebookEdit', 'Edit', 'MultiEdit', 'LSP']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor', 'REPL']);

async function main() {
  let ev;
  try { ev = JSON.parse(await readStdin()); } catch { return out(); }
  const tool = String(ev.tool_name || '');
  const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : process.cwd();
  const paths = [];
  let command = null;
  const addPath = (p) => { if (typeof p === 'string' && p) paths.push(path.resolve(cwd, p)); };
  if (FILE_TOOLS.has(tool)) { addPath(input.file_path); addPath(input.notebook_path); addPath(input.filePath); }
  else if (tool === 'Grep') { if (input.path) addPath(input.path); if (input.glob && isSecret(String(input.glob))) addPath(path.join(input.path || '.', String(input.glob))); }
  else if (tool === 'Glob') { if (typeof input.pattern === 'string' && /\.env|\.pem|id_rsa|credentials/i.test(input.pattern)) addPath(path.join(input.path || '.', input.pattern)); }
  else if (SHELL_TOOLS.has(tool)) {
    // Heuristic only: a secret file name appearing as a word in the command text.
    const texts = Object.values(input).filter((v) => typeof v === 'string');
    command = texts.find((t) => SECRET_IN_CMD.test(t)) || null;
  }

  // A path counts by its own name AND by what it really points at (a symlink named notes.txt -> .env).
  const hitPaths = [];
  for (const p of paths) {
    const real = realOf(p);
    if (isSecret(real)) hitPaths.push(real);
    else if (isSecret(p)) hitPaths.push(p);
  }
  const hitCmd = !!command;
  if (!hitPaths.length && !hitCmd) return out();

  const socketPath = process.env.MERIDIAN_GUARD_SOCKET;
  const token = process.env.MERIDIAN_GUARD_TOKEN;
  if (!socketPath || !token) return out('ask', 'This reads a file that may contain secrets.');

  const answer = await new Promise((resolve) => {
    let buf = '';
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 135_000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ token, tool, paths: hitPaths, command: hitCmd ? command : null }) + '\n'));
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(buf.trim())); } catch { resolve(null); } });
    sock.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  if (!answer || !['allow', 'deny', 'ask'].includes(answer.decision)) return out('ask', 'Meridian could not be reached; this reads a file that may contain secrets.');
  return out(answer.decision, String(answer.reason || '').slice(0, 1000));
}

main().catch(() => out('ask', 'Secret guard failed; this reads a file that may contain secrets.'));
