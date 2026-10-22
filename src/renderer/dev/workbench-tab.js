/* Meridian — Workbench tab, main-UI side.
 *
 * A workbench is a normal sidebar tab ({ kind: 'workbench', url: 'meridian://workbench', project })
 * whose view is the internal workbench page in its own partition. Main gives that page its preload;
 * this file only creates the <webview> and talks to it with webview.send / ipc-message (no new
 * privileges for the main UI). Loaded after app.js and shares its globals (state, rt, space(), …).
 */

const WORKBENCH_TAB_URL = 'meridian://workbench';
const WORKBENCH_PARTITION = 'meridian-internal';
// Resolved next to index.html so it follows the UI if it moves to another scheme (see src/dev/index.js).
const WORKBENCH_PAGE = 'meridian://workbench/workbench.html';

function isWorkbenchTab(t) {
  if (!t) return false;
  if (t.kind === 'workbench') return true;
  if (t.url === WORKBENCH_TAB_URL || t.currentUrl === WORKBENCH_TAB_URL) { t.kind = 'workbench'; return true; }
  return false;
}

const wbViews = new Map(); // tabId -> { wv, ready, queue: [] }

function ensureWorkbenchView(tab) {
  const wv = document.createElement('webview');
  wv.setAttribute('partition', WORKBENCH_PARTITION);
  wv.setAttribute('allowpopups', ''); // window.open reaches main's handler, which opens http(s) links as tabs and denies the rest
  wv.dataset.tabId = tab.id;
  wv.className = 'view hidden workbench-view';
  wv.src = WORKBENCH_PAGE;
  const entry = { wv, ready: false, queue: [] };
  wbViews.set(tab.id, entry);
  // The guest only reaches us through this element; anything else isn't the workbench.
  wv.addEventListener('ipc-message', (e) => { if (e.channel === 'wb:host') onWorkbenchMessage(tab.id, e.args[0] || {}); });
  wv.addEventListener('did-start-loading', () => { entry.ready = false; });
  wv.addEventListener('dom-ready', () => { try { rt.wcToTab.set(wv.getWebContentsId(), tab.id); } catch {} });
  wv.addEventListener('focus', () => {
    const sp = space();
    if (sp.split?.ids.includes(tab.id) && sp.activeTabId !== tab.id) { sp.activeTabId = tab.id; scheduleRender(); }
  });
  $('#views').appendChild(wv);
  rt.views.set(tab.id, wv);
  return wv;
}

function sendWorkbench(tabId, msg) {
  const entry = wbViews.get(tabId);
  if (!entry || !entry.wv.isConnected) return;
  if (entry.ready) entry.wv.send('wb:command', msg); else entry.queue.push(msg);
}

function workbenchTheme() {
  return { type: 'theme', space: getComputedStyle(document.documentElement).getPropertyValue('--space').trim() || SPACE_COLORS[0] };
}

function onWorkbenchMessage(tabId, msg) {
  const l = locateAnywhere(tabId);
  const entry = wbViews.get(tabId);
  if (!l || !entry) return;
  switch (msg.type) {
    case 'ready': {
      entry.ready = true;
      entry.wv.send('wb:command', { ...workbenchTheme(), type: 'init', project: l.node.project || null }); // type last: workbenchTheme() has its own `type`
      for (const m of entry.queue.splice(0)) entry.wv.send('wb:command', m);
      return;
    }
    case 'project': {
      l.node.project = typeof msg.root === 'string' ? msg.root : undefined;
      l.node.title = msg.name ? String(msg.name).slice(0, 120) : 'Workbench';
      scheduleRender(); save();
      return;
    }
    case 'preview': return openWorkbenchPreview(tabId, String(msg.url || ''));
    // Workbench Pro: keep a hub one click away (pinned tab or favorite).
    case 'pin-hub': {
      if (l.zone === 'today') moveNode(tabId, msg.where === 'fav' ? 'fav' : 'pinned', { index: msg.where === 'fav' ? favs().length : l.space.pinned.length });
      else if (msg.where === 'fav' && l.zone !== 'fav') moveNode(tabId, 'fav', { index: favs().length });
      toast(msg.where === 'fav' ? 'Added to Favorites' : 'Pinned to the sidebar');
      return;
    }
    case 'open-url': {
      const url = String(msg.url || '');
      if (/^https?:\/\//i.test(url)) openTab(url, { after: l.zone === 'today' ? tabId : null });
      return;
    }
  }
}

// "Open preview": the project's dev server in split view, to the right of the workbench.
function openWorkbenchPreview(tabId, url) {
  if (!/^https?:\/\/\S+$/i.test(url)) return toast('Preview needs an http(s) URL');
  const l = locateAnywhere(tabId);
  if (!l) return;
  if (l.space.id !== state.activeSpaceId) switchSpace(l.space.id);
  const sp = space();
  const other = sp.split?.ids.includes(tabId) && sp.split.ids.find((x) => x !== tabId);
  if (other && locate(other)) {
    ensureView(locate(other).node, sp).loadURL(url).catch(() => {});
    return activate(tabId);
  }
  const tab = openTab(url, { background: true, after: l.zone === 'today' ? tabId : null });
  sp.split = { ids: [tabId, tab.id], ratio: 0.58 };
  activate(tabId);
}

// Command bar / menu / sidebar entry points.
function openWorkbench({ pickProject = false } = {}) {
  const sp = space();
  const active = activeTab();
  let target = isWorkbenchTab(active) ? active : null;
  if (!target) {
    const ids = visibleTabIds(sp);
    target = ids.map((id) => locate(id, sp)?.node).find((t) => isWorkbenchTab(t)) || null;
  }
  // "Open Project…" gets a fresh workbench when the existing one already has a project.
  if (!target || (pickProject && target.project)) {
    target = { id: uid(), type: 'tab', kind: 'workbench', url: WORKBENCH_TAB_URL, title: 'Workbench', lastActive: now() };
    sp.today.unshift(target);
  }
  activate(target.id);
  if (pickProject) sendWorkbench(target.id, { type: 'pick-project' });
}

// Workbench Pro: command bar entries (New Hub, Customize with Claude, Secrets, Safe Mode).
function workbenchCommand(name) {
  const type = { 'workbench-new-hub': 'new-hub', 'workbench-customize': 'customize', 'workbench-secrets': 'secrets', 'workbench-safe-mode': 'safe-mode' }[name];
  if (!type) return;
  openWorkbench();
  const target = activeTab();
  if (isWorkbenchTab(target)) sendWorkbench(target.id, { type });
}

// Keep the workbench in the space colour.
new MutationObserver(() => {
  const theme = workbenchTheme();
  for (const [id, entry] of wbViews) if (entry.ready && entry.lastSpace !== theme.space) { entry.lastSpace = theme.space; sendWorkbench(id, theme); }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
