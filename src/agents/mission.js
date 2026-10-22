// Mission Control — a live picture of every agent working with Meridian (main process).
//
// Sources
//  - Claude Code sessions started from the Workbench (local and Docker sandbox): lifecycle hooks
//    installed per session through the session's own --settings file (merged with the secret guard's
//    hook, never replacing it). Subagents come from Agent/Task tool calls + SubagentStart/Stop, and
//    tool calls made inside a subagent carry its agent_id, so nested subagents nest here too.
//  - Codex sessions: process status from the terminal, plus Codex's per-session `notify` program
//    (turn finished) set with a `-c notify=[…]` override.
//  - MCP clients driving the browser through the agent hub (each bridge process = one node; when the
//    bridge was started by a Workbench session it nests under that session).
//  - The built-in ⌘J assistant: one node per chat, with its browser tool calls.
//
// Privacy: nodes hold labels, statuses and short redacted summaries (see redact.js); never tool
// inputs, outputs, prompts or page text. Finished sessions go to a short history; only a summary
// (label, kind, project name, times, counts, final status) is written to disk.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Notification } = require('electron');
const { EventChannel } = require('./channel');
const { clean } = require('./redact');

const HOOK_SCRIPT = path.join(__dirname, 'hooks', 'mission-hook.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const WORKING = new Set(['starting', 'thinking', 'tool']);
const LOG_MAX = 30;
const HISTORY_MAX = 40;
const LIVE_MAX = 300;
const SUBTREE_MAX = 100;        // subagent nodes one session may create (hooks are agent-controlled)
const NOTIFY_GAP_MS = 15_000;   // at most one "waiting" notification per session in this window
const LINGER_MS = 20_000;       // finished sessions stay in the live tree this long
const MCP_IDLE_MS = 10 * 60_000; // an MCP client with no calls for this long is considered gone
const ASSISTANT_IDLE_MS = 3 * 60_000;
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const now = () => Date.now();
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ''; } };

// --- hook settings for one Claude Code session ---------------------------------------------------

function claudeHookSettings(command) {
  const hook = { type: 'command', command, timeout: 5, async: true };
  const hooks = {};
  for (const ev of CLAUDE_EVENTS) hooks[ev] = [TOOL_EVENTS.has(ev) ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }];
  return { hooks };
}

// Merge Claude Code settings objects: hook lists are concatenated per event, so the secret guard's
// blocking PreToolUse hook and our async observer hook both run.
function mergeClaudeSettings(...parts) {
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'hooks') {
        out.hooks ||= {};
        for (const [ev, list] of Object.entries(v || {})) out.hooks[ev] = [...(out.hooks[ev] || []), ...(Array.isArray(list) ? list : [])];
      } else out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Short safe summary of a browser tool call (MCP / assistant). Never typed text or code.
function browserSummary(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'open_tab': case 'navigate': return hostOf(i.url) || (typeof i.url === 'string' ? i.url.slice(0, 60) : '');
    case 'type_text': return `${typeof i.value === 'string' ? i.value.length : 0} characters${i.submit ? ' + Enter' : ''}`;
    case 'click': return i.element_index !== undefined ? `element #${i.element_index}` : typeof i.text === 'string' ? `“${i.text.slice(0, 40)}”` : i.selector ? 'selector' : '';
    case 'search_tabs': case 'search_history': return typeof i.query === 'string' ? `“${i.query.slice(0, 50)}”` : '';
    case 'press_key': return String(i.key || '').slice(0, 20);
    case 'scroll': return String(i.direction || '');
    case 'history_nav': return String(i.action || '');
    case 'organize_tab': return String(i.action || '').replace(/_/g, ' ');
    case 'create_space': return typeof i.name === 'string' ? i.name.slice(0, 40) : '';
    case 'run_javascript': return `${typeof i.code === 'string' ? i.code.length : 0} chars of JavaScript`;
    case 'wait_for': return i.text ? `“${String(i.text).slice(0, 30)}”` : i.selector ? 'selector' : '';
    default: return '';
  }
}

