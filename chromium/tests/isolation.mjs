// The isolation guard. Tests run on the owner's own computer, beside his real AI tools; a test that
// leaks (a CLAUDE_CONFIG_DIR inherited from the shell that started it, a stand-in run with the real
// HOME) writes into his real configs. Two things, for every test file (harness.mjs imports this):
//
// 1. The owner's login environment is taken out of this process before anything is spawned, so no
//    browser, stand-in or helper a test starts can see it: the AI tools' variables (CLAUDE_*,
//    CODEX_HOME, ANTHROPIC_*, …), tokens and keys, and the PATH folders that hold his real AI CLIs
//    (~/.local/bin/claude, /usr/local/bin/claude, …).
// 2. Before and after the file, a hash of each file a test must never touch. A change fails the
//    file loudly, naming the file (never its contents: they hold tokens and project names).
//
// The guarded files are read only to hash them. Claude Code itself rewrites its .claude.json all
// the time (the owner works in it while the tests run), so for those two files the hash covers
// what a test could change — the MCP servers, and any trace of a test folder — not the whole file.
// The others are hashed whole. MERIDIAN_GUARD_STRICT=1 hashes every file whole.
import { after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
// The owner's real home folder, whatever HOME a test set.
export const REAL_HOME = os.userInfo().homedir;
const APPDATA = process.env.APPDATA || path.join(REAL_HOME, 'AppData', 'Roaming');

// The files a test must never touch, by where they really are on this system.
export const GUARDED = [
  { file: path.join(REAL_HOME, '.claude.json'), claudeJson: true },
  { file: path.join(REAL_HOME, '.claude-personal', '.claude.json'), claudeJson: true },
  { file: path.join(REAL_HOME, '.codex', 'config.toml') },
  { file: process.platform === 'darwin' ? path.join(REAL_HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : WIN ? path.join(APPDATA, 'Claude', 'claude_desktop_config.json') : path.join(REAL_HOME, '.config', 'Claude', 'claude_desktop_config.json') },
  { file: process.platform === 'darwin' ? path.join(REAL_HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
      : WIN ? path.join(APPDATA, 'Code', 'User', 'mcp.json') : path.join(REAL_HOME, '.config', 'Code', 'User', 'mcp.json') },
  { file: path.join(REAL_HOME, '.copilot', 'mcp-config.json') },
];

// Where tests make their folders: a path from there inside a real config is a leak.
const TEMP_ROOTS = [...new Set([os.tmpdir(), (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })()])];

function digest(entry) {
  let raw;
  try { raw = fs.readFileSync(entry.file); } catch (e) { return e.code === 'ENOENT' ? 'absent' : `unreadable:${e.code}`; }
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  if (!entry.claudeJson || process.env.MERIDIAN_GUARD_STRICT) return sha(raw);
  const text = raw.toString('utf8');
  // Traces of a test: its temp folders, or Meridian's test profiles, anywhere in the file.
  const traces = TEMP_ROOTS.reduce((n, root) => n + text.split(root).length - 1, 0) +
      (text.split('meridian-e2e').length - 1) + (text.split('meridian-qg-').length - 1);
  let servers = '';
  try {
    const j = JSON.parse(text);
    // Top-level servers (`claude mcp add -s user`), and each project's own (`-s local`).
    const perProject = Object.entries(j.projects || {}).map(([k, v]) => [k, v?.mcpServers || null]).filter(([, v]) => v);
    servers = JSON.stringify([j.mcpServers || null, perProject]);
  } catch {
    // Mid-write by Claude Code: only the traces count then.
    servers = 'unparsed';
  }
  return `${sha(servers)}:${traces}`;
}


// "~/.claude.json" for the report, never the owner's user name.
const shown = (file) => file.startsWith(REAL_HOME) ? '~' + file.slice(REAL_HOME.length) : file;

const UNPARSED = crypto.createHash('sha256').update('unparsed').digest('hex');
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function snapshot(list = GUARDED) {
  const take = () => list.map((g) => ({ file: g.file, hash: digest(g) }));
  let now = take();
  // A .claude.json caught mid-write by Claude Code reads as unparsed: look again a moment later.
  for (let i = 0; i < 10 && now.some((n) => n.hash.startsWith(UNPARSED)); i++) { pause(200); now = take(); }
  return now;
}

export function changedSince(before, list = GUARDED) {
  const now = snapshot(list);
  return before.filter((b, i) => b.hash !== now[i].hash).map((b) => shown(b.file));
}

// ---- 1. The owner's login environment, out of every process this test file starts.

// Variables of the AI tools and of the places that hold keys and tokens.
const OWNER_VARS = /^(CLAUDE|CLAUDECODE|ANTHROPIC|OPENAI|CODEX|COPILOT|GEMINI|GOOGLE_(API|GENAI|CLOUD)|VERTEX|XAI_|MISTRAL|DEEPSEEK|GROQ|OPENROUTER|OLLAMA|QWEN|DASHSCOPE|CURSOR|WINDSURF|CODEIUM|AMP_|FACTORY|DROID|GOOSE|OPENCODE|AIDER|LITELLM|HF_|HUGGING|AWS_|AZURE_|GH_|GITHUB_|GITLAB_|HOMEBREW_GITHUB|NPM_TOKEN|NODE_AUTH_TOKEN|VSCODE_|TERM_PROGRAM|ZDOTDIR|XDG_(CONFIG|DATA|STATE|CACHE)_HOME|SSH_AUTH_SOCK|__MISE|MISE_)/i;
const SECRET_NAMES = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_KEY)$/i;
// The agent CLIs Meridian looks for: a PATH folder with one of them is the owner's real install.
const AGENT_CLIS = ['claude', 'codex', 'copilot', 'gemini', 'qwen', 'opencode', 'cursor-agent', 'amp', 'droid', 'goose', 'aider', 'crush', 'kiro-cli'];

export const STRIPPED = [];
export function stripOwnerEnv(env = process.env) {
  for (const name of Object.keys(env)) {
    // The harness's own switches stay (MERIDIAN_APP, MERIDIAN_LOG, …): the browser ignores them.
    if (name.startsWith('MERIDIAN_')) continue;
    if (OWNER_VARS.test(name) || SECRET_NAMES.test(name)) { STRIPPED.push(name); delete env[name]; }
  }
  const node = path.dirname(process.execPath);
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
  for (const key of keys) {
    const kept = env[key].split(path.delimiter).filter((dir) => {
      if (!dir) return false;
      if (path.resolve(dir) === path.resolve(node)) return true;
      // Under the owner's home (~/.local/bin, ~/.npm-global/bin, ~/.bun/bin …): his tools, not the tests'.
      // On Windows the temp folder is under the home too; a test's own folders stay.
      const inTemp = TEMP_ROOTS.some((t) => path.resolve(dir).startsWith(path.resolve(t)));
      if (!inTemp && path.resolve(dir).toLowerCase().startsWith(path.resolve(REAL_HOME).toLowerCase() + path.sep)) return false;
      return !AGENT_CLIS.some((cli) => (WIN ? ['.exe', '.cmd', '.ps1', ''] : ['']).some((ext) => {
        try { return fs.statSync(path.join(dir, cli + ext)).isFile(); } catch { return false; }
      }));
    });
    env[key] = kept.join(path.delimiter);
  }
  return env;
}

// ---- 2. The guard around the whole test file.

let installed = false;
export function installGuard() {
  if (installed) return;
  installed = true;
  stripOwnerEnv(process.env);
  if (process.env.MERIDIAN_GUARD_OFF) return;
  const before = snapshot();
  const check = () => {
    const changed = changedSince(before);
    if (changed.length) {
      return `ISOLATION GUARD: this test file changed the owner's real config:\n  ${changed.join('\n  ')}\n` +
          'A test must only ever touch its own temp HOME. Find the leak before anything else (see chromium/RELEASE_CHECKLIST.md).';
    }
    return '';
  };
  // Under the test runner: a failure of the file. A script (tools/*.mjs) fails at exit instead.
  if (process.env.NODE_TEST_CONTEXT || /\.test\.m?js$/.test(process.argv[1] || '')) {
    after(() => { const why = check(); if (why) throw new Error(why); });
  } else {
    process.on('exit', () => { const why = check(); if (why) { console.error(why); process.exitCode = 1; } });
  }
}
