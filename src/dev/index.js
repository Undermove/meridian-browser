// Workbench — a mini IDE inside Meridian (file tree, Monaco editor, terminals, coding agents).
//
// Security model
//  - The workbench UI is ONE local page (src/renderer/dev/workbench.html) running in a <webview> with
//    its own in-memory partition (INTERNAL_PARTITION) and its own preload (src/dev/preload.js).
//  - Main decides the preload: will-attach-webview gives exactly that preload to exactly that page in
//    exactly that partition, embedded by Meridian's own UI. Any other use of the partition is refused,
//    and the workbench URL can't be opened in a web profile.
//  - The internal session can only load files from an allowlist of local folders (the workbench page,
//    Monaco and xterm). Navigation away and popups are blocked; http(s) links open as normal tabs.
//  - Every wb:* IPC handler checks the sender is that page (URL + partition + webview + Meridian UI host).
//  - Files: scoped to the project root chosen in a native dialog (real-path checks, see files.js).
//  - Terminals: only reachable through these handlers; killed when the page goes away or on quit.
//  - Agents never get to drive the workbench: the agent hub refuses webContents in this partition.
//  - No network listeners are opened here.
//
// Workbench Pro (customizations, secrets vault, sandboxed agents, hubs) keeps the same rules:
//  - The customization folder is served read-only under meridian://workbench/custom/ to this session
//    only (real-path checked, nothing in Safe Mode, switched-off plugins are 404).
//  - Vault values only ever leave main as environment variables of processes started here, or to the
//    page when the user clicks Reveal. Never in files, logs, MCP results or terminal text.
//  - The secret guard is a private local socket (0700 dir / random pipe), not a network listener.
//  - Docker is driven with argv arrays; secrets are passed as bare `-e NAME` (values via env).

const { ipcMain, session, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { ProjectFs } = require('./files');
const { PtyManager } = require('./pty');
const { loginPath, childEnv } = require('./env');
const { detect, launchSpec } = require('./agents');
// Workbench Pro
const { Vault, scanProject, parseDotenv, DOTENV_FILE, RESERVED } = require('./vault');
const { SecretGuard, hookSettings } = require('./guard');
const { Sandbox, SANDBOX_KINDS } = require('./sandbox');
const { Customizations } = require('./custom');
const { TEMPLATES, createHub, hubInfo } = require('./hubs');
const { which } = require('./env');
const { NAME_RE } = require('../renderer/dev/secret-detect');
const { mergeClaudeSettings } = require('../agents/mission');

// ---------- URLs and the partition ----------
// The page is served from meridian://workbench/ by a protocol handler registered ONLY on the internal
// session (file:// can't read app.asar once the file-privileges fuse is off, and web profiles have no
// handler for meridian:// at all). Each URL prefix maps to exactly one folder.

const INTERNAL_PARTITION = 'meridian-internal';
const APP_ROOT = path.join(__dirname, '..', '..');
const ORIGIN = 'meridian://workbench';
const WORKBENCH_URL = `${ORIGIN}/workbench.html`;
const PRELOAD = path.join(__dirname, 'preload.js');
const ROUTES = [
  ['/vendor/monaco/', path.join(APP_ROOT, 'node_modules', 'monaco-editor', 'min')],
  ['/vendor/xterm-fit/', path.join(APP_ROOT, 'node_modules', '@xterm', 'addon-fit')],
  ['/vendor/xterm/', path.join(APP_ROOT, 'node_modules', '@xterm', 'xterm')],
  ['/icons.js', path.join(APP_ROOT, 'src', 'renderer', 'icons.js')],
  ['/', path.join(APP_ROOT, 'src', 'renderer', 'dev')],
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// meridian://workbench/<path> -> a file inside one of the ROUTES folders, or null.
function workbenchFile(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'meridian:' || u.host !== 'workbench') return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  rel = path.posix.normalize('/' + rel);
  for (const [prefix, target] of ROUTES) {
    if (prefix.endsWith('/') ? !rel.startsWith(prefix) : rel !== prefix) continue;
    if (!prefix.endsWith('/')) return target;
    const file = path.resolve(target, '.' + rel.slice(prefix.length - 1));
    return file.startsWith(target + path.sep) ? file : null;
  }
  return null;
}

// Workbench Pro: meridian://workbench/custom/<rel> is answered by the Workbench (user customizations).
let customProvider = null; // async (rel) => Buffer | null
const CUSTOM_PREFIX = `${ORIGIN}/custom/`;
function customRel(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'meridian:' || u.host !== 'workbench' || !u.pathname.startsWith('/custom/')) return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname.slice('/custom/'.length)); } catch { return null; }
  return rel.includes('\0') || rel.includes('\\') ? null : rel;
}

