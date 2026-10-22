// Meridian — main process.
// Owns windows, the app menu and keyboard shortcuts (matched here on every webContents so they work
// even when a page has focus), persistence, sessions/profiles, downloads,
// permissions, ad blocking and the Arc importer.

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog, clipboard, nativeTheme, webContents, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { shortcutTable, findShortcut } = require('./shortcuts');
const { importFromArc, arcDataExists } = require('./importers/arc');
const { AgentHub } = require('./agent/hub');
const { Assistant } = require('./ai/assistant');

const APP_NAME = 'Meridian';
app.setName(APP_NAME);
// Dev/test: isolated profile dir so test runs never touch real data.
// Dev/test hooks are ignored in packaged builds (they could otherwise inject code into the UI).
const DEV = !app.isPackaged;
if (DEV && process.env.MERIDIAN_USER_DATA) app.setPath('userData', process.env.MERIDIAN_USER_DATA);

const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
const HISTORY_FILE = () => path.join(app.getPath('userData'), 'history.json');
const FAVICONS_FILE = () => path.join(app.getPath('userData'), 'favicons.json');
const PERMS_FILE = () => path.join(app.getPath('userData'), 'permissions.json');

// Google & co. refuse to sign in from "Electron" user agents. Present as plain Chrome.
const CHROME_UA = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${APP_NAME}\\/\\S+`, 'i'), '')
  .replace(/\smeridian-browser\/\S+/i, '');
app.userAgentFallback = CHROME_UA;

let mainWindow = null;
const miniWindows = new Set();
let pendingUrls = []; // URLs that arrived before the app was ready

// ---------- single instance + default-browser plumbing ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    if (url) openExternalUrl(url);
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) openExternalUrl(url);
  else pendingUrls.push(url);
});

// Links clicked in other apps open in a small "Little" window, like Little Arc.
function openExternalUrl(url) {
  createMiniWindow(url);
}

// ---------- the UI page: served from meridian://app/ (only files under src/renderer) ----------
// A custom privileged scheme instead of file:// lets the file:// fuse stay off, and gives the UI an
// origin no web page or local file can share.

const UI_SCHEME = 'meridian';
const UI_ORIGIN = `${UI_SCHEME}://app`;
const UI_URL = `${UI_ORIGIN}/index.html`;
const RENDERER_DIR = path.join(__dirname, 'renderer');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

// Same as the <meta> CSP in index.html, also sent as a header.
const UI_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

