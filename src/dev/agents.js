// Workbench: launch specs for coding agents and the plain shell.
//
// When Claude Code or Codex is started from the workbench, the Meridian MCP server is wired in for
// that one session through command-line flags — the user's global CLI configs are never touched.
//   Claude Code: --mcp-config <file>      (temp JSON file, removed when the terminal exits)
//   Codex:       -c mcp_servers.meridian.command=… -c mcp_servers.meridian.args=[…] (config overrides)
//   Gemini CLI:  configures MCP servers only through settings.json files, which we won't write, so it
//                starts without the browser tools.
// The browser still enforces the agent access level from Settings → AI on every tool call.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { userShell, which, IS_WIN } = require('./env');

const AGENTS = {
  claude: { label: 'Claude Code', bin: 'claude', install: 'npm install -g @anthropic-ai/claude-code', mcp: true },
  codex: { label: 'Codex', bin: 'codex', install: 'npm install -g @openai/codex', mcp: true },
  gemini: { label: 'Gemini', bin: 'gemini', install: 'npm install -g @google/gemini-cli', mcp: false },
};

function detect(searchPath) {
  const out = {};
  for (const [id, a] of Object.entries(AGENTS)) {
    const p = which(a.bin, searchPath);
    out[id] = { id, label: a.label, installed: !!p, path: p, install: a.install, mcp: a.mcp };
  }
  out.node = { installed: !!which('node', searchPath) };
  return out;
}

const tomlString = (s) => JSON.stringify(String(s)); // JSON string escaping is valid TOML basic-string escaping

// mcp: { command, args } from main's mcpCommand(); dataDir: Meridian's userData (where the agent endpoint lives).
function launchSpec(kind, { searchPath, mcp, dataDir }) {
  if (kind === 'shell') {
    const sh = userShell();
    return { title: path.basename(sh).replace(/\.exe$/i, ''), file: sh, args: IS_WIN ? [] : ['-l'], cleanup: [], notes: [] };
  }
  const agent = AGENTS[kind];
  if (!agent) throw new Error('unknown agent');
  const bin = which(agent.bin, searchPath);
  if (!bin) {
    const err = new Error(`${agent.label} is not installed. Install it with: ${agent.install}`);
    err.notInstalled = true;
    throw err;
  }
  const notes = [];
  const cleanup = [];
  const args = [];
  const node = mcp && which(mcp.command, searchPath);
  const env = { MERIDIAN_DATA_DIR: dataDir };
  if (agent.mcp && !node) notes.push('Node.js was not found on your PATH, so Meridian browser tools are not connected.');
  if (agent.mcp && node) {
    if (kind === 'claude') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mcp-'));
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, `mcp-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { meridian: { command: node, args: mcp.args, env } } }, null, 2), { mode: 0o600 });
      cleanup.push(dir);
      args.push('--mcp-config', file); // variadic flag: keep it last
    }
    if (kind === 'codex') {
      args.push(
        '-c', `mcp_servers.meridian.command=${tomlString(node)}`,
        '-c', `mcp_servers.meridian.args=[${mcp.args.map(tomlString).join(', ')}]`,
        '-c', `mcp_servers.meridian.env={ MERIDIAN_DATA_DIR = ${tomlString(dataDir)} }`,
      );
    }
  }
  if (!agent.mcp) notes.push(`${agent.label} is started without Meridian browser tools (it only reads MCP servers from its settings files).`);
  // npm installs CLIs as .cmd shims on Windows; those need cmd.exe to run.
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) return { title: agent.label, file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args], cleanup, notes, browserTools: agent.mcp && !!node };
  return { title: agent.label, file: bin, args, cleanup, notes, browserTools: agent.mcp && !!node };
}

module.exports = { AGENTS, detect, launchSpec };
