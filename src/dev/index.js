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

const { ipcMain, session, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { ProjectFs } = require('./files');
const { PtyManager } = require('./pty');
const { loginPath, childEnv } = require('./env');
const { detect, launchSpec } = require('./agents');

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
    const ok = /^(data|blob):/i.test(url) || url.startsWith('devtools:') || (url.startsWith(ORIGIN + '/') && !!workbenchFile(url));
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
  constructor({ app, getMainWindow, isUiContents, mcpCommand, agentStatus }) {
    this.app = app;
    this.getMainWindow = getMainWindow;
    this.isUiContents = isUiContents;
    this.mcpCommand = mcpCommand;
    this.agentStatus = agentStatus;
    this.ptys = new PtyManager();
    this.owners = new Map(); // webContents id -> { wc, project, zone }
    this.storeFile = path.join(app.getPath('userData'), 'workbench.json');
    this.registerIpc();
    loginPath(); // warm up: resolving the login shell PATH can take a moment
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
      const kind = ['shell', 'claude', 'codex', 'gemini'].includes(opts.kind) ? opts.kind : 'shell';
      const searchPath = await loginPath();
      const spec = launchSpec(kind, { searchPath, mcp: this.mcpCommand(), dataDir: this.app.getPath('userData') });
      const env = await childEnv();
      const info = this.ptys.create(owner.wc, { kind, title: spec.title, file: spec.file, args: spec.args, cwd: p.root, env, cols: opts.cols, rows: opts.rows, cleanup: spec.cleanup });
      return { ...info, notes: spec.notes, browserTools: !!spec.browserTools };
    });
    handle('wb:pty-list', (owner) => this.ptys.list(owner.wc));
    handle('wb:pty-kill', (owner, id) => { this.ptys.kill(owner.wc, id); return true; });
    on('wb:pty-write', (owner, id, data) => this.ptys.write(owner.wc, id, data));
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

  async info(owner) {
    const searchPath = await loginPath();
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

  readStore() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')); } catch {}
    return { recents: Array.isArray(s.recents) ? s.recents.filter((r) => r && typeof r.path === 'string') : [], previews: s.previews && typeof s.previews === 'object' ? s.previews : {} };
  }

  writeStore(s) {
    const tmp = this.storeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, this.storeFile);
  }
}

module.exports = { Workbench, INTERNAL_PARTITION, WORKBENCH_URL, isWorkbenchUrl, isWorkbenchResource, isInternalContents };
