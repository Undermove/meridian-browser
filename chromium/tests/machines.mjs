// "Real computers": test homes shaped like the machines Meridian really meets, each a named fixture.
// The E2E suite used to run in a sterile world (one stand-in CLI, a clean HOME), so what broke for
// real people never showed up: an old /usr/local/bin/claude first on the PATH, a second Claude
// account through CLAUDE_CONFIG_DIR, an editor extension and no CLI, Claude Desktop with other
// servers, Meridian run from its disk image, Codex alone. Each fixture here builds that machine in
// a temp folder and says what is true on it (`truth`), so a test can check that Meridian says the
// same (journey.test.mjs).
//
//   const m = machine('two-claude-accounts');  // see MACHINES below
//   const b = await launch(urls, { profile: m.profile, args: [...m.args, ...more], env: m.env });
//   ...
//   assert.deepEqual(m.refused(), []);   // no stand-in ever saw a path outside the fixture
//   m.clean();
//
// Everything lives under one root folder: the home (HOME, %USERPROFILE%), the fake system folders
// (a /usr/local/bin and an /opt/homebrew/bin of its own: never the real ones), the profile and a
// project. Meridian is pointed at it with its test switches, set the way its real discovery reads a
// real machine: the login shell's PATH and variables, the account folders, each tool's config file.
//
// The stand-in CLIs behave like the real ones, version by version (`--version`, `auth status` only
// from 2.0, a sign-in an older copy can't read, `mcp add` into the account's own .claude.json,
// sessions per config folder under projects/<slug>/), and refuse to run (exit 97, logged) when they
// see a path outside the fixture: the owner's real home, his CLAUDE_CONFIG_DIR, his project folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP } from './harness.mjs';
import { standIn } from './stand_in.mjs';

export const WIN = process.platform === 'win32';
export const MAC = process.platform === 'darwin';
const EXE = WIN ? '.exe' : '';

// Claude Code's folder name for a project: every character but letters and digits as "-".
export const slugOf = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

// ---- The stand-ins

// What every stand-in does first: refuse anything outside the fixture.
function fence(root, name) {
  // The Meridian it may be told to run (`mcp add … -- <Meridian> --mcp-bridge`), and the private
  // files Meridian makes for one run in the temp folder (meridian-mcp-…).
  const app = WIN ? path.dirname(APP) : APP.includes('.app/') ? APP.slice(0, APP.indexOf('.app/') + 4) : path.dirname(APP);
  const tmp = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
  return `const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = ${JSON.stringify(root)};
const OK = [ROOT, ${JSON.stringify(app)}, '/dev/null', ${JSON.stringify(path.dirname(process.execPath))}];
const TMP = ${JSON.stringify(tmp)};
const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch {} return ${WIN ? 'r.toLowerCase()' : 'r'}; };
const inside = (p, dir) => { const a = norm(p), b = norm(dir); return a === b || a.startsWith(b + path.sep); };
const allowed = (p) => OK.some((d) => inside(p, d)) ||
    TMP.some((t) => inside(p, t) && /^(dev\.meridian\.browser\.)?meridian-/.test(path.relative(norm(t), norm(p)).split(path.sep)[0]));
const seen = [['cwd', process.cwd()]];
for (const v of ['HOME', 'USERPROFILE', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'ZDOTDIR']) {
  if (process.env[v]) seen.push([v, process.env[v]]);
}
for (const a of process.argv.slice(2)) if (path.isAbsolute(a) && !a.includes('\\n')) seen.push(['argument', a]);
const bad = seen.filter(([, p]) => !allowed(p));
if (bad.length) {
  const line = ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ').slice(0, 200) + ' :: ' + bad.map(([w, p]) => w + '=' + p).join(', ');
  try { fs.appendFileSync(path.join(ROOT, 'refused.log'), line + '\\n'); } catch {}
  console.error('stand-in ${name}: refused to run: it was given a path outside the test home (' + bad.map(([w]) => w).join(', ') + ')');
  process.exit(97);
}
const RUNS = path.join(ROOT, 'runs.log');
const run = (what) => fs.appendFileSync(RUNS, JSON.stringify({ cli: ${JSON.stringify(name)}, ...what }) + '\\n');
const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); } return false; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
`;
}

