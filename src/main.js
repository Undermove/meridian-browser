// Meridian — main process.
// Owns windows, the app menu (all keyboard shortcuts live here so they work
// even when a page has focus), persistence, sessions/profiles, downloads,
// permissions, ad blocking and the Arc importer.

const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog, clipboard, nativeTheme, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { importFromArc, arcDataExists } = require('./importers/arc');

const APP_NAME = 'Meridian';
app.setName(APP_NAME);
// Dev/test: isolated profile dir so test runs never touch real data.
if (process.env.MERIDIAN_USER_DATA) app.setPath('userData', process.env.MERIDIAN_USER_DATA);

const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
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

// ---------- state persistence ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

ipcMain.handle('state:load', () => readJson(STATE_FILE(), null));
ipcMain.handle('state:save', (_e, state) => { writeJsonAtomic(STATE_FILE(), state); return true; });
ipcMain.on('state:save-sync', (e, state) => { try { writeJsonAtomic(STATE_FILE(), state); } catch {} e.returnValue = true; });

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
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (SAFE_PERMISSIONS.has(permission)) return true;
    return permissionDecisions[`${originOf(origin)}|${permission}`] === true;
  });
  applyAdblock(ses);
  for (const ext of loadedExtensionPaths) loadExtensionInto(ses, ext);
}

ipcMain.handle('adblock:set', async (_e, enabled) => {
  adblockEnabled = !!enabled;
  for (const ses of knownSessions) await applyAdblock(ses);
  return adblockEnabled;
});

ipcMain.handle('profile:clear-data', async (_e, partition) => {
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

ipcMain.handle('extensions:set', async (_e, paths) => {
  loadedExtensionPaths = paths || [];
  for (const ses of knownSessions) for (const p of loadedExtensionPaths) await loadExtensionInto(ses, p);
  return true;
});

ipcMain.handle('extensions:pick', async () => {
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

async function handlePermissionRequest(wc, permission, callback, details) {
  if (SAFE_PERMISSIONS.has(permission)) return callback(true);
  const origin = originOf(details.requestingUrl || wc.getURL());
  const key = `${origin}|${permission}`;
  if (key in permissionDecisions) return callback(permissionDecisions[key]);
  const win = BrowserWindow.fromWebContents(wc.hostWebContents || wc) || mainWindow;
  const what = PERMISSION_LABELS[permission] || permission;
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Allow', 'Block'],
    defaultId: 1,
    cancelId: 1,
    message: `${new URL(origin).host} wants to ${what}`,
    checkboxLabel: 'Remember for this site',
    checkboxChecked: true,
  });
  const allowed = response === 0;
  if (checkboxChecked) {
    permissionDecisions[key] = allowed;
    writeJsonAtomic(PERMS_FILE(), permissionDecisions);
  }
  callback(allowed);
}

// ---------- downloads ----------

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function handleDownload(_event, item) {
  const target = uniquePath(app.getPath('downloads'), item.getFilename());
  item.setSavePath(target);
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

ipcMain.on('download:reveal', (_e, p) => shell.showItemInFolder(p));

// ---------- webview wiring: popups, context menu, find ----------

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  prepareSession(contents.session);

  contents.setWindowOpenHandler(({ url, disposition }) => {
    // Real popups (OAuth, payment windows) must stay real windows so window.opener works.
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true },
      };
    }
    sendToHost(contents, 'webview:open', { url, disposition, fromId: contents.id });
    return { action: 'deny' };
  });

  contents.on('context-menu', (_ev, params) => showPageContextMenu(contents, params));
  // Esc inside a page still closes Peek / the find bar (pages keep receiving it too).
  contents.on('before-input-event', (_ev, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') sendToHost(contents, 'webview:escape', { fromId: contents.id });
  });
});

function sendToHost(contents, channel, payload) {
  const host = contents.hostWebContents;
  if (host && !host.isDestroyed()) host.send(channel, payload);
}

function showPageContextMenu(contents, params) {
  const t = [];
  const act = (action, data = {}) => () => sendToHost(contents, 'webview:action', { action, fromId: contents.id, ...data });

  if (params.linkURL) {
    t.push(
      { label: 'Open Link in New Tab', click: act('open-tab', { url: params.linkURL }) },
      { label: 'Open Link in Split View', click: act('open-split', { url: params.linkURL }) },
      { label: 'Open Link in Peek', click: act('open-peek', { url: params.linkURL }) },
      { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' },
    );
  }
  if (params.mediaType === 'image' && params.srcURL) {
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
ipcMain.handle('menu:popup', (e, items) => new Promise((resolve) => {
  let chosen = null;
  const build = (list) => list.map((it) => {
    if (it.type === 'separator') return { type: 'separator' };
    if (it.submenu) return { label: it.label, submenu: build(it.submenu) };
    return { label: it.label, enabled: it.enabled !== false, checked: it.checked, type: it.checked !== undefined ? 'checkbox' : 'normal', click: () => { chosen = it.id; } };
  });
  const menu = Menu.buildFromTemplate(build(items));
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender), callback: () => setTimeout(() => resolve(chosen), 0) });
}));

ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('devtools:open', (_e, id) => { const wc = webContents.fromId(id); if (wc) wc.openDevTools({ mode: 'detach' }); });

// ---------- Arc import ----------

