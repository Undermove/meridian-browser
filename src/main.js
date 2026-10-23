// Meridian — main process.
// Owns windows, the app menu and keyboard shortcuts (matched here on every webContents so they work
// even when a page has focus), persistence, sessions/profiles, downloads,
// permissions, ad blocking and the Arc importer.

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog, clipboard, nativeTheme, webContents, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { shortcutTable, findShortcut, acceleratorFromInput, formatAccelerator } = require('./shortcuts');
const { routeLink, sanitizeAtc } = require('./atc');
const { validatePatch } = require('./settings-schema');
const { detectClis, connectCli } = require('./mcp-connect');
const { importFromArc, arcDataExists, arcRoot, setArcRootOverride } = require('./importers/arc');
const { importArcCookies, findArcProfiles, keychainPassword } = require('./importers/arc-cookies');
const { AgentHub } = require('./agent/hub');
const { Assistant, describeError: describeAiError } = require('./ai/assistant');
const { LocalAgents, PROVIDERS: AGENT_PROVIDERS } = require('./ai/local-agents');
const { openInTerminal } = require('./ai/agent-setup');
const { ChatsStore } = require('./ai/chats-store');
const { meridianGuide } = require('./ai/guide');
const { MissionControl } = require('./agents/mission'); // Mission Control
const { tidyToday, LinkPreviews } = require('./ai/features');
const { Workbench, isInternalContents, isWorkbenchResource } = require('./dev'); // Workbench (mini IDE), see src/dev/index.js

const APP_NAME = 'Meridian';
app.setName(APP_NAME);
// Dev/test: isolated profile dir so test runs never touch real data.
// Dev/test hooks are ignored in packaged builds (they could otherwise inject code into the UI).
const DEV = !app.isPackaged;
if (DEV && process.env.MERIDIAN_USER_DATA) app.setPath('userData', process.env.MERIDIAN_USER_DATA);
// Dev/test: a fake Arc data folder (StorableSidebar.json + "User Data") instead of the real one.
if (DEV && process.env.MERIDIAN_ARC_DIR) setArcRootOverride(process.env.MERIDIAN_ARC_DIR);

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
const privateWindows = new Map(); // BrowserWindow -> in-memory partition name
let settingsWindow = null;
let pendingUrls = []; // URLs that arrived before the app was ready
const REPO_URL = 'https://github.com/meridian-browser/meridian'; // placeholder until the public repo exists

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

// Links clicked in other apps go where Air Traffic Control says (Settings → Links): the Little window
// (like Little Arc) by default, or a tab in a chosen space.
function openExternalUrl(url) {
  if (!/^https?:\/\//i.test(String(url))) return;
  const settings = uiSnapshot?.settings || {};
  const spaceIds = (uiSnapshot?.spaces || []).map((s) => s.id);
  const route = routeLink(settings.atc, url, spaceIds);
  if (route.target === 'little') return createMiniWindow(url);
  deliverToMain(route.target === 'space' ? 'open-url-in-space' : 'open-url-tab', ...(route.target === 'space' ? [route.spaceId, url] : [url]));
  const win = mainWindow;
  if (win) { win.show(); win.focus(); }
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
// Only the main window's UI may write state.json or describe it (private and Little windows never persist).
const fromMainUi = (e) => fromUi(e) && !!mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents;
const handleMain = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromMainUi(e)) throw new Error('forbidden');
  return fn(e, ...args);
});
const onMain = (channel, fn) => ipcMain.on(channel, (e, ...args) => {
  if (!fromMainUi(e)) { e.returnValue = null; return; }
  return fn(e, ...args);
});

// The Settings window is its own page (meridian://app/settings.html) with its own preload, and talks
// only to settings:* channels. Same checks as fromUi, plus it must be *the* settings window.
const SETTINGS_URL = `${UI_ORIGIN}/settings.html`;
const isSettingsUrl = (url) => url === SETTINGS_URL || url.startsWith(SETTINGS_URL + '?') || url.startsWith(SETTINGS_URL + '#');
const fromSettings = (e) => {
  const frame = e.senderFrame;
  return !!frame && !frame.parent && isSettingsUrl(frame.url || '') && e.sender.getType() === 'window'
    && !!settingsWindow && !settingsWindow.isDestroyed() && e.sender === settingsWindow.webContents;
};
const handleSettings = (channel, fn) => ipcMain.handle(channel, (e, ...args) => {
  if (!fromSettings(e)) throw new Error('forbidden');
  return fn(e, ...args);
});

