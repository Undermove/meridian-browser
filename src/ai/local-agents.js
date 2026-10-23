// Local AI agents as chat providers: Claude Code, Codex, Gemini CLI, … run headless with the user's own
// login/subscription, so Ask (⌘T), the ⌘J panel and the Chat view work without an API key.
//
// Every run:
//  - starts the CLI directly (no shell), with the user's login-shell environment (CLAUDE_CONFIG_DIR,
//    CODEX_HOME, proxies… that a GUI app doesn't inherit), in a private empty working directory;
//  - gets the prompt on stdin where the CLI supports it (never in a shell command line);
//  - runs with tools off, or as close to off as the CLI allows (read-only sandbox, no MCP, no user
//    plugins/hooks), because page text in the prompt is untrusted;
//  - is killed on Stop, on a timeout, or when the window goes away.
// Output is parsed per provider into a common stream of events: { delta } / { text } / { session } / { error }.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loginPath, loginEnv, which, IS_WIN } = require('../dev/env');
const { installCommand } = require('./agent-setup');

const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 4 << 20;

// install: what a person runs to get the CLI (shown, copyable, or run in a Workbench terminal after
// confirming). login: the interactive sign-in command, run in a terminal.
const PROVIDERS = {
  claude: {
    label: 'Claude Code', vendor: 'Anthropic', bin: 'claude', stream: true, resume: true,
    plan: 'Claude Pro or Max subscription, or an Anthropic API key',
    install: { mac: 'curl -fsSL https://claude.ai/install.sh | bash', linux: 'curl -fsSL https://claude.ai/install.sh | bash', win: 'irm https://claude.ai/install.ps1 | iex' },
    login: 'claude auth login',
    docs: 'https://docs.claude.com/en/docs/claude-code/setup',
    async auth(bin, env) {
      const r = await run(bin, ['auth', 'status'], env, 8000);
      try { const j = JSON.parse(r.stdout); return { loggedIn: !!j.loggedIn, account: j.email || null }; } catch { return { loggedIn: null }; }
    },
    command({ prompt, system, resume, model }) {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
        '--permission-mode', 'dontAsk'];
      if (system) args.push('--system-prompt', system);
      if (resume) args.push('--resume', resume);
      if (model) args.push('--model', model);
      return { args, stdin: prompt };
    },
    parse: jsonLines((o, emit) => {
      if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && o.event.delta?.type === 'text_delta') emit({ delta: o.event.delta.text });
      else if (o.type === 'system' && o.subtype === 'init' && o.session_id) emit({ session: o.session_id });
      else if (o.type === 'result') {
        if (o.session_id) emit({ session: o.session_id });
        if (o.is_error || (o.subtype && o.subtype !== 'success')) emit({ error: String(o.result || o.subtype || 'Claude Code failed') });
        else emit({ final: String(o.result ?? '') });
      }
    }),
  },

  codex: {
    label: 'Codex', vendor: 'OpenAI', bin: 'codex', stream: false, resume: true,
    plan: 'ChatGPT Plus/Pro/Business plan, or an OpenAI API key',
    install: { mac: [{ cmd: 'brew install --cask codex', needs: 'brew' }, { cmd: 'npm install -g @openai/codex', needs: 'npm' }], linux: [{ cmd: 'npm install -g @openai/codex', needs: 'npm' }], win: [{ cmd: 'npm install -g @openai/codex', needs: 'npm' }] },
    login: 'codex login',
    docs: 'https://developers.openai.com/codex/cli',
    async auth(bin, env) {
      const r = await run(bin, ['login', 'status'], env, 8000);
      const out = `${r.stdout}${r.stderr}`;
      if (/logged in/i.test(out) && !/not logged in/i.test(out)) return { loggedIn: true, account: /ChatGPT/i.test(out) ? 'ChatGPT' : null };
      return { loggedIn: /not logged in/i.test(out) ? false : null };
    },
    // Codex has no "no tools" switch: read-only sandbox (no writes, no network) and an instruction not
    // to run commands. Its answers are shown as text only, so a page can't make it send anything out.
    command({ prompt, system, resume, model }) {
      // `exec resume` has no --sandbox/--color flags; the config override works for both.
      const base = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '--ignore-user-config', '--ignore-rules'];
      if (model) base.push('-m', model);
      const text = system && !resume ? `${system}\n\n${prompt}` : prompt;
      return { args: resume ? ['exec', 'resume', ...base, resume, '-'] : ['exec', ...base, '-'], stdin: text };
    },
    parse: jsonLines((o, emit) => {
      if (o.type === 'thread.started' && o.thread_id) emit({ session: o.thread_id });
      else if (o.type === 'item.completed' && o.item?.type === 'agent_message') emit({ delta: (o.item.text || '') + '\n' });
      else if (o.type === 'error' || o.type === 'turn.failed') emit({ error: String(o.message || o.error?.message || 'Codex failed') });
    }),
  },

  gemini: {
    label: 'Gemini CLI', vendor: 'Google', bin: 'gemini', stream: true, resume: false,
    plan: 'a Google account (free tier) or a Gemini API key',
    install: { mac: [{ cmd: 'brew install gemini-cli', needs: 'brew' }, { cmd: 'npm install -g @google/gemini-cli', needs: 'npm' }], linux: [{ cmd: 'npm install -g @google/gemini-cli', needs: 'npm' }], win: [{ cmd: 'npm install -g @google/gemini-cli', needs: 'npm' }] },
    login: 'gemini',
    docs: 'https://github.com/google-gemini/gemini-cli',
    command({ prompt, system, model }) {
      const args = ['--output-format', 'stream-json', '--approval-mode', 'default', '--allowed-mcp-server-names', '__none__', '--extensions', 'none'];
      if (model) args.push('-m', model);
      // `-p` with an empty value makes Gemini read the prompt from stdin.
      return { args: [...args, '-p', ''], stdin: system ? `${system}\n\n${prompt}` : prompt };
    },
    parse: jsonLines((o, emit) => {
      if (o.type === 'init' && o.session_id) emit({ session: o.session_id });
      else if (o.type === 'message' && o.role === 'assistant' && typeof o.content === 'string') emit({ delta: o.content });
      else if (o.type === 'error') emit({ error: String(o.message || 'Gemini failed') });
      else if (o.type === 'result' && o.status === 'error') emit({ error: String(o.error?.message || 'Gemini failed') });
    }),
  },

  copilot: {
    label: 'GitHub Copilot', vendor: 'GitHub', bin: 'copilot', stream: true, resume: false,
    plan: 'a GitHub Copilot plan (your organization must allow Copilot CLI)',
    install: { mac: [{ cmd: 'brew install copilot-cli', needs: 'brew' }, { cmd: 'npm install -g @github/copilot', needs: 'npm' }], linux: [{ cmd: 'npm install -g @github/copilot', needs: 'npm' }], win: [{ cmd: 'npm install -g @github/copilot', needs: 'npm' }] },
    login: 'copilot',
    docs: 'https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli',
    // No stdin prompt mode: the prompt goes in argv (never through a shell; see spawnSafe for Windows).
    command({ prompt, system, model }) {
      const args = ['-p', system ? `${system}\n\n${prompt}` : prompt, '-s', '--stream', 'on', '--available-tools=',
        '--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user', '--no-auto-update', '--no-color'];
      if (model) args.push('--model', model);
      return { args, stdin: null };
    },
    parse: plainText(),
  },
};

