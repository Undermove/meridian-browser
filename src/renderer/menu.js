/* Meridian — context menus (Arc-style: icons, shortcut hints, submenus, colour swatches).
 *
 * ctxMenu(items, { x, y }) -> Promise<chosen id | null>
 *   item: { id, label, icon?, keys? ('⇧⌘C', shown localized), enabled?, checked?, danger?, swatch?, submenu? }
 *       | { type: 'separator' } | { type: 'header', label }
 * Also the sidebar's right-click menus for tabs, folders, favorites, spaces and the background.
 * Loaded after app.js and shares its globals.
 */

let ctxState = null;

function ctxMenu(items, { x, y } = {}) {
  closeCtxMenu();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'ctx-backdrop';
    document.body.appendChild(backdrop);
    ctxState = { resolve, backdrop, menus: [], index: -1 };
    const root = buildCtxMenu(items, 0);
    placeCtxMenu(root, x ?? 100, y ?? 100);
    backdrop.addEventListener('mousedown', (e) => { e.preventDefault(); closeCtxMenu(null); });
    backdrop.addEventListener('contextmenu', (e) => { e.preventDefault(); closeCtxMenu(null); });
    window.addEventListener('blur', onCtxBlur);
    window.addEventListener('resize', onCtxBlur);
    document.addEventListener('keydown', onCtxKey, true);
  });
}

function onCtxBlur() { closeCtxMenu(null); }

function closeCtxMenu(value = null) {
  if (!ctxState) return;
  const { resolve, backdrop, menus } = ctxState;
  ctxState = null;
  window.removeEventListener('blur', onCtxBlur);
  window.removeEventListener('resize', onCtxBlur);
  document.removeEventListener('keydown', onCtxKey, true);
  backdrop.remove();
  for (const m of menus) { m.classList.add('closing'); setTimeout(() => m.remove(), 90); }
  resolve(value);
}

function buildCtxMenu(items, level) {
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');
  el.innerHTML = items.filter(Boolean).map((it, i) => {
    if (it.type === 'separator') return '<div class="ctx-sep"></div>';
    if (it.type === 'header') return `<div class="ctx-header">${esc(it.label)}</div>`;
    const dis = it.enabled === false;
    const lead = it.swatch
      ? `<span class="ctx-swatch" style="--c:${esc(it.swatch)}"></span>`
      : it.emoji ? `<span class="ctx-emoji">${esc(it.emoji)}</span>`
      : it.icon ? icon(it.icon, 15) : '<span class="ctx-ic-space"></span>';
    return `<div class="ctx-item${dis ? ' disabled' : ''}${it.danger ? ' danger' : ''}${it.submenu ? ' has-sub' : ''}" data-i="${i}" role="menuitem">
      <span class="ctx-lead">${lead}</span>
      <span class="ctx-label">${esc(it.label)}</span>
      ${it.checked ? `<span class="ctx-check">${icon('check', 13)}</span>` : ''}
      ${it.keys ? `<span class="ctx-keys">${esc(keys(it.keys))}</span>` : ''}
      ${it.submenu ? `<span class="ctx-chev">${icon('chevronRight', 12)}</span>` : ''}
    </div>`;
  }).join('');
  el._items = items.filter(Boolean);
  el._level = level;
  document.body.appendChild(el);
  ctxState.menus[level] = el;
  el.addEventListener('mousemove', (e) => {
    const row = e.target.closest('.ctx-item');
    if (!row || row.classList.contains('sel')) return;
    selectCtxRow(el, row);
    clearTimeout(el._subTimer);
    el._subTimer = setTimeout(() => { if (row.classList.contains('has-sub') && row.classList.contains('sel')) openCtxSub(el, row); else closeCtxSubs(level + 1); }, 120);
  });
  el.addEventListener('mouseup', (e) => {
    const row = e.target.closest('.ctx-item');
    if (!row || row.classList.contains('disabled')) return;
    const it = el._items[Number(row.dataset.i)];
    if (it.submenu) return openCtxSub(el, row);
    closeCtxMenu(it.id ?? null);
  });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return el;
}

function selectCtxRow(menu, row) {
  menu.querySelector('.ctx-item.sel')?.classList.remove('sel');
  row?.classList.add('sel');
}