// Claude Code, as version `version` behaves. Its account: CLAUDE_CONFIG_DIR, else ~/.claude (and
// then ~/.claude.json beside it, as Claude Code keeps it). Signed in when that .claude.json has an
// oauthAccount a copy this old can read (a sign-in made by 2.1 is unknown to 2.0).
function claudeJs(root, version) {
  return fence(root, `claude ${version}`) + `
const VERSION = ${JSON.stringify(version)};
const HOME = process.env.HOME || process.env.USERPROFILE;
const CFG = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const STATE = process.env.CLAUDE_CONFIG_DIR ? path.join(CFG, '.claude.json') : path.join(HOME, '.claude.json');
const account = process.env.CLAUDE_CONFIG_DIR ? path.basename(CFG) : '.claude';
const a = process.argv.slice(2);
const state = readJson(STATE);
const signedIn = !!state.oauthAccount && !older(VERSION, state.oauthAccount.signedInWith || '0.0.0');
if (a[0] === '--version' || a[0] === '-v') { console.log(VERSION + ' (Claude Code)'); process.exit(0); }
if (a[0] === 'auth') {
  if (older(VERSION, '2.0.0')) { console.error("error: unknown command 'auth'"); process.exit(1); }
  run({ version: VERSION, account, call: 'auth status' });
  console.log(JSON.stringify(signedIn ? { loggedIn: true, authMethod: 'claude.ai', email: state.oauthAccount.emailAddress } : { loggedIn: false }));
  process.exit(signedIn ? 0 : 1);
}
if (a[0] === 'mcp') {
  run({ version: VERSION, account, call: 'mcp ' + a.slice(1, 2).join(' ') });
  const s = readJson(STATE);
  const local = a.includes('-s') ? a[a.indexOf('-s') + 1] === 'local' : true;
  const holder = local ? ((s.projects ||= {})[process.cwd()] ||= {}) : s;
  if (a[1] === 'add') {
    const at = a.indexOf('--');
    const name = a.slice(2, at).filter((x, i, l) => !x.startsWith('-') && l[i - 1] !== '-s' && l[i - 1] !== '-e')[0];
    (holder.mcpServers ||= {})[name] = { type: 'stdio', command: a[at + 1], args: a.slice(at + 2), env: {} };
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
    console.log('Added stdio MCP server ' + name + ' to ' + (local ? 'local' : 'user') + ' config');
    process.exit(0);
  }
  if (a[1] === 'remove') {
    const name = a.slice(2).find((x, i, l) => !x.startsWith('-') && l[i - 1] !== '-s');
    const had = [s, ...Object.values(s.projects || {})].some((h) => h.mcpServers && h.mcpServers[name] && delete h.mcpServers[name]);
    fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
    process.exit(had ? 0 : 1);
  }
  if (a[1] === 'list' || a[1] === 'get') {
    const all = { ...(s.mcpServers || {}), ...((s.projects || {})[process.cwd()]?.mcpServers || {}) };
    for (const [k, v] of Object.entries(all)) if (a[1] === 'list' || a[2] === k) console.log(k + ': ' + v.command + ' ' + (v.args || []).join(' '));
    process.exit(0);
  }
  process.exit(1);
}
if (a.includes('-p') || a.includes('--print')) {
  // Ask, Improve with AI and the tour's setup: one answer in Claude Code's stream-json.
  let text = a.join(' '); process.stdin.on('data', (d) => { text += d; }); process.stdin.on('end', () => {
    run({ version: VERSION, account, call: 'print', signedIn });
    if (!signedIn) {
      console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }));
      process.exit(1);
    }
    const out = /css/i.test(text)
      ? JSON.stringify({ name: 'Calm', css: '#promo { display: none !important; }', summary: 'Hid the banner.' })
      : 'Answer from Claude Code ' + VERSION + ' (' + account + ')';
    console.log(JSON.stringify({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: out } } }));
    console.log(JSON.stringify({ type: 'result', is_error: false, result: out }));
  });
  return;
}
// Interactive, as in a Workbench tab.
run({ version: VERSION, account, call: 'interactive', args: a.filter((x) => !path.isAbsolute(x)).slice(0, 12) });
console.log('Claude Code v' + VERSION + ' · account ' + account + (signedIn ? '' : ' · not signed in: run /login'));
const r = a.indexOf('--resume');
if (r >= 0 && (!a[r + 1] || a[r + 1].startsWith('-') || path.isAbsolute(a[r + 1]))) {
  // Claude Code's own list: this project's sessions in this account only.
  const dir = path.join(CFG, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  const list = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.jsonl')).map((f) => {
    const first = fs.readFileSync(path.join(dir, f), 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
    return (first.find((e) => e.type === 'summary') || {}).summary || f;
  });
  console.log(list.length ? 'Resume a conversation:\\n' + list.map((t, i) => '  ' + (i + 1) + '. ' + t).join('\\n') : 'No conversations found to resume.');
} else if (r >= 0) {
  console.log('Resumed ' + a[r + 1]);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { for (const line of d.split(/\\r?\\n/)) if (line.trim()) console.log('GOT ' + line.trim()); });
setInterval(() => {}, 1 << 30);
`;
}