ipcMain.handle('import:arc-available', () => arcDataExists());
ipcMain.handle('import:arc', () => importFromArc());

// ---------- default browser ----------

ipcMain.handle('default-browser:set', () => {
  const ok = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https');
  return { ok, packaged: app.isPackaged };
});
ipcMain.handle('default-browser:is', () => app.isDefaultProtocolClient('https'));

// ---------- windows ----------

function baseWindowOptions(extra) {
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
    ...extra,
  };
}

function createMainWindow() {
  const bounds = readJson(path.join(app.getPath('userData'), 'window.json'), { width: 1440, height: 900 });
  mainWindow = new BrowserWindow(baseWindowOptions({ ...bounds, minWidth: 640, minHeight: 420, title: APP_NAME }));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (bounds.maximized) mainWindow.maximize();
    if (process.env.MERIDIAN_SHOT) mainWindow.showInactive(); else mainWindow.show();
  });
  const saveBounds = () => {
    if (mainWindow.isDestroyed()) return;
    writeJsonAtomic(path.join(app.getPath('userData'), 'window.json'), { ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resize', debounce(saveBounds, 500));
  mainWindow.on('move', debounce(saveBounds, 500));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  if (process.env.MERIDIAN_SHOT) runScreenshotScript(mainWindow);
  return mainWindow;
}

function createMiniWindow(url = '') {
  const win = new BrowserWindow(baseWindowOptions({ width: 820, height: 640, minWidth: 360, minHeight: 300, title: APP_NAME }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { mini: '1', url } });
  win.once('ready-to-show', () => win.show());
  miniWindows.add(win);
  win.on('closed', () => miniWindows.delete(win));
  return win;
}

// Little window → "Open in Meridian": move the URL into the main window as a tab.
ipcMain.on('mini:promote', (e, url) => {
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

// ---------- menu: every shortcut is an accelerator that forwards a command to the focused window ----------

function cmd(name, ...args) {
  return () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send('command', name, ...args);
  };
}

function buildMenu() {
  const spaceItems = [];
  for (let i = 1; i <= 9; i++) spaceItems.push({ label: `Space ${i}`, accelerator: `Ctrl+${i}`, click: cmd('space-index', i - 1) });
  const tabItems = [];
  for (let i = 1; i <= 9; i++) tabItems.push({ label: `Tab ${i}`, accelerator: `CmdOrCtrl+${i}`, click: cmd('tab-index', i - 1) });

  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab…', accelerator: 'CmdOrCtrl+T', click: cmd('command-bar') },
        { label: 'New Little Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => createMiniWindow('') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => { if (!mainWindow) createMainWindow(); else mainWindow.focus(); } },
        { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-folder') },
        { type: 'separator' },
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: cmd('edit-url') },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('reopen-tab') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        { type: 'separator' },
        { label: 'Import from Arc…', click: cmd('import-arc') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: cmd('copy-url') },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: cmd('find-next') },
        { label: 'Find Previous', accelerator: 'CmdOrCtrl+Shift+G', click: cmd('find-prev') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: cmd('toggle-sidebar') },
        { label: 'Split View', accelerator: 'Ctrl+Shift+=', click: cmd('split') },
        { label: 'Close Split View', accelerator: 'Ctrl+Shift+-', click: cmd('unsplit') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: cmd('reload') },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('hard-reload') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom', 1) },
        { label: 'Zoom In ', accelerator: 'CmdOrCtrl+Plus', visible: false, click: cmd('zoom', 1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom', -1) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoom', 0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools (page)', accelerator: 'CmdOrCtrl+Alt+I', click: cmd('devtools') },
        { label: 'Developer Tools (Meridian UI)', accelerator: 'CmdOrCtrl+Alt+Shift+I', click: () => BrowserWindow.getFocusedWindow()?.webContents.openDevTools({ mode: 'detach' }) },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: cmd('back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: cmd('forward') },
        { label: 'Back ', accelerator: 'CmdOrCtrl+Left', visible: false, click: cmd('back') },
        { label: 'Forward ', accelerator: 'CmdOrCtrl+Right', visible: false, click: cmd('forward') },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', click: cmd('toggle-pin') },
        { label: 'Add to Favorites', click: cmd('favorite') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: cmd('tab-step', 1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: cmd('tab-step', -1) },
        { label: 'Next Tab ', accelerator: 'CmdOrCtrl+Alt+Down', visible: false, click: cmd('tab-step', 1) },
        { label: 'Previous Tab ', accelerator: 'CmdOrCtrl+Alt+Up', visible: false, click: cmd('tab-step', -1) },
        { label: 'Clear Today Tabs', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('clear-today') },
        { type: 'separator' },
        ...tabItems,
      ],
    },
    {
      label: 'Spaces',
      submenu: [
        { label: 'New Space…', click: cmd('new-space') },
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: cmd('space-step', 1) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: cmd('space-step', -1) },
        { type: 'separator' },
        ...spaceItems,
      ],
    },
    { role: 'windowMenu' },
  ];
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
  buildMenu();
  createMainWindow();
  for (const url of pendingUrls) openExternalUrl(url);
  pendingUrls = [];
  const argUrl = process.argv.slice(1).find((a) => /^https?:\/\//i.test(a));
  if (argUrl) openExternalUrl(argUrl);

  app.on('activate', () => { if (!mainWindow) createMainWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