function openCtxSub(menu, row) {
  const it = menu._items[Number(row.dataset.i)];
  if (!it?.submenu || row.classList.contains('disabled')) return;
  closeCtxSubs(menu._level + 1);
  const sub = buildCtxMenu(it.submenu, menu._level + 1);
  const r = row.getBoundingClientRect();
  placeCtxMenu(sub, r.right + 2, r.top - 5, r.left - 2);
}

function closeCtxSubs(fromLevel) {
  if (!ctxState) return;
  for (let i = ctxState.menus.length - 1; i >= fromLevel; i--) { ctxState.menus[i]?.remove(); ctxState.menus.length = i; }
}

function placeCtxMenu(el, x, y, flipX) {
  const w = el.offsetWidth, h = el.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + w > vw - 6) left = flipX !== undefined ? flipX - w : vw - w - 6;
  if (top + h > vh - 6) top = Math.max(6, vh - h - 6);
  el.style.left = Math.max(6, left) + 'px';
  el.style.top = Math.max(6, top) + 'px';
}

function onCtxKey(e) {
  if (!ctxState) return;
  const menu = ctxState.menus.at(-1);
  const rows = [...menu.querySelectorAll('.ctx-item:not(.disabled)')];
  const cur = menu.querySelector('.ctx-item.sel');
  const i = rows.indexOf(cur);
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape') return ctxState.menus.length > 1 ? closeCtxSubs(ctxState.menus.length - 1) : closeCtxMenu(null);
  if (e.key === 'ArrowDown') return selectCtxRow(menu, rows[(i + 1) % rows.length]);
  if (e.key === 'ArrowUp') return selectCtxRow(menu, rows[(i - 1 + rows.length) % rows.length]);
  if (e.key === 'ArrowRight' && cur?.classList.contains('has-sub')) { openCtxSub(menu, cur); const sub = ctxState.menus.at(-1); selectCtxRow(sub, sub.querySelector('.ctx-item:not(.disabled)')); return; }
  if (e.key === 'ArrowLeft' && ctxState.menus.length > 1) return closeCtxSubs(ctxState.menus.length - 1);
  if (e.key === 'Enter' && cur) {
    const it = menu._items[Number(cur.dataset.i)];
    if (it.submenu) return openCtxSub(menu, cur);
    closeCtxMenu(it.id ?? null);
  }
}

// ---------------------------------------------------------------- sidebar menus

const COLOR_NAMES = ['Lavender', 'Rose', 'Sand', 'Sage', 'Sky', 'Violet', 'Clay', 'Slate'];

async function showSidebarMenu(e) {
  e.preventDefault();
  if (EPHEMERAL && !e.target.closest('.row.tab')) return;
  const at = { x: e.clientX, y: e.clientY };
  const dot = e.target.closest('.space-dot');
  if (dot) return spaceMenu(state.spaces.find((s) => s.id === dot.dataset.space), at);
  if (e.target.closest('.space-header')) return spaceMenu(space(), at);
  const row = e.target.closest('.row.tab, .fav, .row.folder');
  if (!row) return backgroundMenu(at);
  const id = row.dataset.id;
  const l = locate(id);
  if (!l) return;
  if (l.node.type === 'folder') return folderMenu(l, at);
  return tabMenu(l, at);
}

async function backgroundMenu(at) {
  const choice = await ctxMenu([
    { id: 'tab', label: 'New Tab', icon: 'plus', keys: '⌘T' },
    { id: 'folder', label: 'New Folder', icon: 'folder', keys: '⌥⇧⌘N' },
    { id: 'space', label: 'New Space…', icon: 'layers' },
    { type: 'separator' },
    { id: 'theme', label: 'Edit Space Theme…', icon: 'palette' },
    { id: 'archive', label: 'View Archive', icon: 'archive', keys: '⌥⌘A' },
    { id: 'clear', label: 'Clear Today', icon: 'wand', keys: '⇧⌘K', enabled: space().today.length > 0 },
    { type: 'separator' },
    { id: 'side', label: state.settings.sidebarRight ? 'Move Sidebar to the Left' : 'Move Sidebar to the Right', icon: 'sidebar' },
    { id: 'workbench', label: 'Open Project in Workbench…', icon: 'code' }, // Workbench integration
  ], at);
  if (choice === 'workbench') openWorkbench({ pickProject: true });
  if (choice === 'folder') newFolder();
  if (choice === 'tab') openCommandBar('new');
  if (choice === 'space') createSpace();
  if (choice === 'theme') openThemeEditor(space());
  if (choice === 'archive') openArchive();
  if (choice === 'clear') clearToday();
  if (choice === 'side') runCommand('sidebar-side');
}

