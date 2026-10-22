/* Meridian — renderer (browser chrome UI).
 *
 * Model (persisted to state.json by the main process):
 *   spaces[]     { id, name, icon, color, profileId, pinned: Node[], today: Tab[], activeTabId, split }
 *   favorites    { [profileId]: Tab[] }          — shared by all spaces of a profile, like Arc
 *   Node = Tab   { id, type:'tab', url, title, customTitle?, favicon?, currentUrl?, lastActive? }
 *        | Folder{ id, type:'folder', title, collapsed, children: Node[] }
 * For pinned tabs & favorites `url` is the pinned home URL and `currentUrl` is where the page is now.
 * For Today tabs `url` follows navigation.
 */

const api = window.meridian;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
const MINI = params.get('mini') === '1';
// Private window: main hands us an in-memory partition; nothing here is ever saved.
const PRIVATE_PARTITION = /^meridian-private-[\w-]+$/.test(params.get('private') || '') ? params.get('private') : '';
const PRIVATE = !!PRIVATE_PARTITION;
const EPHEMERAL = MINI || PRIVATE;
const IS_MAC = api.platform === 'darwin';

// Shortcut labels are written Mac-style (⌘, ^); on Windows/Linux show Ctrl / Alt instead.
function keys(text) {
  if (IS_MAC) return text;
  return text.replace(/\^(\d|1…9)/g, 'Alt+$1').replace(/\^⇧/g, 'Ctrl+Shift+').replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/\^/g, 'Ctrl+');
}
function localizeKeys(root = document.body) {
  if (IS_MAC || !root) return;
  for (const el of root.querySelectorAll('[title]')) el.title = keys(el.title);
  for (const el of root.querySelectorAll('.keys-text')) el.textContent = keys(el.textContent);
  for (const el of root.querySelectorAll('kbd')) if (el.textContent === '⌘') el.textContent = 'Ctrl';
}

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  kagi: { name: 'Kagi', url: 'https://kagi.com/search?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  yandex: { name: 'Yandex', url: 'https://yandex.ru/search/?text=%s' },
  perplexity: { name: 'Perplexity', url: 'https://www.perplexity.ai/search?q=%s' },
};
const SPACE_COLORS = ['#8a8fe0', '#e08a9b', '#e0b27a', '#7fbf8e', '#6fb6d9', '#b48ae0', '#d98a6f', '#9aa3ad'];
const ARCHIVE_OPTIONS = [[12, '12 hours'], [24, '24 hours'], [168, '7 days'], [720, '30 days'], [0, 'Never']];
const UNLOAD_OPTIONS = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Never']];

const uid = () => crypto.randomUUID();
const now = () => Date.now();

let state = null;
const rt = {
  views: new Map(),        // tabId -> <webview>
  wcToTab: new Map(),      // webContentsId -> tabId
  nav: new Map(),          // tabId -> { loading, canBack, canFwd, audible, muted, error }
  mru: [],                 // recently activated tab ids (most recent first)
  closed: [],              // reopen stack
  downloads: [],
  peek: null,              // { wv, partition }
  cmd: { mode: 'new', results: [], index: 0 },
  sidebarPeek: false,
  findText: '',
  pages: new Map(),        // spaceId -> { el, rows: Map(nodeId -> element), … } (sidebar page per space)
  favEls: new Map(),       // tabId -> favorites tile element
  shownSpace: null,        // space whose page is on screen
  slide: null,             // running space-switch animation
  lastSeen: new Map(),     // tabId -> last time the tab was shown (memory saver)
};

// ---------------------------------------------------------------- state

function defaultState() {
  const space = newSpace('Personal', '🏠', SPACE_COLORS[0], 'default');
  return {
    version: 1,
    profiles: [{ id: 'default', name: 'Default' }],
    spaces: [space],
    activeSpaceId: space.id,
    favorites: { default: [] },
    archive: [],
    history: {},
    settings: { searchEngine: 'google', archiveAfterHours: 12, unloadAfterMinutes: 60, adblock: true, sidebarRight: false, sidebarHidden: false, extensions: [], agentAccess: 'off', agentAllowJs: false, aiUseTools: false },
    onboarded: false,
  };
}

function newSpace(name, icon, color, profileId) {
  return { id: uid(), name, icon, color, profileId, pinned: [], today: [], activeTabId: null, split: null };
}

// Saving: state.json is written debounced (but at least every few seconds while things keep changing).
// History and favicons are big and go to their own files, at most every 15 s and only when changed.
const SAVE_DELAY = 1200, SAVE_MAX_WAIT = 5000, SLOW_SAVE_EVERY = 15000;
const persist = { timer: null, first: 0, slowTimer: null, historyDirty: false, faviconsDirty: false };
function save() {
  if (EPHEMERAL || !state) return;
  scheduleSnapshot();
  const t = now();
  if (!persist.timer) persist.first = t;
  clearTimeout(persist.timer);
  persist.timer = setTimeout(() => flushSave(), Math.max(0, Math.min(SAVE_DELAY, persist.first + SAVE_MAX_WAIT - t)));
}
function markHistoryDirty() { persist.historyDirty = true; scheduleSlowSave(); }
function markFaviconsDirty() { persist.faviconsDirty = true; scheduleSlowSave(); }
function scheduleSlowSave() {
  if (EPHEMERAL || persist.slowTimer) return;
  persist.slowTimer = setTimeout(() => { persist.slowTimer = null; flushSave({ slow: true, state: false }); }, SLOW_SAVE_EVERY);
}
function saveParts({ slow = false, state: withState = true } = {}) {
  const parts = { state: withState ? serialize() : null };
  if (slow && persist.historyDirty) { parts.history = state.history; persist.historyDirty = false; }
  if (slow && persist.faviconsDirty) { parts.favicons = faviconMap(); persist.faviconsDirty = false; }
  return parts;
}
function flushSave(opts) {
  if (EPHEMERAL || !state) return;
  if (opts?.state !== false) { clearTimeout(persist.timer); persist.timer = null; }
  const parts = saveParts(opts);
  if (parts.state || parts.history || parts.favicons) return api.saveState(parts);
}
// state.json without history and favicons (those have their own files).
function serialize() { return JSON.stringify(state, (k, v) => (k === 'history' || k === 'favicon' ? undefined : v)); }
function faviconMap() {
  const out = {};
  const add = (n) => { if (n.type === 'tab' && n.favicon) out[n.id] = n.favicon; };
  for (const list of Object.values(state.favorites)) list.forEach(add);
  for (const sp of state.spaces) { walk(sp.pinned, add); sp.today.forEach(add); }
  return out;
}
window.addEventListener('beforeunload', () => { if (!EPHEMERAL && state) api.saveStateSync(saveParts({ slow: true })); });

// What main and the Settings window need to know about state (settings, profiles, spaces). Sent after
// changes, coalesced; main forwards it to the Settings window and rebuilds menus from it.
let snapshotTimer = null, lastSnapshot = '';
function scheduleSnapshot() {
  if (EPHEMERAL || snapshotTimer) return;
  snapshotTimer = setTimeout(sendSnapshot, 60);
}
function sendSnapshot() {
  snapshotTimer = null;
  if (EPHEMERAL || !state) return;
  const snap = {
    settings: state.settings, profiles: state.profiles, activeSpaceId: state.activeSpaceId,
    spaces: state.spaces.map((s) => ({ id: s.id, name: s.name, icon: s.icon, color: s.color, profileId: s.profileId })),
    stats: { archive: state.archive.length, history: rt.historyCount ?? Object.keys(state.history).length },
  };
  const json = JSON.stringify(snap);
  if (json === lastSnapshot) return;
  lastSnapshot = json;
  api.snapshot(snap);
}

const space = () => state.spaces.find((s) => s.id === state.activeSpaceId) || state.spaces[0];
const favs = (sp = space()) => (state.favorites[sp.profileId] ||= []);
const partitionFor = (profileId) => (PRIVATE ? PRIVATE_PARTITION : `persist:profile-${profileId}`);

function walk(nodes, fn, parent = null) {
  for (const n of nodes) {
    if (fn(n, nodes, parent) === false) return false;
    if (n.type === 'folder' && walk(n.children, fn, n) === false) return false;
  }
}

// Locate a node anywhere (favorites of the space's profile, pinned tree, today).
function locate(id, sp = space()) {
  let found = null;
  const f = favs(sp);
  const fi = f.findIndex((t) => t.id === id);
  if (fi >= 0) return { node: f[fi], list: f, zone: 'fav', space: sp };
  walk(sp.pinned, (n, list, parent) => {
    if (n.id === id) { found = { node: n, list, zone: 'pinned', parent, space: sp }; return false; }
  });
  if (found) return found;
  const ti = sp.today.findIndex((t) => t.id === id);
  if (ti >= 0) return { node: sp.today[ti], list: sp.today, zone: 'today', space: sp };
  return null;
}

function locateAnywhere(id) {
  for (const sp of state.spaces) {
    const l = locate(id, sp);
    if (l) return l;
  }
  return null;
}

const activeTab = () => { const sp = space(); return sp.activeTabId ? locate(sp.activeTabId)?.node : null; };
const isPinnedZone = (zone) => zone === 'fav' || zone === 'pinned';
const tabUrl = (t) => t.currentUrl || t.url;
const navOf = (id) => { if (!rt.nav.has(id)) rt.nav.set(id, {}); return rt.nav.get(id); };

// ---------------------------------------------------------------- URLs

function toUrl(input) {
  const q = input.trim();
  if (!q) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^(about|data|file|view-source):/i.test(q)) return q;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(q) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(q)) return 'http://' + q;
  if (!/\s/.test(q) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(q)) return 'https://' + q;
  return null;
}
function searchUrl(q) {
  const engine = SEARCH_ENGINES[state.settings.searchEngine] || SEARCH_ENGINES.google;
  return engine.url.replace('%s', encodeURIComponent(q));
}
const resolveInput = (q) => toUrl(q) || searchUrl(q);

function hostOf(url) {
  try { const u = new URL(url); return u.host.replace(/^www\./, '') || u.protocol.replace(':', ''); } catch { return url || ''; }
}
function originOf(url) { try { return new URL(url).origin; } catch { return ''; } }
// The UI only ever renders data: favicons; the main process fetches them through the tab's profile session.
function faviconFor(tab) {
  if (tab.favicon && tab.favicon.startsWith('data:image/')) return tab.favicon;
  queueFavicon(tab);
  return '';
}