const stripQueryHash = (url) => String(url || '').split('#')[0].split('?')[0];
const isWorkbenchUrl = (url) => stripQueryHash(url) === WORKBENCH_URL;
// Any URL that points at the workbench (web profiles must never load these).
const isWorkbenchResource = (url) => /^meridian:\/\/workbench(\/|$)/i.test(String(url || ''));

function internalSession() { return session.fromPartition(INTERNAL_PARTITION); }
const isInternalContents = (wc) => !!wc && !wc.isDestroyed() && wc.session === internalSession();

let prepared = false;
function prepareInternalSession() {
  if (prepared) return;
  prepared = true;
  const ses = internalSession();
  ses.protocol.handle('meridian', async (req) => {
    const crel = req.method === 'GET' ? customRel(req.url) : null;
    if (crel !== null) {
      const type = MIME[path.extname(crel).toLowerCase()];
      const body = type && customProvider ? await customProvider(crel).catch(() => null) : null;
      if (!body) return new Response('Not found', { status: 404 });
      return new Response(body, { headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
    }
    const file = req.method === 'GET' ? workbenchFile(req.url) : null;
    const type = file && MIME[path.extname(file).toLowerCase()];
    if (!file || !type) return new Response('Not found', { status: 404 });
    try {
      return new Response(await fs.promises.readFile(file), { headers: { 'content-type': type, 'x-content-type-options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  // Nothing but our own origin (and Monaco's blob: workers) may load in this session.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    const ok = /^(data|blob):/i.test(url) || url.startsWith('devtools:') || (url.startsWith(ORIGIN + '/') && (!!workbenchFile(url) || (url.startsWith(CUSTOM_PREFIX) && customRel(url) !== null)));
    if (!ok) console.warn('workbench: blocked request', url.slice(0, 200));
    callback({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.setSpellCheckerEnabled(false);
}

// ---------- the service ----------

class Workbench {
  constructor({ app, getMainWindow, isUiContents, mcpCommand, agentStatus, mission = null }) {
    this.app = app;
    this.mission = mission; // Mission Control (src/agents/mission.js)
    this.getMainWindow = getMainWindow;
    this.isUiContents = isUiContents;
    this.mcpCommand = mcpCommand;
    this.agentStatus = agentStatus;
    this.ptys = new PtyManager();
    this.owners = new Map(); // webContents id -> { wc, project, zone }
    this.storeFile = path.join(app.getPath('userData'), 'workbench.json');
    // Workbench Pro
    // MERIDIAN_TEST_KEYCHAIN (dev/test only, ignored when packaged): in-memory key, never the real keychain.
    this.vault = new Vault(path.join(app.getPath('userData'), 'vault.json'), { testKeychain: !app.isPackaged && process.env.MERIDIAN_TEST_KEYCHAIN === '1' });
    this.guard = new SecretGuard({ onRequest: (session, req) => this.guardDecision(session, req) });
    this.sandbox = new Sandbox({ getEnv: () => childEnv(), getSearchPath: () => loginPath() });
    this.safeMode = process.argv.includes('--workbench-safe-mode') || (!app.isPackaged && process.env.MERIDIAN_WB_SAFE === '1');
    this.custom = null;
    this.dialogChain = Promise.resolve();
    try {
      this.custom = new Customizations(path.join(app.getPath('userData'), 'workbench-custom'), () => this.broadcast('wb:custom-change', {}));
      this.custom.snapshot('initial').catch(() => {});
    } catch (err) { console.warn('workbench: customizations unavailable', err.message); }
    customProvider = (rel) => this.serveCustom(rel);
    this.registerIpc();
    this.registerProIpc();
    loginPath(); // warm up: resolving the login shell PATH can take a moment
  }

  broadcast(channel, payload) {
    for (const o of this.owners.values()) if (!o.wc.isDestroyed()) o.wc.send(channel, payload);
  }

  // ----- will-attach-webview -----
  // Called for every <webview> attach before the generic hardening. Returns true if it handled it.
  attachPolicy(embedder, event, webPreferences, params) {
    const internal = params.partition === INTERNAL_PARTITION;
    const wantsWorkbench = isWorkbenchResource(params.src || '');
    if (!internal && !wantsWorkbench) return false;
    if (!(internal && isWorkbenchUrl(params.src) && this.isUiContents(embedder))) {
      event.preventDefault();
      return true;
    }
    prepareInternalSession();
    Object.assign(webPreferences, {
      preload: PRELOAD, // set here, never taken from the embedder
      nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false,
      spellcheck: false, safeDialogs: true, navigateOnDragDrop: false,
    });
    delete webPreferences.preloadURL;
    return true;
  }

  // ----- wiring for the workbench guest webContents -----
  wireInternal(contents) {
    const owner = { wc: contents, project: null, zone: 'other' };
    this.owners.set(contents.id, owner);
    // The page may only ever show itself: links to the web open as normal browser tabs instead.
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && isWorkbenchUrl(event.url)) return;
      event.preventDefault();
      if (event.isMainFrame) this.openInBrowser(event.url);
    });
    contents.on('will-navigate', (event, url) => { if (!isWorkbenchUrl(url)) event.preventDefault(); });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => { this.openInBrowser(url); return { action: 'deny' }; });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    // Keyboard: Meridian's menu shortcuts are app-wide. Let the editor/terminal have the keys they need.
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown') return;
      contents.setIgnoreMenuShortcuts(this.keyBelongsToPage(owner.zone, input));
    });
    contents.on('context-menu', (_e, params) => this.contextMenu(contents, params));
    contents.once('destroyed', () => this.release(contents.id));
  }

  keyBelongsToPage(zone, input) {
    const mac = process.platform === 'darwin';
    const mod = mac ? input.meta : input.control;
    const key = String(input.key || '').toLowerCase();
    if (zone === 'editor' && mod && !input.alt) {
      // Save, find, undo/redo, add-cursor-to-next-match, indent: editor meanings win over browser ones.
      if (['s', 'f', 'g', 'z', 'y', 'd', '[', ']', 'h'].includes(key)) return true;
    }
    if (zone === 'terminal' && !mac && input.control && !input.shift && !input.alt && /^[a-z]$/.test(key)) {
      // Windows/Linux: Ctrl+C/D/R/L/W/… are terminal keys, not browser shortcuts.
      return true;
    }
    return false;
  }

  contextMenu(contents, params) {
    const { Menu, clipboard } = require('electron');
    const t = [];
    if (params.isEditable || params.selectionText) t.push({ role: 'cut', enabled: params.isEditable }, { role: 'copy' }, { role: 'paste', enabled: params.isEditable }, { type: 'separator' });
    t.push({ label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) });
    if (params.linkURL && /^https?:/i.test(params.linkURL)) t.unshift({ label: 'Open Link in New Tab', click: () => this.openInBrowser(params.linkURL) }, { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    Menu.buildFromTemplate(t).popup();
  }

  openInBrowser(url) {
    if (!/^https?:\/\//i.test(String(url))) return;
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('command', 'open-url-tab', String(url));
  }

  release(wcId) {
    const owner = this.owners.get(wcId);
    if (!owner) return;
    owner.project?.dispose();
    this.ptys.killAllFor(owner.wc);
    this.owners.delete(wcId);
  }

  dispose() {
    for (const id of [...this.owners.keys()]) this.release(id);
    this.ptys.killAll();
    this.sandbox.disposeSync();
    this.guard.stop();
    this.custom?.dispose();
  }

  // ----- sender validation -----
  isWorkbenchSender(e) {
    const wc = e.sender;
    const frame = e.senderFrame;
    return !!frame && !frame.parent && wc.getType() === 'webview' && isInternalContents(wc) &&
      isWorkbenchUrl(frame.url) && this.isUiContents(wc.hostWebContents) && this.owners.has(wc.id);
  }

  registerIpc() {
    const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
      if (!this.isWorkbenchSender(e)) throw new Error('forbidden');
      return fn(this.owners.get(e.sender.id), ...args);
    });
    const on = (channel, fn) => ipcMain.on(channel, (e, ...args) => {
      if (!this.isWorkbenchSender(e)) return;
      try { fn(this.owners.get(e.sender.id), ...args); } catch {}
    });
    const project = (owner) => { if (!owner.project) throw new Error('no project is open'); return owner.project; };

    handle('wb:info', async (owner) => this.info(owner));
    handle('wb:pick-project', async (owner) => {
      // Dev/test only (ignored in packaged builds): skip the native dialog.
      if (!this.app.isPackaged && process.env.MERIDIAN_TEST_PROJECT) return this.openProject(owner, process.env.MERIDIAN_TEST_PROJECT);
      const win = BrowserWindow.fromWebContents(owner.wc.hostWebContents) || this.getMainWindow();
      const res = await dialog.showOpenDialog(win, { title: 'Open a project folder', buttonLabel: 'Open', properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || !res.filePaths[0]) return null;
      return this.openProject(owner, res.filePaths[0]);
    });
    // Reopening only works for folders the user picked before in the native dialog.
    handle('wb:open-project', async (owner, p) => {
      const store = this.readStore();
      if (!store.recents.some((r) => r.path === p)) throw new Error('Pick this folder with “Open folder…” first');
      return this.openProject(owner, p);
    });
    handle('wb:forget-recent', async (_owner, p) => {
      const store = this.readStore();
      store.recents = store.recents.filter((r) => r.path !== p);
      this.writeStore(store);
      return store.recents;
    });
    handle('wb:close-project', async (owner) => {
      owner.project?.dispose();
      owner.project = null;
      return true;
    });
    handle('wb:set-preview-url', async (owner, url) => {
      if (!/^https?:\/\/[^\s]+$/i.test(String(url)) || String(url).length > 2000) throw new Error('Preview must be an http(s) URL');
      const p = project(owner);
      const store = this.readStore();
      store.previews[p.root] = String(url);
      this.writeStore(store);
      return true;
    });

    handle('wb:list', (owner, rel, opts) => project(owner).list(String(rel || ''), { showHidden: !!opts?.showHidden }));
    handle('wb:read', (owner, rel) => project(owner).read(rel));
    handle('wb:stat', (owner, rel) => project(owner).stat(rel));
    handle('wb:write', (owner, rel, content) => project(owner).write(rel, content));
    handle('wb:create', (owner, rel, kind) => project(owner).create(rel, kind === 'dir' ? 'dir' : 'file'));
    handle('wb:rename', (owner, from, to) => project(owner).rename(from, to));
    handle('wb:delete', (owner, rel) => project(owner).remove(rel));
    handle('wb:reveal', async (owner, rel) => { shell.showItemInFolder(await project(owner).resolve(rel || '.')); return true; });

    handle('wb:pty-create', async (owner, opts = {}) => {
      const p = project(owner);
      const kind = ['shell', 'claude', 'codex', 'gemini', ...Object.keys(SANDBOX_KINDS)].includes(opts.kind) ? opts.kind : 'shell';
      const searchPath = this.agentSearchPath(await loginPath());
      // Workbench Pro: vault secrets for this project go into the environment (names are shown, values never).
      const secrets = this.vault.envFor(p.root);
      const extra = { ...secrets };
      let names = Object.keys(secrets).sort();
      let spec;
      let guardToken = null;
      // Mission Control: a live node + a private event channel for agent sessions (never for shells).
      let mission = null;
      if (this.mission && /^(claude|codex|gemini|sandbox-claude|sandbox-codex)$/.test(kind)) {
        try { mission = await this.mission.registerTerminal({ kind, project: p.name, ownerWcId: owner.wc.id, sandbox: !!SANDBOX_KINDS[kind] }); } catch (err) { console.warn('mission control:', err.message); }
      }
      const missionDone = (info) => { if (mission) this.mission.terminalExit(mission.token, mission.nodeId, info); mission = mission && { ...mission, ended: true }; };
      try {
        if (SANDBOX_KINDS[kind]) {
          const mount = mission?.token ? this.mission.sandboxMount(mission.token, kind) : null;
          spec = await this.sandbox.launchSpec(kind, { root: p.root, secretNames: names, network: this.readStore().sandboxNetwork !== false, mission: mount });
          if (spec.then) { for (const n of names) delete extra[n]; names = []; this.mission.discard(mission?.token, mission?.nodeId); mission = null; } // the image build gets no secrets
          else if (mount && mission) extra.MERIDIAN_MISSION_TOKEN = mission.token;
        } else {
          let claudeSettings = null;
          const node = (kind === 'claude' || kind === 'codex') ? which('node', searchPath) : null;
          if (kind === 'claude') {
            const script = this.guard.hookScript();
            claudeSettings = node && script ? hookSettings(node, script) : null;
            if (claudeSettings) {
              try {
                await this.guard.start();
                guardToken = this.guard.register({ owner, root: p.root, agent: 'Claude Code' });
                extra.MERIDIAN_GUARD_SOCKET = this.guard.socketPath;
                extra.MERIDIAN_GUARD_TOKEN = guardToken;
              } catch { claudeSettings = null; }
            }
            // Merge, never replace: the guard's blocking hook and Mission Control's async observer hooks.
            if (mission?.env.MERIDIAN_MISSION_SOCKET) claudeSettings = mergeClaudeSettings(claudeSettings, this.mission.claudeSettingsFor(node));
          }
          const codexNotify = kind === 'codex' && mission?.env.MERIDIAN_MISSION_SOCKET ? this.mission.codexNotifyArg(node) : null;
          if (mission) Object.assign(extra, mission.env);
          spec = launchSpec(kind, { searchPath, mcp: this.mcpCommand(), dataDir: this.app.getPath('userData'), claudeSettings, codexNotify });
          if (kind === 'claude' && !guardToken) spec.notes.push('Secret-file guard is off for this session (Node.js was not found on your PATH).');
        }
      } catch (err) { missionDone({ code: 1 }); throw err; }
      const env = await childEnv(extra);
      const meta = { secrets: names, guard: !!guardToken, sandbox: !!SANDBOX_KINDS[kind] && !spec.then, then: spec.then || null, missionNode: mission?.nodeId || null };
      let info;
      try {
        info = this.ptys.create(owner.wc, {
          kind, title: spec.title, file: spec.file, args: spec.args, cwd: p.root, env, cols: opts.cols, rows: opts.rows, cleanup: spec.cleanup, meta,
          onExit: (ex) => { if (guardToken) this.guard.unregister(guardToken); missionDone({ code: ex?.code, killed: !!ex?.signal }); spec.onExit?.(); },
          onKill: () => { if (guardToken) this.guard.unregister(guardToken); missionDone({ killed: true }); spec.onKill?.(); },
        });
      } catch (err) { missionDone({ code: 1 }); throw err; }
      if (mission) this.mission.attachTerminal(mission.token, info.id, mission.nodeId);
      return { ...info, notes: spec.notes, browserTools: !!spec.browserTools };
    });
    handle('wb:pty-list', (owner) => this.ptys.list(owner.wc));
    handle('wb:pty-kill', (owner, id) => { this.ptys.kill(owner.wc, id); return true; });
    on('wb:pty-write', (owner, id, data) => {
      this.ptys.write(owner.wc, id, data);
      // Mission Control: Enter in an agent terminal starts a turn (Codex has no per-tool hooks).
      if (this.mission && typeof data === 'string' && data.includes('\r')) { const n = this.ptys.get(owner.wc, id)?.meta?.missionNode; if (n) this.mission.terminalInput(n, data); }
    });
    on('wb:pty-resize', (owner, id, cols, rows) => this.ptys.resize(owner.wc, id, cols, rows));
    // Native context menu: the page sends items, gets back the chosen id (labels are plain text).
    handle('wb:menu', (owner, items) => new Promise((resolve) => {
      const { Menu } = require('electron');
      let chosen = null;
      const template = (Array.isArray(items) ? items : []).slice(0, 40).map((it) => (it?.type === 'separator'
        ? { type: 'separator' }
        : { label: String(it?.label || '').slice(0, 100), enabled: it?.enabled !== false, click: () => { chosen = String(it?.id || ''); } }));
      Menu.buildFromTemplate(template).popup({ window: BrowserWindow.fromWebContents(owner.wc.hostWebContents), callback: () => setTimeout(() => resolve(chosen), 0) });
    }));
    on('wb:focus-zone', (owner, zone) => { owner.zone = ['editor', 'terminal'].includes(zone) ? zone : 'other'; });
  }

  // Mission Control: vault values of the project a terminal belongs to, so summaries can mask them
  // exactly (in memory only; cached briefly because every hook event asks).
  secretValuesFor(ownerWcId) {
    const owner = this.owners.get(ownerWcId);
    const root = owner?.project?.root;
    if (!root) return [];
    const c = this.secretCache;
    if (c && c.root === root && Date.now() - c.at < 5000) return c.values;
    let values = [];
    try { values = Object.entries(this.vault.envFor(root)).map(([name, value]) => ({ name, value })); } catch {}
    this.secretCache = { root, at: Date.now(), values };
    return values;
  }

  // Dev/test only (ignored in packaged builds): MERIDIAN_TEST_AGENT_BIN is searched first, so e2e
  // tests can stand in recorded/fake agent CLIs for the real ones.
  agentSearchPath(base) {
    const extra = !this.app.isPackaged && process.env.MERIDIAN_TEST_AGENT_BIN;
    return extra && path.isAbsolute(extra) ? `${extra}${path.delimiter}${base}` : base;
  }

  async info(owner) {
    const searchPath = this.agentSearchPath(await loginPath());
    const store = this.readStore();
    const access = this.agentStatus()?.access || 'off';
    return {
      platform: process.platform,
      project: owner.project ? this.projectInfo(owner.project, store) : null,
      recents: store.recents.filter((r) => fs.existsSync(r.path)),
      agents: detect(searchPath),
      agentAccess: access,
      terminals: this.ptys.available(),
      terminalError: this.ptys.loadError(),
      // Workbench Pro
      safeMode: this.safeMode,
      customRoot: this.custom?.realRoot || null,
      vaultUnavailable: this.vault.unavailableReason(),
      sandboxNetwork: store.sandboxNetwork !== false,
      hubTemplates: Object.entries(TEMPLATES).map(([id, t]) => ({ id, label: t.label, description: t.description })),
    };
  }

  projectInfo(p, store = this.readStore()) {
    return { root: p.root, name: p.name, preview: store.previews[p.root] || 'http://localhost:3000' };
  }

  openProject(owner, dir) {
    const next = new ProjectFs(dir, (paths) => { if (!owner.wc.isDestroyed()) owner.wc.send('wb:fs-change', { paths }); });
    owner.project?.dispose();
    owner.project = next;
    const store = this.readStore();
    store.recents = [{ path: next.root, name: next.name, openedAt: Date.now() }, ...store.recents.filter((r) => r.path !== next.root && r.path !== dir)].slice(0, 12);
    this.writeStore(store);
    return this.projectInfo(next, store);
  }

  // ======================================================================== Workbench Pro

  registerProIpc() {
    const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
      if (!this.isWorkbenchSender(e)) throw new Error('forbidden');
      return fn(this.owners.get(e.sender.id), ...args);
    });
    const project = (owner) => { if (!owner.project) throw new Error('no project is open'); return owner.project; };
    const root = (owner) => owner.project?.root || null;
    const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');

    // ----- customizations -----
    handle('wb:custom-state', async () => {
      if (!this.custom) return { unavailable: true, safeMode: true };
      const store = this.readStore();
      return { ...(await this.custom.state()), safeMode: this.safeMode, disabled: store.disabledPlugins, snapshots: (await this.custom.snapshots()).slice(0, 30) };
    });
    handle('wb:custom-safe-mode', async (_owner, on) => {
      this.safeMode = !!on;
      this.broadcast('wb:custom-change', { safeMode: this.safeMode });
      return this.safeMode;
    });
    handle('wb:custom-toggle-plugin', async (_owner, file, enabled) => {
      const f = str(file, 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.js$/.test(f)) throw new Error('invalid plugin name');
      const store = this.readStore();
      store.disabledPlugins = store.disabledPlugins.filter((x) => x !== f);
      if (!enabled) store.disabledPlugins.push(f);
      this.writeStore(store);
      this.broadcast('wb:custom-change', {});
      return store.disabledPlugins;
    });
    handle('wb:custom-restore', async (_owner, id) => {
      if (!this.custom) throw new Error('customizations are unavailable');
      await this.custom.restore(str(id, 40));
      return true;
    });
    handle('wb:custom-open', async (owner) => {
      if (!this.custom) throw new Error('customizations are unavailable');
      return this.openProject(owner, this.custom.realRoot);
    });
    handle('wb:custom-reveal', async () => { if (this.custom) shell.openPath(this.custom.realRoot); return true; });

    // ----- vault -----
    handle('wb:vault-list', async (owner) => ({ unavailable: this.vault.unavailableReason(), items: this.vault.list(root(owner)), project: owner.project ? owner.project.name : null }));
    handle('wb:vault-set', async (owner, item) => {
      const it = item && typeof item === 'object' ? item : {};
      const res = this.vault.set({
        id: str(it.id, 64) || undefined,
        name: str(it.name, 64),
        value: typeof it.value === 'string' ? it.value : undefined,
        scope: it.scope === 'project' ? 'project' : 'global',
        note: str(it.note, 500),
      }, root(owner));
      this.broadcast('wb:vault-change', {});
      return res;
    });
    handle('wb:vault-reveal', async (owner, id) => this.vault.reveal(str(id, 64), root(owner)));
    handle('wb:vault-delete', async (owner, id) => { const ok = this.vault.remove(str(id, 64), root(owner)); this.broadcast('wb:vault-change', {}); return ok; });
    handle('wb:secret-scan', async (owner) => scanProject(project(owner).root));
    handle('wb:secret-migrate', async (owner, rel) => {
      const res = await this.migrateDotenv(project(owner), str(rel, 4096));
      this.broadcast('wb:vault-change', {});
      return res;
    });

    // ----- sandbox -----
    handle('wb:sandbox-status', async (_owner, fresh) => this.sandbox.status({ fresh: !!fresh }));
    handle('wb:sandbox-network', async (_owner, on) => {
      const store = this.readStore();
      store.sandboxNetwork = !!on;
      this.writeStore(store);
      return store.sandboxNetwork;
    });

    // ----- hubs -----
    handle('wb:hub-pick-parent', async (owner) => {
      let dir = null;
      if (!this.app.isPackaged && process.env.MERIDIAN_TEST_HUB_PARENT) dir = process.env.MERIDIAN_TEST_HUB_PARENT; // dev/test only
      else {
        const win = BrowserWindow.fromWebContents(owner.wc.hostWebContents) || this.getMainWindow();
        const res = await dialog.showOpenDialog(win, { title: 'Where should the hub folder be created?', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] });
        if (res.canceled || !res.filePaths[0]) return null;
        dir = res.filePaths[0];
      }
      owner.hubParent = fs.realpathSync(dir); // only a folder picked in the native dialog can be a parent
      return owner.hubParent;
    });
    handle('wb:hub-create', async (owner, opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (!owner.hubParent) throw new Error('Choose where to create the hub first.');
      const res = await createHub({ parent: owner.hubParent, name: str(o.name, 80), template: str(o.template, 20), git: o.git !== false, skills: o.skills !== false, gitPath: await this.gitPath() });
      const info = this.openProject(owner, res.root);
      return { project: info, git: res.git, committed: !!res.committed, gitReason: res.reason || null };
    });
    handle('wb:hub-info', async (owner) => hubInfo(project(owner).root));
  }

  // meridian://workbench/custom/<rel>: nothing in Safe Mode, nothing for switched-off plugins.
  async serveCustom(rel) {
    if (this.safeMode || !this.custom) return null;
    const m = /^plugins\/([^/]+\.js)$/.exec(rel);
    if (m && this.readStore().disabledPlugins.includes(m[1])) return null;
    return this.custom.serve(rel);
  }

  // git for `git init` in new hubs. On macOS /usr/bin/git is a stub that pops an installer dialog when
  // the Command Line Tools are missing — only use it when they're there.
  async gitPath() {
    const g = which('git', await loginPath());
    if (!g) return null;
    if (process.platform === 'darwin' && g === '/usr/bin/git') {
      const clt = fs.existsSync('/Library/Developer/CommandLineTools/usr/bin/git');
      const xcode = fs.existsSync('/Applications/Xcode.app/Contents/Developer/usr/bin/git');
      if (!clt && !xcode) return null;
    }
    return g;
  }

  // Move the values of a dotenv file into the vault (project scope) and blank them in the file.
  async migrateDotenv(p, rel) {
    if (!DOTENV_FILE.test(rel)) throw new Error('Only .env files can be migrated.');
    const abs = await p.resolve(rel);
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > 256 * 1024) throw new Error('not a .env file');
    const why = this.vault.unavailableReason();
    if (why) throw new Error(why);
    const text = await fs.promises.readFile(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const imported = [];
    const skipped = [];
    for (const e of parseDotenv(text)) {
      if (!e.secret) continue; // ordinary settings (PORT, NODE_ENV…) stay in the file
      if (!NAME_RE.test(e.name) || RESERVED.test(e.name)) { skipped.push(e.name); continue; }
      this.vault.set({ name: e.name, value: e.value, scope: 'project', note: `Imported from ${rel}` }, p.root);
      lines[e.line] = lines[e.line].replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=).*$/, '$1');
      imported.push(e.name);
    }
    const HEADER = '# Values of the empty keys below are stored in the Meridian vault (encrypted) and are set as';
    if (imported.length && !text.includes(HEADER)) {
      lines.unshift(HEADER, '# environment variables in terminals and agents that Meridian starts for this project.');
    }
    if (imported.length) await fs.promises.writeFile(abs, lines.join(eol), { mode: st.mode });
    // Keep it out of git too.
    let gitignored = false;
    if (fs.existsSync(path.join(p.root, '.git'))) {
      const gi = path.join(p.root, '.gitignore');
      let cur = '';
      try { cur = await fs.promises.readFile(gi, 'utf8'); } catch {}
      const entry = '/' + rel;
      const covered = cur.split(/\r?\n/).some((l) => { const t = l.trim(); return t === entry || t === rel || t === '.env*' || t === '.env' && rel === '.env' || (t === '.env.*' && /^\.env\./.test(rel)); });
      if (!covered) { await fs.promises.writeFile(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + entry + '\n'); gitignored = true; }
    }
    return { imported, skipped, gitignored };
  }

  // A Claude Code session wants to read something that looks like a secret file.
  guardDecision(session, req) {
    const run = async () => {
      const owner = session.owner;
      if (!owner || owner.wc.isDestroyed()) return { decision: 'deny', reason: 'The Meridian workbench for this session is gone.' };
      const root = session.root;
      const relOf = (abs) => { const r = path.relative(root, abs); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : null; };
      const keyOf = req.command ? `cmd:${req.command}` : req.paths.join('\n');
      if (session.allowed.has(keyOf)) return { decision: 'allow', reason: 'Allowed for this session in Meridian.' };
      // dotenv files inside the project that still hold values (candidates for "move to vault")
      const candidates = new Set(req.paths.map(relOf).filter(Boolean));
      if (req.command) for (const m of req.command.matchAll(/(?:^|[\s'"=<>|;&(])((?:[\w.-]+\/)*\.env(?:\.[\w-]+)?)(?=$|[\s'";|&)<>])/g)) candidates.add(m[1].replace(/^\.\//, ''));
      const dotenvs = [];
      for (const rel of candidates) {
        if (!DOTENV_FILE.test(rel)) continue;
        try {
          const abs = await owner.project?.resolve(rel);
          if (!abs || owner.project.root !== root) continue;
          const keys = parseDotenv(await fs.promises.readFile(abs, 'utf8')).filter((k) => k.secret).map((k) => k.name);
          if (keys.length) dotenvs.push({ rel, keys });
        } catch {}
      }
      const what = req.command ? 'run a command that reads a secret file' : `read ${req.paths.map((a) => relOf(a) || a).join(', ').slice(0, 300)}`;
      const keyNames = [...new Set(dotenvs.flatMap((d) => d.keys))];
      const detail = [
        req.command ? `Command: ${req.command.slice(0, 400)}` : null,
        keyNames.length ? `It contains ${keyNames.length} key${keyNames.length === 1 ? '' : 's'}: ${keyNames.slice(0, 8).join(', ')}${keyNames.length > 8 ? '…' : ''}.` : null,
        'Whatever an agent reads is sent to the model and kept in the session transcript.',
        keyNames.length ? '“Move keys to vault” stores the values encrypted in Meridian, leaves the keys empty in the file, and gives the values to terminals and agents Meridian starts as environment variables. The agent then sees only the names.' : null,
      ].filter(Boolean).join('\n\n');
      const buttons = keyNames.length ? ['Move keys to vault', 'Block', 'Allow once', 'Allow for this session'] : ['Block', 'Allow once', 'Allow for this session'];
      const win = BrowserWindow.fromWebContents(owner.wc.hostWebContents) || this.getMainWindow();
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', buttons, defaultId: 0, cancelId: buttons.indexOf('Block'), noLink: true,
        message: `${session.agent} wants to ${what}`, detail,
      });
      const choice = buttons[response];
      const available = this.vault.namesFor(root);
      const hint = available.length ? ` Secrets are available to you as environment variables: ${available.slice(0, 20).join(', ')}. Use them by name (e.g. $${available[0]}) and never print their values.` : ' Ask the user to add the keys you need to the Meridian vault; they will be provided as environment variables.';
      if (choice === 'Move keys to vault') {
        const moved = [];
        for (const d of dotenvs) { try { moved.push(...(await this.migrateDotenv(owner.project, d.rel)).imported); } catch (err) { return { decision: 'deny', reason: `Meridian couldn’t move the keys: ${err.message}` }; } }
        this.broadcast('wb:vault-change', {});
        return { decision: 'allow', reason: `The values were moved to the Meridian vault; the file now holds only key names (${moved.join(', ')}). They are set as environment variables in sessions Meridian starts — restart this session to get them.` };
      }
      if (choice === 'Allow for this session') { session.allowed.add(keyOf); return { decision: 'allow', reason: 'Allowed for this session in Meridian.' }; }
      if (choice === 'Allow once') return { decision: 'allow', reason: 'Allowed once in Meridian.' };
      return { decision: 'deny', reason: `The user blocked this in Meridian: files with secrets must not be read.${hint}` };
    };
    // One prompt at a time.
    const next = this.dialogChain.then(run, run);
    this.dialogChain = next.catch(() => {});
    return next;
  }

  readStore() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')); } catch {}
    return {
      recents: Array.isArray(s.recents) ? s.recents.filter((r) => r && typeof r.path === 'string') : [],
      previews: s.previews && typeof s.previews === 'object' ? s.previews : {},
      // Workbench Pro
      disabledPlugins: Array.isArray(s.disabledPlugins) ? s.disabledPlugins.filter((f) => typeof f === 'string').slice(0, 100) : [],
      sandboxNetwork: s.sandboxNetwork !== false,
    };
  }

  writeStore(s) {
    const tmp = this.storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.storeFile);
  }
}

module.exports = { Workbench, INTERNAL_PARTITION, WORKBENCH_URL, isWorkbenchUrl, isWorkbenchResource, isInternalContents };