// ---------------------------------------------------------------- output parsers

function jsonLines(onObject) {
  return () => {
    let buf = '';
    return {
      push(chunk, emit) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('{')) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          onObject(o, emit);
        }
      },
      end(emit) { if (buf.trim().startsWith('{')) { try { onObject(JSON.parse(buf.trim()), emit); } catch {} } buf = ''; },
    };
  };
}

function plainText() {
  return () => ({
    push(chunk, emit) { const t = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); if (t) emit({ delta: t }); },
    end() {},
  });
}

// ---------------------------------------------------------------- processes

function run(bin, args, env, timeout) {
  return new Promise((resolve) => {
    const s = spawnSafe(bin, args, { env, cwd: os.homedir() });
    if (!s) return resolve({ code: -1, stdout: '', stderr: 'cannot start' });
    let stdout = '', stderr = '';
    const t = setTimeout(() => s.kill('SIGKILL'), timeout);
    s.stdout.on('data', (d) => { if (stdout.length < 65536) stdout += d; });
    s.stderr.on('data', (d) => { if (stderr.length < 65536) stderr += d; });
    s.on('error', () => {});
    s.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    s.stdin.end();
  });
}

// npm installs CLIs on Windows as .cmd shims, which only run through cmd.exe — and cmd.exe re-parses
// arguments, so a prompt in argv could break out. Run the shim's JavaScript entry point with node
// directly instead; refuse if we can't find it rather than go through cmd.
function resolveWindowsShim(bin) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(bin)) return { file: bin, pre: [] };
  try {
    const txt = fs.readFileSync(bin, 'utf8');
    const m = /"%(?:~)?dp0%?\\?([^"%]+\.(?:c|m)?js)"/i.exec(txt);
    if (m) {
      const script = path.join(path.dirname(bin), m[1]);
      const localNode = path.join(path.dirname(bin), 'node.exe');
      const node = fs.existsSync(localNode) ? localNode : 'node.exe';
      if (fs.existsSync(script)) return { file: node, pre: [script] };
    }
  } catch {}
  return null;
}