// Codex: its home is CODEX_HOME, else ~/.codex; signed in with auth.json there.
function codexJs(root, version) {
  return fence(root, `codex ${version}`) + `
const VERSION = ${JSON.stringify(version)};
const HOME = process.env.HOME || process.env.USERPROFILE;
const CODEX = process.env.CODEX_HOME || path.join(HOME, '.codex');
const account = path.basename(CODEX);
const a = process.argv.slice(2);
const signedIn = fs.existsSync(path.join(CODEX, 'auth.json'));
if (a[0] === '--version' || a[0] === '-V') { console.log('codex-cli ' + VERSION); process.exit(0); }
if (a[0] === 'login' && a[1] === 'status') { console.log(signedIn ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(signedIn ? 0 : 1); }
if (a[0] === 'mcp' && a[1] === 'add') {
  run({ version: VERSION, account, call: 'mcp add' });
  const at = a.indexOf('--');
  const file = path.join(CODEX, 'config.toml');
  let toml = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  toml = toml.replace(/\\n?\\[mcp_servers\\.meridian\\][^[]*/g, '');
  toml += '\\n[mcp_servers.meridian]\\ncommand = ' + JSON.stringify(a[at + 1]) + '\\nargs = ' + JSON.stringify(a.slice(at + 2)) + '\\n';
  fs.mkdirSync(CODEX, { recursive: true });
  fs.writeFileSync(file, toml);
  process.exit(0);
}
if (a[0] === 'exec') {
  let text = ''; process.stdin.on('data', (d) => { text += d; }); process.stdin.on('end', () => {
    run({ version: VERSION, account, call: 'exec', signedIn });
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 't-1' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Answer from Codex ' + VERSION + ' (' + account + ')' } }));
  });
  return;
}
run({ version: VERSION, account, call: 'interactive' });
console.log('OpenAI Codex v' + VERSION + ' · ' + account);
process.stdin.on('data', () => {});
setInterval(() => {}, 1 << 30);
`;
}