const favQueue = [];
let favActive = 0;
function queueFavicon(tab, url) {
  rt.favTried ||= new Set();
  const src = url || (originOf(tab.url).startsWith('http') ? originOf(tab.url) + '/favicon.ico' : '');
  if (!src || rt.favTried.has(tab.id + src)) return;
  rt.favTried.add(tab.id + src);
  favQueue.push({ tab, src, partition: partitionFor(space().profileId) });
  pumpFavicons();
}
function pumpFavicons() {
  while (favActive < 4 && favQueue.length) {
    const { tab, src, partition } = favQueue.shift();
    favActive++;
    api.fetchFavicon(src, partition).then((data) => {
      if (data && data !== tab.favicon) { tab.favicon = data; scheduleRender(); markFaviconsDirty(); }
    }).finally(() => { favActive--; pumpFavicons(); });
  }
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titleOf = (t) => t.customTitle || t.title || hostOf(t.url) || 'New Tab';

// ---------------------------------------------------------------- webviews

function ensureView(tab, sp = space()) {
  let wv = rt.views.get(tab.id);
  if (wv) return wv;
  if (isWorkbenchTab(tab)) return ensureWorkbenchView(tab, sp); // Workbench integration (dev/workbench-tab.js)
  wv = document.createElement('webview');
  wv.setAttribute('partition', partitionFor(sp.profileId));
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('webpreferences', 'contextIsolation=yes');
  wv.dataset.tabId = tab.id;
  wv.className = 'view hidden';
  wv.src = tabUrl(tab) || 'about:blank';
  bindView(wv, tab.id);
  $('#views').appendChild(wv);
  rt.views.set(tab.id, wv);
  rt.lastSeen.set(tab.id, now());
  return wv;
}

function destroyView(id) {
  const wv = rt.views.get(id);
  if (!wv) return;
  for (const [wc, t] of rt.wcToTab) if (t === id) rt.wcToTab.delete(wc);
  if (document.activeElement === wv) wv.blur();
  wv.remove();
  rt.views.delete(id);
  rt.nav.delete(id);
}

function bindView(wv, id) {
  const update = () => scheduleRender();
  const findTab = () => locateAnywhere(id);

  wv.addEventListener('dom-ready', () => {
    try { rt.wcToTab.set(wv.getWebContentsId(), id); } catch {}
    const n = navOf(id);
    n.canBack = wv.canGoBack(); n.canFwd = wv.canGoForward();
  }, { once: false });

  wv.addEventListener('page-title-updated', (e) => {
    const l = findTab(); if (!l) return;
    l.node.title = e.title; update(); save();
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    const l = findTab(); if (!l || !e.favicons?.length) return;
    queueFavicon(l.node, e.favicons[e.favicons.length - 1]);
  });
  const onNav = (url, inPage) => {
    const l = findTab(); if (!l) return;
    if (isPinnedZone(l.zone)) l.node.currentUrl = url; else l.node.url = url;
    l.node.lastActive = now();
    const n = navOf(id);
    n.canBack = wv.canGoBack(); n.canFwd = wv.canGoForward();
    if (!inPage) n.error = null;
    recordHistory(url, l.node.title);
    update(); save();
  };
  wv.addEventListener('did-navigate', (e) => onNav(e.url, false));
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNav(e.url, true); });
  wv.addEventListener('did-start-loading', () => { navOf(id).loading = true; update(); });
  wv.addEventListener('did-stop-loading', () => {
    const n = navOf(id); n.loading = false; n.canBack = wv.canGoBack(); n.canFwd = wv.canGoForward();
    const l = findTab(); if (l) recordHistory(wv.getURL(), wv.getTitle());
    update();
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = aborted (user navigated away)
    navOf(id).error = { code: e.errorCode, desc: e.errorDescription, url: e.validatedURL };
    update();
  });
  wv.addEventListener('media-started-playing', () => { navOf(id).audible = true; update(); });
  wv.addEventListener('media-paused', () => { navOf(id).audible = false; update(); });
  wv.addEventListener('found-in-page', (e) => {
    const r = e.result;
    $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : (rt.findText ? '0/0' : '');
  });
  wv.addEventListener('focus', () => {
    const sp = space();
    if (sp.split?.ids.includes(id) && sp.activeTabId !== id) { sp.activeTabId = id; update(); }
  });
  wv.addEventListener('enter-html-full-screen', () => document.body.classList.add('html-fullscreen'));
  wv.addEventListener('leave-html-full-screen', () => document.body.classList.remove('html-fullscreen'));
}

// ---------------------------------------------------------------- tab actions

function activate(id, { focus = true } = {}) {
  const sp = space();
  const l = locate(id, sp);
  if (!l) return;
  if (sp.activeTabId && sp.activeTabId !== id) rt.lastSeen.set(sp.activeTabId, now());
  sp.activeTabId = id;
  l.node.lastActive = now();
  rt.lastSeen.set(id, now());
  rt.mru = [id, ...rt.mru.filter((x) => x !== id)].slice(0, 50);
  if (l.parent?.collapsed) l.parent.collapsed = false;
  const wv = ensureView(l.node, sp);
  render();
  if (focus && $('#cmdbar-overlay').hidden) setTimeout(() => wv.focus(), 0);
  save();
}

function openTab(url, { background = false, after = null } = {}) {
  const sp = space();
  const tab = { id: uid(), type: 'tab', url, title: hostOf(url), lastActive: now() };
  // Arc puts new tabs at the top of Today; links opened from a page go right below their opener.
  const idx = after ? sp.today.findIndex((t) => t.id === after) : -1;
  if (idx >= 0) sp.today.splice(idx + 1, 0, tab); else sp.today.unshift(tab);
  if (background) { ensureView(tab, sp); render(); save(); } else activate(tab.id);
  return tab;
}

function navigateActive(url) {
  const tab = activeTab();
  if (!tab || isWorkbenchTab(tab)) return openTab(url); // Workbench integration: never load web pages into it
  const wv = ensureView(tab);
  wv.loadURL(url).catch(() => {});
  activate(tab.id);
}

// The most recently used open tab; otherwise the Today tab that took the closed one's place.
function nextActiveAfterClose(sp, closedId, todayBefore = null) {
  const visible = visibleTabIds(sp).filter((x) => x !== closedId);
  const recent = rt.mru.find((x) => x !== closedId && visible.includes(x) && rt.views.has(x));
  if (recent) return recent;
  const i = todayBefore ? todayBefore.indexOf(closedId) : -1;
  if (i < 0) return null;
  const rest = todayBefore.filter((x) => x !== closedId && sp.today.some((t) => t.id === x));
  return rest[Math.min(i, rest.length - 1)] || null;
}

function closeTab(id = space().activeTabId) {
  if (!id) return;
  const sp = space();
  const l = locate(id, sp);
  if (!l) return;
  const todayBefore = sp.today.map((t) => t.id);
  if (sp.split?.ids.includes(id)) sp.split = null;
  if (l.zone === 'today') {
    l.list.splice(l.list.indexOf(l.node), 1);
    rt.closed.push({ tab: l.node, spaceId: sp.id });
    archiveTab(l.node, sp);
  } else {
    l.node.currentUrl = undefined; // unloading a pinned tab resets it to its pinned URL
  }
  destroyView(id);
  rt.mru = rt.mru.filter((x) => x !== id);
  if (sp.activeTabId === id) {
    sp.activeTabId = nextActiveAfterClose(sp, id, todayBefore);
    if (sp.activeTabId) return activate(sp.activeTabId);
  }
  render(); save();
}

function reopenTab() {
  const last = rt.closed.pop();
  if (!last) return toast('Nothing to reopen');
  const sp = state.spaces.find((s) => s.id === last.spaceId) || space();
  if (sp.id !== state.activeSpaceId) switchSpace(sp.id);
  sp.today.unshift(last.tab);
  state.archive = state.archive.filter((a) => a.url !== last.tab.url || a.closedAt < now() - 5000);
  activate(last.tab.id);
}

// The most recently archived tab (Today tabs that were closed, cleared or auto-archived).
function reopenArchived(entry = state.archive[0]) {
  if (!entry) return toast('The archive is empty');
  state.archive = state.archive.filter((a) => a !== entry);
  const sp = state.spaces.find((s) => s.id === entry.spaceId);
  if (sp && sp.id !== state.activeSpaceId) switchSpace(sp.id);
  openTab(entry.url);
}

function archiveTab(tab, sp) {
  state.archive.unshift({ url: tab.url, title: titleOf(tab), closedAt: now(), spaceId: sp.id });
  state.archive = state.archive.slice(0, 500);
}

function autoArchive() {
  const hours = state.settings.archiveAfterHours;
  if (!hours) return;
  const cutoff = now() - hours * 3600e3;
  let changed = false;
  for (const sp of state.spaces) {
    sp.today = sp.today.filter((t) => {
      const keep = t.id === sp.activeTabId || (sp.split?.ids.includes(t.id)) || (t.lastActive || now()) > cutoff || isWorkbenchTab(t);
      if (!keep) { archiveTab(t, sp); destroyView(t.id); changed = true; }
      return keep;
    });
  }
  if (changed) { render(); save(); }
}

// Memory saver, like Arc: pages not looked at for a while are unloaded (they reload on click, pinned tabs
// where they were). Never the tab on screen in any space, split tabs, tabs playing audio, or tabs an agent
// used recently.
function unloadIdleTabs() {
  const minutes = state.settings.unloadAfterMinutes;
  if (!minutes) return;
  const cutoff = now() - minutes * 60e3;
  const keep = new Set();
  for (const sp of state.spaces) {
    if (sp.activeTabId) keep.add(sp.activeTabId);
    sp.split?.ids.forEach((x) => keep.add(x));
  }
  for (const a of rt.agentLog || []) if (a.tabId && a.ts > cutoff) keep.add(a.tabId);
  for (const id of keep) rt.lastSeen.set(id, now()); // the clock starts when a tab leaves the screen
  let changed = false;
  for (const id of [...rt.views.keys()]) {
    const nav = rt.nav.get(id) || {};
    if (keep.has(id) || nav.audible || rt.agentGlow?.has(id) || (rt.lastSeen.get(id) || 0) > cutoff) continue;
    destroyView(id);
    changed = true;
  }
  if (changed) scheduleRender();
}

function clearToday() {
  const sp = space();
  for (const t of sp.today) { archiveTab(t, sp); destroyView(t.id); }
  if (sp.today.some((t) => t.id === sp.activeTabId)) sp.activeTabId = null;
  sp.today = [];
  sp.split = null;
  render(); save();
  toast('Today cleared — tabs are in the archive (⌘T → “archive”)');
}

function detach(id) {
  const l = locate(id);
  if (!l) return null;
  l.list.splice(l.list.indexOf(l.node), 1);
  return l;
}

function insertNode(node, zone, { parentId = null, index = 0 } = {}) {
  const sp = space();
  let list;
  if (zone === 'fav') list = favs(sp);
  else if (zone === 'today') list = sp.today;
  else if (parentId) list = locate(parentId)?.node.children || sp.pinned;
  else list = sp.pinned;
  list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
}