async function folderMenu(l, at) {
  const id = l.node.id;
  let count = 0;
  walk(l.node.children, (n) => { if (n.type === 'tab') count++; });
  const choice = await ctxMenu([
    { id: 'rename', label: 'Rename Folder…', icon: 'pencil' },
    { id: 'toggle', label: l.node.collapsed ? 'Expand' : 'Collapse', icon: l.node.collapsed ? 'folderOpen' : 'folder' },
    { id: 'open', label: `Open ${count} Tab${count === 1 ? '' : 's'} in Today`, icon: 'layers', enabled: count > 0 },
    { id: 'sub', label: 'New Folder Inside', icon: 'plus' },
    { type: 'separator' },
    { id: 'move', label: 'Move to Space', icon: 'moveTo', enabled: state.spaces.length > 1, submenu: state.spaces.filter((s) => s.id !== state.activeSpaceId).map((s) => ({ id: 'move:' + s.id, label: s.name, emoji: s.icon || undefined, swatch: s.icon ? undefined : s.color })) },
    { type: 'separator' },
    { id: 'delete', label: 'Delete Folder…', icon: 'trash', danger: true },
  ], at);
  if (!choice) return;
  if (choice === 'rename') renameNode(id);
  if (choice === 'toggle') { l.node.collapsed = !l.node.collapsed; render(); save(); }
  if (choice === 'open') walk(l.node.children, (n) => { if (n.type === 'tab') openTab(n.url, { background: true }); });
  if (choice === 'sub') { const f = { id: uid(), type: 'folder', title: 'New Folder', collapsed: false, children: [] }; l.node.children.unshift(f); l.node.collapsed = false; render(); save(); renameNode(f.id); }
  if (choice === 'delete' && (count === 0 || await confirmBox(`Delete “${l.node.title}” and its ${count} tab${count === 1 ? '' : 's'}?`, 'Delete'))) deleteNode(id);
  if (choice.startsWith('move:')) moveToSpace(id, choice.slice(5));
}