// A program installed the way its installer puts it. `how`: 'native' (one file, as Claude Code's
// own installer and Homebrew leave it), or 'npm' (a package in node_modules with the shim npm makes:
// a symlink to the script on macOS and Linux, run through `#!/usr/bin/env node`, so node must be on
// the PATH; on Windows claude.cmd and claude.ps1 in %APPDATA%\npm, and no .exe).
function install(root, dir, name, js, how = 'native') {
  fs.mkdirSync(dir, { recursive: true });
  if (how === 'native') return standIn(dir, name, js);
  const pkg = path.join(dir, ...(WIN ? [] : ['..', 'lib']), 'node_modules', name === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex');
  fs.mkdirSync(pkg, { recursive: true });
  const script = path.join(pkg, 'cli.js');
  fs.writeFileSync(script, `#!/usr/bin/env node\n${js}`, { mode: 0o755 });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: path.basename(pkg), bin: { [name]: 'cli.js' } }));
  if (WIN) {
    const rel = path.relative(dir, script);
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"node" "%dp0%\\${rel}" %*\r\n`);
    fs.writeFileSync(path.join(dir, `${name}.ps1`), `#!/usr/bin/env pwsh\r\n& "node" "$PSScriptRoot/${rel.replace(/\\/g, '/')}" $args\r\nexit $LASTEXITCODE\r\n`);
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nexec node "$(dirname "$0")/${rel.replace(/\\/g, '/')}" "$@"\n`);
    return path.join(dir, `${name}.cmd`);
  }
  const link = path.join(dir, name);
  fs.symlinkSync(path.relative(dir, script), link);
  return link;
}

// A sign-in as the given Claude Code version leaves it in the account's .claude.json.
export function signInClaude(stateFile, { email = 'ada@example.com', version = '2.1.332' } = {}) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  j.oauthAccount = { emailAddress: email, organizationName: 'Ada', signedInWith: version };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(j, null, 2));
}

// Earlier sessions of `project` in a Claude account folder, as Claude Code writes them.
export function claudeSessions(cfg, project, titles) {
  const dir = path.join(cfg, 'projects', slugOf(project));
  fs.mkdirSync(dir, { recursive: true });
  titles.forEach((title, i) => {
    const id = `0000000${i}-aaaa-4bbb-8ccc-${String(Date.now()).slice(-12).padStart(12, '0')}`;
    const at = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
      { type: 'summary', summary: title, leafUuid: id },
      { type: 'user', sessionId: id, cwd: project, timestamp: at, message: { role: 'user', content: title } },
      { type: 'assistant', sessionId: id, cwd: project, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
}

// ---- The machines

// Each: what it is, where it runs, how it is built, and what is true on it.
// truth.claudeCode: null (none) | { version, path, signedIn, account }   (the copy Meridian must use)
// truth.desktop:    null | { config: bool, others: [names] }
// truth.codex:      null | { home, signedIn }
// truth.editor:     null | { vscode: bool, extensions: [...] }
// truth.resume:     titles Resume must list (the account the Workbench runs), and `elsewhere`, the
//                   other account's (listed once Resume looks under every account, ai-subs)
// truth.unstable:   Meridian runs from its disk image: nothing may be connected to that path
export const MACHINES = {
  'native-and-old-on-path': {
    about: 'Claude Code from its own installer in ~/.local/bin (new), and an old npm copy first on the PATH in /usr/local/bin',
    build(m) {
      const fresh = install(m.root, path.join(m.home, '.local', 'bin'), 'claude', claudeJs(m.root, '2.1.332'));
      install(m.root, m.sys('usr/local/bin'), 'claude', claudeJs(m.root, '2.0.14'));
      m.loginPath = [m.sys('usr/local/bin'), path.join(m.home, '.local', 'bin')];
      m.dot('.claude');
      signInClaude(path.join(m.home, '.claude.json'));
      claudeSessions(path.join(m.home, '.claude'), m.project, ['Fix the login redirect', 'Add dark mode']);
      return { claudeCode: { version: '2.1.332', path: fresh, signedIn: true, account: '.claude' }, resume: { titles: ['Fix the login redirect', 'Add dark mode'] } };
    },
  },
  'npm-global': {
    about: WIN ? 'Claude Code and Codex from npm: claude.cmd / codex.cmd in %APPDATA%\\npm, no .exe'
        : 'Claude Code and Codex from npm into ~/.npm-global (a symlinked shim, #!/usr/bin/env node, node from nvm)',
    build(m) {
      const bin = WIN ? path.join(m.home, 'AppData', 'Roaming', 'npm') : path.join(m.home, '.npm-global', 'bin');
      const claude = install(m.root, bin, 'claude', claudeJs(m.root, '2.1.320'), 'npm');
      install(m.root, bin, 'codex', codexJs(m.root, '0.61.0'), 'npm');
      // node where nvm keeps it, on the login PATH as nvm's lines in .zshrc put it.
      const nodeBin = path.join(m.home, '.nvm', 'versions', 'node', 'v22.21.0', 'bin');
      fs.mkdirSync(nodeBin, { recursive: true });
      if (WIN) fs.copyFileSync(process.execPath, path.join(nodeBin, 'node.exe'));
      else fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
      m.loginPath = [nodeBin, bin];
      m.dot('.claude');
      signInClaude(path.join(m.home, '.claude.json'), { version: '2.1.320' });
      fs.mkdirSync(path.join(m.home, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(m.home, '.codex', 'auth.json'), '{"auth_mode":"chatgpt"}');
      claudeSessions(path.join(m.home, '.claude'), m.project, ['Upgrade to React 19']);
      return { claudeCode: { version: '2.1.320', path: claude, signedIn: true, account: '.claude' },
        codex: { home: path.join(m.home, '.codex'), signedIn: true }, resume: { titles: ['Upgrade to React 19'] } };
    },
  },
  'editor-extension-only': {
    about: 'VS Code with the Codex (openai.chatgpt) and GitHub Copilot extensions, no AI CLI anywhere',
    build(m) {
      const ext = path.join(m.home, '.vscode', 'extensions');
      for (const [id, v] of [['openai.chatgpt', '0.5.40-darwin-arm64'], ['github.copilot', '1.388.0'], ['github.copilot-chat', '0.33.2']]) {
        const dir = path.join(ext, `${id}-${v}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: id.split('.')[1], publisher: id.split('.')[0], version: v.split('-')[0] }));
      }
      fs.mkdirSync(m.vscodeUser, { recursive: true });
      fs.writeFileSync(path.join(m.vscodeUser, 'settings.json'), '{}');
      m.loginPath = [];
      return { claudeCode: null, editor: { vscode: true, extensions: ['openai.chatgpt', 'github.copilot'] } };
    },
  },
  'claude-desktop-with-servers': {
    about: 'Claude Desktop set up, with two MCP servers of its own in claude_desktop_config.json; no Claude Code',
    build(m) {
      fs.mkdirSync(path.dirname(m.desktopConfig), { recursive: true });
      fs.writeFileSync(m.desktopConfig, JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', m.project] }, github: { command: 'docker', args: ['run', '-i', 'ghcr.io/github/github-mcp-server'] } }, preferences: { menuBarEnabled: true } }, null, 2));
      m.loginPath = [];
      return { claudeCode: null, desktop: { config: true, others: ['files', 'github'] } };
    },
  },
  'claude-desktop-fresh': {
    about: 'Claude Desktop installed and opened once: its folder, no claude_desktop_config.json yet',
    build(m) {
      fs.mkdirSync(path.dirname(m.desktopConfig), { recursive: true });
      m.loginPath = [];
      return { claudeCode: null, desktop: { config: false, others: [] } };
    },
  },
  'claude-code-signed-out': {
    about: 'Claude Code installed (current), never signed in',
    build(m) {
      const bin = install(m.root, path.join(m.home, '.local', 'bin'), 'claude', claudeJs(m.root, '2.1.332'));
      m.loginPath = [path.join(m.home, '.local', 'bin')];
      m.dot('.claude');
      fs.writeFileSync(path.join(m.home, '.claude.json'), JSON.stringify({ numStartups: 1 }));
      return { claudeCode: { version: '2.1.332', path: bin, signedIn: false, account: '.claude', signInFile: path.join(m.home, '.claude.json') }, resume: { titles: [] } };
    },
  },
  'two-claude-accounts': {
    about: 'Two Claude accounts: CLAUDE_CONFIG_DIR=~/.claude-personal in the login shell, and ~/.claude; sessions of this project in each',
    build(m) {
      const bin = install(m.root, path.join(m.home, '.local', 'bin'), 'claude', claudeJs(m.root, '2.1.332'));
      m.loginPath = [path.join(m.home, '.local', 'bin')];
      const personal = m.dot('.claude-personal');
      m.dot('.claude');
      m.loginEnv.CLAUDE_CONFIG_DIR = personal;
      signInClaude(path.join(personal, '.claude.json'), { email: 'me@example.com' });
      signInClaude(path.join(m.home, '.claude.json'), { email: 'me@work.example' });
      claudeSessions(personal, m.project, ['Personal: refactor the parser', 'Personal: write the README', 'Personal: fix CI']);
      claudeSessions(path.join(m.home, '.claude'), m.project, ['Work: rotate the API keys']);
      return { claudeCode: { version: '2.1.332', path: bin, signedIn: true, account: '.claude-personal' },
        accounts: ['.claude-personal', '.claude'],
        resume: { titles: ['Personal: refactor the parser', 'Personal: write the README', 'Personal: fix CI'], elsewhere: ['Work: rotate the API keys'] } };
    },
  },
  'run-from-disk-image': {
    about: 'Meridian opened straight from its disk image (/Volumes/Meridian) or a translocated download; Claude Code and Desktop here',
    skip: !MAC && 'macOS only (disk images and App Translocation)',
    build(m) {
      const bin = install(m.root, path.join(m.home, '.local', 'bin'), 'claude', claudeJs(m.root, '2.1.332'));
      m.loginPath = [path.join(m.home, '.local', 'bin')];
      m.dot('.claude');
      signInClaude(path.join(m.home, '.claude.json'));
      fs.mkdirSync(path.dirname(m.desktopConfig), { recursive: true });
      fs.writeFileSync(m.desktopConfig, JSON.stringify({ mcpServers: {} }));
      m.args.push('--meridian-test-program=/Volumes/Meridian/Meridian.app/Contents/MacOS/Meridian');
      return { claudeCode: { version: '2.1.332', path: bin, signedIn: true, account: '.claude' }, desktop: { config: true, others: [] }, unstable: true, resume: { titles: [] } };
    },
  },
  'codex-only': {
    about: 'Only Codex (Homebrew), its home moved with CODEX_HOME=~/.codex-work in the login shell',
    build(m) {
      install(m.root, m.sys('opt/homebrew/bin'), 'codex', codexJs(m.root, '0.63.0'));
      m.loginPath = [m.sys('opt/homebrew/bin')];
      const home = m.dot('.codex-work');
      m.loginEnv.CODEX_HOME = home;
      fs.writeFileSync(path.join(home, 'auth.json'), '{"auth_mode":"chatgpt"}');
      fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.1-codex"\n\n[mcp_servers.linear]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "https://mcp.linear.app/sse"]\n');
      return { claudeCode: null, codex: { home, signedIn: true } };
    },
  },
};