class MissionControl {
  constructor({ app, getMainWindow, getSettings, secretValues }) {
    this.app = app;
    this.getMainWindow = getMainWindow;
    this.getSettings = getSettings || (() => ({}));
    this.secretValues = secretValues || (() => []);
    this.nodes = new Map();       // id -> node
    this.history = [];
    this.historyFile = path.join(app.getPath('userData'), 'mission-history.json');
    this.terminals = new Map();   // token -> { nodeId, root }
    this.tokenHashes = new Map(); // sha256(token)[0..16] -> nodeId (links MCP bridges to their session)
    this.calls = new Map();       // hub call id -> { nodeId, logEntry }
    this.notified = [];           // dev/test: notifications that would have been shown
    this.lastNotify = new Map();  // root id -> time of its last waiting notification
    this.quiet = !app.isPackaged && (process.env.MERIDIAN_E2E_NO_FOCUS === '1' || !!process.env.MERIDIAN_SHOT || process.env.MERIDIAN_NO_NOTIFY === '1');
    this.channel = new EventChannel({ onEvent: (session, ev) => this.onHookEvent(session, ev) });
    this.loadHistory();
    this.sweepTimer = setInterval(() => this.sweep(), 5000);
    this.sweepTimer.unref?.();
  }

  hookScript() { return fs.existsSync(HOOK_SCRIPT) ? HOOK_SCRIPT : null; }
  hookScriptSource() { try { return fs.readFileSync(HOOK_SCRIPT, 'utf8'); } catch { return null; } }

  // ---------- Workbench terminals ----------

  // Before the agent starts: a node + a channel token. kind: 'claude' | 'codex' | 'gemini' |
  // 'sandbox-claude' | 'sandbox-codex'. Returns { token, nodeId, env }.
  async registerTerminal({ kind, project, ownerWcId, sandbox = false }) {
    const base = kind.replace(/^sandbox-/, '');
    const id = `term-${crypto.randomBytes(6).toString('hex')}`;
    const node = this.addNode({
      id, parentId: null, kind: 'session', source: base, where: sandbox ? 'sandbox' : 'local',
      label: { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }[base] || base,
      project: clean(project, 60), status: 'starting', ownerWcId,
    });
    let token = null;
    const env = {};
    if (base === 'claude' || base === 'codex') {
      token = this.channel.register({ nodeId: id, kind: base });
      this.terminals.set(token, { nodeId: id });
      this.tokenHashes.set(crypto.createHash('sha256').update(token).digest('hex').slice(0, 32), id);
      env.MERIDIAN_MISSION_TOKEN = token;
      if (!sandbox) {
        try { await this.channel.start(); env.MERIDIAN_MISSION_SOCKET = this.channel.socketPath; } catch { /* the session just has process-level status */ }
      }
    }
    if (base === 'gemini') node.statusText = 'Running · no live status';
    this.changed();
    return { token, nodeId: id, env, node };
  }