protocol.registerSchemesAsPrivileged([
  { scheme: UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Maps meridian://app/<path> to a file inside src/renderer, or null for anything else.
function uiFilePath(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${UI_SCHEME}:` || u.host !== 'app') return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname); } catch { return null; }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const file = path.resolve(RENDERER_DIR, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return null;
  return file;
}

function registerUiProtocol() {
  protocol.handle(UI_SCHEME, async (req) => {
    const file = req.method === 'GET' ? uiFilePath(req.url) : null;
    const type = file && MIME[path.extname(file).toLowerCase()];
    if (!file || !type) return new Response('Not found', { status: 404 });
    try {
      const body = await fs.promises.readFile(file);
      const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' };
      if (type.startsWith('text/html')) headers['content-security-policy'] = UI_CSP;
      return new Response(body, { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

const uiPageUrl = (query) => (query ? `${UI_URL}?${new URLSearchParams(query)}` : UI_URL);

// ---------- IPC guard ----------
// Every privileged channel only answers our own UI page (meridian://app/index.html).
// Web content lives in <webview> guests and can never reach these handlers, but checking the sender
// keeps it that way even if something is misconfigured later.

const isUiUrl = (url) => url === UI_URL || url.startsWith(UI_URL + '?') || url.startsWith(UI_URL + '#');
const fromUi = (e) => {
  const frame = e.senderFrame;
  return !!frame && !frame.parent && isUiUrl(frame.url || '') && e.sender.getType() === 'window';
};
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromUi(e)) throw new Error('forbidden');
  return fn(e, ...args);
});
const on = (channel, fn) => ipcMain.on(channel, (e, ...args) => {
  if (!fromUi(e)) { e.returnValue = null; return; }
  return fn(e, ...args);
});

// ---------- state persistence ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// Async writes keep the main process (which routes all input) free; one chain per file keeps them in order.
const writeChains = new Map();
function writeJsonAtomicAsync(file, data) {
  const run = async () => {
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, typeof data === 'string' ? data : JSON.stringify(data));
    await fs.promises.rename(tmp, file);
  };
  const next = (writeChains.get(file) || Promise.resolve()).then(run, run);
  writeChains.set(file, next.catch(() => {}));
  return next;
}

// state.json holds spaces/tabs/settings. History and favicons change often and are big, so they live in
// their own files and the UI sends them only when they changed. Older state.json files carry history
// inline; it is moved out on first load.
function loadState() {
  const state = readJson(STATE_FILE(), null);
  if (!state) return null;
  const history = readJson(HISTORY_FILE(), null);
  if (history) state.history = history;
  else if (state.history && Object.keys(state.history).length) writeJsonAtomic(HISTORY_FILE(), state.history);
  state.faviconCache = readJson(FAVICONS_FILE(), {});
  return state;
}

// parts: { state: object | JSON string, history?: object, favicons?: object }. Legacy callers send the
// state object itself (history inline).
function splitStateParts(arg) {
  if (arg && typeof arg === 'object' && 'state' in arg && !('spaces' in arg)) return arg;
  const { history, ...state } = arg || {};
  return { state, history };
}

async function saveStateParts(arg) {
  const { state, history, favicons } = splitStateParts(arg);
  if (history) await writeJsonAtomicAsync(HISTORY_FILE(), history);
  if (favicons) await writeJsonAtomicAsync(FAVICONS_FILE(), favicons);
  if (state) await writeJsonAtomicAsync(STATE_FILE(), state);
  return true;
}

function saveStatePartsSync(arg) {
  const { state, history, favicons } = splitStateParts(arg);
  if (history) writeJsonAtomic(HISTORY_FILE(), history);
  if (favicons) writeJsonAtomic(FAVICONS_FILE(), favicons);
  if (state) writeJsonAtomic(STATE_FILE(), state);
}

handle('state:load', () => loadState());
handle('state:save', (_e, parts) => saveStateParts(parts));
on('state:save-sync', (e, parts) => { try { saveStatePartsSync(parts); } catch {} e.returnValue = true; });

// ---------- sessions (one per profile) ----------

const preparedSessions = new WeakSet();
let blockerPromise = null;
let adblockEnabled = true;

function getBlocker() {
  if (!blockerPromise) {
    blockerPromise = (async () => {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const fetch = require('cross-fetch');
      const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
      return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: cache,
        read: fs.promises.readFile,
        write: fs.promises.writeFile,
      });
    })().catch((err) => { console.error('adblock init failed', err); blockerPromise = null; return null; });
  }
  return blockerPromise;
}

async function applyAdblock(ses) {
  const blocker = await getBlocker();
  if (!blocker) return;
  const on = blocker.isBlockingEnabled(ses);
  if (adblockEnabled && !on) blocker.enableBlockingInSession(ses);
  if (!adblockEnabled && on) blocker.disableBlockingInSession(ses);
}

const knownSessions = new Set();

function prepareSession(ses) {
  if (preparedSessions.has(ses)) return;
  preparedSessions.add(ses);
  knownSessions.add(ses);
  ses.setUserAgent(CHROME_UA);
  ses.on('will-download', handleDownload);
  ses.setPermissionRequestHandler(handlePermissionRequest);
  ses.setDevicePermissionHandler(() => false); // WebUSB / WebHID / Web Serial: off
  ses.on('select-hid-device', (event, _d, callback) => { event.preventDefault(); callback(); });
  ses.on('select-serial-port', (event, _p, _wc, callback) => { event.preventDefault(); callback(''); });
  ses.on('select-usb-device', (event, _d, callback) => { event.preventDefault(); callback(); });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (SAFE_PERMISSIONS.has(permission)) return true;
    return permissionDecisions[`${originOf(origin)}|${permission}`] === true;
  });
  applyAdblock(ses);
  for (const ext of loadedExtensionPaths) loadExtensionInto(ses, ext);
}

handle('adblock:set', async (_e, enabled) => {
  adblockEnabled = !!enabled;
  for (const ses of knownSessions) await applyAdblock(ses);
  return adblockEnabled;
});

handle('profile:clear-data', async (_e, partition) => {
  await session.fromPartition(partition).clearStorageData();
  return true;
});

// ---------- extensions (experimental: Electron supports a subset of the Chrome APIs) ----------

let loadedExtensionPaths = [];

async function loadExtensionInto(ses, extPath) {
  try {
    const api = ses.extensions || ses;
    await api.loadExtension(extPath, { allowFileAccess: true });
  } catch (err) {
    console.warn('extension failed', extPath, err.message);
  }
}

handle('extensions:set', async (_e, paths) => {
  loadedExtensionPaths = paths || [];
  for (const ses of knownSessions) for (const p of loadedExtensionPaths) await loadExtensionInto(ses, p);
  return true;
});

handle('extensions:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose an unpacked extension folder (with manifest.json)',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    dialog.showErrorBox('Not an extension', 'That folder has no manifest.json.');
    return null;
  }
  return dir;
});

// ---------- permissions ----------

const SAFE_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management']);
const PERMISSION_LABELS = {
  media: 'use your camera / microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'record your screen',
  openExternal: 'open an external application',
};
let permissionDecisions = {};

function originOf(url) {
  try { return new URL(url).origin; } catch { return String(url); }
}

function siteLabel(origin) {
  try { return new URL(origin).host || origin; } catch { return origin || 'This page'; }
}

async function handlePermissionRequest(wc, permission, callback, details) {
  if (SAFE_PERMISSIONS.has(permission)) return callback(true);
  const win = BrowserWindow.fromWebContents(wc.hostWebContents || wc) || mainWindow;
  const origin = originOf(details.requestingUrl || wc.getURL());

  // External protocols (also reached via server redirects): allowlisted schemes only, URL shown, never remembered.
  if (permission === 'openExternal') {
    const url = details.externalURL || '';
    if (!EXTERNAL_SCHEMES.has(schemeOf(url))) return callback(false);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `${siteLabel(origin)} wants to open another app`, detail: url.length > 300 ? url.slice(0, 300) + '…' : url,
    });
    return callback(response === 0);
  }

  // Camera and microphone are separate decisions.
  const kind = permission === 'media' ? `media:${(details.mediaTypes || []).slice().sort().join('+') || 'any'}` : permission;
  const key = `${origin}|${kind}`;
  if (key in permissionDecisions) return callback(permissionDecisions[key]);
  let what = PERMISSION_LABELS[permission] || permission;
  if (permission === 'media') {
    const t = details.mediaTypes || [];
    what = t.includes('video') && t.includes('audio') ? 'use your camera and microphone' : t.includes('video') ? 'use your camera' : 'use your microphone';
  }
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', 'Block'],
    defaultId: 1,
    cancelId: 1,
    message: `${siteLabel(origin)} wants to ${what}`,
    checkboxLabel: 'Remember for this site',
    checkboxChecked: false,
  });
  const allowed = response === 0;
  if (checkboxChecked) {
    permissionDecisions[key] = allowed;
    writeJsonAtomic(PERMS_FILE(), permissionDecisions);
  }
  callback(allowed);
}

// ---------- client certificates ----------

app.on('select-client-certificate', async (event, wc, url, list, callback) => {
  event.preventDefault();
  if (!list.length) return callback();
  const win = BrowserWindow.fromWebContents(wc.hostWebContents || wc) || mainWindow;
  const buttons = [...list.slice(0, 5).map((c) => c.subjectName || c.issuerName || 'Certificate'), 'Don’t send'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons, cancelId: buttons.length - 1, defaultId: buttons.length - 1,
    message: `${siteLabel(originOf(url))} asks for a client certificate`,
  });
  callback(response < list.length && response < 5 ? list[response] : undefined);
});

// ---------- downloads ----------

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

// Files that run code when opened. Asking before keeping them, like Chrome's "dangerous file" warning.
const DANGEROUS_EXT = new Set(['.exe', '.msi', '.msix', '.appx', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.hta', '.reg', '.lnk', '.cpl', '.jar', '.command', '.tool', '.app', '.pkg', '.mpkg', '.terminal', '.workflow', '.scpt', '.sh', '.bash', '.zsh', '.run', '.appimage', '.deb', '.rpm', '.desktop', '.html', '.htm', '.svg', '.xhtml', '.mht', '.mhtml']);
const recentDownloads = new Map(); // origin -> timestamps
const multiDownloadDecision = new Map(); // origin -> boolean (this session)

function handleDownload(_event, item, wc) {
  const target = uniquePath(app.getPath('downloads'), item.getFilename());
  item.setSavePath(target);
  const origin = originOf(wc && !wc.isDestroyed() ? wc.getURL() : item.getURL());
  const ext = path.extname(target).toLowerCase();
  const now = Date.now();
  const times = (recentDownloads.get(origin) || []).filter((t) => now - t < 10_000);
  times.push(now);
  recentDownloads.set(origin, times);
  const burst = times.length > 3 && multiDownloadDecision.get(origin) !== true;
  if (multiDownloadDecision.get(origin) === false) { item.cancel(); return; }
  if (DANGEROUS_EXT.has(ext) || burst) {
    item.pause();
    const win = (wc && BrowserWindow.fromWebContents(wc.hostWebContents || wc)) || mainWindow;
    dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Keep', 'Discard'], defaultId: 1, cancelId: 1,
      message: burst ? `${siteLabel(origin)} is trying to download multiple files` : `“${path.basename(target)}” can run code on your computer`,
      detail: burst ? 'Allow this site to keep downloading files?' : `From ${siteLabel(origin)}. Only keep it if you trust this site.`,
    }).then(({ response }) => {
      if (burst) multiDownloadDecision.set(origin, response === 0);
      if (response === 0) item.resume(); else item.cancel();
    });
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const send = (extra) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('download', {
    id, name: path.basename(target), path: target,
    received: item.getReceivedBytes(), total: item.getTotalBytes(), ...extra,
  });
  send({ state: 'started' });
  item.on('updated', (_e, state) => send({ state }));
  item.once('done', (_e, state) => {
    send({ state });
    if (state === 'completed' && process.platform === 'darwin') app.dock.downloadFinished(target);
  });
}

on('download:reveal', (_e, p) => shell.showItemInFolder(p));
handle('permissions:reset', () => { permissionDecisions = {}; writeJsonAtomic(PERMS_FILE(), {}); return true; });

// ---------- URL scheme policy ----------

const WEB_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:']);
const SUBFRAME_SCHEMES = new Set([...WEB_SCHEMES, 'chrome-extension:']);
const EXTERNAL_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'facetime:', 'zoommtg:', 'msteams:', 'slack:', 'tg:', 'spotify:', 'vscode:', 'figma:', 'notion:', 'linear:', 'obsidian:']);
const schemeOf = (url) => { try { return new URL(url).protocol; } catch { return ''; } };

// Pages may link to mailto:/zoom:/… — ask before handing those to another app. Never file:, javascript: etc.
async function maybeOpenExternal(url, contents) {
  const scheme = schemeOf(url);
  if (!EXTERNAL_SCHEMES.has(scheme)) return;
  const win = BrowserWindow.fromWebContents(contents.hostWebContents || contents) || mainWindow;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Open', 'Cancel'], defaultId: 0, cancelId: 1,
    message: `Open this link in another app?`, detail: url.length > 300 ? url.slice(0, 300) + '…' : url,
  });
  if (response === 0) shell.openExternal(url);
}

// ---------- webview wiring: hardening, popups, context menu ----------

// Force safe settings on every <webview> no matter what the embedder asked for.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    const scheme = schemeOf(params.src);
    if (params.src && !WEB_SCHEMES.has(scheme) && scheme !== 'file:') event.preventDefault();
    if (!String(params.partition || '').startsWith('persist:profile-')) event.preventDefault();
  });
});

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  prepareSession(contents.session);

  // Page-initiated navigation: web pages can't jump to file:// or other privileged schemes.
  const guardNavigation = (event, url) => {
    const scheme = schemeOf(url);
    if (WEB_SCHEMES.has(scheme)) return;
    if (scheme === 'file:' && schemeOf(contents.getURL()) === 'file:') return;
    event.preventDefault();
    maybeOpenExternal(url, contents);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', (event, url) => { if (!WEB_SCHEMES.has(schemeOf(url))) event.preventDefault(); });
  // Bluetooth device picker: never auto-pick a nearby device.
  contents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
  contents.on('will-frame-navigate', (event) => { if (!event.isMainFrame && !SUBFRAME_SCHEMES.has(schemeOf(event.url))) event.preventDefault(); });

  contents.setWindowOpenHandler(({ url, disposition }) => {
    const scheme = schemeOf(url);
    if (!(scheme === 'http:' || scheme === 'https:' || url === 'about:blank')) {
      maybeOpenExternal(url, contents);
      return { action: 'deny' };
    }
    // Real popups (OAuth, payment windows) must stay real windows so window.opener works.
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 720, autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: undefined },
        },
      };
    }
    sendToHost(contents, 'webview:open', { url, disposition, fromId: contents.id });
    return { action: 'deny' };
  });

  // Popup windows opened by pages get the same navigation rules.
  contents.on('did-create-window', (win) => {
    win.webContents.on('will-navigate', (event, url) => { if (!WEB_SCHEMES.has(schemeOf(url))) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && mainWindow) mainWindow.webContents.send('command', 'open-url-tab', url);
      return { action: 'deny' };
    });
  });

  contents.on('context-menu', (_ev, params) => showPageContextMenu(contents, params));
  // Esc inside a page still closes Peek / the find bar (pages keep receiving it too).
  contents.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') sendToHost(contents, 'webview:escape', { fromId: contents.id });
  });
});

// ---------- keyboard shortcuts ----------
// Matched before the page sees the key, on the UI windows and on every guest page. preventDefault()
// also stops the menu accelerator, so a shortcut fires exactly once.

const SHORTCUTS = shortcutTable();

// The UI window a webContents belongs to (pages in <webview>s report to their embedder), or null for
// page-opened popups and devtools, which keep plain menu behaviour.
function uiWindowFor(contents) {
  const owner = contents.getType() === 'webview' ? contents.hostWebContents : contents;
  if (!owner || owner.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(owner);
  return win && (win === mainWindow || miniWindows.has(win)) && owner === win.webContents ? win : null;
}

function runShortcut(sc, win) {
  if (sc.run === 'mini-window') return createMiniWindow('');
  if (sc.run === 'new-window') { if (!mainWindow) createMainWindow(); else mainWindow.focus(); return; }
  if (sc.run === 'ui-devtools') return win?.webContents.openDevTools({ mode: 'detach' });
  if (win && !win.isDestroyed()) win.webContents.send('command', ...sc.cmd);
}

app.on('web-contents-created', (_e, contents) => {
  const type = contents.getType();
  if (type !== 'webview' && type !== 'window') return;
  contents.on('before-input-event', (event, input) => {
    const sc = findShortcut(SHORTCUTS, input);
    if (!sc) return;
    const win = uiWindowFor(contents);
    if (!win) return;
    event.preventDefault();
    if (input.isAutoRepeat && !sc.repeat) return;
    runShortcut(sc, win);
  });
});

function sendToHost(contents, channel, payload) {
  const host = contents.hostWebContents;
  if (host && !host.isDestroyed()) host.send(channel, payload);
}

function showPageContextMenu(contents, params) {
  const t = [];
  const act = (action, data = {}) => () => sendToHost(contents, 'webview:action', { action, fromId: contents.id, ...data });

  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    t.push(
      { label: 'Open Link in New Tab', click: act('open-tab', { url: params.linkURL }) },
      { label: 'Open Link in Split View', click: act('open-split', { url: params.linkURL }) },
      { label: 'Open Link in Peek', click: act('open-peek', { url: params.linkURL }) },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  if (params.mediaType === 'image' && /^(https?|data|blob):/i.test(params.srcURL || '')) {
    t.push(
      { label: 'Open Image in New Tab', click: act('open-tab', { url: params.srcURL }) },
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
      { label: 'Save Image…', click: () => contents.downloadURL(params.srcURL) },
      { type: 'separator' },
    );
  }
  if (params.selectionText) {
    const text = params.selectionText.trim();
    t.push(
      { label: 'Copy', role: 'copy' },
      { label: `Search for “${text.length > 30 ? text.slice(0, 30) + '…' : text}”`, click: act('search', { text }) },
      { type: 'separator' },
    );
  }
  if (params.isEditable) {
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      for (const s of params.dictionarySuggestions.slice(0, 5)) {
        t.push({ label: s, click: () => contents.replaceMisspelling(s) });
      }
      t.push({ type: 'separator' });
    }
    t.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
  }
  t.push(
    { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
    { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Copy Page URL', click: () => clipboard.writeText(contents.getURL()) },
    { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) },
  );
  Menu.buildFromTemplate(t).popup();
}

// Generic native context menu for the sidebar: renderer sends items, gets back the chosen id.
handle('menu:popup', (e, items) => new Promise((resolve) => {
  let chosen = null;
  const build = (list) => list.map((it) => {
    if (it.type === 'separator') return { type: 'separator' };
    if (it.submenu) return { label: it.label, submenu: build(it.submenu) };
    return { label: it.label, enabled: it.enabled !== false, checked: it.checked, type: it.checked !== undefined ? 'checkbox' : 'normal', click: () => { chosen = it.id; } };
  });
  const menu = Menu.buildFromTemplate(build(items));
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(chosen), 0) });
}));

on('clipboard:write', (_e, text) => clipboard.writeText(text));

// Favicons: fetched by main through the tab's own profile session and handed to the UI as data: URLs,
// so the privileged UI page never loads page-chosen URLs itself.
handle('favicon:fetch', async (_e, url, partition) => {
  if (!/^https?:/i.test(String(url)) || !String(partition).startsWith('persist:profile-')) return null;
  try {
    const res = await session.fromPartition(partition).fetch(url, { signal: AbortSignal.timeout(8000) });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp|ico)$/i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 200_000) return null;
    // SVG can carry script; rasterize-free option is to refuse it.
    if (/svg/i.test(type)) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
});

// Current page text for the ⌘J panel, read in an isolated world so the page can't spoof it.
handle('ai:page-text', async (e, wcId) => {
  const wc = webContents.fromId(Number(wcId));
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents?.id !== e.sender.id) return null;
  try { return await hub.pageTextFor(wc); } catch { return null; }
});
handle('devtools:open', (_e, id) => { const wc = webContents.fromId(id); if (wc) wc.openDevTools({ mode: 'detach' }); });

// ---------- AI: agent hub (MCP + assistant tools) and the built-in assistant ----------

let hub = null;
let assistant = null;

function mcpCommand() {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'meridian-mcp.cjs')
    : path.join(__dirname, '..', 'mcp', 'meridian-mcp.js');
  return { command: 'node', args: [script], claudeCode: `claude mcp add meridian -- node "${script}"` };
}

handle('agent:config', (_e, cfg) => { hub.setConfig(cfg || {}); return hub.status(); });
handle('agent:status', () => ({ ...hub.status(), mcp: mcpCommand() }));
handle('agent:pause', (_e, paused) => { hub.paused = !!paused; return hub.paused; });
on('agent:rpc-result', (e, payload) => hub.onRpcResult(e.sender, payload || {}));

handle('ai:has-key', () => assistant.hasKey());
handle('ai:set-key', (_e, key) => { assistant.setKey(typeof key === 'string' ? key : ''); return assistant.hasKey(); });
on('ai:chat', (e, req) => { assistant.chat(e.sender, req || {}); });
on('ai:stop', (_e, sessionId) => assistant.stop(sessionId));
on('ai:reset', (_e, sessionId) => assistant.reset(sessionId));

// ---------- Arc import ----------

handle('import:arc-available', () => arcDataExists());
handle('import:arc', () => importFromArc());

// ---------- default browser ----------

handle('default-browser:set', () => {
  const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  return { ok, packaged: app.isPackaged };
});
handle('default-browser:is', () => app.isDefaultProtocolClient('https'));

// ---------- windows ----------

const IS_MAC = process.platform === 'darwin';

function baseWindowOptions(extra) {
  // macOS: inset traffic lights over a translucent sidebar. Windows/Linux: frameless with the
  // native window controls drawn over the top-right corner (titleBarOverlay).
  const chrome = IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
    : {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8ee' : '#3a3a44', height: 36 },
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b20' : '#e9e9f0',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '..', 'build', 'icon-1024.png'),
      };
  return {
    ...chrome,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
    ...extra,
  };
}

function createMainWindow() {
  const bounds = readJson(path.join(app.getPath('userData'), 'window.json'), { width: 1440, height: 900 });
  mainWindow = new BrowserWindow(baseWindowOptions({ ...bounds, minWidth: 640, minHeight: 420, title: APP_NAME }));
  mainWindow.loadURL(uiPageUrl());
  mainWindow.once('ready-to-show', () => {
    if (bounds.maximized) mainWindow.maximize();
    if (DEV && process.env.MERIDIAN_SHOT) mainWindow.showInactive(); else mainWindow.show();
  });
  const saveBounds = () => {
    if (mainWindow.isDestroyed()) return;
    writeJsonAtomic(path.join(app.getPath('userData'), 'window.json'), { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resize', debounce(saveBounds, 500));
  mainWindow.on('move', debounce(saveBounds, 500));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (DEV && process.env.MERIDIAN_SHOT) runScreenshotScript(mainWindow);
  return mainWindow;
}

function createMiniWindow(url = '') {
  const win = new BrowserWindow(baseWindowOptions({ width: 820, height: 640, minWidth: 360, minHeight: 300, title: APP_NAME }));
  win.loadURL(uiPageUrl({ mini: '1', url }));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  miniWindows.add(win);
  win.on('closed', () => miniWindows.delete(win));
  return win;
}

// Little window → "Open in Meridian": move the URL into the main window as a tab.
on('mini:promote', (e, url) => {
  const win = mainWindow || createMainWindow();
  const deliver = () => { win.webContents.send('command', 'open-url-tab', url); win.show(); win.focus(); };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver); else deliver();
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// Dev/test: MERIDIAN_SHOT=out.png MERIDIAN_STEPS='[{"js":"...","wait":2000,"shot":"a.png"}]'
function runScreenshotScript(win) {
  const steps = JSON.parse(process.env.MERIDIAN_STEPS || '[{"wait":3000}]');
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  win.webContents.once('did-finish-load', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const st of steps) {
      try {
        if (st.js) console.log('[eval]', JSON.stringify(await win.webContents.executeJavaScript(st.js)));
        // {"key":"Right","modifiers":["meta","alt"],"to":"page"} — a keypress sent to the active tab's page
        // ("to":"page") or to whatever has focus.
        if (st.key) {
          const pageId = st.to === 'page' ? await win.webContents.executeJavaScript('webview()?.getWebContentsId() || 0') : 0;
          const target = (pageId && webContents.fromId(pageId)) || webContents.getFocusedWebContents() || win.webContents;
          console.log('[key]', st.key, (st.modifiers || []).join('+'), '->', target.getType());
          target.sendInputEvent({ type: 'keyDown', keyCode: st.key, modifiers: st.modifiers || [] });
          if (st.key.length === 1 && !(st.modifiers || []).length) target.sendInputEvent({ type: 'char', keyCode: st.key });
          target.sendInputEvent({ type: 'keyUp', keyCode: st.key, modifiers: st.modifiers || [] });
        }
      } catch (err) { console.log('[eval error]', err.message); }
      await sleep(st.wait || 500);
      if (st.shot) fs.writeFileSync(st.shot, (await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(process.env.MERIDIAN_SHOT, (await win.webContents.capturePage()).toPNG());
    app.exit(0);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- menu: shows every shortcut; clicks (and keys nothing else caught) go to the focused UI window ----------

function targetWindow() {
  const win = BrowserWindow.getFocusedWindow();
  return win && (win === mainWindow || miniWindows.has(win)) ? win : mainWindow;
}

function cmd(name, ...args) {
  return () => {
    const win = targetWindow();
    if (win && !win.isDestroyed()) win.webContents.send('command', name, ...args);
  };
}

// A menu item for a shortcut from the table. Shortcuts handled in before-input-event aren't registered
// as accelerators on Windows/Linux (macOS has no such option; preventDefault() there stops the menu).
function sc(label, id, extra = {}) {
  const s = SHORTCUTS.find((x) => x.id === id);
  return {
    label, accelerator: s.accel, registerAccelerator: !!s.soft,
    click: () => runShortcut(s, targetWindow()),
    ...extra,
  };
}

function buildMenu() {
  const spaceItems = [];
  for (let i = 1; i <= 9; i++) spaceItems.push(sc(`Space ${i}`, `space-${i}`));
  const tabItems = [];
  for (let i = 1; i <= 9; i++) tabItems.push(sc(`Tab ${i}`, `tab-${i}`));

  const template = [
    IS_MAC ? {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        sc('Settings…', 'settings'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    } : null,
    {
      label: 'File',
      submenu: [
        ...(IS_MAC ? [] : [sc('Settings…', 'settings'), { type: 'separator' }]),
        sc('New Tab…', 'command-bar'),
        sc('New Little Window', 'mini-window'),
        sc('New Window', 'new-window'),
        sc('New Folder', 'new-folder'),
        { type: 'separator' },
        sc('Open Location…', 'edit-url'),
        sc('Reopen Closed Tab', 'reopen-tab'),
        { type: 'separator' },
        sc('Close Tab', 'close-tab'),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        { type: 'separator' },
        { label: 'Import from Arc…', click: cmd('import-arc') },
        ...(IS_MAC ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        sc('Copy URL', 'copy-url'),
        sc('Find…', 'find'),
        sc('Find Next', 'find-next'),
        sc('Find Previous', 'find-prev'),
      ],
    },
    {
      label: 'View',
      submenu: [
        sc('Toggle Sidebar', 'toggle-sidebar'),
        sc('Ask AI about Page', 'ai-panel'),
        sc('Split View', 'split'),
        sc('Close Split View', 'unsplit'),
        { type: 'separator' },
        sc('Reload', 'reload'),
        sc('Hard Reload', 'hard-reload'),
        sc('Zoom In', 'zoom-in'),
        sc('Zoom In ', 'zoom-in-plus', { visible: false }),
        sc('Zoom Out', 'zoom-out'),
        sc('Actual Size', 'zoom-reset'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        sc('Developer Tools (page)', 'devtools'),
        sc('Developer Tools (Meridian UI)', 'ui-devtools'),
      ],
    },
    {
      label: 'History',
      submenu: [
        sc('Back', 'back'),
        sc('Forward', 'forward'),
        sc('Back ', 'back-arrow', { visible: false }),
        sc('Forward ', 'forward-arrow', { visible: false }),
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        sc('Pin / Unpin Tab', 'toggle-pin'),
        { label: 'Add to Favorites', click: cmd('favorite') },
        sc('Next Tab', 'next-tab'),
        sc('Previous Tab', 'prev-tab'),
        sc('Next Tab ', 'next-tab-arrow', { visible: false }),
        sc('Previous Tab ', 'prev-tab-arrow', { visible: false }),
        sc('Clear Today Tabs', 'clear-today'),
        { type: 'separator' },
        ...tabItems,
      ],
    },
    {
      label: 'Spaces',
      submenu: [
        { label: 'New Space…', click: cmd('new-space') },
        sc('Next Space', 'next-space'),
        sc('Previous Space', 'prev-space'),
        { type: 'separator' },
        ...spaceItems,
      ],
    },
    { role: 'windowMenu' },
  ].filter(Boolean);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------

app.whenReady().then(() => {
  permissionDecisions = readJson(PERMS_FILE(), {});
  const saved = readJson(STATE_FILE(), null);
  if (saved && saved.settings) {
    adblockEnabled = saved.settings.adblock !== false;
    loadedExtensionPaths = saved.settings.extensions || [];
  }
  hub = new AgentHub({ getWindow: () => mainWindow, userDataDir: app.getPath('userData') });
  assistant = new Assistant({ userDataDir: app.getPath('userData'), hub });
  if (saved?.settings) hub.setConfig({ access: saved.settings.agentAccess || 'off', allowJs: !!saved.settings.agentAllowJs });
  registerUiProtocol();
  buildMenu();
  createMainWindow();
  for (const url of pendingUrls) openExternalUrl(url);
  pendingUrls = [];
  const argUrl = process.argv.slice(1).find((a) => /^https?:\/\//i.test(a));
  if (argUrl) openExternalUrl(argUrl);

  app.on('activate', () => { if (!mainWindow) createMainWindow(); });
});

app.on('will-quit', () => { hub?.stopServer(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