async function tabMenu(l, at) {
  const id = l.node.id;
  const loaded = rt.views.has(id);
  const nav = rt.nav.get(id) || {};
  const wb = isWorkbenchTab(l.node);
  const items = [
    { id: 'copy', label: 'Copy Link', icon: 'link', keys: id === space().activeTabId ? '⇧⌘C' : undefined, enabled: !wb },
    { id: 'dup', label: 'Duplicate', icon: 'duplicate', enabled: !wb },
    { id: 'split', label: 'Open in Split View', icon: 'split', enabled: space().activeTabId !== id },
    { id: 'little', label: 'Open in Little Window', icon: 'littleWindow', enabled: !wb && !EPHEMERAL },
    { type: 'separator' },
  ];
  if (!EPHEMERAL) {
    if (l.zone === 'fav') items.push({ id: 'unfav', label: 'Remove from Favorites', icon: 'star' });
    else items.push({ id: 'fav', label: 'Add to Favorites', icon: 'star' });
    if (l.zone === 'today') items.push({ id: 'pin', label: 'Pin Tab', icon: 'pin', keys: id === space().activeTabId ? '⌘D' : undefined });
    else if (l.zone === 'pinned') items.push({ id: 'unpin', label: 'Unpin Tab', icon: 'unpin', keys: id === space().activeTabId ? '⌘D' : undefined });
    if (l.zone !== 'today') items.push({ id: 'rename', label: 'Rename…', icon: 'pencil' });
    if (l.zone !== 'today' && l.node.currentUrl && l.node.currentUrl !== l.node.url) items.push({ id: 'reset', label: 'Go Back to Pinned URL', icon: 'home' });
    if (l.zone !== 'today' && l.node.currentUrl && l.node.currentUrl !== l.node.url) items.push({ id: 'repin', label: 'Pin Current URL', icon: 'pin' });
    items.push({ id: 'move', label: 'Move to Space', icon: 'moveTo', enabled: state.spaces.length > 1 && l.zone !== 'fav', submenu: state.spaces.filter((s) => s.id !== state.activeSpaceId).map((s) => ({ id: 'move:' + s.id, label: s.name, emoji: s.icon || undefined, swatch: s.icon ? undefined : s.color })) });
    items.push({ type: 'separator' });
  }
  if (nav.audible || nav.muted) items.push({ id: 'mute', label: nav.muted ? 'Unmute Tab' : 'Mute Tab', icon: nav.muted ? 'speaker' : 'mute' });
  items.push(
    { id: 'reload', label: 'Reload', icon: 'reload', enabled: loaded },
    { id: 'unload', label: 'Put to Sleep', icon: 'unload', enabled: loaded },
    { type: 'separator' },
    l.zone === 'today'
      ? { id: 'close', label: 'Close Tab', icon: 'x', keys: id === space().activeTabId ? '⌘W' : undefined }
      : { id: 'close', label: l.zone === 'fav' ? 'Delete Favorite' : 'Delete from Sidebar', icon: 'trash', danger: true },
  );
  const choice = await ctxMenu(items, at);
  if (!choice) return;
  const url = tabUrl(l.node);
  if (choice === 'copy') { api.copy(url); toast('Copied link'); }
  if (choice === 'split') splitWith(id);
  if (choice === 'dup') openTab(url, { after: l.zone === 'today' ? id : null });
  if (choice === 'little') api.openWindow('little', url);
  if (choice === 'pin' || choice === 'unpin') togglePin(id);
  if (choice === 'fav') addFavorite(id);
  if (choice === 'unfav') { moveNode(id, 'today', { index: 0 }); toast('Removed from favorites — moved to Today'); }
  if (choice === 'rename') renameNode(id);
  if (choice === 'reset') resetPinned(id);
  if (choice === 'repin') { l.node.url = l.node.currentUrl; render(); save(); toast('Pinned URL updated'); }
  if (choice === 'mute') { const wv = rt.views.get(id); nav.muted = !nav.muted; wv?.setAudioMuted(nav.muted); render(); }
  if (choice === 'reload') rt.views.get(id)?.reload();
  if (choice === 'unload') { destroyView(id); if (space().activeTabId === id) space().activeTabId = null; render(); }
  if (choice === 'close') { if (l.zone === 'today') closeTab(id); else deleteNode(id); }
  if (choice.startsWith('move:')) moveToSpace(id, choice.slice(5));
}

async function spaceMenu(sp, at) {
  if (!sp) return;
  const choice = await ctxMenu([
    { type: 'header', label: sp.name },
    { id: 'theme', label: 'Edit Theme…', icon: 'palette' },
    { id: 'rename', label: 'Rename…', icon: 'pencil' },
    { label: 'Colour', icon: 'grid', submenu: SPACE_COLORS.map((c, i) => ({ id: 'color:' + c, label: COLOR_NAMES[i], swatch: c, checked: sp.color === c && !sp.color2 })) },
    { label: 'Profile', icon: 'user', submenu: [
      ...state.profiles.map((p) => ({ id: 'profile:' + p.id, label: p.name, checked: sp.profileId === p.id })),
      { type: 'separator' },
      { id: 'profile:new', label: 'New Profile…', icon: 'plus' },
      { id: 'profile:manage', label: 'Manage Profiles…', icon: 'users' },
    ] },
    { type: 'separator' },
    { id: 'left', label: 'Move Left', icon: 'arrowLeft', enabled: state.spaces[0] !== sp },
    { id: 'right', label: 'Move Right', icon: 'arrowRight', enabled: state.spaces.at(-1) !== sp },
    { type: 'separator' },
    { id: 'new', label: 'New Space…', icon: 'plus' },
    { id: 'delete', label: 'Delete Space…', icon: 'trash', danger: true, enabled: state.spaces.length > 1 },
  ], at);
  if (!choice) return;
  if (choice === 'theme') return openThemeEditor(sp);
  if (choice === 'new') return createSpace();
  if (choice === 'profile:manage') return openSettings('profiles');
  if (choice === 'rename') { const v = await askText('Rename space', sp.name); if (v) sp.name = v; }
  if (choice.startsWith('color:')) { sp.color = choice.slice(6); delete sp.color2; }
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
