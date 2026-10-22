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
    settings: { searchEngine: 'google', archiveAfterHours: 12, adblock: true, sidebarRight: false, sidebarHidden: false, extensions: [] },
    onboarded: false,
  };
}

function newSpace(name, icon, color, profileId) {
  return { id: uid(), name, icon, color, profileId, pinned: [], today: [], activeTabId: null, split: null };
}

let saveTimer = null;
function save() {
  if (MINI) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.saveState(serialize()), 600);
}
function serialize() { return state; }
window.addEventListener('beforeunload', () => { if (!MINI && state) api.saveStateSync(serialize()); });

const space = () => state.spaces.find((s) => s.id === state.activeSpaceId) || state.spaces[0];
const favs = (sp = space()) => (state.favorites[sp.profileId] ||= []);
const partitionFor = (profileId) => `persist:profile-${profileId}`;

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
function faviconFor(tab) {
  if (tab.favicon) return tab.favicon;
  const o = originOf(tab.url);
  return o.startsWith('http') ? o + '/favicon.ico' : '';
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const titleOf = (t) => t.customTitle || t.title || hostOf(t.url) || 'New Tab';

// ---------------------------------------------------------------- webviews

function ensureView(tab, sp = space()) {
  let wv = rt.views.get(tab.id);
  if (wv) return wv;
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
  return wv;
}

function destroyView(id) {
  const wv = rt.views.get(id);
  if (!wv) return;
  for (const [wc, t] of rt.wcToTab) if (t === id) rt.wcToTab.delete(wc);
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
    l.node.favicon = e.favicons[e.favicons.length - 1]; update(); save();
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
  sp.activeTabId = id;
  l.node.lastActive = now();
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
  if (!tab) return openTab(url);
  const wv = ensureView(tab);
  wv.loadURL(url).catch(() => {});
  activate(tab.id);
}

function nextActiveAfterClose(sp, closedId) {
  const visible = visibleTabIds(sp).filter((x) => x !== closedId);
  const recent = rt.mru.find((x) => x !== closedId && visible.includes(x) && rt.views.has(x));
  return recent || null;
}

function closeTab(id = space().activeTabId) {
  if (!id) return;
  const sp = space();
  const l = locate(id, sp);
  if (!l) return;
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
    sp.activeTabId = nextActiveAfterClose(sp, id);
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

function archiveTab(tab, sp) {
  state.archive.unshift({ url: tab.url, title: titleOf(tab), favicon: tab.favicon, closedAt: now(), spaceId: sp.id });
  state.archive = state.archive.slice(0, 500);
}

function autoArchive() {
  const hours = state.settings.archiveAfterHours;
  if (!hours) return;
  const cutoff = now() - hours * 3600e3;
  let changed = false;
  for (const sp of state.spaces) {
    sp.today = sp.today.filter((t) => {
      const keep = t.id === sp.activeTabId || (sp.split?.ids.includes(t.id)) || (t.lastActive || now()) > cutoff;
      if (!keep) { archiveTab(t, sp); destroyView(t.id); changed = true; }
      return keep;
    });
  }
  if (changed) { render(); save(); }
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

function switchSpace(id, dir = 0) {
  if (id === state.activeSpaceId) return;
  state.activeSpaceId = id;
  const pages = $('#space-pages');
  pages.classList.remove('slide-left', 'slide-right');
  void pages.offsetWidth;
  if (dir) pages.classList.add(dir > 0 ? 'slide-left' : 'slide-right');
  const sp = space();
  if (sp.activeTabId && locate(sp.activeTabId)) activate(sp.activeTabId); else { sp.activeTabId = null; render(); save(); }
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

async function spaceMenu(sp) {
  const choice = await api.popupMenu([
    { id: 'rename', label: 'Rename…' },
    { id: 'icon', label: 'Change icon (emoji)…' },
    { label: 'Color', submenu: SPACE_COLORS.map((c, i) => ({ id: 'color:' + c, label: ['Lavender', 'Rose', 'Sand', 'Sage', 'Sky', 'Violet', 'Clay', 'Slate'][i], checked: sp.color === c })) },
    { label: 'Profile', submenu: [
      ...state.profiles.map((p) => ({ id: 'profile:' + p.id, label: p.name, checked: sp.profileId === p.id })),
      { type: 'separator' },
      { id: 'profile:new', label: 'New profile…' },
    ] },
    { type: 'separator' },
    { id: 'left', label: 'Move left', enabled: state.spaces[0] !== sp },
    { id: 'right', label: 'Move right', enabled: state.spaces.at(-1) !== sp },
    { type: 'separator' },
    { id: 'delete', label: 'Delete space…', enabled: state.spaces.length > 1 },
  ]);
  if (!choice) return;
  if (choice === 'rename') { const v = await askText('Rename space', sp.name); if (v) sp.name = v; }
  if (choice === 'icon') { const v = await askText('Space icon', sp.icon || '', 'Paste an emoji (empty = none)'); if (v != null) sp.icon = [...v.trim()].slice(0, 2).join('') || null; }
  if (choice.startsWith('color:')) sp.color = choice.slice(6);
  if (choice === 'profile:new') {
    const name = await askText('New profile', sp.name, 'Profiles keep cookies & logins separate');
    if (name) { const p = { id: uid().slice(0, 8), name }; state.profiles.push(p); state.favorites[p.id] = []; reassignProfile(sp, p.id); }
  } else if (choice.startsWith('profile:')) reassignProfile(sp, choice.slice(8));
  if (choice === 'left' || choice === 'right') {
    const i = state.spaces.indexOf(sp); const j = i + (choice === 'left' ? -1 : 1);
    [state.spaces[i], state.spaces[j]] = [state.spaces[j], state.spaces[i]];
  }
  if (choice === 'delete') {
    if (!(await confirmBox(`Delete “${sp.name}” and its pinned tabs?`, 'Delete'))) return;
    walk([...sp.pinned, ...sp.today], (n) => { if (n.type === 'tab') destroyView(n.id); });
    state.spaces = state.spaces.filter((s) => s !== sp);
    if (state.activeSpaceId === sp.id) state.activeSpaceId = state.spaces[0].id;
  }
  render(); save();
}

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
  if (!url || !/^https?:/.test(url)) return;
  const h = state.history[url] || (state.history[url] = { url, title: '', count: 0, last: 0 });
  if (title) h.title = title;
  if (now() - h.last > 30_000) h.count++;
  h.last = now();
  const keys = Object.keys(state.history);
  if (keys.length > 4000) {
    keys.sort((a, b) => state.history[a].last - state.history[b].last).slice(0, keys.length - 3500).forEach((k) => delete state.history[k]);
  }
}

// ---------------------------------------------------------------- rendering

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  if (!state) return;
  const sp = space();
  applyTheme(sp);
  document.body.classList.toggle('sidebar-hidden', !!state.settings.sidebarHidden && !MINI);
  document.body.classList.toggle('sidebar-right', !!state.settings.sidebarRight);
  if (!MINI) {
    renderTopBar(sp);
    renderFavorites(sp);
    renderSpacePage(sp);
    renderSpaceDots();
  } else {
    renderMiniBar();
  }
  layoutViews();
}

function applyTheme(sp) {
  document.documentElement.style.setProperty('--space', sp.color || SPACE_COLORS[0]);
}

function renderTopBar(sp) {
  const tab = activeTab();
  const nav = tab ? navOf(tab.id) : {};
  const url = tab ? tabUrl(tab) : '';
  $('#urlbar .host').textContent = tab ? hostOf(url) : 'Search or enter URL';
  $('#urlbar .lock').innerHTML = url.startsWith('https:') ? icon('lock', 12) : '';
  $('#urlbar').classList.toggle('empty', !tab);
  $('#urlbar').classList.toggle('loading', !!nav.loading);
  $('[data-cmd="back"]').disabled = !nav.canBack;
  $('[data-cmd="forward"]').disabled = !nav.canFwd;
}

function renderFavorites(sp) {
  const el = $('#favorites');
  const list = favs(sp);
  el.innerHTML = list.map((t) => `
    <div class="fav ${t.id === sp.activeTabId ? 'active' : ''} ${rt.views.has(t.id) ? 'loaded' : ''}" draggable="true" data-id="${t.id}" title="${esc(titleOf(t))}">
      ${faviconImg(t, 20)}
    </div>`).join('');
  el.classList.toggle('empty', list.length === 0);
}

function faviconImg(t, size = 16) {
  const src = faviconFor(t);
  const letter = esc((hostOf(t.url)[0] || '•').toUpperCase());
  return `<span class="favicon" style="width:${size}px;height:${size}px">${src ? `<img src="${esc(src)}" width="${size}" height="${size}" loading="lazy" data-fallback="${letter}">` : `<span class="letter">${letter}</span>`}</span>`;
}

function renderSpacePage(sp) {
  const page = $('#space-pages');
  const pinnedHtml = sp.pinned.map((n) => nodeHtml(n, sp, 0)).join('');
  const todayHtml = sp.today.map((t) => tabRowHtml(t, sp, 'today', 0)).join('');
  page.innerHTML = `
    <div class="space-header">
      <span class="space-icon">${sp.icon ? esc(sp.icon) : ''}</span>
      <span class="space-name">${esc(sp.name)}</span>
    </div>
    <div class="zone" id="pinned" data-zone="pinned">${pinnedHtml || '<div class="zone-hint">Drag tabs here to pin them</div>'}</div>
    <div class="divider"><span>Today</span><button class="clear-today" title="Clear Today (⇧⌘K)">Clear</button></div>
    <button class="row new-tab" data-cmd="command-bar">${icon('plus', 14)}<span>New Tab</span></button>
    <div class="zone" id="today" data-zone="today">${todayHtml}</div>
  `;
  page.querySelectorAll('img[data-fallback]').forEach(bindFaviconFallback);
  $('#favorites').querySelectorAll('img[data-fallback]').forEach(bindFaviconFallback);
}

function bindFaviconFallback(img) {
  img.addEventListener('error', () => {
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = img.dataset.fallback;
    img.replaceWith(span);
  }, { once: true });
}

function nodeHtml(n, sp, depth) {
  if (n.type === 'tab') return tabRowHtml(n, sp, 'pinned', depth);
  return `
    <div class="folder-wrap ${n.collapsed ? 'collapsed' : ''}">
      <div class="row folder" draggable="true" data-id="${n.id}" style="--depth:${depth}">
        <span class="folder-ic">${icon(n.collapsed ? 'folder' : 'folderOpen', 15)}</span>
        <span class="title">${esc(n.title)}</span>
      </div>
      <div class="children">${n.children.map((c) => nodeHtml(c, sp, depth + 1)).join('')}</div>
    </div>`;
}

function tabRowHtml(t, sp, zone, depth) {
  const nav = rt.nav.get(t.id) || {};
  const loaded = rt.views.has(t.id);
  const drifted = zone !== 'today' && t.currentUrl && t.currentUrl !== t.url;
  const inSplit = sp.split?.ids.includes(t.id);
  const audio = nav.audible || nav.muted
    ? `<button class="row-btn audio" data-act="mute" title="${nav.muted ? 'Unmute' : 'Mute'}">${icon(nav.muted ? 'mute' : 'speaker', 13)}</button>` : '';
  return `
    <div class="row tab ${t.id === sp.activeTabId ? 'active' : ''} ${loaded ? 'loaded' : 'unloaded'} ${nav.loading ? 'loading' : ''} ${inSplit ? 'in-split' : ''}"
         draggable="true" data-id="${t.id}" data-zone="${zone}" style="--depth:${depth}" title="${esc(tabUrl(t))}">
      ${drifted ? `<button class="row-btn reset" data-act="reset" title="Back to pinned URL">${icon('slash', 13)}</button>` : ''}
      ${faviconImg(t)}
      <span class="title">${esc(titleOf(t))}</span>
      ${inSplit ? `<span class="badge">${icon('split', 12)}</span>` : ''}
      ${audio}
      <button class="row-btn close" data-act="close" title="${zone === 'today' ? 'Close' : 'Unload'} (⌘W)">${icon(zone === 'today' ? 'x' : 'x', 13)}</button>
    </div>`;
}

function renderSpaceDots() {
  $('#space-dots').innerHTML = state.spaces.map((s, i) => `
    <button class="space-dot ${s.id === state.activeSpaceId ? 'active' : ''}" data-space="${s.id}" title="${esc(s.name)} (^${i + 1})" style="--dot:${s.color}">
      ${s.icon ? `<span class="emoji">${esc(s.icon)}</span>` : '<span class="dot"></span>'}
    </button>`).join('');
}

function layoutViews() {
  const sp = space();
  const activeId = sp.activeTabId;
  const split = sp.split && sp.split.ids.includes(activeId) && sp.split.ids.every((x) => locate(x)) ? sp.split : null;
  if (split) split.ids.forEach((x) => ensureView(locate(x).node, sp));
  const visible = split ? split.ids : activeId ? [activeId] : [];
  for (const [id, wv] of rt.views) {
    const i = visible.indexOf(id);
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
  $('.cmd-icon').innerHTML = icon('search', 18);
  $('#find-prev').innerHTML = icon('chevronUp', 14);
  $('#find-next').innerHTML = icon('chevronDown', 14);
  $('#find-close').innerHTML = icon('x', 14);
  $('#peek-split').innerHTML = icon('split', 14);
  $('#peek-expand').innerHTML = icon('expand', 14);
  $('#peek-close').innerHTML = icon('x', 14);
  $('#empty-state .logo').innerHTML = `<svg width="56" height="56" viewBox="0 0 64 64"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="var(--space)" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="50" r="4" fill="var(--space)"/></svg>`;

  document.addEventListener('click', (e) => {
    const cmdEl = e.target.closest('[data-cmd]');
    if (cmdEl && !cmdEl.disabled) { e.stopPropagation(); return runCommand(cmdEl.dataset.cmd); }
  });

  $('#urlbar').addEventListener('click', (e) => { if (!e.target.closest('[data-cmd]')) openCommandBar('edit'); });
  $('#btn-add-space').addEventListener('click', createSpace);
  $('#btn-downloads').addEventListener('click', showDownloadsMenu);

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

  sidebar.addEventListener('contextmenu', async (e) => {
    const dot = e.target.closest('.space-dot');
    if (dot) { e.preventDefault(); return spaceMenu(state.spaces.find((s) => s.id === dot.dataset.space)); }
    const row = e.target.closest('.row.tab, .fav, .row.folder');
    e.preventDefault();
    if (!row) {
      const choice = await api.popupMenu([{ id: 'folder', label: 'New Folder' }, { id: 'tab', label: 'New Tab' }, { id: 'space', label: 'New Space…' }]);
      if (choice === 'folder') newFolder();
      if (choice === 'tab') openCommandBar('new');
      if (choice === 'space') createSpace();
      return;
    }
    const id = row.dataset.id;
    const l = locate(id);
    if (!l) return;
    if (l.node.type === 'folder') {
      const choice = await api.popupMenu([{ id: 'rename', label: 'Rename…' }, { id: 'open', label: 'Open all in Today' }, { type: 'separator' }, { id: 'delete', label: 'Delete folder' }]);
      if (choice === 'rename') renameNode(id);
      if (choice === 'delete') deleteNode(id);
      if (choice === 'open') walk(l.node.children, (n) => { if (n.type === 'tab') openTab(n.url, { background: true }); });
      return;
    }
    const choice = await api.popupMenu([
      { id: 'copy', label: 'Copy URL' },
      { id: 'split', label: 'Open in Split View', enabled: space().activeTabId !== id },
      { id: 'dup', label: 'Duplicate' },
      { type: 'separator' },
      l.zone === 'today' ? { id: 'pin', label: 'Pin Tab' } : { id: 'unpin', label: 'Unpin (move to Today)' },
      { id: 'fav', label: 'Add to Favorites', enabled: l.zone !== 'fav' },
      { id: 'rename', label: 'Rename…', enabled: l.zone !== 'today' },
      { id: 'move', label: 'Move to Space', submenu: state.spaces.filter((s) => s.id !== state.activeSpaceId).map((s) => ({ id: 'move:' + s.id, label: s.name })) },
      { type: 'separator' },
      { id: 'unload', label: 'Unload', enabled: rt.views.has(id) },
      { id: 'close', label: l.zone === 'today' ? 'Close Tab' : 'Delete from Sidebar' },
    ]);
    if (!choice) return;
    if (choice === 'copy') { api.copy(tabUrl(l.node)); toast('Copied URL'); }
    if (choice === 'split') splitWith(id);
    if (choice === 'dup') openTab(tabUrl(l.node));
    if (choice === 'pin' || choice === 'unpin') togglePin(id);
    if (choice === 'fav') addFavorite(id);
    if (choice === 'rename') renameNode(id);
    if (choice === 'unload') { destroyView(id); if (space().activeTabId === id) { space().activeTabId = null; } render(); }
    if (choice === 'close') { if (l.zone === 'today') closeTab(id); else deleteNode(id); }
    if (choice.startsWith('move:')) moveToSpace(id, choice.slice(5));
  });

  initDragAndDrop();
  initSidebarResize();

  // Hidden sidebar reveals on hover at the window edge, like Arc.
  $('#edge-hotzone').addEventListener('mouseenter', () => { if (state.settings.sidebarHidden) { rt.sidebarPeek = true; document.body.classList.add('sidebar-peek'); } });
  sidebar.addEventListener('mouseleave', () => { if (rt.sidebarPeek) { rt.sidebarPeek = false; document.body.classList.remove('sidebar-peek'); } });
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
  { id: 'new-folder', label: 'New Folder', icon: 'folder' },
  { id: 'split', label: 'Split View', icon: 'split' },
  { id: 'unsplit', label: 'Close Split View', icon: 'split' },
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', icon: 'sidebar' },
  { id: 'copy-url', label: 'Copy URL', icon: 'copy' },
  { id: 'toggle-pin', label: 'Pin / Unpin Tab', icon: 'pin' },
  { id: 'favorite', label: 'Add to Favorites', icon: 'star' },
  { id: 'clear-today', label: 'Clear Today Tabs', icon: 'archive' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'import-arc', label: 'Import from Arc', icon: 'bolt' },
  { id: 'toggle-adblock', label: 'Toggle Ad Blocker', icon: 'shield' },
  { id: 'default-browser', label: 'Set Meridian as Default Browser', icon: 'globe' },
  { id: 'devtools', label: 'Developer Tools', icon: 'settings' },
  { id: 'sidebar-side', label: 'Move Sidebar to Other Side', icon: 'sidebar' },
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
    for (const { c } of cmds) out.push({ kind: 'cmd', icon: c.icon, title: c.label, sub: 'Command', action: () => runCommand(c.id) });
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
  const { results, index } = rt.cmd;
  box.innerHTML = results.map((r, i) => `
    <div class="cmd-row ${i === index ? 'sel' : ''}" data-i="${i}">
      <span class="cmd-ic">${r.favicon ? faviconImg(r.favicon, 16) : icon(r.icon, 16)}</span>
      <span class="cmd-title">${esc(r.title)}</span>
      <span class="cmd-sub">${esc(r.sub || '')}</span>
      ${i === index && r.badge ? `<span class="cmd-badge">${esc(r.badge)} ↵</span>` : ''}
    </div>`).join('');
  box.querySelectorAll('img[data-fallback]').forEach(bindFaviconFallback);
  box.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
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
    const n = rt.cmd.results.length;
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); rt.cmd.index = (rt.cmd.index + 1) % Math.max(n, 1); drawCommandResults(); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); rt.cmd.index = (rt.cmd.index - 1 + n) % Math.max(n, 1); drawCommandResults(); }
    else if (e.key === 'Enter') { e.preventDefault(); runResult(rt.cmd.index); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCommandBar(); }
  });
  $('#cmd-results').addEventListener('mousedown', (e) => {
    const row = e.target.closest('.cmd-row');
    if (row) { e.preventDefault(); runResult(Number(row.dataset.i)); }
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
}

async function showDownloadsMenu() {
  if (!rt.downloads.length) return toast('No downloads yet');
  const choice = await api.popupMenu(rt.downloads.map((d) => ({ id: d.path, label: `${d.name}  ${d.state === 'completed' ? fmtBytes(d.total) : d.state}` })));
  if (choice) api.revealDownload(choice);
}

// ---------------------------------------------------------------- settings & import

async function openSettings() {
  const s = state.settings;
  const isDefault = await api.isDefaultBrowser().catch(() => false);
  const arc = await api.arcAvailable().catch(() => false);
  showModal(`
    <h3>Settings</h3>
    <label class="field"><span>Search engine</span>
      <select id="set-engine">${Object.entries(SEARCH_ENGINES).map(([k, v]) => `<option value="${k}" ${k === s.searchEngine ? 'selected' : ''}>${v.name}</option>`).join('')}</select>
    </label>
    <label class="field"><span>Archive Today tabs after</span>
      <select id="set-archive">${ARCHIVE_OPTIONS.map(([h, l]) => `<option value="${h}" ${h === s.archiveAfterHours ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </label>
    <label class="field check"><input type="checkbox" id="set-adblock" ${s.adblock !== false ? 'checked' : ''}><span>Block ads &amp; trackers</span></label>
    <label class="field check"><input type="checkbox" id="set-right" ${s.sidebarRight ? 'checked' : ''}><span>Sidebar on the right</span></label>
    <div class="field"><span>Default browser</span>
      ${isDefault ? '<span class="muted">Meridian is your default browser ✓</span>' : '<button class="btn" id="set-default">Make default</button>'}
    </div>
    <div class="field"><span>Arc</span><button class="btn" id="set-import" ${arc ? '' : 'disabled'}>${arc ? 'Import spaces &amp; pinned tabs' : 'Arc data not found'}</button></div>
    <div class="field col"><span>Profiles</span>
      ${state.profiles.map((p) => `<div class="prof-row"><span>${esc(p.name)}</span><span class="muted">${state.spaces.filter((x) => x.profileId === p.id).map((x) => esc(x.name)).join(', ') || 'unused'}</span><button class="btn small" data-clear="${p.id}">Clear cookies &amp; data</button></div>`).join('')}
    </div>
    <div class="field col"><span>Extensions <em class="muted">(experimental — no toolbar popups yet)</em></span>
      ${(s.extensions || []).map((p, i) => `<div class="prof-row"><span title="${esc(p)}">${esc(p.split('/').slice(-2).join('/'))}</span><button class="btn small" data-rm-ext="${i}">Remove</button></div>`).join('')}
      <button class="btn small" id="set-add-ext">Load unpacked extension…</button>
    </div>
    <div class="modal-actions"><span class="muted grow">Meridian · the open-source Arc browser alternative</span><button class="btn accent" data-a="close">Done</button></div>
  `, (m, close) => {
    $('#set-engine', m).onchange = (e) => { s.searchEngine = e.target.value; save(); };
    $('#set-archive', m).onchange = (e) => { s.archiveAfterHours = Number(e.target.value); save(); };
    $('#set-adblock', m).onchange = (e) => { s.adblock = e.target.checked; api.setAdblock(s.adblock); save(); };
    $('#set-right', m).onchange = (e) => { s.sidebarRight = e.target.checked; render(); save(); };
    $('#set-default', m)?.addEventListener('click', setDefaultBrowser);
    $('#set-import', m)?.addEventListener('click', () => { close(); importArc(); });
    $('#set-add-ext', m).onclick = async () => { const p = await api.pickExtension(); if (p) { s.extensions = [...(s.extensions || []), p]; await api.setExtensions(s.extensions); save(); close(); openSettings(); toast('Extension loaded'); } };
    m.querySelectorAll('[data-rm-ext]').forEach((b) => b.onclick = () => { s.extensions.splice(Number(b.dataset.rmExt), 1); save(); close(); openSettings(); toast('Removed — restart Meridian to fully unload it'); });
    m.querySelectorAll('[data-clear]').forEach((b) => b.onclick = async () => {
      if (!(await confirmBox('Clear all cookies, logins and site data for this profile?', 'Clear'))) return;
      await api.clearProfileData(partitionFor(b.dataset.clear)); toast('Profile data cleared');
    });
    m.querySelector('[data-a="close"]').onclick = close;
  });
}

async function setDefaultBrowser() {
  const r = await api.setDefaultBrowser();
  if (!r.packaged) toast('Works from the built app (npm run dist), not from dev mode', { timeout: 4500 });
  else toast(r.ok ? 'macOS will ask you to confirm' : 'Could not set default browser');
}

async function importArc() {
  let data;
  try { data = await api.importArc(); } catch (err) { return toast('Arc import failed: ' + err.message, { timeout: 5000 }); }
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
}

async function onboarding() {
  state.onboarded = true; save();
  const arc = await api.arcAvailable().catch(() => false);
  showModal(`
    <div class="welcome">
      <svg width="64" height="64" viewBox="0 0 64 64"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="var(--space)" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="50" r="4" fill="var(--space)"/></svg>
      <h2>Welcome to Meridian</h2>
      <p class="muted">Spaces, pinned tabs, a Today list that tidies itself, split view, Peek and a command bar — the Arc workflow, open source.</p>
      ${arc ? '<p>We found your Arc data on this Mac. Bring over your spaces, pinned tabs, folders and favorites?</p>' : ''}
      <div class="modal-actions center">
        ${arc ? '<button class="btn accent" data-a="import">Import from Arc</button>' : ''}
        <button class="btn" data-a="skip">${arc ? 'Start fresh' : 'Get started'}</button>
      </div>
      <p class="muted small">⌘T new tab · ⌘L edit URL · ⌘S hide sidebar · ⌘D pin · ^⇧= split · ^1…9 spaces</p>
    </div>
  `, (m, close) => {
    m.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      close();
      if (a === 'import') importArc();
    });
  });
}

// ---------------------------------------------------------------- commands (menu accelerators land here)

function webview() { const t = activeTab(); return t ? rt.views.get(t.id) : null; }

function runCommand(name, ...args) {
  const wv = webview();
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
    case 'settings': return openSettings();
    case 'import-arc': return importArc();
    case 'toggle-adblock':
      state.settings.adblock = state.settings.adblock === false;
      api.setAdblock(state.settings.adblock); save();
      return toast(state.settings.adblock ? 'Ad blocker on' : 'Ad blocker off');
    case 'default-browser': return setDefaultBrowser();
    case 'devtools': { if (wv) api.openDevTools(wv.getWebContentsId()); return; }
    case 'open-url-tab': return openTab(args[0]);
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
  if (!state.spaces.some((s) => s.id === state.activeSpaceId)) state.activeSpaceId = state.spaces[0].id;

  if (MINI) {
    // The little window borrows settings/profile but never writes state.
    state = { ...state, spaces: [newSpace('Little', null, space().color, 'default')], favorites: { default: [] } };
    state.activeSpaceId = state.spaces[0].id;
  }

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

  const sp = space();
  if (sp.activeTabId && locate(sp.activeTabId)) activate(sp.activeTabId, { focus: true }); else render();
  autoArchive();
  setInterval(autoArchive, 10 * 60 * 1000);
  if (!state.onboarded) onboarding();
}

boot();
