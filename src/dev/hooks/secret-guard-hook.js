#!/usr/bin/env node
// Meridian — Claude Code PreToolUse hook: ask Meridian before the agent reads a secret file.
//
// Installed per session by the Meridian Workbench through `claude --settings <file>` (see
// src/dev/guard.js). Standalone: plain Node, no dependencies, runs outside the app bundle.
//
// stdin:  the hook event JSON from Claude Code ({ tool_name, tool_input, cwd, ... }).
// stdout: nothing (no opinion) or { hookSpecificOutput: { hookEventName: 'PreToolUse',
//         permissionDecision: 'allow'|'deny'|'ask', permissionDecisionReason } }.

'use strict';
const net = require('net');
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

async function main() {
  let ev;
  try { ev = JSON.parse(await readStdin()); } catch { return out(); }
  const tool = String(ev.tool_name || '');
  const input = ev.tool_input || {};
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : process.cwd();
  const paths = [];
  let command = null;
  const addPath = (p) => { if (typeof p === 'string' && p) paths.push(path.resolve(cwd, p)); };
  if (tool === 'Read' || tool === 'NotebookRead') addPath(input.file_path || input.notebook_path);
  else if (tool === 'Grep') { if (input.path) addPath(input.path); if (input.glob && SECRET_FILE.test(String(input.glob).replace(/\*/g, 'x'))) addPath(path.join(input.path || '.', String(input.glob))); }
  else if (tool === 'Glob') { if (typeof input.pattern === 'string' && /\.env|\.pem|id_rsa|credentials/i.test(input.pattern)) addPath(path.join(input.path || '.', input.pattern)); }
  else if (tool === 'Bash') command = typeof input.command === 'string' ? input.command : null;

  const hitPaths = paths.filter((p) => SECRET_FILE.test(p.replace(/\*+/g, 'x')));
  const hitCmd = command && SECRET_IN_CMD.test(command);
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
