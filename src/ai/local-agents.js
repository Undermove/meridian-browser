// Local AI agents as chat providers for Ask (⌘T), the ⌘J panel, Chat and the welcome tour.
//
// Only where the provider's terms allow it (checked October 2026):
//  - policy 'default': fine for an app to use on the user's own account — GitHub Copilot (its official SDK
//    drives the signed-in CLI the same way), and local model servers (Ollama, LM Studio).
//  - policy 'optin': no explicit rule either way; shown only after the user turns on "Other agents" in
//    Settings → AI, labelled as running under their own account and that provider's terms.
// Claude Code and Gemini CLI aren't here on purpose: Anthropic and Google don't allow third-party apps to
// run their features on a consumer subscription login. Claude works through an API key (the 'api'
// provider in assistant.js); both CLIs remain available in the Workbench terminal, where the user runs them.
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
  codex: {
    label: 'Codex', vendor: 'OpenAI', bin: 'codex', stream: false, resume: true, policy: 'optin',
    plan: 'ChatGPT Plus/Pro/Business plan, or an OpenAI API key',
    install: { mac: [{ cmd: 'brew install --cask codex', needs: 'brew' }, { cmd: 'npm install -g @openai/codex', needs: 'npm' }], linux: [{ cmd: 'npm install -g @openai/codex', needs: 'npm' }], win: [{ cmd: 'npm install -g @openai/codex', needs: 'npm' }] },
    login: 'codex login',
    docs: 'https://developers.openai.com/codex/cli',
    async auth(bin, env) {
      const r = await run(bin, ['login', 'status'], env, 4000);
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

  copilot: {
    label: 'GitHub Copilot', vendor: 'GitHub', bin: 'copilot', stream: true, resume: false, policy: 'default',
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

  cursor: {
    label: 'Cursor', vendor: 'Anysphere', bin: 'cursor-agent', altBins: ['agent'], stream: true, resume: true, policy: 'optin',
    plan: 'a Cursor plan',
    install: { mac: 'curl https://cursor.com/install -fsS | bash', linux: 'curl https://cursor.com/install -fsS | bash', win: null },
    login: 'cursor-agent login',
    docs: 'https://cursor.com/docs/cli/overview',
    async auth(bin, env) {
      const r = await run(bin, ['status'], env, 4000);
      const out = `${r.stdout}${r.stderr}`;
      if (/not logged in|log in|login required/i.test(out)) return { loggedIn: false };
      const m = /logged in(?: as)?\s+([^\s]+@[^\s]+)/i.exec(out);
      return { loggedIn: /logged in/i.test(out) ? true : null, account: m ? m[1] : null };
    },
    // "ask" mode is Cursor's read-only Q&A; prompt goes in argv (no documented stdin).
    command({ prompt, system, resume, model }, cwd) {
      const args = ['-p', system && !resume ? `${system}\n\n${prompt}` : prompt, '--output-format', 'stream-json', '--stream-partial-output',
        '--mode', 'ask', '--trust', '--workspace', cwd];
      if (resume) args.push('--resume', resume);
      if (model) args.push('--model', model);
      return { args, stdin: null };
    },
    // With partial output, a delta is an assistant event with timestamp_ms and no model_call_id; the others
    // repeat text already sent.
    parse: jsonLines((o, emit) => {
      if (o.session_id && (o.type === 'system' || o.type === 'result')) emit({ session: o.session_id });
      if (o.type === 'assistant' && o.timestamp_ms && !o.model_call_id) {
        for (const c of o.message?.content || []) if (c.type === 'text' && c.text) emit({ delta: c.text });
      } else if (o.type === 'result') {
        if (o.is_error) emit({ error: String(o.result || 'Cursor failed') }); else emit({ final: String(o.result ?? '') });
      }
    }),
  },

  opencode: {
    label: 'OpenCode', vendor: 'SST', bin: 'opencode', stream: false, resume: true, policy: 'optin',
    plan: 'any provider you set up in OpenCode (Claude, ChatGPT, Copilot, local models…)',
    install: { mac: [{ cmd: 'brew install opencode', needs: 'brew' }, { cmd: 'curl -fsSL https://opencode.ai/install | bash' }], linux: 'curl -fsSL https://opencode.ai/install | bash', win: [{ cmd: 'npm install -g opencode-ai', needs: 'npm' }] },
    login: 'opencode auth login',
    docs: 'https://opencode.ai/docs/cli',
    async auth(bin, env) {
      const r = await run(bin, ['auth', 'list'], env, 4000);
      const m = /(\d+)\s+credentials?/i.exec(r.stdout.replace(/\x1b\[[0-9;]*m/g, ''));
      return { loggedIn: m ? Number(m[1]) > 0 : null };
    },
    // Every permission denied, no project config / Claude Code files / plugins; prompt on stdin.
    command({ prompt, system, resume, model }, cwd) {
      const config = { permission: { '*': 'deny' }, ...(system ? { agent: { meridian: { prompt: system, mode: 'primary' } } } : {}) };
      const args = ['run', '--format', 'json', '--dir', cwd];
      if (system) args.push('--agent', 'meridian');
      if (resume) args.push('--session', resume);
      if (model) args.push('-m', model);
      return { args, stdin: prompt, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' } };
    },
    parse: jsonLines((o, emit) => {
      if (o.sessionID) emit({ session: o.sessionID });
      if (o.type === 'text' && o.part?.text) emit({ delta: o.part.text + '\n' });
      else if (o.type === 'error') emit({ error: String(o.error?.data?.message || o.error?.message || 'OpenCode failed') });
    }),
  },

  qwen: {
    label: 'Qwen Code', vendor: 'Alibaba', bin: 'qwen', stream: true, resume: true, policy: 'optin',
    plan: 'a free Qwen account or an API key',
    install: { mac: [{ cmd: 'brew install qwen-code', needs: 'brew' }, { cmd: 'npm install -g @qwen-code/qwen-code@latest', needs: 'npm' }], linux: [{ cmd: 'npm install -g @qwen-code/qwen-code@latest', needs: 'npm' }], win: [{ cmd: 'npm install -g @qwen-code/qwen-code@latest', needs: 'npm' }] },
    login: 'qwen',
    docs: 'https://github.com/QwenLM/qwen-code',
    // Same stream format as Claude Code. Plan mode is read-only; safe mode drops MCP, hooks, extensions.
    command({ prompt, system, resume, model }) {
      const args = ['-p', '', '-o', 'stream-json', '--include-partial-messages', '--approval-mode', 'plan', '--safe-mode'];
      if (system) args.push('--system-prompt', system);
      if (resume) args.push('--resume', resume);
      if (model) args.push('-m', model);
      return { args, stdin: prompt };
    },
    parse: jsonLines((o, emit) => {
      if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && o.event.delta?.type === 'text_delta') emit({ delta: o.event.delta.text });
      else if (o.type === 'system' && o.session_id) emit({ session: o.session_id });
      else if (o.type === 'result') {
        if (o.session_id) emit({ session: o.session_id });
        if (o.is_error) emit({ error: String(o.error?.message || o.result || 'Qwen Code failed') }); else emit({ final: String(o.result ?? '') });
      }
    }),
  },

  amp: {
    label: 'Amp', vendor: 'Sourcegraph', bin: 'amp', stream: false, resume: false, policy: 'optin',
    plan: 'an Amp account',
    install: { mac: 'curl -fsSL https://ampcode.com/install.sh | bash', linux: 'curl -fsSL https://ampcode.com/install.sh | bash', win: [{ cmd: 'npm install -g @sourcegraph/amp', needs: 'npm' }] },
    login: 'amp login',
    docs: 'https://ampcode.com/manual',
    // An isolated settings file turns every tool off.
    command({ prompt, system }) {
      return { args: ['-x', '--stream-json', '--settings-file', 'amp-settings.json'], stdin: system ? `${system}\n\n${prompt}` : prompt,
        files: { 'amp-settings.json': JSON.stringify({ 'amp.tools.disable': ['*'], 'amp.mcpServers': {} }) } };
    },
    parse: jsonLines((o, emit) => {
      if (o.session_id && o.type === 'system') emit({ session: o.session_id });
      if (o.type === 'assistant') { for (const c of o.message?.content || []) if (c.type === 'text' && c.text) emit({ delta: c.text }); }
      else if (o.type === 'result' && o.is_error) emit({ error: String(o.error || o.result || 'Amp failed') });
      else if (o.type === 'system' && o.subtype === 'error_during_execution') emit({ error: String(o.error || 'Amp failed') });
    }),
  },

  goose: {
    label: 'Goose', vendor: 'Block', bin: 'goose', stream: true, resume: false, policy: 'optin',
    plan: 'any provider you set up in Goose',
    install: { mac: [{ cmd: 'brew install block-goose-cli', needs: 'brew' }, { cmd: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash' }], linux: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash', win: null },
    login: 'goose configure',
    docs: 'https://block.github.io/goose/',
    // No profile and no built-ins = no extensions or MCP tools.
    command({ prompt, system, model }) {
      const args = ['run', '-i', '-', '--output-format', 'stream-json', '--no-profile', '--no-session', '--quiet'];
      if (system) args.push('--system', system);
      if (model) args.push('--model', model);
      return { args, stdin: prompt };
    },
    parse: jsonLines((o, emit) => {
      if (o.type === 'message' && o.message?.role === 'assistant') { for (const c of o.message.content || []) if (c.type === 'text' && c.text) emit({ delta: c.text }); }
      else if (o.type === 'error') emit({ error: String(o.error || 'Goose failed') });
    }),
  },

  droid: {
    label: 'Droid', vendor: 'Factory', bin: 'droid', stream: false, resume: true, policy: 'optin',
    plan: 'a Factory account',
    install: { mac: 'curl -fsSL https://app.factory.ai/cli | sh', linux: 'curl -fsSL https://app.factory.ai/cli | sh', win: [{ cmd: 'npm install -g droid', needs: 'npm' }] },
    login: 'droid',
    docs: 'https://docs.factory.ai/cli/droid-exec/overview',
    // exec is read-only by default; drop the shell tool too.
    command({ prompt, system, resume, model }, cwd) {
      const args = ['exec', '-o', 'json', '--remove-tools', 'Execute', '--cwd', cwd];
      if (system) args.push('--append-system-prompt', system);
      if (resume) args.push('-s', resume);
      if (model) args.push('-m', model);
      return { args, stdin: prompt };
    },
    parse: jsonLines((o, emit) => {
      if (o.type === 'result') {
        if (o.session_id) emit({ session: o.session_id });
        if (o.is_error) emit({ error: String(o.result || 'Droid failed') }); else emit({ final: String(o.result ?? '') });
      }
    }),
  },

  // Local models over HTTP: nothing to sign in to; "installed" = the server answers and has a model.
  ollama: {
    label: 'Ollama', vendor: 'local models', http: { base: 'http://127.0.0.1:11434', kind: 'ollama' }, stream: true, resume: false, policy: 'default',
    plan: 'models running on this computer, free and private',
    install: { mac: [{ cmd: 'brew install ollama && brew services start ollama && ollama pull llama3.2', needs: 'brew' }], linux: 'curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2', win: null },
    login: null,
    docs: 'https://ollama.com/download',
  },
  lmstudio: {
    label: 'LM Studio', vendor: 'local models', http: { base: 'http://127.0.0.1:1234', kind: 'openai' }, stream: true, resume: false, policy: 'default',
    plan: 'models running on this computer, free and private',
    install: { mac: null, linux: null, win: null },
    login: null,
    docs: 'https://lmstudio.ai/docs/app',
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
    const login = await loginEnv(); // first, so loginPath() reuses the same shell
    const env = { ...process.env, ...login, PATH: await loginPath(), NO_COLOR: '1', CI: '1', TERM: 'dumb' };
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

  // The CLI's path. Cursor also installs itself as `agent`, a name other tools use too, so that one
  // only counts when it really is Cursor's.
  findBin(p, searchPath) {
    const direct = which(p.bin, searchPath);
    if (direct) return direct;
    for (const alt of p.altBins || []) {
      const b = which(alt, searchPath);
      try { if (b && /cursor/i.test(fs.realpathSync(b))) return b; } catch {}
    }
    return null;
  }

  // Installed? Signed in? Cached for a minute; `fresh` re-checks (after the user installs or signs in).
  async list({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.list;
    const env = await this.env();
    const list = await Promise.all(Object.entries(PROVIDERS).map(async ([id, p]) => {
      if (p.http) {
        const models = await httpModels(p.http).catch(() => null);
        return { id, policy: p.policy, label: p.label, vendor: p.vendor, plan: p.plan, installed: !!models?.length, loggedIn: models?.length ? true : null, account: models?.[0] || null,
          install: installCommand(p, env.PATH), login: null, docs: p.docs, streams: true, local: true, running: models != null };
      }
      const bin = this.findBin(p, env.PATH);
      let auth = { loggedIn: null };
      if (bin && p.auth) auth = await p.auth(bin, env).catch(() => ({ loggedIn: null }));
      return {
        id, policy: p.policy, label: p.label, vendor: p.vendor, plan: p.plan, installed: !!bin, loggedIn: auth.loggedIn, account: auth.account || null,
        install: installCommand(p, env.PATH), login: p.login, docs: p.docs, streams: p.stream,
      };
    }));
    this.cache = { at: Date.now(), list };
    return list;
  }

  stop(runId) {
    const c = this.runs.get(runId);
    if (c) { try { c.kill(IS_WIN ? undefined : 'SIGTERM'); if (c.pid) setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 1500); } catch {} }
  }

  // onEvent({ delta } | { session } | { done, text } | { error }) — always ends with done or error.
  async chat(runId, { provider, prompt, system = '', resume = null, model = null }, onEvent) {
    const p = PROVIDERS[provider];
    if (!p) return onEvent({ error: 'Unknown AI agent.' });
    if (p.http) return this.httpChat(runId, p, { prompt, system, model }, onEvent);
    const env = await this.env();
    const bin = this.findBin(p, env.PATH);
    if (!bin) return onEvent({ error: `${p.label} isn’t installed. Set it up in Settings → AI.`, code: 'not-installed' });
    const cwd = this.workdir(provider);
    const spec = p.command({ prompt, system, resume: p.resume ? resume : null, model }, cwd);
    const { args, stdin } = spec;
    for (const [name, content] of Object.entries(spec.files || {})) fs.writeFileSync(path.join(cwd, name), content, { mode: 0o600 });
    const child = spawnSafe(bin, args, { env: { ...env, ...(spec.env || {}) }, cwd });
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

// ---------------------------------------------------------------- local model servers (Ollama, LM Studio)

async function httpModels({ base, kind }) {
  const r = await fetch(base + (kind === 'ollama' ? '/api/tags' : '/v1/models'), { signal: AbortSignal.timeout(1200) });
  if (!r.ok) return null;
  const j = await r.json();
  return kind === 'ollama' ? (j.models || []).map((m) => m.name) : (j.data || []).map((m) => m.id);
}

LocalAgents.prototype.httpChat = async function httpChat(runId, p, { prompt, system, model }, onEvent) {
  const { base, kind } = p.http;
  const models = await httpModels(p.http).catch(() => null);
  if (!models) return onEvent({ error: `${p.label} isn’t running. Start it, then try again.` });
  const use = model && models.includes(model) ? model : models[0];
  if (!use) return onEvent({ error: `${p.label} has no models yet. Download one first.` });
  const abort = new AbortController();
  this.runs.set(runId, { kill: () => abort.abort() });
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  let text = '';
  try {
    const r = await fetch(base + (kind === 'ollama' ? '/api/chat' : '/v1/chat/completions'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: JSON.stringify({ model: use, messages, stream: true }),
    });
    if (!r.ok) throw new Error(`${p.label}: HTTP ${r.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (kind === 'openai') { if (!line.startsWith('data:')) continue; line = line.slice(5).trim(); if (line === '[DONE]') continue; }
        if (!line.startsWith('{')) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) throw new Error(String(o.error.message || o.error));
        const d = kind === 'ollama' ? o.message?.content : o.choices?.[0]?.delta?.content;
        if (d) { text += d; onEvent({ delta: d }); }
      }
    }
    onEvent({ done: true, text: text.trim() });
  } catch (err) {
    if (abort.signal.aborted) onEvent({ done: true, stopped: true, text });
    else onEvent({ error: err.message || `${p.label} failed` });
  } finally { this.runs.delete(runId); }
};

function friendlyError(p, msg, stderr) {
  const all = `${msg}\n${stderr}`;
  if (/not logged in|log in|login|unauthori[sz]ed|authenticat|401|credentials/i.test(all)) return `${p.label} isn’t signed in. Open Settings → AI and click Sign in.`;
  if (/policy|access denied/i.test(all)) return `${p.label} is blocked by your organization’s policy.`;
  if (/rate.?limit|429|usage limit|quota/i.test(all)) return `${p.label} hit a usage limit. Try again later or pick another agent.`;
  const line = (msg || stderr).split('\n').map((l) => l.trim()).filter(Boolean).slice(-1)[0] || 'Something went wrong.';
  return `${p.label}: ${line.slice(0, 300)}`;
}

module.exports = { LocalAgents, PROVIDERS, jsonLines, resolveWindowsShim };