// Builds the machine `name`. The result:
//   root, home, profile, project       its folders (profile: pass to launch({ profile }))
//   args                               Meridian's switches that point it at this machine
//   env                                HOME (and on Windows USERPROFILE/APPDATA) of the browser
//   truth                              what is true here (see MACHINES)
//   refused()                          what the stand-ins refused (paths outside the fixture)
//   runs()                             the stand-ins' runs: { cli, version, account, call }
//   clean()
export function machine(name) {
  const spec = MACHINES[name];
  if (!spec) throw new Error(`no machine ${name}`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `meridian-qg-${name.slice(0, 12)}-`)));
  const home = path.join(root, 'home');
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'project');
  for (const d of [home, profile, project]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# A project\n');
  const appSupport = MAC ? path.join(home, 'Library', 'Application Support') : WIN ? path.join(home, 'AppData', 'Roaming') : path.join(home, '.config');
  const m = {
    name, about: spec.about, root, home, profile, project,
    desktopConfig: path.join(appSupport, 'Claude', 'claude_desktop_config.json'),
    vscodeUser: path.join(appSupport, 'Code', 'User'),
    loginPath: [], loginEnv: {}, args: [],
    // A fake system folder ("usr/local/bin") under the root, never the real one.
    sys: (rel) => { const d = path.join(root, 'sys', ...rel.split('/')); fs.mkdirSync(d, { recursive: true }); return d; },
    // A folder in the home (an account's config folder).
    dot: (rel) => { const d = path.join(home, rel); fs.mkdirSync(d, { recursive: true }); return d; },
  };
  m.truth = spec.build(m);
  m.truth.resume ||= { titles: [] };
  const env = Object.entries(m.loginEnv).map(([k, v]) => `${k}=${v}`).join(';');
  m.args = [
    // The login shell's PATH and variables, as Meridian reads them from a real one.
    `--meridian-agents-path=${m.loginPath.join(path.delimiter)}`,
    ...(env ? [`--meridian-test-login-env=${env}`] : []),
    // Where each tool really keeps its files on this system, inside this home.
    `--meridian-accounts-home=${home}`, `--meridian-test-home=${home}`, `--meridian-agent-home=${home}`,
    `--meridian-claude-desktop-config=${m.desktopConfig}`,
    `--meridian-vscode-config=${m.vscodeUser}`, `--meridian-vscode-extensions=${path.join(home, '.vscode', 'extensions')}`,
    `--meridian-copilot-config=${path.join(home, '.copilot')}`,
    `--meridian-opencode-config=${path.join(home, '.config', 'opencode')}`,
    `--meridian-cursor-config=${path.join(home, '.cursor')}`,
    `--meridian-windsurf-config=${path.join(home, '.codeium', 'windsurf')}`,
    `--meridian-goose-config=${path.join(home, '.config', 'goose')}`,
    `--meridian-amp-config=${path.join(home, '.config', 'amp')}`,
    `--meridian-droid-config=${path.join(home, '.factory')}`,
    ...(WIN ? [`--meridian-visualstudio-config=${home}`] : []),
    `--meridian-test-project=${project}`,
    ...m.args,
  ];
  m.env = { HOME: home, ...(WIN ? { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') } : {}) };
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  m.refused = () => lines(path.join(root, 'refused.log'));
  m.runs = () => lines(path.join(root, 'runs.log')).map((l) => JSON.parse(l));
  m.clean = () => { if (!process.env.MERIDIAN_QG_KEEP) fs.rmSync(root, { recursive: true, force: true }); };
  return m;
}

// The machines for this system, as [name, skip-reason-or-false].
export function machinesHere() {
  return Object.entries(MACHINES).map(([name, spec]) => [name, spec.skip || false]);
}