// Moving between zones changes pin semantics: pinning freezes the current URL as home.
function moveNode(id, zone, opts) {
  const l = locate(id);
  if (!l) return;
  const node = l.node;
  if (node.type === 'folder' && zone !== 'pinned') return;
  if (node.type === 'folder' && opts.parentId) {
    let inside = node.id === opts.parentId;
    walk(node.children, (n) => { if (n.id === opts.parentId) inside = true; });
    if (inside) return;
  }
  // Keep the target index stable when moving within the same list
  let index = opts.index;
  const targetList = zone === 'fav' ? favs() : zone === 'today' ? space().today : (opts.parentId ? locate(opts.parentId)?.node.children : space().pinned);
  if (targetList === l.list && l.list.indexOf(node) < index) index--;
  detach(id);
  const wasPinned = isPinnedZone(l.zone);
  const nowPinned = isPinnedZone(zone);
  if (!wasPinned && nowPinned) { node.currentUrl = node.url; delete node.lastActive; }
  if (wasPinned && !nowPinned) { node.url = tabUrl(node); delete node.currentUrl; node.lastActive = now(); delete node.customTitle; }
  insertNode(node, zone, { ...opts, index });
  render(); save();
}

function togglePin(id = space().activeTabId) {
  const l = id && locate(id);
  if (!l) return;
  if (l.zone === 'today') { moveNode(id, 'pinned', { index: space().pinned.length }); toast('Pinned'); }
  else { moveNode(id, 'today', { index: 0 }); toast('Unpinned — moved to Today'); }
}

function addFavorite(id = space().activeTabId) {
  const l = id && locate(id);
  if (!l || l.zone === 'fav') return;
  moveNode(id, 'fav', { index: favs().length });
}

function resetPinned(id) {
  const l = locate(id);
  if (!l || !isPinnedZone(l.zone)) return;
  l.node.currentUrl = l.node.url;
  const wv = rt.views.get(id);
  if (wv) wv.loadURL(l.node.url).catch(() => {});
  render(); save();
}

function newFolder() {
  const sp = space();
  const folder = { id: uid(), type: 'folder', title: 'New Folder', collapsed: false, children: [] };
  sp.pinned.unshift(folder);
  render(); save();
  renameNode(folder.id);
}

async function renameNode(id) {
  const l = locate(id);
  if (!l) return;
  const value = await askText(l.node.type === 'folder' ? 'Rename folder' : 'Rename tab', l.node.type === 'folder' ? l.node.title : titleOf(l.node));
  if (value == null) return;
  if (l.node.type === 'folder') l.node.title = value || 'Folder';
  else l.node.customTitle = value || undefined;
  render(); save();
}

function deleteNode(id) {
  const l = locate(id);
  if (!l) return;
  const ids = [];
  walk([l.node], (n) => { if (n.type === 'tab') ids.push(n.id); });
  l.list.splice(l.list.indexOf(l.node), 1);
  for (const t of ids) destroyView(t);
  const sp = space();
  if (ids.includes(sp.activeTabId)) sp.activeTabId = nextActiveAfterClose(sp, sp.activeTabId);
  if (sp.split && sp.split.ids.some((x) => ids.includes(x))) sp.split = null;
  if (sp.activeTabId) activate(sp.activeTabId); else { render(); save(); }
}

function visibleTabIds(sp = space()) {
  const ids = favs(sp).map((t) => t.id);
  walk(sp.pinned, (n, _l, parent) => { if (n.type === 'tab' && !(parent && parent.collapsed)) ids.push(n.id); });
  return ids.concat(sp.today.map((t) => t.id));
}

function stepTab(dir) {
  const ids = visibleTabIds();
  if (!ids.length) return;
  const i = ids.indexOf(space().activeTabId);
  activate(ids[(i + dir + ids.length) % ids.length]);
}

function tabByIndex(i) {
  const ids = visibleTabIds();
  if (!ids.length) return;
  activate(i === 8 ? ids[ids.length - 1] : ids[i] || ids[ids.length - 1]);
}

// ---------------------------------------------------------------- split view

function splitWith(rightId) {
  const sp = space();
  const leftId = sp.activeTabId;
  if (!leftId || leftId === rightId) return activate(rightId);
  sp.split = { ids: [leftId, rightId], ratio: 0.5 };
  activate(rightId);
}

function unsplit() { space().split = null; render(); save(); }

function initSplitHandle() {
  const handle = $('#split-handle');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = $('#content').getBoundingClientRect();
    document.body.classList.add('resizing');
    const move = (ev) => {
      const sp = space(); if (!sp.split) return;
      sp.split.ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      layoutViews();
    };
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); save(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// ---------------------------------------------------------------- spaces

// The sidebar page slides in from `dir` (render() runs the animation), the content area fades over.
function switchSpace(id, dir = 0) {
  if (id === state.activeSpaceId || !state.spaces.some((s) => s.id === id)) return;
  const from = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
  state.activeSpaceId = id;
  rt.slideDir = dir || Math.sign(state.spaces.findIndex((s) => s.id === id) - from) || 1;
  const sp = space();
  if (sp.activeTabId && locate(sp.activeTabId)) activate(sp.activeTabId);
  else {
    sp.activeTabId = null;
    // Keys must not keep going to the previous space's (now hidden) page.
    if (document.activeElement?.tagName === 'WEBVIEW') document.activeElement.blur();
    render(); save();
  }
  if (!MINI) $('#views').animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
}

function stepSpace(dir) {
  const i = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
  const next = state.spaces[(i + dir + state.spaces.length) % state.spaces.length];
  switchSpace(next.id, dir);
}

async function createSpace() {
  const name = await askText('New space', '', 'Space name');
  if (name == null) return;
  const sp = newSpace(name || 'Space', null, SPACE_COLORS[state.spaces.length % SPACE_COLORS.length], space().profileId);
  state.spaces.push(sp);
  switchSpace(sp.id, 1);
}

// Space context menu: spaceMenu() in menu.js.

function reassignProfile(sp, profileId) {
  if (sp.profileId === profileId) return;
  // Live pages belong to the old session; drop them so they reload under the new profile.
  walk([...sp.pinned, ...sp.today], (n) => { if (n.type === 'tab') destroyView(n.id); });
  for (const t of favs(sp)) destroyView(t.id);
  sp.profileId = profileId;
  state.favorites[profileId] ||= [];
  if (sp.id === state.activeSpaceId && sp.activeTabId) activate(sp.activeTabId);
}

// ---------------------------------------------------------------- history

function recordHistory(url, title) {
  if (PRIVATE || !url || !/^https?:/.test(url)) return;
  const h = state.history[url] || (state.history[url] = { url, title: '', count: 0, last: 0 });
  if (title) h.title = title;
  if (now() - h.last > 30_000) h.count++;
  h.last = now();
  markHistoryDirty();
  const keys = Object.keys(state.history);
  if (keys.length > 4000) {
    keys.sort((a, b) => state.history[a].last - state.history[b].last).slice(0, keys.length - 3500).forEach((k) => delete state.history[k]);
  }
}

// ---------------------------------------------------------------- rendering
// The sidebar is patched, not rebuilt: every row keeps its element and is only touched when what it
// shows changed. Each space has its own page element, so switching spaces only patches the rows that
// changed since that page was last on screen, and each page keeps its own scroll position.

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { if (renderQueued) render(); });
}

function render() {
  if (!state) return;
  renderQueued = false;
  const sp = space();
  applyTheme(sp);
  document.body.classList.toggle('sidebar-hidden', !!state.settings.sidebarHidden && !MINI);
  document.body.classList.toggle('sidebar-right', !!state.settings.sidebarRight);
  if (!MINI) {
    renderTopBar(sp);
    renderFavorites(sp);
    renderSpacePages(sp);
    renderSpaceDots();
  } else {
    renderMiniBar();
  }
  layoutViews();
  if (!MINI && document.body.classList.contains('ai-open')) {
    const t = activeTab();
    const chip = $('#ai-page-chip');
    if (chip) { chip.textContent = t ? hostOf(tabUrl(t)) : 'no page'; chip.classList.toggle('off', !ai.includePage || !t); }
  }
}

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setHtml = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };

// Puts `els` into `container` in order, moving only what is out of place and removing the rest.
function syncChildren(container, els) {
  let cursor = container.firstChild;
  for (const el of els) {
    if (el === cursor) cursor = cursor.nextSibling;
    else container.insertBefore(el, cursor);
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}

// A space's theme: `color`, plus an optional second colour `color2` for a gradient (Settings-free, set in
// the theme editor). Private windows keep their own grey theme.
function applyTheme(sp) {
  const color = PRIVATE ? '#7d7d88' : sp.color || SPACE_COLORS[0];
  const color2 = PRIVATE ? '#4a4a55' : sp.color2 || color;
  const key = color + color2;
  if (rt.themeColor === key) return;
  // No tint fade on the very first paint.
  if (!rt.themeColor) { document.documentElement.style.transition = 'none'; requestAnimationFrame(() => { document.documentElement.style.transition = ''; }); }
  rt.themeColor = key;
  const root = document.documentElement.style;
  root.setProperty('--space', color);
  root.setProperty('--space-bg', color);
  root.setProperty('--space-bg2', color2);
}

function renderTopBar(sp) {
  const tab = activeTab();
  const nav = tab ? navOf(tab.id) : {};
  const url = tab ? tabUrl(tab) : '';
  setText($('#urlbar .host'), tab ? hostOf(url) : 'Search or enter URL');
  setHtml($('#urlbar .lock'), url.startsWith('https:') ? icon('lock', 12) : '');
  $('#urlbar').classList.toggle('empty', !tab);
  $('#urlbar').classList.toggle('loading', !!nav.loading);
  $('[data-cmd="back"]').disabled = !nav.canBack;
  $('[data-cmd="forward"]').disabled = !nav.canFwd;
}

function renderFavorites(sp) {
  const el = $('#favorites');
  const list = favs(sp);
  syncChildren(el, list.map((t) => favEl(t, sp)));
  el.classList.toggle('empty', list.length === 0);
  if (rt.favEls.size > list.length + 100) for (const [id, e] of rt.favEls) if (!e.isConnected) rt.favEls.delete(id);
}

function favEl(t, sp) {
  let el = rt.favEls.get(t.id);
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('draggable', 'true');
    el.dataset.id = t.id;
    rt.favEls.set(t.id, el);
  }
  const cls = `fav${t.id === sp.activeTabId ? ' active' : ''}${rt.views.has(t.id) ? ' loaded' : ''}`;
  if (el.className !== cls) el.className = cls;
  const title = titleOf(t);
  if (el.title !== title) el.title = title;
  if (el._fav !== t.favicon || el._host !== t.url || !el.firstChild) { el._fav = t.favicon; el._host = t.url; el.innerHTML = faviconImg(t, 20); }
  return el;
}

function faviconImg(t, size = 16) {
  if (isWorkbenchTab(t)) return `<span class="favicon workbench-ic" style="width:${size}px;height:${size}px;color:var(--space)">${icon('code', size)}</span>`; // Workbench integration
  const src = faviconFor(t);
  const letter = esc((hostOf(t.url)[0] || '•').toUpperCase());
  return `<span class="favicon" style="width:${size}px;height:${size}px">${src ? `<img src="${esc(src)}" width="${size}" height="${size}" data-fallback="${letter}">` : `<span class="letter">${letter}</span>`}</span>`;
}

