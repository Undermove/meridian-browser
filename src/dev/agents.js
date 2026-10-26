// Workbench: launch specs for coding agents and the plain shell.
//
// When Claude Code or Codex is started from the workbench, the Meridian MCP server is wired in for
// that one session through command-line flags — the user's global CLI configs are never touched.
//   Claude Code: --mcp-config <file>      (temp JSON file, removed when the terminal exits)
//   Codex:       -c mcp_servers.meridian.command=… -c mcp_servers.meridian.args=[…] (config overrides)
//   Copilot CLI: --additional-mcp-config @<file>  (temp JSON file, augments the user's config for this session)
//   OpenCode:    OPENCODE_CONFIG=<file>  (temp JSON file merged over the user's config)
//   Gemini CLI, Cursor, Qwen Code, Amp, Goose, Droid: MCP servers only come from their settings files,
//                which we won't write, so they start without the browser tools.
// Every agent learns which vault secrets are set in its environment (names only; MERIDIAN_VAULT_SECRETS,
// and for Claude Code a line in its system prompt), so it uses them instead of hunting for the blank .env values.
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
  // More agents: listed in the Workbench once they're installed.
  copilot: { label: 'Copilot', bin: 'copilot', install: 'npm install -g @github/copilot', mcp: true, extra: true },
  opencode: { label: 'OpenCode', bin: 'opencode', install: 'curl -fsSL https://opencode.ai/install | bash', mcp: true, extra: true },
  cursor: { label: 'Cursor', bin: 'cursor-agent', install: 'curl https://cursor.com/install -fsS | bash', mcp: false, extra: true },
  qwen: { label: 'Qwen Code', bin: 'qwen', install: 'npm install -g @qwen-code/qwen-code@latest', mcp: false, extra: true },
  amp: { label: 'Amp', bin: 'amp', install: 'npm install -g @sourcegraph/amp', mcp: false, extra: true },
  goose: { label: 'Goose', bin: 'goose', install: 'brew install block-goose-cli', mcp: false, extra: true },
  droid: { label: 'Droid', bin: 'droid', install: 'curl -fsSL https://app.factory.ai/cli | sh', mcp: false, extra: true },
};

// What an agent is told about the vault secrets in its environment (names only, never values).
function secretsBrief(names) {
  return `Meridian Workbench: this project's secrets live in Meridian's encrypted vault and are already set as environment variables in this session: ${names.join(', ')}. `
    + 'Their values in .env files are blank on purpose. Read them from the environment (process.env.NAME, os.environ["NAME"], $NAME). '
    + 'Don\'t ask the user to paste them, don\'t write their values into files or logs, and when a script loads a .env file, don\'t let it override variables that are already set.';
}

function detect(searchPath) {
  const out = {};
  for (const [id, a] of Object.entries(AGENTS)) {
    const p = which(a.bin, searchPath);
    out[id] = { id, label: a.label, installed: !!p, path: p, install: a.install, mcp: a.mcp, extra: !!a.extra };
  }
  out.node = { installed: !!which('node', searchPath) };
  return out;
}

const tomlString = (s) => JSON.stringify(String(s)); // JSON string escaping is valid TOML basic-string escaping

// mcp: { command, args } from main's mcpCommand(); dataDir: Meridian's userData (where the agent endpoint lives).
// claudeSettings (Workbench Pro): extra settings for Claude Code (the secret-guard hook, merged with
// Mission Control's observer hooks) — written to the same private temp dir as --settings; it must
// never contain secret values or tokens.
// codexNotify (Mission Control): a `notify=[…]` config override for Codex, or null.
// secretNames: vault secrets set in the terminal's environment (names only).
function launchSpec(kind, { searchPath, mcp, dataDir, claudeSettings = null, codexNotify = null, secretNames = [] }) {
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
  const extraEnv = {};
  if (secretNames.length) {
    extraEnv.MERIDIAN_VAULT_SECRETS = secretNames.join(',');
    if (kind === 'claude') args.push('--append-system-prompt', secretsBrief(secretNames));
  }
  const node = mcp && which(mcp.command, searchPath);
  const env = { MERIDIAN_DATA_DIR: dataDir };
  let tmpDir = null;
  const privateDir = () => {
    if (tmpDir) return tmpDir;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-mcp-'));
    fs.chmodSync(tmpDir, 0o700);
    cleanup.push(tmpDir);
    return tmpDir;
  };
  if (kind === 'claude' && claudeSettings) {
    const file = path.join(privateDir(), `settings-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(claudeSettings, null, 2), { mode: 0o600 });
    args.push('--settings', file);
  }
  if (kind === 'codex' && codexNotify) args.push('-c', codexNotify);
  if (agent.mcp && !node) notes.push('Node.js was not found on your PATH, so Meridian browser tools are not connected.');
  if (agent.mcp && node) {
    if (kind === 'claude') {
      const file = path.join(privateDir(), `mcp-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { meridian: { command: node, args: mcp.args, env } } }, null, 2), { mode: 0o600 });
      args.push('--mcp-config', file); // variadic flag: keep it last
    }
    if (kind === 'codex') {
      args.push(
        '-c', `mcp_servers.meridian.command=${tomlString(node)}`,
        '-c', `mcp_servers.meridian.args=[${mcp.args.map(tomlString).join(', ')}]`,
        '-c', `mcp_servers.meridian.env={ MERIDIAN_DATA_DIR = ${tomlString(dataDir)} }`,
      );
    }
    if (kind === 'copilot') {
      const file = path.join(privateDir(), `mcp-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { meridian: { type: 'local', command: node, args: mcp.args, env, tools: ['*'] } } }, null, 2), { mode: 0o600 });
      args.push('--additional-mcp-config', `@${file}`);
    }
    if (kind === 'opencode') {
      const file = path.join(privateDir(), `opencode-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { meridian: { type: 'local', command: [node, ...mcp.args], environment: env, enabled: true } } }, null, 2), { mode: 0o600 });
      extraEnv.OPENCODE_CONFIG = file;
    }
  }
  if (!agent.mcp) notes.push(`${agent.label} is started without Meridian browser tools (it only reads MCP servers from its settings files).`);
  if (secretNames.length && kind !== 'claude') notes.push(`Vault secrets are in this session’s environment (${secretNames.join(', ')}). If ${agent.label} looks for them in .env, tell it to read the environment variables.`);
  // npm installs CLIs as .cmd shims on Windows; those need cmd.exe to run.
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) return { title: agent.label, file: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args], cleanup, notes, browserTools: agent.mcp && !!node, env: extraEnv };
  return { title: agent.label, file: bin, args, cleanup, notes, browserTools: agent.mcp && !!node, env: extraEnv };
}

module.exports = { AGENTS, detect, launchSpec };