// Workbench integration: is this webContents Meridian's own UI window?
const isUiContents = (wc) => {
  const url = wc && !wc.isDestroyed() ? wc.getURL() : '';
  return (url === UI_URL || url.startsWith(UI_URL + '?') || url.startsWith(UI_URL + '#')) && wc.getType() === 'window';
};

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
function writeJsonAtomicAsync(file, data, { mode } = {}) {
  const run = async () => {
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, typeof data === 'string' ? data : JSON.stringify(data), mode ? { mode } : undefined);
    if (mode) await fs.promises.chmod(tmp, mode); // writeFile's mode only applies to a new file
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
  // A bare string is the state JSON itself (destructuring it below would write an object of characters).
  if (typeof arg === 'string') return { state: arg };
  if (!arg || typeof arg !== 'object') return {};
  if ('state' in arg && !('spaces' in arg)) return arg;
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
handleMain('state:save', (_e, parts) => saveStateParts(parts));
onMain('state:save-sync', (e, parts) => { try { saveStatePartsSync(parts); } catch {} e.returnValue = true; });

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

// Ghostery registers its cosmetic-filter IPC handlers process-wide on every enable (and removes them on
// every disable), so a second profile session threw "second handler" and got no network blocking. The
// handlers only call into the one shared blocker, so clear them before enabling and restore them after a
// disable while other sessions still block.
const GHOSTERY_CHANNELS = ['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled'];
async function applyAdblock(ses) {
  const blocker = await getBlocker();
  if (!blocker) return;
  const on = blocker.isBlockingEnabled(ses);
  if (adblockEnabled && !on) {
    GHOSTERY_CHANNELS.forEach((c) => ipcMain.removeHandler(c));
    blocker.enableBlockingInSession(ses);
  }
  if (!adblockEnabled && on) {
    blocker.disableBlockingInSession(ses);
    if ([...knownSessions].some((x) => x !== ses && blocker.isBlockingEnabled(x))) {
      ipcMain.handle(GHOSTERY_CHANNELS[0], (e, url, msg) => blocker.onInjectCosmeticFilters(e, url, msg));
      ipcMain.handle(GHOSTERY_CHANNELS[1], (e) => blocker.onIsMutationObserverEnabled(e));
    }
  }
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
  installFilePolicy(ses);
  applyAdblock(ses);
  for (const ext of loadedExtensionPaths) loadExtensionInto(ses, ext);
}

// Local files: a file:// page opened in a tab (a typed or dropped local HTML file) is shown, but it can't
// load or read other local files — no fetch/XHR, <img>, <script>, <iframe>… of file:// URLs, only the page
// itself. (Electron would otherwise let file:// pages read any file, e.g. ~/.ssh, and send it anywhere.)
// Electron keeps one onBeforeRequest listener per session and the ad blocker sets its own, so ours wraps
// session.webRequest.onBeforeRequest and runs the ad blocker's listener after the file check.
const stripHash = (u) => String(u || '').split('#')[0];
function fileRequestAllowed(details) {
  if (details.resourceType === 'mainFrame') return true; // navigations are policed by guardNavigation
  let page = '';
  try { page = details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() : ''; } catch {}
  return !!page && stripHash(page) === stripHash(details.url);
}
function installFilePolicy(ses) {
  const wr = ses.webRequest;
  const register = wr.onBeforeRequest.bind(wr);
  let inner = null;
  const policy = (details, callback) => {
    if (/^file:/i.test(details.url)) return callback(fileRequestAllowed(details) ? {} : { cancel: true });
    if (inner) return inner(details, callback);
    callback({});
  };
  // Without another listener only file:// requests pay for the hop into JS.
  const apply = () => (inner ? register(policy) : register({ urls: ['file://*/*'] }, policy));
  wr.onBeforeRequest = (filter, listener) => { inner = typeof filter === 'function' ? filter : listener || null; apply(); };
  apply();
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

handle('extensions:pick', () => pickExtensionDir(mainWindow));

async function pickExtensionDir(parent) {
  const res = await dialog.showOpenDialog(parent, {
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
}

// ---------- permissions ----------

// 'window-management' (screen layout + placing windows on any display) is not auto-granted: it falls
// through to the normal ask/deny path like other powerful permissions.
const SAFE_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const PERMISSION_LABELS = {
  media: 'use your camera / microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'record your screen',
  openExternal: 'open an external application',
  'window-management': 'see your displays and place windows on them',
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
    if (!hadRecentGesture(wc)) return callback(false);
    lastGesture.delete(wc);
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
const DANGEROUS_EXT = new Set(['.exe', '.msi', '.msix', '.appx', '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.hta', '.reg', '.lnk', '.cpl', '.jar', '.command', '.tool', '.app', '.pkg', '.mpkg', '.terminal', '.workflow', '.scpt', '.sh', '.bash', '.zsh', '.run', '.appimage', '.deb', '.rpm', '.desktop', '.html', '.htm', '.svg', '.xhtml', '.mht', '.mhtml',
  // disk images / installers, link files that open URLs or apps, macro-enabled Office documents
  '.dmg', '.iso', '.img', '.webloc', '.fileloc', '.url', '.inetloc', '.docm', '.xlsm', '.pptm', '.dotm', '.xltm', '.potm', '.ppsm', '.xlam', '.ppam']);
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
  // Progress goes to the window the download came from (a private window keeps its own list).
  const owner = (wc && !wc.isDestroyed() && uiWindowFor(wc)) || mainWindow;
  const send = (extra) => owner && !owner.isDestroyed() && owner.webContents.send('download', {
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
// Only right after the user clicked or typed in that page (like Chrome's user activation): a page can't
// pop "open another app?" prompts on its own, and a stray Enter answers Cancel.
const lastGesture = new WeakMap(); // webContents -> time of the last mouse down / key down in it
const GESTURE_MS = 5000;
const hadRecentGesture = (contents) => Date.now() - (lastGesture.get(contents) || 0) < GESTURE_MS;
async function maybeOpenExternal(url, contents) {
  const scheme = schemeOf(url);
  if (!EXTERNAL_SCHEMES.has(scheme)) return;
  if (!hadRecentGesture(contents)) return;
  lastGesture.delete(contents); // one prompt per gesture
  const win = BrowserWindow.fromWebContents(contents.hostWebContents || contents) || mainWindow;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Open this link in another app?`, detail: url.length > 300 ? url.slice(0, 300) + '…' : url,
  });
  if (response === 0) shell.openExternal(url);
}

// ---------- webview wiring: hardening, popups, context menu ----------

// Force safe settings on every <webview> no matter what the embedder asked for.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    // Workbench integration: the internal workbench page gets its own preload/partition; refuses misuse.
    if (workbench && workbench.attachPolicy(contents, event, webPreferences, params)) return;
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
    // Profiles, or the in-memory partition main gave to this private window (and only that window).
    const partition = String(params.partition || '');
    if (!partition.startsWith('persist:profile-') && !(partition && partition === privatePartitionOf(contents))) event.preventDefault();
  });
});

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  if (isInternalContents(contents)) return workbench?.wireInternal(contents); // Workbench integration
  prepareSession(contents.session);

  // Page-initiated navigation: web pages can't jump to file:// or other privileged schemes.
  const guardNavigation = (event, url) => {
    if (isWorkbenchResource(url)) return event.preventDefault(); // Workbench integration: never from web pages
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

  // Popup windows opened by pages get the same navigation rules. Their links open in the window the
  // page lives in (so a private window's popups never land in the normal profile).
  contents.on('did-create-window', (win) => {
    win.webContents.on('will-navigate', (event, url) => { if (!WEB_SCHEMES.has(schemeOf(url))) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => {
      const owner = uiWindowFor(contents) || mainWindow;
      if (/^https?:/i.test(url) && owner && !owner.isDestroyed()) owner.webContents.send('command', 'open-url-tab', url);
      return { action: 'deny' };
    });
  });

  // User activation for external-app prompts (maybeOpenExternal / openExternal permission).
  contents.on('input-event', (_ev, input) => {
    if (input.type === 'mouseDown' || input.type === 'rawKeyDown' || input.type === 'keyDown' || input.type === 'gestureTap') lastGesture.set(contents, Date.now());
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

// Rebuilt when Settings → Shortcuts remaps a key (applyShortcutOverrides); the menu follows.
let SHORTCUTS = shortcutTable();
let shortcutOverridesSig = '{}';

// The UI window a webContents belongs to (pages in <webview>s report to their embedder), or null for
// page-opened popups and devtools, which keep plain menu behaviour.
function uiWindowFor(contents) {
  const owner = contents.getType() === 'webview' ? contents.hostWebContents : contents;
  if (!owner || owner.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(owner);
  return win && isUiWindow(win) && owner === win.webContents ? win : null;
}
const isUiWindow = (win) => !!win && (win === mainWindow || miniWindows.has(win) || privateWindows.has(win));

function runShortcut(sc, win) {
  if (sc.run === 'mini-window') return createMiniWindow('');
  if (sc.run === 'new-window') { if (!mainWindow) createMainWindow(); else mainWindow.focus(); return; }
  if (sc.run === 'private-window') return createPrivateWindow();
  if (sc.run === 'settings') return openSettingsWindow();
  if (sc.run === 'shortcuts-help') return openSettingsWindow('shortcuts');
  if (sc.run === 'ui-devtools') return (win || BrowserWindow.getFocusedWindow())?.webContents.openDevTools({ mode: 'detach' });
  if (win && !win.isDestroyed()) win.webContents.send('command', ...sc.cmd);
}

app.on('web-contents-created', (_e, contents) => {
  const type = contents.getType();
  if (type !== 'webview' && type !== 'window') return;
  contents.on('before-input-event', (event, input) => {
    // Settings window: records keys for Settings → Shortcuts, closes on ⌘W, ignores browser shortcuts.
    if (settingsWindow && !settingsWindow.isDestroyed() && contents === settingsWindow.webContents) return settingsWindowInput(event, input);
    const sc = findShortcut(SHORTCUTS, input);
    if (!sc) return;
    // Workbench integration: in its editor/terminal, keys like ⌘S/⌘F/⌘Z mean save/find/undo (the
    // workbench decides which, by focus zone), not the browser shortcut on the same key.
    if (workbench && isInternalContents(contents) && workbench.keyBelongsToPage(workbench.owners.get(contents.id)?.zone || 'other', input)) return;
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
handle('favicon:fetch', async (e, url, partition) => {
  const own = privatePartitionOf(e.sender);
  if (!/^https?:/i.test(String(url)) || !(String(partition).startsWith('persist:profile-') || (own && partition === own))) return null;
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
  if (!wc || wc.isDestroyed() || wc.getType() !== 'webview' || wc.hostWebContents?.id !== e.sender.id || isInternalContents(wc)) return null;
  try { return await hub.pageTextFor(wc); } catch { return null; }
});
handle('devtools:open', (_e, id) => { const wc = webContents.fromId(id); if (wc) wc.openDevTools({ mode: 'detach' }); });

// ---------- AI: agent hub (MCP + assistant tools) and the built-in assistant ----------

let hub = null;
let assistant = null;
let localAgents = null;

// The renderer picks the provider; only known ids get through ('api' = the Claude API key path).
// `history` seeds a reopened Chat view conversation (main forgets sessions on restart): strings only, capped.
function sanitizeAiRequest(req) {
  const r = req && typeof req === 'object' ? req : {};
  const provider = r.provider === 'api' || Object.prototype.hasOwnProperty.call(AGENT_PROVIDERS, r.provider) ? r.provider : 'api';
  const out = { ...r, provider, mode: r.mode === 'ask' ? 'ask' : 'chat', text: String(r.text || '').slice(0, 100_000) };
  delete out.history;
  if (Array.isArray(r.history)) {
    let budget = 60_000;
    const history = [];
    for (const m of r.history.slice(-40).reverse()) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string' || !m.text || budget <= 0) continue;
      const text = m.text.slice(0, Math.min(20_000, budget));
      budget -= text.length;
      history.unshift({ role: m.role, text });
    }
    if (history.length) out.history = history;
  }
  return out;
}

// Install / sign in to a local AI agent: confirm the exact command, then run it in the system terminal.
async function agentSetup(win, id, action) {
  const p = AGENT_PROVIDERS[id];
  if (!p || !['install', 'login'].includes(action)) return { ok: false, error: 'Unknown agent' };
  const info = (await localAgents.list()).find((x) => x.id === id);
  const cmd = action === 'install' ? info?.install?.cmd : p.login;
  if (!cmd) return { ok: false, error: info?.install?.missing ? `Install ${info.install.missing} first.` : 'No install command for this system.', docs: p.docs };
  const verb = action === 'install' ? 'Install' : 'Sign in to';
  const opts = {
    type: 'question', buttons: ['Cancel', action === 'install' ? 'Open Terminal and Install' : 'Open Terminal and Sign In'], defaultId: 1, cancelId: 0,
    message: `${verb} ${p.label}?`,
    detail: `Meridian will open a terminal window and run:\n\n${cmd}\n\n${action === 'install' ? 'Follow any prompts there. ' : 'Your browser may open to finish signing in. '}This window updates by itself when it’s done.`,
  };
  const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response !== 1) return { ok: false, cancelled: true };
  return openInTerminal(cmd, `${verb} ${p.label}`) ? { ok: true } : { ok: false, error: 'Couldn’t open a terminal. Run this yourself: ' + cmd };
}
let workbench = null;

function mcpScript() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'meridian-mcp.cjs')
    : path.join(__dirname, '..', 'mcp', 'meridian-mcp.js');
}
function mcpCommand() {
  const script = mcpScript();
  return { command: 'node', args: [script], claudeCode: `claude mcp add -s user meridian -- node "${script}"`, codex: `codex mcp add meridian -- node "${script}"` };
}

// "Connect Claude Code / Codex" (onboarding and Settings → AI): shows the exact command in a native
// dialog and runs it only after the user confirms.
async function connectMcpCli(cli, parent) {
  return connectCli(String(cli), mcpScript(), async (command, name) => {
    const { response } = await dialog.showMessageBox(parent || mainWindow, {
      type: 'question', buttons: ['Run Command', 'Cancel'], defaultId: 1, cancelId: 1,
      message: `Connect ${name} to Meridian?`,
      detail: `Meridian will run this command:\n\n${command}\n\n${name} can then use Meridian's browser tools, within the agent access level you choose.`,
    });
    return response === 0;
  });
}
handle('mcp:detect', () => detectClis(mcpScript()));
handleMain('mcp:connect', (e, cli) => connectMcpCli(cli, BrowserWindow.fromWebContents(e.sender)));

handle('agent:config', (_e, cfg) => { hub.setConfig(cfg || {}); return hub.status(); });
handle('agent:status', () => ({ ...hub.status(), mcp: mcpCommand() }));
handle('agent:pause', (_e, paused) => { hub.paused = !!paused; return hub.paused; });
on('agent:rpc-result', (e, payload) => hub.onRpcResult(e.sender, payload || {}));

handle('ai:has-key', () => assistant.hasKey());
handle('ai:set-key', (_e, key) => { assistant.setKey(typeof key === 'string' ? key : ''); return assistant.hasKey(); });
on('ai:chat', (e, req) => { assistant.chat(e.sender, sanitizeAiRequest(req)); });
handle('agents:list', (_e, fresh) => localAgents.list({ fresh: !!fresh }));
handle('agents:setup', (e, id, action) => agentSetup(BrowserWindow.fromWebContents(e.sender), String(id), String(action)));
on('ai:stop', (_e, sessionId) => assistant.stop(sessionId));
on('ai:reset', (_e, sessionId) => assistant.reset(sessionId));

// Chat view conversations (src/ai/chats-store.js). Main window only: private and Little windows never save chats.
let chatsStore = null;
const chats = () => (chatsStore ||= new ChatsStore({ userDataDir: app.getPath('userData'), writeAtomic: writeJsonAtomicAsync }));
handleMain('chats:list', () => chats().list());
handleMain('chats:get', (_e, id) => chats().get(String(id || '')));
handleMain('chats:save', (_e, chat) => chats().save(chat));
handleMain('chats:delete', (_e, id) => chats().delete(String(id || '')));

// ---------- Mission Control + Arc Max-style AI features (src/agents/mission.js, src/ai/features.js) ----------

let mission = null;
let linkPreviews = null;
const isMainUiContents = (wc) => !!mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents;
function setupMission() {
  mission = new MissionControl({
    app, getMainWindow: () => mainWindow, getSettings: () => uiSnapshot?.settings || {},
    secretValues: (node) => workbench?.secretValuesFor?.(node.ownerWcId) || [],
  });
  mission.registerIpc(handleMain);
  linkPreviews = new LinkPreviews({ assistant, getSettings: () => uiSnapshot?.settings || {}, isMainUi: isMainUiContents,
    // Private windows use in-memory partitions; profiles are persist:. (Their guests' host is also never the main UI.)
    isPrivatePartition: (c) => { try { return !c.session.isPersistent(); } catch { return true; } },
    isInternal: isInternalContents,
    // Dev/test builds only: exact host:port pairs the preview may fetch even though they're local (the e2e fixture server).
    allowHosts: DEV && process.env.MERIDIAN_TEST_PREVIEW_ALLOW ? process.env.MERIDIAN_TEST_PREVIEW_ALLOW.split(',').map((x) => x.trim()).filter(Boolean) : [],
  });
  app.on('web-contents-created', (_e, contents) => { if (contents.getType() === 'webview' && !isInternalContents(contents)) linkPreviews.attach(contents); });
  if (DEV) global.__meridianMission = mission; // dev/test harness only
}
// Tidy Today: a proposal only; the UI shows it as a diff and applies what the user accepts.
handleMain('ai:tidy', async (_e, tabs) => {
  if (uiSnapshot?.settings?.aiTidy === false) return { error: 'Tidy Today is turned off in Settings → AI.' };
  try { return await tidyToday(assistant, Array.isArray(tabs) ? tabs.slice(0, 80).map((t) => ({ id: str(t?.id, 64), title: str(t?.title, 300), url: str(t?.url, 2000) })) : []); }
  catch (err) { return { error: describeAiError(err) }; }
});
handleMain('ai:link-preview-test', async (_e, url) => { // dev/test only: same path as Shift-hover, without input events
  if (!DEV || !/^https?:\/\//i.test(String(url)) || !linkPreviews.enabled()) return null;
  try { return await linkPreviews.summary(String(url).slice(0, 4000), session.fromPartition('persist:profile-default')); } catch (err) { return { error: describeAiError(err) }; }
});

// ---------- Arc import ----------

handle('import:arc-available', () => arcDataExists());
handle('import:arc', () => importFromArc());
// Counts for the onboarding ("12 spaces, 140 pinned tabs, 8 favorites") before anything is imported.
handle('import:arc-preview', () => {
  if (!arcDataExists()) return null;
  try {
    const d = importFromArc();
    let pinned = 0, today = 0;
    const count = (n) => { if (n.type === 'tab') pinned++; else (n.children || []).forEach(count); };
    for (const sp of d.spaces) { sp.pinned.forEach(count); today += sp.today.length; }
    const favorites = Object.values(d.favorites).reduce((a, l) => a + l.length, 0);
    return { spaces: d.spaces.length, pinned, today, favorites, profiles: d.profiles.length, names: d.spaces.slice(0, 8).map((s) => ({ name: s.name, icon: s.icon, color: s.color })) };
  } catch (err) { return { error: err.message }; }
});

// ---------- Arc logins (cookies) import, macOS only: src/importers/arc-cookies.js ----------
// Profiles: cookies go into the same Meridian profiles the sidebar import uses ("Default" → default,
// "Profile 3" → arc-profile-3). Profiles Meridian doesn't have yet are created in the UI state (as the
// sidebar import would), so imported logins never end up in a session no profile points at. When
// Arc's sidebar is readable, only profiles it still uses are imported (Arc leaves folders of deleted
// profiles behind).

// Dev/test only: MERIDIAN_ARC_SAFE_STORAGE is the "keychain" password; "__deny__" acts like Cancel.
function arcPasswordSource() {
  if (DEV && process.env.MERIDIAN_ARC_SAFE_STORAGE != null) {
    const v = process.env.MERIDIAN_ARC_SAFE_STORAGE;
    return async () => { if (v === '__deny__') throw Object.assign(new Error('You didn’t allow access to Arc’s logins, so nothing was imported.'), { code: 'denied' }); return v; };
  }
  return () => keychainPassword();
}
const arcUserDataDir = () => { const root = arcRoot(); return root ? path.join(root, 'User Data') : null; };
function arcLoginsAvailable() {
  if (process.platform !== 'darwin' && !(DEV && process.env.MERIDIAN_ARC_DIR)) return false;
  const dir = arcUserDataDir();
  return !!dir && findArcProfiles(dir).length > 0;
}

let arcLoginsBusy = false;
async function importArcLogins(parent) {
  const win = parent && !parent.isDestroyed() ? parent : mainWindow;
  const box = (opts) => (win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
  if (!arcLoginsAvailable()) return { ok: false, error: process.platform === 'darwin' ? 'No Arc logins were found on this computer.' : 'Importing Arc logins works on macOS only.' };
  if (arcLoginsBusy) return { ok: false, error: 'An import is already running.' };
  arcLoginsBusy = true;
  try {
    const { response } = await box({
      type: 'question', buttons: ['Cancel', 'Continue'], defaultId: 1, cancelId: 0,
      message: 'Bring your Arc logins to Meridian?',
      detail: 'Meridian will ask macOS for access to “Arc Safe Storage” to copy your Arc logins (cookies) to Meridian. '
        + 'You’ll see a system dialog next: click Allow (or Always Allow) and enter your Mac password if asked.\n\n'
        + 'Nothing leaves this computer, and Arc isn’t changed. Saved passwords aren’t copied.',
    });
    if (response !== 1) return { ok: false, cancelled: true };

    // Profile names like the sidebar import gives them (named after their first space).
    let known = null, names = new Map();
    try { const d = importFromArc(); known = new Set(d.profiles.map((p) => p.id)); names = new Map(d.profiles.map((p) => [p.id, p.name])); } catch {}
    let summary;
    try {
      summary = await importArcCookies({
        userDataDir: arcUserDataDir(),
        getPassword: arcPasswordSource(),
        onlyProfileIds: known,
        sessionFor: (id) => session.fromPartition(`persist:profile-${id}`),
      });
    } catch (err) {
      const msg = err.code === 'denied' || err.code === 'not-found' || err.code === 'no-data' ? err.message : 'Arc’s logins couldn’t be read, so nothing was imported.';
      await box({ type: 'info', buttons: ['OK'], message: 'Logins weren’t imported', detail: msg + (err.code === 'denied' ? ' You can try again any time from Settings → General.' : '') });
      return { ok: false, denied: err.code === 'denied', error: msg };
    }
    const profiles = summary.profiles.filter((p) => p.imported > 0).map((p) => ({ id: p.profileId, name: names.get(p.profileId) || (p.dir === 'Default' ? 'Default' : p.dir) }));
    if (profiles.length) deliverToMain('arc-profiles', profiles);
    const n = summary.total, pc = profiles.length;
    const failed = summary.profiles.reduce((a, p) => a + p.failed, 0);
    await box({
      type: 'info', buttons: ['OK'],
      message: n ? `Imported ${n.toLocaleString('en-US')} ${n === 1 ? 'login' : 'logins'} into ${pc} ${pc === 1 ? 'profile' : 'profiles'}.` : 'No logins were imported.',
      detail: n ? 'Sites where you were signed in to Arc are signed in here too. Open pages pick it up when they reload.'
        + (failed ? ` ${failed.toLocaleString('en-US')} cookies couldn’t be copied.` : '')
        : 'Arc had no current logins to copy.',
    });
    return { ok: true, total: n, profiles: summary.profiles.map(({ profileId, imported, skipped, failed: f }) => ({ profileId, imported, skipped, failed: f })) };
  } finally { arcLoginsBusy = false; }
}
handle('import:arc-logins-available', () => arcLoginsAvailable());
handleMain('import:arc-logins', () => importArcLogins(mainWindow));

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
  mainUiReady = false;
  // A reload re-boots the UI; commands wait for its next snapshot.
  mainWindow.webContents.on('did-start-loading', () => { mainUiReady = false; });
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
  mainWindow.on('closed', () => { mainWindow = null; mainUiReady = false; });
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
  if (!/^https?:\/\//i.test(String(url))) return;
  deliverToMain('open-url-tab', url);
  mainWindow?.show(); mainWindow?.focus();
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// ---------- delivering commands to the main window's UI ----------
// Commands sent before the UI has booted (its listeners register after state loads) would be lost, so
// they wait until the UI's first snapshot says it's ready. Opens the main window if it's closed.

let mainUiReady = false;
const mainQueue = [];
function deliverToMain(name, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (mainUiReady) mainWindow.webContents.send('command', name, ...args);
  else mainQueue.push([name, ...args]);
}
function flushMainQueue() {
  while (mainUiReady && mainQueue.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('command', ...mainQueue.shift());
}

// ---------- private windows ----------
// Each gets its own in-memory partition (no "persist:" prefix: nothing touches disk), its own UI state
// that is never saved, and is wiped when it closes. will-attach-webview only lets this window's page
// use this partition.

function privatePartitionOf(contents) {
  if (!contents || contents.isDestroyed()) return null;
  const win = BrowserWindow.fromWebContents(contents);
  return win && privateWindows.has(win) && win.webContents === contents ? privateWindows.get(win) : null;
}

function createPrivateWindow() {
  const partition = `meridian-private-${crypto.randomUUID()}`;
  const win = new BrowserWindow(baseWindowOptions({
    width: 1200, height: 800, minWidth: 640, minHeight: 420, title: `${APP_NAME} — Private`,
    ...(IS_MAC ? { vibrancy: undefined, backgroundColor: '#1b1b1f' } : { backgroundColor: '#1b1b1f' }),
  }));
  privateWindows.set(win, partition);
  win.loadURL(uiPageUrl({ private: partition }));
  win.once('ready-to-show', () => { if (DEV && process.env.MERIDIAN_SHOT) win.showInactive(); else win.show(); });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    privateWindows.delete(win);
    const ses = session.fromPartition(partition);
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
    ses.clearAuthCache?.().catch?.(() => {});
    knownSessions.delete(ses);
  });
  return win;
}

// ---------- settings: the UI renderer owns state.json; this is the channel to the Settings window ----------
//
//   UI renderer --ui:snapshot--> main (cache: menus, shortcuts, Air Traffic Control) --settings:state--> Settings window
//   Settings window --settings:set (patch) / settings:action--> main (validates) --command settings-patch--> UI renderer
//
// The UI applies the patch (and its side effects: ad blocker, agent access, sidebar side…), saves, and
// sends a new snapshot, which flows back to the Settings window. One writer, live everywhere.

let uiSnapshot = null;
let menuSig = '';

function applySnapshot(snap) {
  uiSnapshot = snap;
  const s = snap.settings || {};
  if (!mainUiReady) { mainUiReady = true; flushMainQueue(); }
  applyShortcutOverrides(s.shortcutOverrides || {});
  applyAppearance(s.appearance);
  const sig = JSON.stringify([snap.spaces, snap.activeSpaceId]);
  if (sig !== menuSig) { menuSig = sig; scheduleMenu(); }
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:state', settingsState());
}

function applyShortcutOverrides(overrides) {
  const sig = JSON.stringify(overrides);
  if (sig === shortcutOverridesSig) return;
  shortcutOverridesSig = sig;
  SHORTCUTS = shortcutTable(IS_MAC, overrides);
  scheduleMenu();
}

function applyAppearance(mode) {
  if (DEV && process.env.MERIDIAN_THEME) return; // screenshots pin the theme
  const want = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (nativeTheme.themeSource !== want) nativeTheme.themeSource = want;
}

const str = (v, max = 200) => String(v ?? '').slice(0, max);
onMain('ui:snapshot', (_e, snap) => {
  if (!snap || typeof snap !== 'object') return;
  applySnapshot({
    settings: snap.settings && typeof snap.settings === 'object' ? snap.settings : {},
    profiles: (Array.isArray(snap.profiles) ? snap.profiles : []).slice(0, 100).map((p) => ({ id: str(p.id, 64), name: str(p.name, 80) })),
    spaces: (Array.isArray(snap.spaces) ? snap.spaces : []).slice(0, 200).map((sp) => ({ id: str(sp.id, 64), name: str(sp.name, 80), icon: sp.icon ? str(sp.icon, 16) : null, color: str(sp.color, 32), profileId: str(sp.profileId, 64) })),
    activeSpaceId: str(snap.activeSpaceId, 64),
    stats: snap.stats && typeof snap.stats === 'object' ? { archive: Number(snap.stats.archive) || 0, history: Number(snap.stats.history) || 0 } : {},
  });
});

function shortcutRows() {
  return SHORTCUTS.map((s) => ({
    id: s.id, label: s.label, group: s.group, alias: !!s.alias,
    accel: s.accel, defaultAccel: s.defaultAccel,
    display: formatAccelerator(s.accel, IS_MAC), defaultDisplay: formatAccelerator(s.defaultAccel, IS_MAC),
  }));
}

// For the member card: when this profile was created, and the user's name as a default for the card.
let memberCache = null;
function memberInfo() {
  if (memberCache) return memberCache;
  let since = Date.now();
  try { const st = fs.statSync(app.getPath('userData')); since = (st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) || since; } catch {}
  let name = '';
  try { name = os.userInfo().username; } catch {}
  if (IS_MAC) { try { name = require('child_process').execFileSync('/usr/bin/id', ['-F'], { timeout: 1000, encoding: 'utf8' }).trim() || name; } catch {} }
  return (memberCache = { since, name: name.slice(0, 40) });
}

function settingsState() {
  return { snapshot: uiSnapshot, shortcuts: shortcutRows() };
}

function openSettingsWindow(section) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (section) settingsWindow.webContents.send('settings:section', section);
    settingsWindow.show(); settingsWindow.focus();
    return settingsWindow;
  }
  const chrome = IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
    : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8ee' : '#3a3a44', height: 36 }, backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b20' : '#f3f3f6', autoHideMenuBar: true };
  settingsWindow = new BrowserWindow({
    ...chrome,
    width: 820, height: 620, minWidth: 680, minHeight: 480, title: `${APP_NAME} Settings`,
    show: false, fullscreenable: false,
    parent: undefined,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, spellcheck: false },
  });
  settingsWindow.loadURL(`${SETTINGS_URL}${section ? `#${encodeURIComponent(section)}` : ''}`);
  settingsWindow.once('ready-to-show', () => { if (DEV && process.env.MERIDIAN_SHOT) settingsWindow.showInactive(); else settingsWindow.show(); });
  settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.on('closed', () => { settingsWindow = null; recordingShortcut = false; });
  return settingsWindow;
}

let recordingShortcut = false;
function settingsWindowInput(event, input) {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return;
  if (recordingShortcut) {
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(input.key)) return event.preventDefault();
    event.preventDefault();
    const cancel = input.code === 'Escape' && !input.meta && !input.control && !input.alt && !input.shift;
    const accel = cancel ? null : acceleratorFromInput(input, IS_MAC);
    settingsWindow.webContents.send('settings:recorded', cancel ? { cancel: true } : { accel, display: formatAccelerator(accel, IS_MAC), raw: input.key });
    return;
  }
  const sc = findShortcut(SHORTCUTS, input);
  if (!sc) return;
  if (sc.id === 'close-tab') { event.preventDefault(); settingsWindow.close(); }
  else if (sc.run === 'settings') event.preventDefault();
  else if (sc.run === 'private-window' || sc.run === 'mini-window' || sc.run === 'new-window') { event.preventDefault(); runShortcut(sc, null); }
  // Everything else: the page gets the key (editing text fields), browser shortcuts don't fire here.
  else if (!sc.soft) event.preventDefault();
}

const shortcutIds = () => new Set(SHORTCUTS.map((s) => s.id));
on('window:open', (_e, kind, url) => { if (kind === 'private') createPrivateWindow(); else if (kind === 'little') createMiniWindow(/^https?:\/\//i.test(String(url || '')) ? String(url).slice(0, 4000) : ''); });
on('settings:open', (_e, section) => openSettingsWindow(typeof section === 'string' ? section.slice(0, 20) : undefined));

handleSettings('settings:get', async () => ({
  ...settingsState(),
  platform: process.platform, version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
  packaged: app.isPackaged, mcp: mcpCommand(), repo: REPO_URL, member: memberInfo(),
}));
handleSettings('settings:set', (_e, patch) => {
  const clean = validatePatch(patch, shortcutIds());
  if (!Object.keys(clean).length) return false;
  if (clean.shortcutOverrides) applyShortcutOverrides(clean.shortcutOverrides);
  if (clean.appearance) applyAppearance(clean.appearance);
  deliverToMain('settings-patch', clean);
  return true;
});
handleSettings('settings:record', (_e, on) => { recordingShortcut = !!on; return recordingShortcut; });
handleSettings('settings:is-default', () => app.isDefaultProtocolClient('https'));
handleSettings('settings:set-default', () => {
  const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  return { ok, packaged: app.isPackaged };
});
handleSettings('settings:arc-available', () => arcDataExists());
handleSettings('settings:arc-logins-available', () => arcLoginsAvailable());
handleSettings('settings:import-arc-logins', () => importArcLogins(settingsWindow));
handleSettings('settings:pick-extension', () => pickExtensionDir(settingsWindow));
handleSettings('settings:reset-permissions', () => { permissionDecisions = {}; writeJsonAtomic(PERMS_FILE(), {}); return true; });
handleSettings('settings:clear-profile-data', async (_e, profileId) => {
  if (!/^[\w-]{1,64}$/.test(String(profileId))) return false;
  const ses = session.fromPartition(`persist:profile-${profileId}`);
  await ses.clearStorageData(); await ses.clearCache();
  return true;
});
// what: { history, cache, cookies } — cache/cookies for every profile; history lives in the UI's state.
handleSettings('settings:clear-browsing-data', async (_e, what = {}) => {
  const profiles = (uiSnapshot?.profiles || []).map((p) => p.id).filter((id) => /^[\w-]{1,64}$/.test(id));
  for (const id of profiles) {
    const ses = session.fromPartition(`persist:profile-${id}`);
    if (what.cache) await ses.clearCache();
    if (what.cookies) await ses.clearStorageData();
  }
  if (what.history) deliverToMain('settings-action', 'clear-history');
  return true;
});
// Profile/space edits and other things only the UI can do with its state.
const UI_ACTIONS = new Set(['profile-rename', 'profile-add', 'profile-delete', 'import-arc', 'clear-archive', 'onboarding', 'edit-theme']);
handleSettings('settings:action', (_e, name, arg) => {
  if (!UI_ACTIONS.has(name)) return false;
  const a = arg && typeof arg === 'object' ? { id: arg.id ? str(arg.id, 64) : undefined, name: arg.name ? str(arg.name, 80) : undefined } : {};
  deliverToMain('settings-action', name, a);
  if (name === 'onboarding' || name === 'edit-theme' || name === 'import-arc') { mainWindow?.show(); mainWindow?.focus(); }
  return true;
});
handleSettings('settings:ai-has-key', () => assistant.hasKey());
handleSettings('settings:ai-set-key', (_e, key) => { assistant.setKey(typeof key === 'string' ? key : ''); return assistant.hasKey(); });
handleSettings('settings:agent-status', () => ({ ...hub.status(), mcp: mcpCommand() }));
handleSettings('settings:mcp-detect', () => detectClis(mcpScript()));
handleSettings('settings:agents-list', (_e, fresh) => localAgents.list({ fresh: !!fresh }));
handleSettings('settings:agents-setup', (_e, id, action) => agentSetup(settingsWindow, String(id), String(action)));
handleSettings('settings:mcp-connect', (_e, cli) => connectMcpCli(cli, settingsWindow));
// "Where would this link go?" for Settings → Links, with the rules being edited (not yet saved).
handleSettings('settings:route-test', (_e, atc, url) => {
  const spaces = uiSnapshot?.spaces || [];
  const r = routeLink(sanitizeAtc(atc) || {}, String(url || ''), spaces.map((sp) => sp.id));
  return { target: r.target, spaceId: r.spaceId || null, pattern: r.rule?.pattern || null };
});
handleSettings('settings:copy', (_e, text) => { clipboard.writeText(str(text, 4000)); return true; });
handleSettings('settings:open-url', (_e, url) => { if (/^https:\/\//i.test(String(url))) deliverToMain('open-url-tab', str(url, 2000)); return true; });

// Dev/test: MERIDIAN_SHOT=out.png MERIDIAN_STEPS='[{"js":"...","wait":2000,"shot":"a.png"}]'
// "win": "settings" | "private" | "mini" runs that step's js / shot in that window instead.
function stepWindow(name, fallback) {
  if (name === 'settings') return settingsWindow;
  if (name === 'private') return [...privateWindows.keys()].at(-1) || null;
  if (name === 'mini') return [...miniWindows].at(-1) || null;
  return fallback;
}
function runScreenshotScript(win) {
  const steps = JSON.parse(process.env.MERIDIAN_STEPS || '[{"wait":3000}]');
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  win.webContents.once('did-finish-load', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const st of steps) {
      const w = stepWindow(st.win, win);
      try {
        if (st.win && (!w || w.webContents.isLoading())) await sleep(800);
        if (st.js && w) console.log('[eval]', JSON.stringify(await w.webContents.executeJavaScript(st.js)));
        // {"main":"open-url","url":"…"} = a link from another app; {"main":"menu","menu":"Spaces"} = print that menu.
        if (st.main === 'open-url') app.emit('open-url', { preventDefault() {} }, st.url);
        if (st.main === 'menu') console.log('[menu]', JSON.stringify(Menu.getApplicationMenu().items.find((m) => m.label === st.menu)?.submenu.items.map((i) => `${i.label}${i.checked ? ' ✓' : ''}${i.accelerator ? ' ' + i.accelerator : ''}`)));
        if (st.main === 'windows') console.log('[windows]', JSON.stringify({ mini: miniWindows.size, private: privateWindows.size, settings: !!settingsWindow }));
        // {"key":"Right","modifiers":["meta","alt"],"to":"page"} — a keypress sent to the active tab's page
        // ("to":"page") or to whatever has focus.
        if (st.key) {
          const pageId = st.to === 'page' ? await win.webContents.executeJavaScript('webview()?.getWebContentsId() || 0') : 0;
          const target = (pageId && webContents.fromId(pageId)) || (st.win && w ? w.webContents : null) || webContents.getFocusedWebContents() || win.webContents;
          console.log('[key]', st.key, (st.modifiers || []).join('+'), '->', target.getType());
          target.sendInputEvent({ type: 'keyDown', keyCode: st.key, modifiers: st.modifiers || [] });
          if (st.key.length === 1 && !(st.modifiers || []).length) target.sendInputEvent({ type: 'char', keyCode: st.key });
          target.sendInputEvent({ type: 'keyUp', keyCode: st.key, modifiers: st.modifiers || [] });
        }
      } catch (err) { console.log('[eval error]', err.message); }
      await sleep(st.wait || 500);
      if (st.shot) { const sw = stepWindow(st.win, win); if (sw && !sw.isDestroyed()) fs.writeFileSync(st.shot, (await sw.webContents.capturePage()).toPNG()); }
    }
    fs.writeFileSync(process.env.MERIDIAN_SHOT, (await win.webContents.capturePage()).toPNG());
    app.exit(0);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- menu: modelled on Arc's. Shows every shortcut; clicks (and keys nothing else caught) go to the focused UI window ----------

function targetWindow() {
  const win = BrowserWindow.getFocusedWindow();
  return win && isUiWindow(win) ? win : mainWindow;
}

function cmd(name, ...args) {
  return () => {
    const win = targetWindow();
    if (win && !win.isDestroyed()) win.webContents.send('command', name, ...args);
    else deliverToMain(name, ...args);
  };
}

// A menu item for a shortcut from the table. Shortcuts handled in before-input-event aren't registered
// as accelerators on Windows/Linux (macOS has no such option; preventDefault() there stops the menu).
function sc(label, id, extra = {}) {
  const s = SHORTCUTS.find((x) => x.id === id);
  return {
    label, ...(s.accel ? { accelerator: s.accel, registerAccelerator: !!s.soft } : {}),
    click: () => {
      // ⌘W in the Settings window closes it rather than a tab behind it.
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && focused === settingsWindow && s.id === 'close-tab') return focused.close();
      const win = targetWindow();
      if (!win && s.cmd) return deliverToMain(...s.cmd);
      runShortcut(s, win);
    },
    ...extra,
  };
}

const menuText = (v, max = 40) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max);

function buildMenu() {
  const snap = uiSnapshot || {};
  const spaces = Array.isArray(snap.spaces) ? snap.spaces : [];
  const spaceItems = spaces.length
    ? spaces.map((sp, i) => ({
        label: `${sp.icon ? menuText(sp.icon, 4) + '  ' : ''}${menuText(sp.name) || 'Space'}`,
        type: 'checkbox', checked: sp.id === snap.activeSpaceId,
        ...(i < 9 && SHORTCUTS.find((x) => x.id === `space-${i + 1}`)?.accel ? { accelerator: SHORTCUTS.find((x) => x.id === `space-${i + 1}`).accel, registerAccelerator: false } : {}),
        click: () => deliverToMain('space-select', sp.id),
      }))
    : Array.from({ length: 9 }, (_, i) => sc(`Space ${i + 1}`, `space-${i + 1}`));
  const tabItems = [];
  for (let i = 1; i <= 9; i++) tabItems.push(sc(i === 9 ? 'Last Tab' : `Tab ${i}`, `tab-${i}`));
  const settingsItem = sc('Settings…', 'settings');

  const template = [
    IS_MAC ? {
      label: APP_NAME,
      submenu: [
        { label: `About ${APP_NAME}`, role: 'about' },
        { type: 'separator' },
        settingsItem,
        { label: 'Set as Default Browser…', click: () => setDefaultBrowserFromMenu() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    } : null,
    {
      label: 'File',
      submenu: [
        sc('New Tab…', 'command-bar'),
        sc('New Window', 'new-window'),
        sc('New Little Window', 'mini-window'),
        sc('New Private Window', 'private-window'),
        { type: 'separator' },
        sc('New Folder', 'new-folder'),
        sc('Open Location…', 'edit-url'),
        sc('Reopen Closed Tab', 'reopen-tab'),
        { type: 'separator' },
        sc('Close Tab', 'close-tab'),
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        { type: 'separator' },
        { label: 'Import from Arc…', click: () => deliverToMain('import-arc') },
        ...(IS_MAC ? [{ label: 'Import Logins from Arc…', click: () => importArcLogins(mainWindow) }] : []),
        ...(IS_MAC ? [] : [{ type: 'separator' }, settingsItem, { label: 'Set as Default Browser…', click: () => setDefaultBrowserFromMenu() }, { type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        sc('Copy URL', 'copy-url'),
        { type: 'separator' },
        sc('Find…', 'find'),
        sc('Find Next', 'find-next'),
        sc('Find Previous', 'find-prev'),
      ],
    },
    {
      label: 'View',
      submenu: [
        sc('Toggle Sidebar', 'toggle-sidebar'),
        sc('Ask AI', 'ai-panel'),
        sc('Chat', 'open-chat'),
        sc('Workbench', 'open-workbench'), // Workbench integration
        sc('Mission Control', 'mission-control'), // Mission Control
        sc('Downloads', 'downloads'),
        { type: 'separator' },
        sc('Split View', 'split'),
        sc('Close Split View', 'unsplit'),
        { type: 'separator' },
        sc('Reload', 'reload'),
        sc('Hard Reload', 'hard-reload'),
        { type: 'separator' },
        sc('Zoom In', 'zoom-in'),
        sc('Zoom In ', 'zoom-in-plus', { visible: false }),
        sc('Zoom Out', 'zoom-out'),
        sc('Actual Size', 'zoom-reset'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Developer',
          submenu: [
            sc('Developer Tools', 'devtools'),
            sc('Meridian UI Developer Tools', 'ui-devtools'),
          ],
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        sc('Back', 'back'),
        sc('Forward', 'forward'),
        sc('Back ', 'back-arrow', { visible: false }),
        sc('Forward ', 'forward-arrow', { visible: false }),
        { type: 'separator' },
        sc('Reopen Closed Tab', 'reopen-tab'),
      ],
    },
    {
      label: 'Spaces',
      submenu: [
        ...spaceItems,
        { type: 'separator' },
        sc('New Space…', 'new-space'),
        sc('Edit Space Theme…', 'edit-theme'),
        { type: 'separator' },
        sc('Next Space', 'next-space'),
        sc('Previous Space', 'prev-space'),
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        sc('Pin / Unpin Tab', 'toggle-pin'),
        sc('Duplicate Tab', 'duplicate-tab'),
        sc('Add to Favorites', 'add-favorite'),
        sc('Copy URL', 'copy-url'),
        { type: 'separator' },
        sc('Clear Today', 'clear-today'),
        { type: 'separator' },
        sc('Next Tab', 'next-tab'),
        sc('Previous Tab', 'prev-tab'),
        sc('Next Tab ', 'next-tab-arrow', { visible: false }),
        sc('Previous Tab ', 'prev-tab-arrow', { visible: false }),
        { type: 'separator' },
        ...tabItems,
      ],
    },
    {
      label: 'Archive',
      submenu: [
        sc('View Archive', 'view-archive'),
        sc('Reopen Last Archived Tab', 'reopen-archived'),
      ],
    },
    {
      label: 'Extensions',
      submenu: [
        { label: 'Manage Extensions…', click: () => openSettingsWindow('advanced') },
        { label: 'Load Unpacked Extension…', click: () => loadExtensionFromMenu() },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        sc('Keyboard Shortcuts', 'shortcuts-help'),
        { label: 'Welcome Tour…', click: () => deliverToMain('onboarding') },
        { type: 'separator' },
        { label: 'Report an Issue…', click: () => deliverToMain('open-url-tab', `${REPO_URL}/issues/new`) },
        { label: 'Meridian on GitHub', click: () => deliverToMain('open-url-tab', REPO_URL) },
      ],
    },
  ].filter(Boolean);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Coalesces rebuilds (snapshots can arrive in bursts while spaces are edited).
let menuTimer = null;
function scheduleMenu() { clearTimeout(menuTimer); menuTimer = setTimeout(buildMenu, 50); }

async function setDefaultBrowserFromMenu() {
  if (!app.isPackaged) {
    await dialog.showMessageBox(BrowserWindow.getFocusedWindow() || mainWindow, { type: 'info', message: 'Run the built app to make Meridian your default browser', detail: 'Development builds can’t register as the system browser (npm run dist).' });
    return;
  }
  app.setAsDefaultProtocolClient('http');
  app.setAsDefaultProtocolClient('https');
}

async function loadExtensionFromMenu() {
  const dir = await pickExtensionDir(BrowserWindow.getFocusedWindow() || mainWindow);
  if (dir) deliverToMain('extension-add', dir);
}

// ---------- lifecycle ----------

app.whenReady().then(() => {
  permissionDecisions = readJson(PERMS_FILE(), {});
  const saved = readJson(STATE_FILE(), null);
  if (saved && saved.settings) {
    adblockEnabled = saved.settings.adblock !== false;
    loadedExtensionPaths = saved.settings.extensions || [];
  }
  if (DEV && /^(light|dark)$/.test(process.env.MERIDIAN_THEME || '')) nativeTheme.themeSource = process.env.MERIDIAN_THEME;
  // Until the UI has booted, menus, shortcuts and link routing work from what's on disk.
  if (saved) {
    uiSnapshot = {
      settings: saved.settings || {}, profiles: saved.profiles || [], activeSpaceId: saved.activeSpaceId,
      spaces: (saved.spaces || []).map((sp) => ({ id: sp.id, name: sp.name, icon: sp.icon, color: sp.color, profileId: sp.profileId })),
    };
    SHORTCUTS = shortcutTable(IS_MAC, saved.settings?.shortcutOverrides || {});
    shortcutOverridesSig = JSON.stringify(saved.settings?.shortcutOverrides || {});
    applyAppearance(saved.settings?.appearance);
  }
  app.setAboutPanelOptions({
    applicationName: APP_NAME, applicationVersion: app.getVersion(),
    copyright: 'Open source, MIT licensed. Not affiliated with The Browser Company.',
    website: REPO_URL, iconPath: path.join(__dirname, '..', 'build', 'icon-1024.png'),
  });
  hub = new AgentHub({ getWindow: () => mainWindow, userDataDir: app.getPath('userData'), isProtected: isInternalContents });
  localAgents = new LocalAgents({ userDataDir: app.getPath('userData') });
  assistant = new Assistant({ userDataDir: app.getPath('userData'), hub, localAgents, guide: () => meridianGuide(shortcutRows()) });
  setupMission(); // Mission Control
  hub.observer = mission;
  assistant.observer = mission;
  // Workbench integration: IPC for the internal workbench page (files, terminals, agents).
  workbench = new Workbench({ app, getMainWindow: () => mainWindow, isUiContents, mcpCommand, agentStatus: () => hub.status(), mission });
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

app.on('will-quit', () => { hub?.stopServer(); workbench?.dispose(); mission?.dispose(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