// One listener for every favicon in the UI: a broken image becomes the site's letter.
function initFaviconFallback() {
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img?.tagName !== 'IMG' || !img.dataset.fallback) return;
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = img.dataset.fallback;
    img.replaceWith(span);
  }, true);
}

function pageFor(sp) {
  let p = rt.pages.get(sp.id);
  if (p) return p;
  const el = document.createElement('div');
  el.className = 'space-page';
  el.dataset.space = sp.id;
  el.innerHTML = `
    <div class="space-header"><span class="space-icon"></span><span class="space-name"></span></div>
    <div class="zone" data-zone="pinned"></div>
    <div class="divider"><span>Today</span><button class="clear-today" title="${esc(keys('Clear Today (⇧⌘K)'))}">Clear</button></div>
    <button class="row new-tab" data-cmd="command-bar">${icon('plus', 14)}<span>New Tab</span></button>
    <div class="zone" data-zone="today"></div>`;
  p = {
    el, rows: new Map(),
    icon: $('.space-icon', el), name: $('.space-name', el),
    pinned: $('[data-zone="pinned"]', el), today: $('[data-zone="today"]', el),
  };
  $('#space-pages').appendChild(el);
  rt.pages.set(sp.id, p);
  return p;
}

function renderPage(sp) {
  const p = pageFor(sp);
  setText(p.icon, sp.icon || '');
  setText(p.name, sp.name);
  const ctx = { sp, p, seen: new Set() };
  if (sp.pinned.length) syncChildren(p.pinned, sp.pinned.map((n) => nodeEl(n, ctx, 0)));
  else if (!p.pinned.querySelector('.zone-hint')) p.pinned.innerHTML = '<div class="zone-hint">Drag tabs here to pin them</div>';
  syncChildren(p.today, sp.today.map((t) => tabEl(t, ctx, 'today', 0)));
  if (p.rows.size > ctx.seen.size) for (const id of p.rows.keys()) if (!ctx.seen.has(id)) p.rows.delete(id);
  return p;
}

function nodeEl(n, ctx, depth) {
  return n.type === 'tab' ? tabEl(n, ctx, 'pinned', depth) : folderEl(n, ctx, depth);
}

// Children of collapsed folders aren't built until the folder opens.
function folderEl(n, ctx, depth) {
  let w = ctx.p.rows.get(n.id);
  if (!w || !w.classList.contains('folder-wrap')) {
    w = document.createElement('div');
    w.className = 'folder-wrap';
    w.innerHTML = `<div class="row folder" draggable="true"></div><div class="children"></div>`;
    w._row = w.firstChild;
    w._children = w.lastChild;
    w._row.dataset.id = n.id;
    ctx.p.rows.set(n.id, w);
  }
  ctx.seen.add(n.id);
  const sig = `${n.collapsed}|${depth}|${n.title}`;
  if (w._sig !== sig) {
    w._sig = sig;
    w.className = `folder-wrap${n.collapsed ? ' collapsed' : ''}`;
    w._row.style.setProperty('--depth', depth);
    w._row.innerHTML = `<span class="folder-ic">${icon(n.collapsed ? 'folder' : 'folderOpen', 15)}</span><span class="title">${esc(n.title)}</span>`;
  }
  if (!n.collapsed) syncChildren(w._children, n.children.map((c) => nodeEl(c, ctx, depth + 1)));
  return w;
}

function tabEl(t, ctx, zone, depth) {
  const { sp, p } = ctx;
  let el = p.rows.get(t.id);
  if (!el || !el.classList.contains('tab')) {
    el = document.createElement('div');
    el.className = 'row tab';
    el.setAttribute('draggable', 'true');
    el.dataset.id = t.id;
    p.rows.set(t.id, el);
  }
  ctx.seen.add(t.id);
  const nav = rt.nav.get(t.id) || {};
  const loaded = rt.views.has(t.id);
  const inSplit = !!sp.split?.ids.includes(t.id);
  const agentGlow = !!rt.agentGlow?.has(t.id);
  // State that only restyles the row goes in classes, so a row being clicked is never rebuilt under the pointer.
  const cls = `row tab${t.id === sp.activeTabId ? ' active' : ''} ${loaded ? 'loaded' : 'unloaded'}${nav.loading ? ' loading' : ''}${inSplit ? ' in-split' : ''}${agentGlow ? ' agent' : ''}`;
  if (el.className !== cls) el.className = cls;
  if (el.dataset.zone !== zone) el.dataset.zone = zone;
  const url = tabUrl(t) || '';
  if (el.title !== url) el.title = url;
  const drifted = zone !== 'today' && t.currentUrl && t.currentUrl !== t.url;
  const sig = `${depth}|${zone}|${drifted ? 1 : 0}|${inSplit ? 1 : 0}|${agentGlow ? 1 : 0}|${nav.audible ? 1 : 0}${nav.muted ? 1 : 0}|${t.url}|${titleOf(t)}`;
  if (el._sig !== sig || el._fav !== t.favicon) {
    el._sig = sig;
    el._fav = t.favicon;
    el.style.setProperty('--depth', depth);
    el.innerHTML = tabRowInner(t, zone, nav, drifted, inSplit, agentGlow);
  }
  return el;
}

function tabRowInner(t, zone, nav, drifted, inSplit, agentGlow) {
  const audio = nav.audible || nav.muted
    ? `<button class="row-btn audio" data-act="mute" title="${nav.muted ? 'Unmute' : 'Mute'}">${icon(nav.muted ? 'mute' : 'speaker', 13)}</button>` : '';
  return `
      ${drifted ? `<button class="row-btn reset" data-act="reset" title="Back to pinned URL">${icon('slash', 13)}</button>` : ''}
      ${faviconImg(t)}
      <span class="title">${esc(titleOf(t))}</span>
      ${inSplit ? `<span class="badge">${icon('split', 12)}</span>` : ''}
      ${agentGlow ? `<span class="badge agent-badge" title="An AI agent is working in this tab">${icon('bolt', 12)}</span>` : ''}
      ${audio}
      <button class="row-btn close" data-act="close" title="${esc(keys(`${zone === 'today' ? 'Close' : 'Unload'} (⌘W)`))}">${icon('x', 13)}</button>`;
}

// Shows the active space's page; a change of space slides the old page out and the new one in.
function renderSpacePages(sp) {
  const p = renderPage(sp);
  if (rt.pages.size > state.spaces.length) {
    for (const [id, page] of rt.pages) if (!state.spaces.some((s) => s.id === id)) { page.el.remove(); rt.pages.delete(id); }
  }
  if (rt.shownSpace === sp.id) return;
  const prev = rt.pages.get(rt.shownSpace);
  rt.shownSpace = sp.id;
  for (const z of $$('#pinned, #today')) z.removeAttribute('id');
  p.pinned.id = 'pinned';
  p.today.id = 'today';
  const dir = rt.slideDir || 0;
  const from = rt.slideFrom || 0;
  rt.slideDir = 0; rt.slideFrom = 0;
  endDrag(false);
  endSlide();
  if (prev && prev !== p && dir) slidePages(prev.el, p.el, dir, from);
  else { prev?.el.classList.remove('current'); p.el.classList.add('current'); }
}

const SLIDE_MS = 280;
const SLIDE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
// Kept up to date by a ResizeObserver: reading clientWidth mid-switch would force a synchronous layout.
const pageWidth = () => rt.pageW || 260;