  // Claude Code --settings fragment for a local session (null if node/script can't be quoted safely).
  claudeSettingsFor(nodePath) {
    const script = this.hookScript();
    if (!nodePath || !script) return null;
    if (/["`$\\\n\r]/.test(nodePath + script) && process.platform !== 'win32') return null;
    if (/["\n\r]/.test(nodePath + script)) return null;
    return claudeHookSettings(`"${nodePath}" "${script}"`);
  }

  // Codex `-c notify=[…]` value (TOML array; JSON string escaping is valid TOML).
  codexNotifyArg(nodePath) {
    const script = this.hookScript();
    if (!nodePath || !script) return null;
    return `notify=[${[nodePath, script, '--codex'].map((s) => JSON.stringify(s)).join(', ')}]`;
  }

  // Docker sandbox: a per-session dir (mounted at /meridian) holding a copy of the hook script, the
  // Claude settings and the append-only events file, all private to this user (0700/0600). Docker
  // Desktop and OrbStack map container writes to the host user; on Linux that only holds when the
  // container user (uid 1000) is us, so other Linux hosts get no hooks (never a world-writable file).
  sandboxMount(token, kind) {
    if (!token) return null;
    if (process.platform === 'linux' && process.getuid?.() !== 1000) return null;
    const src = this.hookScriptSource();
    if (!src) return null;
    const dir = this.channel.tailDir(token);
    fs.writeFileSync(path.join(dir, 'mission-hook.js'), src, { mode: 0o600 });
    const out = { dir, target: '/meridian', env: { MERIDIAN_MISSION_FILE: '/meridian/events.jsonl' }, args: [] };
    if (kind === 'sandbox-claude') {
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(claudeHookSettings('node /meridian/mission-hook.js'), null, 2), { mode: 0o600 });
      out.args = ['--settings', '/meridian/settings.json'];
    } else if (kind === 'sandbox-codex') {
      out.args = ['-c', 'notify=["node", "/meridian/mission-hook.js", "--codex"]'];
    }
    return out;
  }

  attachTerminal(token, termId, nodeId) {
    const node = this.nodes.get(nodeId || this.terminals.get(token)?.nodeId);
    if (!node) return;
    node.termId = String(termId);
    if (node.source === 'codex' && node.status === 'starting') { node.status = 'idle'; node.statusText = 'Ready'; }
    this.changed();
  }

  // The user typed into the agent's terminal. Codex has no per-tool hooks: Enter starts a turn.
  terminalInput(nodeId, data) {
    const node = this.nodes.get(nodeId);
    if (!node || node.endedAt || typeof data !== 'string') return;
    if (!data.includes('\r')) return;
    if (node.source === 'codex' && node.status !== 'thinking') { this.setStatus(node, 'thinking', 'Working'); this.changed(); }
    if (node.status === 'waiting' && node.source === 'claude') { this.setStatus(node, 'thinking'); this.changed(); }
  }

  terminalExit(token, nodeId, { code = 0, killed = false } = {}) {
    const node = this.nodes.get(nodeId || this.terminals.get(token)?.nodeId);
    if (token) { this.channel.unregister(token); this.terminals.delete(token); for (const [h, id] of this.tokenHashes) if (id === node?.id) this.tokenHashes.delete(h); }
    if (!node || node.endedAt) return;
    const ok = killed || !code;
    this.finish(node, ok ? 'done' : 'error', ok ? (killed ? 'Stopped' : 'Exited') : `Exited with code ${code}`);
  }

  // A terminal that turned out not to be an agent session (the sandbox image build runs first).
  discard(token, nodeId) {
    if (token) { this.channel.unregister(token); this.terminals.delete(token); }
    for (const [h, id] of this.tokenHashes) if (id === nodeId) this.tokenHashes.delete(h);
    if (nodeId && this.nodes.delete(nodeId)) this.changed();
  }

  // ---------- Claude Code / Codex hook events ----------

  onHookEvent(session, raw) {
    const root = this.nodes.get(session.nodeId);
    if (!root || root.endedAt) return;
    const sv = this.secretValues(root);
    const s = (v, n = 60) => (typeof v === 'string' ? clean(v, n, sv) : null);
    const ev = {
      event: typeof raw.event === 'string' ? raw.event.slice(0, 40) : '',
      agentId: typeof raw.agent_id === 'string' ? raw.agent_id.slice(0, 80) : null,
      agentType: s(raw.agent_type, 40), tool: s(raw.tool, 80), toolUseId: typeof raw.tool_use_id === 'string' ? raw.tool_use_id.slice(0, 80) : null,
      summary: s(raw.summary, 140), description: s(raw.description, 100), subagentType: s(raw.subagent_type, 40),
      message: s(raw.message, 160), notificationType: s(raw.notification_type, 30), model: s(raw.model, 40), reason: s(raw.reason, 30),
      source: s(raw.source, 20), error: raw.error === true, background: raw.background === true, cwdName: s(raw.cwd_name, 60),
    };
    if (session.kind === 'codex') return this.onCodexEvent(root, ev);
    root.lastEventAt = now();
    if (!root.project && ev.cwdName) root.project = ev.cwdName;
    const target = (ev.agentId && this.subagentFor(root, ev.agentId)) || root;

    switch (ev.event) {
      case 'SessionStart':
        if (ev.model) root.sublabel = ev.model;
        if (root.status === 'starting' || root.status === 'done') this.setStatus(root, 'idle', 'Ready');
        break;
      case 'UserPromptSubmit':
        this.setStatus(root, 'thinking');
        break;
      case 'PreToolUse': {
        target.toolCalls++;
        target.tool = { name: ev.tool || 'tool', summary: ev.summary };
        this.setStatus(target, 'tool');
        this.log(target, { id: ev.toolUseId, name: ev.tool, summary: ev.summary });
        if (SPAWN_TOOLS.has(ev.tool)) {
          const child = this.addNode({
            id: `${root.id}~spawn~${ev.toolUseId || crypto.randomBytes(4).toString('hex')}`, parentId: target.id, rootId: root.id, kind: 'subagent', source: 'claude',
            where: root.where, label: ev.description || ev.subagentType || 'Subagent', sublabel: ev.subagentType, project: root.project,
            status: 'starting', statusText: ev.background ? 'Starting in background' : 'Starting', toolUseId: ev.toolUseId, subagentType: ev.subagentType, ownerWcId: root.ownerWcId, termId: root.termId,
          });
          if (child) child.pending = true;
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const entry = target.log.find((l) => l.id && l.id === ev.toolUseId) || target.log.find((l) => l.ok === null && l.name === ev.tool);
        if (entry) entry.ok = !ev.error;
        if (ev.error) target.errors++;
        target.tool = null;
        if (target.status === 'tool' || target.status === 'waiting') this.setStatus(target, 'thinking');
        if (SPAWN_TOOLS.has(ev.tool)) {
          const child = this.findChild(root, (n) => n.toolUseId && n.toolUseId === ev.toolUseId);
          // Background subagents return at once and report through SubagentStop; old CLIs have no SubagentStart.
          if (child && !child.endedAt && (!child.agentId || ev.error)) this.finish(child, ev.error ? 'error' : 'done', ev.error ? 'Failed' : 'Done');
        }
        break;
      }
      case 'PermissionRequest':
        this.setStatus(target, 'waiting', `Needs permission${ev.tool ? ': ' + ev.tool : ''}${ev.summary ? ' · ' + ev.summary : ''}`);
        break;
      case 'Notification':
        if (ev.notificationType === 'permission_prompt' || ev.notificationType === 'elicitation_dialog' || (!ev.notificationType && /permission|approve|input/i.test(ev.message || ''))) {
          this.setStatus(target, 'waiting', ev.message || 'Waiting for you');
        } else if (ev.notificationType === 'idle_prompt') {
          if (root.status !== 'waiting') this.setStatus(root, 'idle', 'Waiting for your next prompt');
        }
        break;
      case 'Stop':
        root.tool = null;
        this.setStatus(root, 'idle', 'Turn finished');
        break;
      case 'StopFailure':
        root.tool = null;
        root.errors++;
        this.setStatus(root, 'error', 'The turn failed');
        break;
      case 'SubagentStart': {
        let child = this.findChild(root, (n) => n.pending && !n.agentId && !n.endedAt && (!ev.agentType || !n.subagentType || n.subagentType === ev.agentType));
        if (!child) {
          child = this.addNode({ id: `${root.id}~agent~${ev.agentId}`, parentId: root.id, rootId: root.id, kind: 'subagent', source: 'claude', where: root.where, label: ev.agentType || 'Subagent', sublabel: ev.agentType, project: root.project, status: 'starting', ownerWcId: root.ownerWcId, termId: root.termId });
          if (!child) break;
        }
        child.pending = false;
        child.agentId = ev.agentId;
        if (ev.agentType && !child.sublabel) child.sublabel = ev.agentType;
        this.setStatus(child, 'thinking');
        break;
      }
      case 'SubagentStop': {
        const child = ev.agentId && this.subagentFor(root, ev.agentId);
        if (child && !child.endedAt) this.finish(child, 'done', 'Done');
        break;
      }
      case 'PreCompact':
        target.tool = { name: 'Compacting', summary: 'context' };
        this.setStatus(target, 'tool');
        break;
      case 'SessionEnd':
        for (const c of this.descendants(root)) if (!c.endedAt) this.finish(c, 'done', 'Done');
        root.tool = null;
        if (ev.reason === 'clear' || ev.reason === 'resume') this.setStatus(root, 'idle', 'Ready');
        else this.setStatus(root, 'done', 'Session ended');
        break;
      default:
        return;
    }
    this.changed();
  }

  onCodexEvent(root, ev) {
    if (ev.event === 'TurnComplete') {
      root.toolCalls++; // turns, for Codex
      root.turns = (root.turns || 0) + 1;
      if (!root.project && ev.cwdName) root.project = ev.cwdName;
      this.setStatus(root, 'idle', 'Turn finished — your move');
      this.log(root, { name: 'Turn', summary: `turn ${root.turns}`, ok: true });
      this.changed();
    }
  }

  // ---------- MCP clients + the ⌘J assistant (from the agent hub) ----------

  // Called by the hub around every tool call. ctx: { source, client: { id, name, session }, runId }.
  hubCallStart(callId, name, input, ctx = {}) {
    let node;
    if (ctx.source === 'assistant') node = this.assistantNode(ctx.runId);
    else node = this.mcpNode(ctx.client || {});
    if (!node) return;
    node.toolCalls++;
    node.lastEventAt = now();
    node.endedAt = null;
    const summary = clean(browserSummary(name, input), 80, this.secretValues(node));
    node.tool = { name, summary };
    this.setStatus(node, 'tool');
    const entry = this.log(node, { name, summary });
    this.calls.set(callId, { nodeId: node.id, entry });
    this.changed();
  }

  hubCallEnd(callId, { ok = true, tabId = null } = {}) {
    const c = this.calls.get(callId);
    this.calls.delete(callId);
    const node = c && this.nodes.get(c.nodeId);
    if (!node) return;
    if (c.entry) c.entry.ok = ok;
    if (!ok) node.errors++;
    if (tabId) node.tabId = String(tabId).slice(0, 80);
    node.tool = null;
    if (node.kind === 'assistant') this.setStatus(node, node.running ? 'thinking' : 'done');
    else this.setStatus(node, 'idle', 'Connected');
    this.changed();
  }

  mcpNode(client) {
    const cid = /^[\w-]{6,64}$/.test(client.id || '') ? client.id : 'anonymous';
    const id = `mcp-${cid}`;
    let node = this.nodes.get(id);
    if (node && !node.endedAt) return node;
    if (node) this.archive(node);
    const parentId = client.session && this.tokenHashes.get(client.session) || null;
    const parent = parentId && this.nodes.get(parentId);
    // The client's name comes from the MCP client itself (anything holding the hub token can claim
    // to be "Claude Code"), so it's always shown as self-reported. Only the session link is verified:
    // the bridge proves it with a hash of that session's Mission token.
    const name = clean(client.name, 40);
    return this.addNode({
      id, parentId: parent ? parent.id : null, rootId: parent ? parent.id : undefined, kind: 'client', source: 'mcp', where: 'mcp',
      label: parent ? 'Meridian browser tools' : (name || 'MCP client'), sublabel: name ? `${parent ? name + ' · ' : ''}self-reported name` : (parent ? null : 'MCP'),
      selfReported: !!name, project: parent?.project || null, status: 'idle', statusText: 'Connected',
      ownerWcId: parent?.ownerWcId, termId: parent?.termId,
    });
  }

  assistantNode(runId) {
    const rid = /^[\w-]{6,64}$/.test(runId || '') ? runId : 'default';
    const id = `assistant-${rid}`;
    let node = this.nodes.get(id);
    if (node && !node.endedAt) return node;
    if (node) this.archive(node);
    return this.addNode({ id, parentId: null, kind: 'assistant', source: 'assistant', where: 'assistant', label: '⌘J Assistant', sublabel: 'Claude', status: 'idle', statusText: 'Ready' });
  }

  assistantRunStart(runId, { host } = {}) {
    const node = this.assistantNode(runId);
    node.running = true;
    node.endedAt = null;
    node.runs = (node.runs || 0) + 1;
    if (host) node.project = clean(host, 60);
    this.setStatus(node, 'thinking');
    this.changed();
  }

  assistantRunEnd(runId, { error = null, stopped = false } = {}) {
    const node = this.nodes.get(`assistant-${runId}`);
    if (!node) return;
    node.running = false;
    node.tool = null;
    if (error) { node.errors++; this.setStatus(node, 'error', clean(error, 120)); }
    else this.setStatus(node, 'done', stopped ? 'Stopped' : 'Answered');
    node.lastEventAt = now();
    this.changed();
  }

  assistantReset(runId) {
    const node = this.nodes.get(`assistant-${runId}`);
    if (node && !node.endedAt) this.finish(node, node.status === 'error' ? 'error' : 'done', 'Chat closed');
  }

  // ---------- tree helpers ----------

  // Returns null (nothing added) when an agent-driven node would exceed the caps: hook events and MCP
  // client ids are attacker-influenced, and every node is re-sent to the UI on each change.
  addNode(n) {
    if (n.kind === 'subagent' || n.kind === 'client') {
      if (this.nodes.size >= LIVE_MAX) this.sweep(true);
      if (this.nodes.size >= LIVE_MAX && !this.nodes.has(n.id)) return null;
      if (n.kind === 'subagent' && n.rootId && !this.nodes.has(n.id) && this.descendants({ id: n.rootId }).length >= SUBTREE_MAX) return null;
    }
    const node = {
      parentId: null, rootId: undefined, sublabel: null, project: null, statusText: null, tool: null, toolCalls: 0, errors: 0,
      startedAt: now(), endedAt: null, lastEventAt: now(), log: [], termId: null, ownerWcId: null, tabId: null, ...n,
    };
    node.rootId ||= node.parentId ? (this.nodes.get(node.parentId)?.rootId || node.parentId) : node.id;
    this.nodes.set(node.id, node);
    if (this.nodes.size > LIVE_MAX) this.sweep(true);
    return node;
  }

  descendants(root) { return [...this.nodes.values()].filter((n) => n.rootId === root.id && n.id !== root.id); }
  findChild(root, pred) { return this.descendants(root).sort((a, b) => a.startedAt - b.startedAt).find(pred) || null; }
  subagentFor(root, agentId) { return this.findChild(root, (n) => n.agentId === agentId); }

  log(node, { id = null, name, summary, ok = null }) {
    const entry = { id, ts: now(), name: name || 'tool', summary: summary || null, ok };
    node.log.push(entry);
    if (node.log.length > LOG_MAX) node.log.splice(0, node.log.length - LOG_MAX);
    return entry;
  }

  setStatus(node, status, text = null) {
    const was = node.status;
    node.status = status;
    node.statusText = text;
    if (status !== 'tool') node.tool = status === 'waiting' ? node.tool : null;
    if (status === 'waiting') {
      if (was !== 'waiting') { node.waitingSince = now(); this.notifyWaiting(node); }
    } else node.waitingSince = null;
  }

  finish(node, status, text) {
    node.tool = null;
    this.setStatus(node, status, text);
    node.endedAt = now();
    if (!node.parentId) for (const c of this.descendants(node)) if (!c.endedAt) { c.tool = null; this.setStatus(c, 'done', c.statusText || 'Done'); c.endedAt = now(); }
    this.changed();
  }

  // Move a finished root (and its subtree) to history.
  archive(root) {
    const sub = this.descendants(root);
    for (const n of sub) this.nodes.delete(n.id);
    this.nodes.delete(root.id);
    this.lastNotify.delete(root.id);
    if (root.toolCalls === 0 && root.kind === 'client' && !sub.length) return; // an MCP bridge that only listed tools
    this.history.unshift({
      id: root.id, label: root.label, sublabel: root.sublabel, source: root.source, where: root.where, project: root.project,
      startedAt: root.startedAt, endedAt: root.endedAt || now(), status: root.status === 'error' ? 'error' : 'done',
      toolCalls: root.toolCalls + sub.reduce((a, n) => a + n.toolCalls, 0), subagents: sub.filter((n) => n.kind === 'subagent').length,
    });
    this.history.length = Math.min(this.history.length, HISTORY_MAX);
    this.saveHistory();
  }

  sweep(force = false) {
    const t = now();
    let changed = false;
    for (const n of [...this.nodes.values()]) {
      if (!this.nodes.has(n.id)) continue;
      if (n.parentId) continue;
      if (!n.endedAt && n.kind === 'client' && t - n.lastEventAt > MCP_IDLE_MS && !n.tool) { this.finish(n, 'done', 'Disconnected'); changed = true; }
      if (!n.endedAt && n.kind === 'assistant' && !n.running && t - n.lastEventAt > ASSISTANT_IDLE_MS) { this.finish(n, n.status === 'error' ? 'error' : 'done', n.statusText); changed = true; }
      if (n.endedAt && (force || t - n.endedAt > LINGER_MS)) { this.archive(n); changed = true; }
    }
    if (changed) this.changed();
  }

  dismiss(id) {
    const n = this.nodes.get(String(id));
    if (n && !n.parentId && n.endedAt) { this.archive(n); this.changed(); return true; }
    return false;
  }

  clearHistory() { this.history = []; this.saveHistory(); this.changed(); return true; }

  // ---------- output ----------

  counts() {
    let working = 0, waiting = 0, live = 0;
    for (const n of this.nodes.values()) {
      if (n.endedAt) continue;
      if (!n.parentId) live++;
      if (WORKING.has(n.status)) working++;
      if (n.status === 'waiting') waiting++;
    }
    return { working, waiting, live };
  }

  snapshot() {
    const nodes = [...this.nodes.values()].map((n) => ({
      id: n.id, parentId: n.parentId, kind: n.kind, source: n.source, where: n.where, label: n.label, sublabel: n.sublabel,
      project: n.project, status: n.status, statusText: n.statusText, tool: n.tool, toolCalls: n.toolCalls, errors: n.errors,
      startedAt: n.startedAt, endedAt: n.endedAt, waitingSince: n.waitingSince || null, termId: n.termId, ownerWcId: n.ownerWcId, tabId: n.tabId,
      turns: n.turns || 0, selfReported: !!n.selfReported, log: n.log.slice(-LOG_MAX),
    }));
    return { nodes, history: this.history.slice(0, HISTORY_MAX), counts: this.counts(), now: now() };
  }

  changed() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const win = this.getMainWindow();
      const snap = this.snapshot();
      if (win && !win.isDestroyed()) win.webContents.send('mission:state', snap);
      this.updateBadge(snap.counts);
    }, 80);
  }

  updateBadge({ waiting }) {
    if (this.quiet || process.platform !== 'darwin' || !this.app.dock) return;
    const want = waiting ? String(waiting) : '';
    if (this.lastBadge !== want) { this.lastBadge = want; try { this.app.dock.setBadge(want); } catch {} }
  }

  notifyWaiting(node) {
    const settings = this.getSettings() || {};
    const root = node.parentId ? this.nodes.get(node.rootId) : node;
    // An agent can flip between waiting and working as fast as its hooks fire: throttle per session.
    const key = root?.id || node.id;
    if (now() - (this.lastNotify.get(key) || 0) < NOTIFY_GAP_MS) return;
    this.lastNotify.set(key, now());
    const title = `${root?.label || node.label}${root?.project ? ' · ' + root.project : ''} is waiting for you`;
    const body = (node.statusText || (node !== root ? node.label : '') || 'It needs your input to continue.').slice(0, 200);
    const win = this.getMainWindow();
    const focused = !!win && !win.isDestroyed() && win.isFocused();
    const record = { nodeId: node.id, title, body, native: !focused };
    if (this.notified.length > 50) this.notified.splice(0, this.notified.length - 50);
    if (settings.missionNotify === false) return;
    if (focused) { win.webContents.send('mission:toast', { nodeId: node.id, title, body }); this.notified.push({ ...record, toast: true }); return; }
    this.notified.push(record);
    if (this.quiet || !Notification.isSupported()) return;
    try {
      const n = new Notification({ title, body, silent: false });
      n.on('click', () => {
        const w = this.getMainWindow();
        if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore();
        w.show(); w.focus();
        w.webContents.send('command', 'mission-reveal', node.id);
      });
      n.show();
    } catch {}
  }

  loadHistory() {
    try {
      const h = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      if (Array.isArray(h)) this.history = h.filter((x) => x && typeof x.label === 'string').slice(0, HISTORY_MAX).map((x) => ({
        id: String(x.id || '').slice(0, 80), label: String(x.label).slice(0, 80), sublabel: x.sublabel ? String(x.sublabel).slice(0, 60) : null,
        source: String(x.source || '').slice(0, 20), where: String(x.where || '').slice(0, 20), project: x.project ? String(x.project).slice(0, 60) : null,
        startedAt: Number(x.startedAt) || 0, endedAt: Number(x.endedAt) || 0, status: x.status === 'error' ? 'error' : 'done',
        toolCalls: Number(x.toolCalls) || 0, subagents: Number(x.subagents) || 0,
      }));
    } catch {}
  }

  saveHistory() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = this.historyFile + '.tmp';
      try { fs.writeFileSync(tmp, JSON.stringify(this.history), { mode: 0o600 }); fs.renameSync(tmp, this.historyFile); } catch {}
    }, 500);
  }

  // ---------- IPC (main.js passes its sender-checked helpers) ----------

  registerIpc(handle) {
    handle('mission:snapshot', () => this.snapshot());
    handle('mission:dismiss', (_e, id) => this.dismiss(id));
    handle('mission:clear-history', () => this.clearHistory());
  }

  dispose() {
    clearInterval(this.sweepTimer);
    this.channel.stop();
    if (this.saveTimer) { clearTimeout(this.saveTimer); try { fs.writeFileSync(this.historyFile, JSON.stringify(this.history), { mode: 0o600 }); } catch {} }
  }
}

module.exports = { MissionControl, mergeClaudeSettings, claudeHookSettings, browserSummary, CLAUDE_EVENTS };