function spawnSafe(bin, args, opts) {
  const r = resolveWindowsShim(bin);
  if (!r) return null;
  return spawn(r.file, [...r.pre, ...args], { ...opts, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

class LocalAgents {
  constructor({ userDataDir }) {
    this.base = path.join(userDataDir, 'agent-chat');
    this.runs = new Map();      // runId -> child
    this.cache = null;          // { at, list }
  }

  async env() {
    const env = { ...process.env, ...(await loginEnv()), PATH: await loginPath(), NO_COLOR: '1', CI: '1', TERM: 'dumb' };
    for (const k of Object.keys(env)) if (/^(ELECTRON_|MERIDIAN_|npm_|NODE_OPTIONS$)/i.test(k)) delete env[k];
    return env;
  }

  // A stable, private, empty working directory per provider (Claude Code keys resumable sessions by cwd).
  workdir(id) {
    const dir = path.join(this.base, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch {}
    return dir;
  }

  // Installed? Signed in? Cached for a minute; `fresh` re-checks (after the user installs or signs in).
  async list({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.list;
    const env = await this.env();
    const list = await Promise.all(Object.entries(PROVIDERS).map(async ([id, p]) => {
      const bin = which(p.bin, env.PATH);
      let auth = { loggedIn: null };
      if (bin && p.auth) auth = await p.auth(bin, env).catch(() => ({ loggedIn: null }));
      return {
        id, label: p.label, vendor: p.vendor, plan: p.plan, installed: !!bin, loggedIn: auth.loggedIn, account: auth.account || null,
        install: installCommand(p, env.PATH), login: p.login, docs: p.docs, streams: p.stream,
      };
    }));
    this.cache = { at: Date.now(), list };
    return list;
  }

  stop(runId) {
    const c = this.runs.get(runId);
    if (c) { try { c.kill(IS_WIN ? undefined : 'SIGTERM'); setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 1500); } catch {} }
  }

  // onEvent({ delta } | { session } | { done, text } | { error }) — always ends with done or error.
  async chat(runId, { provider, prompt, system = '', resume = null, model = null }, onEvent) {
    const p = PROVIDERS[provider];
    if (!p) return onEvent({ error: 'Unknown AI agent.' });
    const env = await this.env();
    const bin = which(p.bin, env.PATH);
    if (!bin) return onEvent({ error: `${p.label} isn’t installed. Set it up in Settings → AI.`, code: 'not-installed' });
    const { args, stdin } = p.command({ prompt, system, resume: p.resume ? resume : null, model });
    const child = spawnSafe(bin, args, { env, cwd: this.workdir(provider) });
    if (!child) return onEvent({ error: `Couldn’t start ${p.label}.` });
    this.runs.set(runId, child);
    const parser = p.parse();
    let text = '', finalText = null, stderr = '', size = 0, failed = null, finished = false;
    const emit = (ev) => {
      if (ev.delta) { text += ev.delta; onEvent({ delta: ev.delta }); }
      else if (ev.final != null) finalText = ev.final;
      else if (ev.session) onEvent({ session: ev.session });
      else if (ev.error) failed = ev.error;
    };
    const timer = setTimeout(() => { failed = `${p.label} took too long to answer.`; this.stop(runId); }, RUN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { size += d.length; if (size > MAX_OUTPUT) { failed = 'The answer was too long.'; this.stop(runId); return; } parser.push(d, emit); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += d; });
    child.on('error', (err) => { failed = err.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      this.runs.delete(runId);
      if (finished) return;
      finished = true;
      parser.end(emit);
      // Non-streaming CLIs (or a stream that only had the final result) still produce the answer.
      if (!text && finalText) { text = finalText; onEvent({ delta: finalText }); }
      if (signal && !failed) return onEvent({ done: true, stopped: true, text });
      if (failed) return onEvent({ error: friendlyError(p, failed, stderr), text });
      if (code !== 0 && !text) return onEvent({ error: friendlyError(p, '', stderr) });
      onEvent({ done: true, text: text.trim() });
    });
    if (stdin != null) child.stdin.end(stdin); else child.stdin.end();
  }
}

function friendlyError(p, msg, stderr) {
  const all = `${msg}\n${stderr}`;
  if (/not logged in|log in|login|unauthori[sz]ed|authenticat|401|credentials/i.test(all)) return `${p.label} isn’t signed in. Open Settings → AI and click Sign in.`;
  if (/policy|access denied/i.test(all)) return `${p.label} is blocked by your organization’s policy.`;
  if (/rate.?limit|429|usage limit|quota/i.test(all)) return `${p.label} hit a usage limit. Try again later or pick another agent.`;
  const line = (msg || stderr).split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || 'Something went wrong.';
  return `${p.label}: ${line.slice(0, 300)}`;
}

module.exports = { LocalAgents, PROVIDERS, jsonLines, resolveWindowsShim };