// `from` is where the finger left the old page (px); the animation continues from there.
function slidePages(outEl, inEl, dir, from = 0) {
  const w = pageWidth();
  const opts = { duration: SLIDE_MS * Math.max(0.35, 1 - Math.abs(from) / w), easing: SLIDE_EASE };
  outEl.classList.add('moving');
  outEl.classList.remove('current');
  inEl.classList.add('current');
  const anims = [
    outEl.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${-dir * w}px)` }], opts),
    inEl.animate([{ transform: `translateX(${from + dir * w}px)` }, { transform: 'translateX(0)' }], opts),
  ];
  const done = () => { outEl.classList.remove('moving'); outEl.style.transform = ''; inEl.style.transform = ''; };
  rt.slide = { anims, done };
  anims[1].onfinish = () => { if (rt.slide?.anims === anims) { rt.slide = null; done(); } };
}

// A new switch while one is animating snaps the old one to its end, so key repeats stay instant.
function endSlide() {
  const s = rt.slide;
  if (!s) return;
  rt.slide = null;
  s.anims.forEach((a) => a.cancel());
  s.done();
}

// Build the other spaces' pages while idle, so the first switch to each is as quick as the rest.
function prebuildPages() {
  const todo = state.spaces.filter((s) => !rt.pages.has(s.id));
  const step = (deadline) => {
    while (todo.length && deadline.timeRemaining() > 4) { const sp = todo.shift(); if (state.spaces.includes(sp)) renderPage(sp); }
    if (todo.length) requestIdleCallback(step, { timeout: 2000 });
  };
  requestIdleCallback(step, { timeout: 2000 });
}

// ---------------------------------------------------------------- two-finger swipe between spaces

function neighbourSpace(dir) {
  const i = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
  return state.spaces[(i + dir + state.spaces.length) % state.spaces.length];
}

// Follow the finger: the current page moves with the gesture and the next page comes in beside it.
function dragPages(offset) {
  endSlide();
  const cur = rt.pages.get(state.activeSpaceId)?.el;
  if (!cur) return;
  const dir = offset < 0 ? 1 : -1;
  const nb = renderPage(neighbourSpace(dir)).el;
  if (rt.drag && rt.drag.nb !== nb && rt.drag.nb !== cur) { rt.drag.nb.classList.remove('moving'); rt.drag.nb.style.transform = ''; }
  cur.style.transform = `translateX(${offset}px)`;
  if (nb !== cur) { nb.classList.add('moving'); nb.style.transform = `translateX(${offset + dir * pageWidth()}px)`; }
  rt.drag = { offset, nb, cur, dir };
}

// Gesture ended below the threshold: spring back (or just reset when `animate` is false).
function endDrag(animate = true) {
  const d = rt.drag;
  if (!d) return;
  rt.drag = null;
  const hasNb = d.nb !== d.cur;
  d.cur.style.transform = '';
  if (hasNb) d.nb.style.transform = '';
  const dropNb = () => { if (hasNb && !d.nb.classList.contains('current')) d.nb.classList.remove('moving'); };
  if (!animate || !d.offset) return dropNb();
  const w = pageWidth();
  const opts = { duration: 220, easing: SLIDE_EASE };
  const anims = [d.cur.animate([{ transform: `translateX(${d.offset}px)` }, { transform: 'translateX(0)' }], opts)];
  if (hasNb) anims.push(d.nb.animate([{ transform: `translateX(${d.offset + d.dir * w}px)` }, { transform: `translateX(${d.dir * w}px)` }], opts));
  rt.slide = { anims, done: dropNb };
  anims[0].onfinish = () => { if (rt.slide?.anims === anims) { rt.slide = null; dropNb(); } };
}

// Trackpad: horizontal wheel deltas accumulate; crossing the threshold switches once per gesture
// (the momentum that follows is swallowed until the wheel goes quiet).
function initSpaceSwipe() {
  const sidebar = $('#sidebar');
  new ResizeObserver(([e]) => { rt.pageW = e.contentRect.width; }).observe($('#space-scroller'));
  let acc = 0, tracking = false, locked = false, idle = null;
  const end = () => {
    if (tracking && !locked) endDrag(true);
    acc = 0; tracking = false; locked = false;
  };
  sidebar.addEventListener('wheel', (e) => {
    if (state.spaces.length < 2 || e.ctrlKey) return;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2;
    if (!tracking && !locked && (!horizontal || Math.abs(e.deltaX) < 1)) return;
    e.preventDefault();
    clearTimeout(idle);
    idle = setTimeout(end, 160);
    if (locked) return;
    tracking = true;
    acc += e.deltaX;
    if (Math.abs(acc) >= Math.min(pageWidth() * 0.3, 90)) {
      locked = true;
      rt.slideFrom = rt.drag?.offset || 0;
      if (rt.drag) { const d = rt.drag; rt.drag = null; if (d.nb !== d.cur && d.dir !== Math.sign(acc)) { d.nb.classList.remove('moving'); d.nb.style.transform = ''; } }
      stepSpace(Math.sign(acc));
      return;
    }
    dragPages(-acc);
  }, { passive: false });
}

function renderSpaceDots() {
  setHtml($('#space-dots'), state.spaces.map((s, i) => `
    <button class="space-dot ${s.id === state.activeSpaceId ? 'active' : ''}" data-space="${esc(s.id)}" title="${esc(s.name)} (${esc(keys(`^${i + 1}`))})" style="--dot:${esc(s.color)}">
      ${s.icon ? `<span class="emoji">${esc(s.icon)}</span>` : '<span class="dot"></span>'}
    </button>`).join(''));
}

function layoutViews() {
  const sp = space();
  const activeId = sp.activeTabId;
  const split = sp.split && sp.split.ids.includes(activeId) && sp.split.ids.every((x) => locate(x)) ? sp.split : null;
  if (split) split.ids.forEach((x) => ensureView(locate(x).node, sp));
  const visible = split ? split.ids : activeId ? [activeId] : [];
  for (const [id, wv] of rt.views) {
    const i = visible.indexOf(id);
    if (i < 0 && document.activeElement === wv) wv.blur();
    wv.classList.toggle('hidden', i < 0);
    wv.classList.toggle('focused', !!split && id === activeId);
    if (split && i >= 0) {
      const r = split.ratio * 100;
      wv.style.left = i === 0 ? '0' : `calc(${r}% + 3px)`;
      wv.style.right = i === 0 ? `calc(${100 - r}% + 3px)` : '0';
    } else {
      wv.style.left = ''; wv.style.right = '';
    }
  }
  const handle = $('#split-handle');
  handle.hidden = !split;
  if (split) handle.style.left = `calc(${split.ratio * 100}% - 3px)`;
  document.body.classList.toggle('is-split', !!split);
  $('#empty-state').hidden = visible.length > 0;

  const err = activeId && rt.nav.get(activeId)?.error;
  const box = $('#load-error');
  box.hidden = !err || !!split;
  if (err) {
    $('.err-title', box).textContent = `Can’t open ${hostOf(err.url)}`;
    $('.err-desc', box).textContent = err.desc || `Error ${err.code}`;
  }
}

function renderMiniBar() {
  const tab = activeTab();
  $('.mini-host').textContent = tab ? hostOf(tabUrl(tab)) : '';
  const nav = tab ? navOf(tab.id) : {};
  $('#mini-bar [data-cmd="back"]').disabled = !nav.canBack;
}

// ---------------------------------------------------------------- sidebar interactions

function initSidebar() {
  $$('[data-cmd]').forEach((b) => { if (b.dataset.cmd && !b.innerHTML.trim()) b.innerHTML = icon({ 'toggle-sidebar': 'sidebar', back: 'back', forward: 'forward', reload: 'reload', 'copy-url': 'copy' }[b.dataset.cmd] || 'plus'); });
  $('#btn-downloads').innerHTML = icon('download');
  $('#btn-add-space').innerHTML = icon('plus');
  $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, 15); });
  if (EPHEMERAL) $$('.empty-act[data-cmd="ai-panel"], .empty-act[data-cmd="archive"]').forEach((el) => el.remove());
  $('.cmd-icon').innerHTML = icon('search', 18);
  $('#find-prev').innerHTML = icon('chevronUp', 14);
  $('#find-next').innerHTML = icon('chevronDown', 14);
  $('#find-close').innerHTML = icon('x', 14);
  $('#peek-split').innerHTML = icon('split', 14);
  $('#peek-expand').innerHTML = icon('expand', 14);
  $('#peek-close').innerHTML = icon('x', 14);
  $('#empty-state .logo').innerHTML = `<svg width="56" height="56" viewBox="0 7 64 64"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="var(--space)" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="50" r="4" fill="var(--space)"/></svg>`;

  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    if (cmdEl && !cmdEl.disabled) { e.stopPropagation(); return runCommand(cmdEl.dataset.cmd); }
  });

  $('#urlbar').addEventListener('click', (e) => { if (!e.target.closest('[data-cmd]')) openCommandBar('edit'); });
  $('#btn-add-space').addEventListener('click', createSpace);
  $('#btn-downloads').addEventListener('click', toggleDownloads);

  const sidebar = $('#sidebar');
  sidebar.addEventListener('click', (e) => {
    const btn = e.target.closest('.row-btn');
    const row = e.target.closest('.row.tab, .fav');
    if (btn && row) {
      e.stopPropagation();
      const id = row.dataset.id;
      if (btn.dataset.act === 'close') closeTab(id);
      if (btn.dataset.act === 'reset') resetPinned(id);
      if (btn.dataset.act === 'mute') {
        const wv = rt.views.get(id); const n = navOf(id);
        n.muted = !n.muted; wv?.setAudioMuted(n.muted); render();
      }
      return;
    }
    if (row) return activate(row.dataset.id);
    const folder = e.target.closest('.row.folder');
    if (folder) {
      const l = locate(folder.dataset.id);
      if (l) { l.node.collapsed = !l.node.collapsed; render(); save(); }
      return;
    }
    if (e.target.closest('.clear-today')) return clearToday();
    const dot = e.target.closest('.space-dot');
    if (dot) {
      const i = state.spaces.findIndex((s) => s.id === dot.dataset.space);
      const cur = state.spaces.findIndex((s) => s.id === state.activeSpaceId);
      switchSpace(dot.dataset.space, Math.sign(i - cur));
    }
  });

  sidebar.addEventListener('auxclick', (e) => {
    const row = e.target.closest('.row.tab');
    if (e.button === 1 && row) closeTab(row.dataset.id);
  });

  sidebar.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row.folder, .row.tab[data-zone="pinned"]');
    if (row) renameNode(row.dataset.id);
  });

  sidebar.addEventListener('contextmenu', showSidebarMenu); // menu.js: tabs, folders, favorites, spaces, background

  initDragAndDrop();
  initSidebarResize();

  // Hidden sidebar reveals on hover at the window edge, like Arc, and stays a moment after the pointer
  // leaves (so a sloppy mouse doesn't close it).
  let hideTimer = null;
  const reveal = () => {
    clearTimeout(hideTimer);
    if (!state.settings.sidebarHidden || rt.sidebarPeek) return;
    rt.sidebarPeek = true;
    document.body.classList.add('sidebar-peek');
  };
  const conceal = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!rt.sidebarPeek || sidebar.matches(':hover')) return;
      rt.sidebarPeek = false;
      document.body.classList.remove('sidebar-peek');
    }, 350);
  };
  $('#edge-hotzone').addEventListener('mouseenter', reveal);
  sidebar.addEventListener('mouseenter', () => { if (rt.sidebarPeek) clearTimeout(hideTimer); });
  sidebar.addEventListener('mouseleave', () => { if (rt.sidebarPeek) conceal(); });
}

function moveToSpace(id, spaceId) {
  const l = locate(id);
  const target = state.spaces.find((s) => s.id === spaceId);
  if (!l || !target) return;
  detach(id);
  if (target.profileId !== space().profileId) destroyView(id);
  if (l.zone === 'today') target.today.unshift(l.node); else target.pinned.push(l.node);
  if (space().activeTabId === id) space().activeTabId = nextActiveAfterClose(space(), id);
  render(); save();
  toast(`Moved to ${target.name}`);
}

function initSidebarResize() {
  const saved = Number(localStorageGet('sidebarWidth')) || 0;
  if (saved) document.documentElement.style.setProperty('--sidebar-w', saved + 'px');
  const grip = document.createElement('div');
  grip.id = 'sidebar-grip';
  $('#sidebar').appendChild(grip);
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const right = state.settings.sidebarRight;
    const move = (ev) => {
      const w = Math.min(420, Math.max(200, right ? window.innerWidth - ev.clientX : ev.clientX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      localStorageSet('sidebarWidth', w);
    };
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

// ---------------------------------------------------------------- drag & drop

function initDragAndDrop() {
  const sidebar = $('#sidebar');
  let dragId = null;
  let marker = null;

  const clearMarker = () => { if (marker) marker.classList.remove('drop-before', 'drop-after', 'drop-into'); marker = null; $('#favorites').classList.remove('drop-target'); $$('.zone.drop-target').forEach((z) => z.classList.remove('drop-target')); };

  sidebar.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[draggable="true"][data-id]');
    if (!el) return;
    dragId = el.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    const l = locate(dragId);
    if (l?.node.type === 'tab') e.dataTransfer.setData('text/uri-list', tabUrl(l.node));
    e.dataTransfer.setData('text/meridian-id', dragId);
    el.classList.add('dragging');
  });
  sidebar.addEventListener('dragend', (e) => { e.target.closest?.('.dragging')?.classList.remove('dragging'); dragId = null; clearMarker(); });

  const target = (e) => {
    const fav = e.target.closest('.fav');
    if (fav) { const r = fav.getBoundingClientRect(); return { el: fav, pos: e.clientX < r.left + r.width / 2 ? 'before' : 'after' }; }
    if (e.target.closest('#favorites')) return { zone: 'fav', el: $('#favorites') };
    const row = e.target.closest('.row.tab, .row.folder');
    if (row) {
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      if (row.classList.contains('folder')) return { el: row, pos: y < 0.3 ? 'before' : y > 0.7 && row.parentElement.classList.contains('collapsed') ? 'after' : 'into' };
      return { el: row, pos: y < 0.5 ? 'before' : 'after' };
    }
    const zone = e.target.closest('.zone, .divider, .new-tab');
    if (zone) return { zone: zone.dataset.zone || 'today', el: zone.classList.contains('zone') ? zone : $('#today') };
    return null;
  };

  sidebar.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const t = target(e);
    if (!t) return;
    e.preventDefault();
    clearMarker();
    if (t.pos) { marker = t.el; marker.classList.add('drop-' + t.pos); }
    else if (t.zone === 'fav') $('#favorites').classList.add('drop-target');
    else t.el.classList.add('drop-target');
  });
  sidebar.addEventListener('dragleave', (e) => { if (!sidebar.contains(e.relatedTarget)) clearMarker(); });

  sidebar.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const t = target(e);
    const id = dragId;
    clearMarker();
    if (!t || t.el?.dataset.id === id) return;
    if (!t.pos) {
      const zone = t.zone;
      return moveNode(id, zone, { index: zone === 'fav' ? favs().length : zone === 'today' ? 0 : space().pinned.length });
    }
    const ref = locate(t.el.dataset.id);
    if (!ref) return;
    if (t.pos === 'into') return moveNode(id, 'pinned', { parentId: ref.node.id, index: 0 });
    const zone = ref.zone;
    const parentId = ref.parent?.id || null;
    const idx = ref.list.indexOf(ref.node) + (t.pos === 'after' ? 1 : 0);
    moveNode(id, zone, { parentId, index: idx });
  });
}

// ---------------------------------------------------------------- command bar

const COMMANDS = [
  { id: 'new-space', label: 'New Space', icon: 'layers' },
  { id: 'new-folder', label: 'New Folder', icon: 'folder', keys: '⌥⇧⌘N' },
  { id: 'split', label: 'Split View', icon: 'split', keys: '^⇧=' },
  { id: 'unsplit', label: 'Close Split View', icon: 'split', keys: '^⇧-' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', icon: 'sidebar', keys: '⌘S' },
  { id: 'copy-url', label: 'Copy URL', icon: 'copy', keys: '⇧⌘C' },
  { id: 'toggle-pin', label: 'Pin / Unpin Tab', icon: 'pin', keys: '⌘D' },
  { id: 'duplicate-tab', label: 'Duplicate Tab', icon: 'duplicate' },
  { id: 'favorite', label: 'Add to Favorites', icon: 'star' },
  { id: 'clear-today', label: 'Clear Today Tabs', icon: 'wand', keys: '⇧⌘K' },
  { id: 'archive', label: 'View Archive', icon: 'archive', keys: '⌥⌘A' },
  { id: 'reopen-archived', label: 'Reopen Last Archived Tab', icon: 'restore' },
  { id: 'downloads', label: 'Downloads', icon: 'download', keys: '⇧⌘J' },
  { id: 'edit-theme', label: 'Edit Space Theme', icon: 'palette' },
  { id: 'private-window', label: 'New Private Window', icon: 'incognito', keys: '⇧⌘N' },
  { id: 'little-window', label: 'New Little Window', icon: 'littleWindow', keys: '⌥⌘N' },
  { id: 'settings', label: 'Settings', icon: 'settings', keys: '⌘,' },
  { id: 'import-arc', label: 'Import from Arc', icon: 'download' },
  { id: 'onboarding', label: 'Welcome Tour', icon: 'sparkles' },
  { id: 'toggle-adblock', label: 'Toggle Ad Blocker', icon: 'shield' },
  { id: 'default-browser', label: 'Set Meridian as Default Browser', icon: 'globe' },
  { id: 'devtools', label: 'Developer Tools', icon: 'code', keys: '⌥⌘I' },
  { id: 'ai-panel', label: 'Ask AI about This Page', icon: 'sparkles', keys: '⌘J' },
  { id: 'ai-summarize', label: 'Summarize Page with AI', icon: 'sparkles' },
  { id: 'sidebar-side', label: 'Move Sidebar to Other Side', icon: 'sidebar' },
  // Workbench integration
  { id: 'open-workbench', label: 'Open Workbench', icon: 'code' },
  { id: 'open-project', label: 'Open Project in Workbench…', icon: 'code' },
  // Workbench Pro integration (handled in dev/workbench-tab.js)
  { id: 'workbench-new-hub', label: 'New Hub… (Workbench)', icon: 'layers' },
  { id: 'workbench-customize', label: 'Customize Workbench with Claude', icon: 'settings' },
  { id: 'workbench-secrets', label: 'Workbench Secrets Vault', icon: 'lock' },
  { id: 'workbench-safe-mode', label: 'Workbench Safe Mode (no customizations)', icon: 'shield' },
];

function openCommandBar(mode = 'new') {
  if (MINI) mode = 'edit';
  rt.cmd = { mode, results: [], index: 0 };
  const input = $('#cmd-input');
  const tab = activeTab();
  input.value = mode === 'edit' && tab ? tabUrl(tab) : '';
  input.placeholder = mode === 'split' ? 'Open in split view…' : 'Search, enter URL, or type a command…';
  $('#cmdbar-overlay').hidden = false;
  input.focus();
  input.select();
  updateCommandResults();
}

function closeCommandBar() {
  $('#cmdbar-overlay').hidden = true;
  const tab = activeTab();
  if (tab) rt.views.get(tab.id)?.focus();
}

function score(text, q) {
  text = (text || '').toLowerCase();
  if (!q) return 0;
  const i = text.indexOf(q);
  if (i < 0) return -1;
  return 100 - Math.min(i, 50) + (i === 0 ? 50 : 0);
}

function updateCommandResults() {
  const raw = $('#cmd-input').value;
  const q = raw.trim().toLowerCase();
  const out = [];
  const mode = rt.cmd.mode;
  const tab = activeTab();

  if (q) {
    const url = toUrl(raw);
    if (mode === 'edit' && tab && raw.trim() === tabUrl(tab)) {
      out.push({ kind: 'nav', icon: 'reload', title: 'Reload page', sub: hostOf(raw), action: () => rt.views.get(tab.id)?.reload() });
    } else if (url) {
      out.push({ kind: 'url', icon: 'globe', title: url, sub: 'Open URL', action: () => go(url) });
    } else {
      const engine = SEARCH_ENGINES[state.settings.searchEngine]?.name || 'Google';
      out.push({ kind: 'search', icon: 'search', title: raw.trim(), sub: `Search ${engine}`, action: () => go(searchUrl(raw.trim())) });
    }
  }

  if (mode !== 'split' && !MINI) {
    // Commands first when the query looks like one
    const cmds = COMMANDS.map((c) => ({ c, s: score(c.label, q) })).filter((x) => q && x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 3);
    for (const { c } of cmds) {
      if (PRIVATE && ['settings', 'import-arc', 'onboarding', 'edit-theme', 'ai-panel', 'ai-summarize', 'open-workbench', 'open-project', 'new-space'].includes(c.id)) continue;
      out.push({ kind: 'cmd', icon: c.icon, title: c.label, sub: 'Command', keys: c.keys, action: () => runCommand(c.id) });
    }
  }

  if (!MINI) {
    // Open tabs across all spaces
    const tabs = [];
    for (const sp of state.spaces) {
      const all = [...(state.favorites[sp.profileId] || []).map((t) => [t, 'fav'])];
      walk(sp.pinned, (n) => { if (n.type === 'tab') all.push([n, 'pinned']); });
      sp.today.forEach((t) => all.push([t, 'today']));
      for (const [t, zone] of all) {
        if (zone === 'fav' && sp.id !== state.activeSpaceId) continue;
        const s = Math.max(score(titleOf(t), q), score(tabUrl(t), q) - 10);
        if (q ? s < 0 : !rt.views.has(t.id) || t.id === space().activeTabId) continue;
        tabs.push({ t, sp, zone, s: s + (rt.views.has(t.id) ? 5 : 0) + (sp.id === state.activeSpaceId ? 5 : 0) });
      }
    }
    tabs.sort((a, b) => b.s - a.s || (b.t.lastActive || 0) - (a.t.lastActive || 0));
    for (const { t, sp } of tabs.slice(0, q ? 6 : 8)) {
      out.push({
        kind: 'tab', favicon: t, title: titleOf(t), sub: (sp.id !== state.activeSpaceId ? sp.name + ' · ' : '') + hostOf(tabUrl(t)), badge: 'Switch to tab',
        action: () => {
          if (mode === 'split') { if (sp.id === state.activeSpaceId) return splitWith(t.id); }
          if (sp.id !== state.activeSpaceId) switchSpace(sp.id);
          activate(t.id);
        },
      });
    }
  }

  if (q) {
    const hist = Object.values(state.history)
      .map((h) => ({ h, s: Math.max(score(h.title, q), score(h.url.replace(/^https?:\/\/(www\.)?/, ''), q)) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => (b.s + Math.log2(1 + b.h.count) * 8) - (a.s + Math.log2(1 + a.h.count) * 8) || b.h.last - a.h.last)
      .slice(0, 6);
    for (const { h } of hist) out.push({ kind: 'history', icon: 'history', title: h.title || h.url, sub: hostOf(h.url), action: () => go(h.url) });

    if (!MINI) {
      const arch = state.archive.filter((a) => score(a.title, q) >= 0 || score(a.url, q) >= 0 || 'archive'.startsWith(q)).slice(0, 5);
      for (const a of arch) out.push({ kind: 'archive', icon: 'archive', title: a.title, sub: 'Archived · ' + hostOf(a.url), action: () => go(a.url) });
    }
  }

  // De-duplicate URLs (keep first = best)
  const seen = new Set();
  rt.cmd.results = out.filter((r) => {
    if (r.kind !== 'history' && r.kind !== 'archive') return true;
    const key = r.sub + r.title;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 14);
  rt.cmd.index = 0;
  drawCommandResults();
}

function go(url) {
  const mode = rt.cmd.mode;
  if (mode === 'edit') return navigateActive(url);
  if (mode === 'split') {
    const sp = space();
    const left = sp.activeTabId;
    const tab = openTab(url, { background: true });
    if (left) { sp.split = { ids: [left, tab.id], ratio: 0.5 }; activate(tab.id); } else activate(tab.id);
    return;
  }
  openTab(url);
}

function drawCommandResults() {
  const box = $('#cmd-results');
  box.innerHTML = rt.cmd.results.map((r, i) => `
    <div class="cmd-row" data-i="${i}">
      <span class="cmd-ic">${r.favicon ? faviconImg(r.favicon, 16) : icon(r.icon, 16)}</span>
      <span class="cmd-title">${esc(r.title)}</span>
      <span class="cmd-sub">${esc(r.sub || '')}</span>
      ${r.keys ? `<span class="cmd-keys">${esc(keys(r.keys))}</span>` : ''}
      ${r.badge ? `<span class="cmd-badge">${esc(r.badge)} ↵</span>` : ''}
    </div>`).join('');
  selectCommandResult(rt.cmd.index);
}

// Moving the selection only restyles two rows; the list isn't rebuilt.
function selectCommandResult(i, { scroll = true } = {}) {
  const box = $('#cmd-results');
  rt.cmd.index = i;
  box.querySelector('.cmd-row.sel')?.classList.remove('sel');
  const row = box.children[i];
  if (!row) return;
  row.classList.add('sel');
  if (scroll) row.scrollIntoView({ block: 'nearest' });
}

function runResult(i) {
  const r = rt.cmd.results[i];
  closeCommandBar();
  if (r) r.action();
}

function initCommandBar() {
  const input = $('#cmd-input');
  input.addEventListener('input', updateCommandResults);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME candidate window owns these keys
    const n = rt.cmd.results.length;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); if (n) selectCommandResult((rt.cmd.index + 1) % n); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); if (n) selectCommandResult((rt.cmd.index - 1 + n) % n); }
    else if (e.key === 'Enter') { e.preventDefault(); runResult(rt.cmd.index); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommandBar(); }
  });
  $('#cmd-results').addEventListener('mousedown', (e) => {
    const row = e.target.closest('.cmd-row');
    if (row) { e.preventDefault(); runResult(Number(row.dataset.i)); }
  });
  // Hover selects (only on real pointer movement, so rows scrolling under a still pointer don't steal it).
  $('#cmd-results').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.cmd-row');
    if (row && Number(row.dataset.i) !== rt.cmd.index) selectCommandResult(Number(row.dataset.i), { scroll: false });
  });
  $('#cmdbar-overlay').addEventListener('mousedown', (e) => { if (e.target.id === 'cmdbar-overlay') closeCommandBar(); });
}

// ---------------------------------------------------------------- peek

function openPeek(url) {
  closePeek();
  const sp = space();
  const wv = document.createElement('webview');
  wv.setAttribute('partition', partitionFor(sp.profileId));
  wv.setAttribute('allowpopups', '');
  wv.src = url;
  $('#peek .peek-body').appendChild(wv);
  const setHost = () => { $('#peek .peek-host').textContent = hostOf(wv.getURL?.() || url); };
  $('#peek .peek-host').textContent = hostOf(url);
  wv.addEventListener('did-navigate', setHost);
  wv.addEventListener('dom-ready', () => { try { rt.wcToTab.set(wv.getWebContentsId(), '__peek__'); } catch {} wv.focus(); });
  $('#peek').hidden = false;
  rt.peek = { wv, url };
}

function closePeek() {
  if (!rt.peek) return;
  rt.peek.wv.remove();
  rt.peek = null;
  $('#peek').hidden = true;
}

function peekUrl() { try { return rt.peek.wv.getURL() || rt.peek.url; } catch { return rt.peek.url; } }

function initPeek() {
  $('#peek-close').addEventListener('click', closePeek);
  $('#peek-expand').addEventListener('click', () => { const u = peekUrl(); closePeek(); openTab(u); });
  $('#peek-split').addEventListener('click', () => { const u = peekUrl(); closePeek(); rt.cmd.mode = 'split'; go(u); });
  $('#peek').addEventListener('mousedown', (e) => { if (e.target.id === 'peek') closePeek(); });
}

// ---------------------------------------------------------------- find in page

function openFind() {
  if (!activeTab()) return;
  $('#findbar').hidden = false;
  const input = $('#find-input');
  input.focus(); input.select();
}
function find(forward = true, next = true) {
  const wv = activeTab() && rt.views.get(activeTab().id);
  const text = $('#find-input').value;
  rt.findText = text;
  if (!wv) return;
  if (!text) { wv.stopFindInPage('clearSelection'); $('#find-count').textContent = ''; return; }
  wv.findInPage(text, { forward, findNext: next });
}
function closeFind() {
  $('#findbar').hidden = true;
  const wv = activeTab() && rt.views.get(activeTab().id);
  wv?.stopFindInPage('clearSelection');
  wv?.focus();
}
function initFind() {
  const input = $('#find-input');
  input.addEventListener('input', () => find(true, false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); find(!e.shiftKey, true); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#find-next').addEventListener('click', () => find(true, true));
  $('#find-prev').addEventListener('click', () => find(false, true));
  $('#find-close').addEventListener('click', closeFind);
}

// ---------------------------------------------------------------- modals, toasts

function showModal(html, onMount) {
  const overlay = $('#modal-overlay');
  $('#modal').innerHTML = html;
  overlay.hidden = false;
  const close = () => { overlay.hidden = true; $('#modal').innerHTML = ''; };
  overlay.onmousedown = (e) => { if (e.target === overlay) { close(); overlay.dispatchEvent(new Event('dismiss')); } };
  onMount?.($('#modal'), close);
  localizeKeys($('#modal'));
  return close;
}

function askText(title, value = '', hint = '') {
  return new Promise((resolve) => {
    const close = showModal(`
      <h3>${esc(title)}</h3>
      ${hint ? `<p class="muted">${esc(hint)}</p>` : ''}
      <input class="text-input" id="ask-input" value="${esc(value)}" spellcheck="false">
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn accent" data-a="ok">OK</button></div>
    `, (m) => {
      const input = $('#ask-input', m);
      input.focus(); input.select();
      const done = (v) => { close(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
      m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'ok') done(input.value.trim()); if (a === 'cancel') done(null); });
      $('#modal-overlay').addEventListener('dismiss', () => resolve(null), { once: true });
    });
  });
}

function confirmBox(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const close = showModal(`
      <h3>${esc(message)}</h3>
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn danger" data-a="ok">${esc(okLabel)}</button></div>
    `, (m) => {
      m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) { close(); resolve(a === 'ok'); } });
      $('#modal-overlay').addEventListener('dismiss', () => resolve(false), { once: true });
    });
  });
}

function toast(text, { action, onClick, timeout = 2600, id } = {}) {
  let el = id && document.getElementById('toast-' + id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    if (id) el.id = 'toast-' + id;
    $('#toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
  }
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="toast-action">${esc(action)}</button>` : ''}`;
  if (onClick) el.onclick = onClick;
  clearTimeout(el._t);
  if (timeout) el._t = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, timeout);
  return el;
}

// ---------------------------------------------------------------- downloads

function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function onDownload(d) {
  const existing = rt.downloads.find((x) => x.id === d.id);
  if (existing) Object.assign(existing, d); else rt.downloads.unshift(d);
  rt.downloads = rt.downloads.slice(0, 20);
  const reveal = () => api.revealDownload(d.path);
  if (d.state === 'progressing' || d.state === 'started') {
    const pct = d.total ? ` ${Math.round((d.received / d.total) * 100)}%` : ` ${fmtBytes(d.received)}`;
    toast(`Downloading ${d.name}${pct}`, { id: d.id, timeout: 0 });
  } else if (d.state === 'completed') {
    toast(`Downloaded ${d.name}`, { id: d.id, action: 'Show', onClick: reveal, timeout: 5000 });
  } else if (d.state === 'cancelled' || d.state === 'interrupted') {
    toast(`Download failed: ${d.name}`, { id: d.id, timeout: 4000 });
  }
  $('#btn-downloads').classList.toggle('active', rt.downloads.some((x) => x.state === 'progressing'));
  drawDownloads();
}

// ---------------------------------------------------------------- settings & import

// Settings live in their own window (settings.html). It changes state through main, which forwards
// validated patches here: this page stays the only writer of state.json.
function openSettings(section) { if (!EPHEMERAL) api.openSettings(section); }

function applySettingsPatch(patch) {
  const s = state.settings;
  const changed = Object.keys(patch || {}).filter((k) => JSON.stringify(s[k]) !== JSON.stringify(patch[k]));
  for (const k of changed) s[k] = patch[k];
  if (changed.includes('adblock')) api.setAdblock(s.adblock);
  if (changed.includes('extensions')) api.setExtensions(s.extensions);
  if (changed.includes('agentAccess') || changed.includes('agentAllowJs')) {
    api.agentConfig({ access: s.agentAccess || 'off', allowJs: !!s.agentAllowJs });
    renderAgentBar(); refreshAiPanel();
  }
  if (changed.some((k) => k === 'sidebarRight' || k === 'sidebarHidden')) render();
  if (changed.includes('archiveAfterHours')) autoArchive();
  save();
}

async function runSettingsAction(name, arg = {}) {
  const profile = arg.id && state.profiles.find((p) => p.id === arg.id);
  switch (name) {
    case 'profile-rename': if (profile && arg.name) profile.name = arg.name.trim().slice(0, 60) || profile.name; break;
    case 'profile-add': {
      const p = { id: uid().slice(0, 8), name: (arg.name || 'New Profile').trim().slice(0, 60) };
      state.profiles.push(p); state.favorites[p.id] = [];
      break;
    }
    case 'profile-delete': {
      if (!profile || profile.id === 'default' || state.spaces.some((sp) => sp.profileId === profile.id)) return;
      for (const t of state.favorites[profile.id] || []) destroyView(t.id);
      delete state.favorites[profile.id];
      state.profiles = state.profiles.filter((p) => p !== profile);
      api.clearProfileData(partitionFor(profile.id));
      break;
    }
    case 'import-arc': return importArc();
    case 'clear-archive': state.archive = []; break;
    case 'clear-history': state.history = {}; persist.historyDirty = true; flushSave({ slow: true }); toast('History cleared'); break;
    case 'onboarding': return startOnboarding();
    case 'edit-theme': return openThemeEditor(space());
    default: return;
  }
  render(); save();
}

async function setDefaultBrowser() {
  const r = await api.setDefaultBrowser();
  if (!r.packaged) toast('Works from the built app (npm run dist), not from dev mode', { timeout: 4500 });
  else toast(r.ok ? 'macOS will ask you to confirm' : 'Could not set default browser');
}

async function importArc() {
  let data;
  try { data = await api.importArc(); } catch (err) { toast('Arc import failed: ' + err.message, { timeout: 5000 }); return null; }
  // Replace the pristine starter space; otherwise append.
  const pristine = state.spaces.length === 1 && !state.spaces[0].pinned.length && !state.spaces[0].today.length;
  if (pristine) state.spaces = [];
  for (const p of data.profiles) if (!state.profiles.some((x) => x.id === p.id)) state.profiles.push(p);
  for (const [pid, list] of Object.entries(data.favorites)) {
    const existing = new Set((state.favorites[pid] || []).map((t) => t.url));
    state.favorites[pid] = [...(state.favorites[pid] || []), ...list.filter((t) => !existing.has(t.url))];
  }
  for (const sp of data.spaces) state.spaces.push({ ...sp, activeTabId: null, split: null });
  state.activeSpaceId = state.spaces[0].id;
  render(); save();
  const tabs = data.spaces.reduce((a, s) => { let c = s.today.length; walk(s.pinned, (n) => { if (n.type === 'tab') c++; }); return a + c; }, 0);
  toast(`Imported ${data.spaces.length} spaces and ${tabs} tabs from Arc. Logins don’t transfer — sign in once per profile.`, { timeout: 7000 });
  return { spaces: data.spaces.length, tabs };
}

// ---------------------------------------------------------------- commands (menu accelerators land here)

function webview() { const t = activeTab(); return t ? rt.views.get(t.id) : null; }

function runCommand(name, ...args) {
  const wv = webview();
  // The welcome tour turns the shortcuts it teaches into "try it" checkmarks while it's open.
  if (typeof onboardingIntercept === 'function' && onboardingIntercept(name, ...args)) return;
  switch (name) {
    case 'command-bar': return openCommandBar('new');
    case 'edit-url': return openCommandBar('edit');
    case 'close-tab':
      if (!$('#cmdbar-overlay').hidden) return closeCommandBar();
      if (rt.peek) return closePeek();
      if (MINI) return window.close();
      return closeTab();
    case 'reopen-tab': return reopenTab();
    case 'back': return wv?.canGoBack() && wv.goBack();
    case 'forward': return wv?.canGoForward() && wv.goForward();
    case 'reload': return wv?.reload();
    case 'hard-reload': return wv?.reloadIgnoringCache();
    case 'copy-url': { const t = activeTab(); if (t) { api.copy(tabUrl(t)); toast('Copied URL'); } return; }
    case 'toggle-sidebar': state.settings.sidebarHidden = !state.settings.sidebarHidden; rt.sidebarPeek = false; document.body.classList.remove('sidebar-peek'); render(); return save();
    case 'sidebar-side': state.settings.sidebarRight = !state.settings.sidebarRight; render(); return save();
    case 'split': {
      const sp = space();
      if (sp.split && sp.split.ids.includes(sp.activeTabId)) return toast('Already in split view — ^⇧- to close');
      return openCommandBar('split');
    }
    case 'unsplit': return unsplit();
    case 'zoom': {
      if (!wv) return;
      const level = args[0] === 0 ? 0 : wv.getZoomLevel() + args[0] * 0.5;
      wv.setZoomLevel(level);
      return toast(`Zoom ${Math.round(Math.pow(1.2, level) * 100)}%`, { id: 'zoom', timeout: 1200 });
    }
    case 'find': return openFind();
    case 'find-next': return find(true, true);
    case 'find-prev': return find(false, true);
    case 'toggle-pin': return togglePin();
    case 'favorite': return addFavorite();
    case 'new-folder': return newFolder();
    case 'new-space': return createSpace();
    case 'space-index': { const sp = state.spaces[args[0]]; if (sp) switchSpace(sp.id, Math.sign(args[0] - state.spaces.indexOf(space()))); return; }
    case 'space-step': return stepSpace(args[0]);
    case 'tab-index': return tabByIndex(args[0]);
    case 'tab-step': return stepTab(args[0]);
    case 'clear-today': return clearToday();
    case 'settings': return openSettings(args[0]);
    case 'settings-patch': return EPHEMERAL ? null : applySettingsPatch(args[0] || {});
    case 'settings-action': return EPHEMERAL ? null : runSettingsAction(args[0], args[1] || {});
    case 'import-arc': return EPHEMERAL ? null : importArc();
    case 'onboarding': return EPHEMERAL ? null : startOnboarding();
    case 'private-window': return api.openWindow('private');
    case 'little-window': return api.openWindow('little');
    case 'duplicate-tab': { const t = activeTab(); if (t && !isWorkbenchTab(t)) openTab(tabUrl(t), { after: locate(t.id)?.zone === 'today' ? t.id : null }); return; }
    case 'archive': return MINI ? null : openArchive();
    case 'reopen-archived': return reopenArchived();
    case 'downloads': return MINI ? null : toggleDownloads();
    case 'edit-theme': return EPHEMERAL ? null : openThemeEditor(space());
    case 'space-select': { const i = state.spaces.findIndex((s) => s.id === args[0]); if (i >= 0) switchSpace(args[0], Math.sign(i - state.spaces.indexOf(space()))); return; }
    case 'open-url-in-space': {
      const sp = state.spaces.find((s) => s.id === args[0]);
      if (sp && sp.id !== state.activeSpaceId) switchSpace(sp.id);
      return openTab(args[1]);
    }
    case 'extension-add': {
      const list = state.settings.extensions || [];
      if (typeof args[0] === 'string' && !list.includes(args[0])) applySettingsPatch({ extensions: [...list, args[0]] });
      return toast('Extension loaded');
    }
    case 'toggle-adblock':
      applySettingsPatch({ adblock: state.settings.adblock === false });
      return toast(state.settings.adblock ? 'Ad blocker on' : 'Ad blocker off');
    case 'default-browser': return setDefaultBrowser();
    case 'devtools': { if (wv) api.openDevTools(wv.getWebContentsId()); return; }
    case 'open-url-tab': return openTab(args[0]);
    case 'ai-panel': return EPHEMERAL ? null : toggleAiPanel();
    case 'open-workbench': return EPHEMERAL ? null : openWorkbench(); // Workbench integration
    case 'open-project': return EPHEMERAL ? null : openWorkbench({ pickProject: true });
    case 'workbench-new-hub': case 'workbench-customize': case 'workbench-secrets': case 'workbench-safe-mode': return EPHEMERAL ? null : workbenchCommand(name); // Workbench Pro integration
    case 'ai-summarize': toggleAiPanel(true); return setTimeout(() => sendAi('Summarize this page.', { allowTools: false }), 100);
  }
}

// Links that pages open in a new tab (target=_blank, ⌘-click).
function onWebviewOpen({ url, disposition, fromId }) {
  const fromTab = rt.wcToTab.get(fromId);
  if (MINI) return webview()?.loadURL(url);
  if (fromTab === '__peek__') { rt.peek?.wv.loadURL(url); return; }
  const l = fromTab && locate(fromTab);
  // Arc behaviour: links leaving a pinned tab / favorite to another site open in Peek.
  if (l && isPinnedZone(l.zone) && disposition === 'foreground-tab' && hostOf(url) !== hostOf(tabUrl(l.node))) return openPeek(url);
  openTab(url, { background: disposition === 'background-tab', after: l?.zone === 'today' ? fromTab : null });
}

function onWebviewAction({ action, url, text, fromId }) {
  const fromTab = rt.wcToTab.get(fromId);
  if (action === 'open-tab') return MINI ? api.promoteMini(url) : openTab(url, { background: true, after: fromTab });
  if (action === 'open-peek') return MINI ? webview()?.loadURL(url) : openPeek(url);
  if (action === 'open-split') {
    if (MINI) return api.promoteMini(url);
    if (fromTab && fromTab !== '__peek__' && space().activeTabId !== fromTab) activate(fromTab);
    rt.cmd.mode = 'split'; return go(url);
  }
  if (action === 'search') return MINI ? webview()?.loadURL(searchUrl(text)) : openTab(searchUrl(text), { after: fromTab });
}

// ---------------------------------------------------------------- Little (mini) window

function initMini() {
  document.body.classList.add('mini');
  const url = params.get('url');
  const sp = space();
  sp.activeTabId = null;
  if (url) {
    const tab = { id: uid(), type: 'tab', url, title: hostOf(url) };
    sp.today.unshift(tab);
    activate(tab.id);
  } else {
    render();
    setTimeout(() => openCommandBar('edit'), 50);
  }
  $('#mini-promote').addEventListener('click', () => { const t = activeTab(); if (t) api.promoteMini(tabUrl(t)); });
  $('#mini-bar .mini-host').addEventListener('click', () => openCommandBar('edit'));
}

// ---------------------------------------------------------------- boot

async function boot() {
  state = (await api.loadState()) || defaultState();
  const d = defaultState();
  state.settings = { ...d.settings, ...state.settings };
  state.history ||= {}; state.archive ||= []; state.favorites ||= {}; state.profiles ||= d.profiles;
  for (const sp of state.spaces) { sp.split ||= null; sp.today ||= []; sp.pinned ||= []; }
  // Favicons live in their own file; older state.json files have them inline (moved out on the next save).
  const icons = state.faviconCache || {};
  delete state.faviconCache;
  const attach = (n) => {
    if (n.type !== 'tab') return;
    if (n.favicon) persist.faviconsDirty = true;
    else if (icons[n.id]) n.favicon = icons[n.id];
  };
  for (const list of Object.values(state.favorites)) list.forEach(attach);
  for (const sp of state.spaces) { walk(sp.pinned, attach); sp.today.forEach(attach); }
  if (persist.faviconsDirty) scheduleSlowSave();
  if (!state.spaces.some((s) => s.id === state.activeSpaceId)) state.activeSpaceId = state.spaces[0].id;

  if (MINI) {
    // The little window borrows settings/profile but never writes state.
    state = { ...state, spaces: [newSpace('Little', null, space().color, 'default')], favorites: { default: [] } };
    state.activeSpaceId = state.spaces[0].id;
  }
  if (PRIVATE) {
    // Only the search engine carries over; no tabs, history or archive in or out.
    const d = defaultState();
    state = { ...d, settings: { ...d.settings, searchEngine: state.settings.searchEngine, sidebarRight: state.settings.sidebarRight }, onboarded: true, profiles: [{ id: 'private', name: 'Private' }], favorites: { private: [] } };
    state.spaces = [newSpace('Private', null, '#7d7d88', 'private')];
    state.activeSpaceId = state.spaces[0].id;
    document.body.classList.add('private');
  }

  document.body.classList.add(IS_MAC ? 'plat-mac' : 'plat-other');
  localizeKeys();
  initFaviconFallback();
  initSidebar();
  initCommandBar();
  initPeek();
  initFind();
  initSplitHandle();
  $('#err-retry').addEventListener('click', () => { const t = activeTab(); if (t) { navOf(t.id).error = null; rt.views.get(t.id)?.reload(); render(); } });

  api.onCommand(runCommand);
  api.onWebviewOpen(onWebviewOpen);
  api.onWebviewAction(onWebviewAction);
  api.onDownload(onDownload);
  api.onWebviewEscape(({ fromId }) => {
    const tabId = rt.wcToTab.get(fromId);
    if (tabId === '__peek__') return closePeek();
    if (!$('#findbar').hidden) closeFind();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-overlay').hidden) { $('#modal-overlay').hidden = true; return; }
      if (rt.peek) return closePeek();
      if (!$('#findbar').hidden) return closeFind();
    }
  });

  if (MINI) return initMini();
  if (!PRIVATE) initAi(); // agents never see private windows
  initSpaceSwipe();
  initPolish();

  const sp = space();
  if (sp.activeTabId && locate(sp.activeTabId)) activate(sp.activeTabId, { focus: true }); else render();
  prebuildPages();
  autoArchive();
  setInterval(autoArchive, 10 * 60 * 1000);
  setInterval(unloadIdleTabs, 60 * 1000);
  sendSnapshot();
  if (!state.onboarded && !PRIVATE) startOnboarding();
}

// ai.js loads after this file; start once every script is in.
window.addEventListener('DOMContentLoaded', boot);
