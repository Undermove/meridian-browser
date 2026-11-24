/* Meridian Workbench — UI (runs in the internal workbench page; only `window.workbench` is available).
 *
 *   file tree (lazy) | editor tabs + Monaco | terminal tabs + xterm.js
 *   launcher: Claude Code · Codex · Gemini · Shell, and "Preview" (opens a URL in split view)
 *
 * Every name/path from disk is rendered with textContent or esc(). Paths sent to main are always
 * relative to the project root; main re-checks them.
 */

const wb = window.workbench;
const $ = (s, root = document) => root.querySelector(s);
const IS_MAC = wb.platform === 'darwin';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const basename = (p) => String(p).split('/').pop() || String(p);
const dirname = (p) => { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

const AGENT_UI = {
  claude: { label: 'Claude Code', mark: 'Cl', color: '#d97757' },
  codex: { label: 'Codex', mark: 'Cx', color: '#3c3c46' },
  gemini: { label: 'Gemini', mark: 'Ge', color: '#4c8df6' },
  copilot: { label: 'Copilot', mark: 'Co', color: '#8957e5' },
  opencode: { label: 'OpenCode', mark: 'OC', color: '#4b5563' },
  cursor: { label: 'Cursor', mark: 'Cu', color: '#1c1c1c' },
  qwen: { label: 'Qwen Code', mark: 'Qw', color: '#615ced' },
  amp: { label: 'Amp', mark: 'Am', color: '#f34e3f' },
  goose: { label: 'Goose', mark: 'Go', color: '#222222' },
  droid: { label: 'Droid', mark: 'Dr', color: '#ff6b00' },
  shell: { label: 'Shell', mark: '$', color: '#7a808c' },
  // Workbench Pro: sandboxed agents (Docker / OrbStack)
  'sandbox-claude': { label: 'Claude Code (sandbox)', mark: 'Cl', color: '#d97757' },
  'sandbox-codex': { label: 'Codex (sandbox)', mark: 'Cx', color: '#3c3c46' },
  'sandbox-shell': { label: 'Shell (sandbox)', mark: '$', color: '#7a808c' },
};

// Claude Code, Codex and Gemini always show (with an install hint); the other agents once they're installed.
const agentKinds = () => ['claude', 'codex', 'gemini', ...Object.keys(S.info?.agents || {}).filter((id) => S.info.agents[id]?.extra && S.info.agents[id].installed && AGENT_UI[id])];

// Workbench Pro: events for workbench-pro.js and plugins ('project', 'file-open', 'file-save', 'info').
const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
const ACCESS_LABEL = { off: 'Off', read: 'Read only', ask: 'Ask before acting', full: 'Full control' };

const S = {
  info: null,
  project: null,          // { root, name, preview }
  showHidden: false,
  tree: new Map(),        // dir rel path -> { entries, open }
  selected: null,
  tabs: [],               // editor tabs: { path, model, savedVersion, mtimeMs, viewState, state: 'ok'|'deleted'|'conflict', special }
  activeTab: null,
  terms: [],              // { id, kind, title, xterm, fit, el, exited, browserTools }
  activeTerm: null,
  monaco: null,
  editor: null,
  initReceived: false,
};

// ---------------------------------------------------------------- small UI helpers

function iconize(root = document) {
  for (const el of root.querySelectorAll('.ic-slot[data-icon]')) {
    if (!el.firstChild) el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 14);
  }
}

function toast(text, timeout = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, timeout);
}

function modal(html, onMount) {
  const overlay = $('#modal-overlay');
  $('#modal').className = '';
  $('#modal').innerHTML = html;
  overlay.hidden = false;
  const close = () => { overlay.hidden = true; $('#modal').innerHTML = ''; overlay.onmousedown = null; };
  overlay.onmousedown = (e) => { if (e.target === overlay) { close(); overlay.dispatchEvent(new Event('dismiss')); } };
  onMount($('#modal'), close);
}

function askText(title, value = '', hint = '') {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3>${hint ? `<p>${esc(hint)}</p>` : ''}<input id="ask" spellcheck="false" value="${esc(value)}">
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn accent" data-a="ok">OK</button></div>`, (m, close) => {
      const input = $('#ask', m);
      input.focus();
      // Select the name part (not the extension), like Finder.
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
      const done = (v) => { close(); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
      m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'ok' ? input.value.trim() : null); });
      $('#modal-overlay').addEventListener('dismiss', () => resolve(null), { once: true });
    });
  });
}

// Where each agent sends your prompts and the project's files. Before the first start (once per
// Workbench, or never again after "Always start"), the person decides.
const AGENT_DESTINATION = {
  claude: 'Anthropic (Claude)', codex: 'OpenAI (Codex)', gemini: 'Google (Gemini)', copilot: 'GitHub (Copilot)',
  cursor: 'Anysphere (Cursor)', qwen: 'Alibaba (Qwen)', amp: 'Sourcegraph (Amp)', droid: 'Factory (Droid)',
  goose: 'the AI service Goose is set up with', opencode: 'the AI service OpenCode is set up with',
};
const agentConsentGiven = new Set();
async function agentConsent(kind) {
  const base = String(kind).replace(/^sandbox-/, '');
  const to = AGENT_DESTINATION[base];
  if (!to || agentConsentGiven.has(base)) return true;
  let state = '';
  try { state = typeof wb.aiConsent === 'function' ? await wb.aiConsent(base) : 'always'; } catch {}
  if (state === 'always') return true;
  const label = AGENT_UI[kind]?.label || base;
  return new Promise((resolve) => {
    modal(`<h3>${esc(label)} sends what you type and the project's files to ${esc(to)}</h3>
      <p>Nothing has been sent yet. Choose once: Meridian remembers it (Settings › AI).</p>
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn" data-a="always">Always start, don't ask</button><button class="btn accent" data-a="ok">Start</button></div>`, (m, close) => {
      setTimeout(() => $('[data-a="cancel"]', m).focus(), 0);
      const done = (a) => {
        close();
        if (a === 'ok' || a === 'always') agentConsentGiven.add(base);
        if (a === 'ok' || a === 'always') wb.setAiConsent?.(base, a === 'always' ? 'always' : 'once').catch(() => {});
        resolve(a === 'ok' || a === 'always');
      };
      m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a); });
      m.addEventListener('keydown', (e) => { if (e.key === 'Escape') done('cancel'); });
      $('#modal-overlay').addEventListener('dismiss', () => resolve(false), { once: true });
    });
  });
}

function confirmBox(title, detail, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3>${detail ? `<p>${esc(detail)}</p>` : ''}
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn ${danger ? 'danger' : 'accent'}" data-a="ok">${esc(okLabel)}</button></div>`, (m, close) => {
      setTimeout(() => $('[data-a="cancel"]', m).focus(), 0);
      m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) { close(); resolve(a === 'ok'); } });
      m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); resolve(false); } });
      $('#modal-overlay').addEventListener('dismiss', () => resolve(false), { once: true });
    });
  });
}

function popover(anchor, html, onMount) {
  const pop = $('#popover');
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = 320;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  pop.style.top = (r.bottom + 8) + 'px';
  const close = () => { pop.hidden = true; document.removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  onMount?.(pop, close);
  return close;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Could not copy'));
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

// ---------------------------------------------------------------- project

async function refreshInfo() {
  try { S.info = await wb.info(); } catch (err) { console.error(err); return; }
  renderLauncher();
  renderBrowserTools();
  emit('info', S.info);
  return S.info;
}

async function pickProject() {
  try {
    const p = await wb.pickProject();
    if (p) await setProject(p);
  } catch (err) { toast(err.message); }
}

async function openRecent(path) {
  try { await setProject(await wb.openProject(path)); } catch (err) { toast(err.message); refreshInfo().then(renderWelcome); }
}

async function setProject(p, { reattach = false } = {}) {
  const switching = S.project && S.project.root !== p.root;
  if (switching) {
    if (S.tabs.some(isDirty) && !(await confirmBox('Discard unsaved changes?', 'Switching projects closes the open files.', 'Discard', true))) return;
    for (const t of [...S.tabs]) closeTab(t, { force: true });
  }
  S.project = p;
  S.savedSessions = null;
  S.tree.clear();
  S.selected = null;
  document.title = p.name;
  $('#project-name').textContent = p.name;
  $('#project-btn').title = p.root;
  $('#preview-url').value = p.preview || 'http://localhost:3000';
  $('#welcome').hidden = true;
  $('#main').hidden = false;
  wb.toHost({ type: 'project', root: p.root, name: p.name });
  // The tab's address names the project, so the tab reopens it after a restart (as a pinned hub does).
  try { const u = new URL(location.href); if (u.searchParams.get('project') !== p.root) { u.searchParams.set('project', p.root); history.replaceState(history.state, '', u.href); } } catch {}
  await loadDir('', true);
  renderTree();
  // (Also when none are open here: terminals that outlived a crash of the browser come back.)
  const alive = reattach || !S.terms.length ? await reattachTerminals() : S.terms.length;
  if (!alive) await restoreClaudeSessions(p.root);
  layoutTerminals();
  emit('project', p);
}

async function projectMenu() {
  const info = await refreshInfo();
  const recents = (info?.recents || []).filter((r) => r.path !== S.project?.root).slice(0, 8);
  const close = popover($('#project-btn'), `
    <h3>${esc(S.project?.name || 'Projects')}</h3>
    ${S.project ? `<p>${esc(S.project.root)}</p>` : ''}
    <div id="pop-recents"></div>
    <div class="row"><button class="btn small" data-a="reveal" ${S.project ? '' : 'disabled'}>${IS_MAC ? 'Show in Finder' : 'Show in folder'}</button><button class="btn small accent" data-a="open">Open folder…</button></div>`, (pop, closeIt) => {
    const list = $('#pop-recents', pop);
    for (const r of recents) list.appendChild(recentRow(r, () => { closeIt(); openRecent(r.path); }, false));
    pop.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'open') { closeIt(); pickProject(); }
      if (a === 'reveal') { closeIt(); wb.reveal(''); }
    });
  });
  return close;
}

function recentRow(r, onOpen, forgettable = true) {
  const b = document.createElement('button');
  b.className = 'recent';
  b.innerHTML = `<span class="ic-slot" data-icon="folder"></span><span class="name"></span><span class="path"></span>${forgettable ? '<span class="icon-btn small forget" title="Remove from list"><span class="ic-slot" data-icon="x" data-size="12"></span></span>' : ''}`;
  $('.name', b).textContent = r.name;
  $('.path', b).textContent = r.path;
  iconize(b);
  b.addEventListener('click', async (e) => {
    if (e.target.closest('.forget')) {
      e.stopPropagation();
      await wb.forgetRecent(r.path);
      await refreshInfo(); renderWelcome();
      return;
    }
    onOpen();
  });
  return b;
}

function renderWelcome() {
  const info = S.info || {};
  $('#welcome').hidden = !!S.project;
  $('#main').hidden = !S.project;
  const recents = $('#recents');
  recents.innerHTML = '';
  if (info.recents?.length) {
    recents.innerHTML = '<h2>Recent</h2>';
    for (const r of info.recents.slice(0, 6)) recents.appendChild(recentRow(r, () => openRecent(r.path)));
  }
  const agents = $('#welcome-agents');
  agents.innerHTML = '<h2>Agents on this computer</h2><div class="agent-list"></div>';
  const list = agents.querySelector('.agent-list');
  for (const id of agentKinds()) {
    const a = info.agents?.[id];
    const row = document.createElement('div');
    row.className = 'agent-row';
    row.innerHTML = `<span class="mark-wrap"></span><span class="label"></span><span class="state"></span>`;
    row.querySelector('.mark-wrap').appendChild(agentMark(id));
    row.querySelector('.label').textContent = AGENT_UI[id].label;
    const st = row.querySelector('.state');
    st.textContent = a?.installed ? 'Installed' : `Not installed — ${a?.install || ''}`;
    st.classList.toggle('ok', !!a?.installed);
    if (!a?.installed) st.title = st.textContent;
    list.appendChild(row);
  }
  const err = $('#terminal-error');
  err.hidden = info.terminals !== false;
  err.textContent = info.terminals === false ? `Terminals are unavailable: ${info.terminalError || 'node-pty failed to load'}` : '';
}

function agentMark(kind, cls = 'mark') {
  const m = document.createElement('span');
  m.className = cls;
  m.style.setProperty('--mark', AGENT_UI[kind].color);
  m.textContent = AGENT_UI[kind].mark;
  return m;
}

// ---------------------------------------------------------------- launcher + browser-tools status

function renderLauncher() {
  const bar = $('#launcher');
  // Not under a pressed mouse button: the click would be lost with the button.
  if (!bar._watched) {
    bar._watched = true;
    bar.addEventListener('mousedown', () => { bar._pressed = true; });
    window.addEventListener('mouseup', () => setTimeout(() => {
      if (!bar._pressed) return;
      bar._pressed = false;
      if (bar._redraw) { bar._redraw = false; renderLauncher(); }
    }, 0));
  }
  if (bar._pressed) { bar._redraw = true; return; }
  bar.innerHTML = '';
  const agents = S.info?.agents || {};
  for (const kind of [...agentKinds(), 'shell']) {
    const a = agents[kind];
    const installed = kind === 'shell' || !!a?.installed;
    const b = document.createElement('button');
    b.className = 'launch' + (installed ? '' : ' missing');
    b.appendChild(agentMark(kind));
    const label = document.createElement('span');
    label.textContent = AGENT_UI[kind].label;
    b.appendChild(label);
    if (installed && a?.mcp) {
      const plug = document.createElement('span');
      plug.className = 'plug ic-slot';
      plug.dataset.icon = 'globe';
      plug.dataset.size = '12';
      b.appendChild(plug);
    }
    b.title = !installed ? `${AGENT_UI[kind].label} is not installed`
      : kind === 'shell' ? 'Open a shell in the project'
      : `Start ${AGENT_UI[kind].label} in the project${a?.mcp ? ' — with Meridian browser tools' : ''}`;
    // `anchor`: where a hint shows (the More button when this one is in its menu).
    b._run = (anchor) => (installed ? launch(kind) : installHint(anchor, kind));
    b.addEventListener('click', () => b._run(b));
    bar.appendChild(b);
    if (kind === 'claude' && installed) bar.appendChild(resumeButton('launch resume'));
  }
  if (typeof proLauncherExtras === 'function') proLauncherExtras(bar); // Workbench Pro: sandbox + plugin launchers
  iconize(bar);
  fitLauncher();
}

// The launchers that don't fit the top bar go into a "More" menu at its end (the last ones first),
// so every agent stays one click away on a small screen.
function fitLauncher() {
  const bar = $('#launcher');
  if (!bar) return;
  bar.querySelector('#launcher-more')?.remove();
  bar.classList.remove('compact');
  const items = [...bar.children];
  for (const el of items) el.hidden = false;
  if (bar.scrollWidth <= bar.clientWidth + 1) return;
  const more = document.createElement('button');
  more.id = 'launcher-more';
  more.className = 'launch more';
  more.title = 'More agents';
  more.setAttribute('aria-haspopup', 'menu');
  bar.appendChild(more);
  const hidden = [];
  // Claude Code stays; everything after it can go.
  for (let i = items.length - 1; i > 0 && bar.scrollWidth > bar.clientWidth + 1; i--) {
    items[i].hidden = true;
    hidden.unshift(items[i]);
    more.innerHTML = `<span class="ic-slot" data-icon="more" data-size="14"></span><span class="more-n">${hidden.length}</span>`;
    more.title = `More agents: ${hidden.map((e) => e.textContent.trim()).join(', ')}`;
    iconize(more);
  }
  if (!hidden.length) { more.remove(); return; }
  // Still too narrow: Claude Code's button shows only its mark.
  if (bar.scrollWidth > bar.clientWidth + 1) bar.classList.add('compact');
  more.addEventListener('click', () => {
    popover(more, '<div class="launch-menu" role="menu"></div>', (pop, close) => {
      const list = $('.launch-menu', pop);
      for (const el of hidden) {
        const row = el.cloneNode(true);
        row.hidden = false;
        row.removeAttribute('id');
        row.classList.add('menu-row');
        row.setAttribute('role', 'menuitem');
        row.addEventListener('click', () => { close(); el._run ? el._run(more) : el.click(); });
        list.appendChild(row);
      }
    });
  });
}

function installHint(anchor, kind) {
  const a = S.info?.agents?.[kind] || {};
  popover(anchor, `<h3>${esc(AGENT_UI[kind].label)} isn’t installed</h3>
    <p>${a.needs ? `This command needs ${esc(a.needs)}, which isn’t on this computer: install that first. ` : ''}Install it in a terminal, then click the button again.</p>
    <div class="cmd">${esc(a.install || '')}</div>
    <div class="row"><button class="btn small" data-a="copy">Copy command</button><button class="btn small accent" data-a="shell" ${S.project ? '' : 'disabled'}>Open a shell</button></div>`, (pop, close) => {
    pop.addEventListener('click', (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (act === 'copy') copyText(a.install || '');
      if (act === 'shell') { close(); launch('shell').then((t) => t && wb.ptyWrite(t.id, a.install || '')); }
    });
  });
  // Re-check: the user may have just installed it.
  refreshInfo();
}

function renderBrowserTools() {
  const el = $('#browser-tools');
  const access = S.info?.agentAccess || 'off';
  el.className = `status-chip ${access}`;
  $('.label', el).textContent = access === 'off' ? 'Browser tools off for agents' : `Browser tools: ${ACCESS_LABEL[access] || access}`;
  el.title = 'Claude Code and Codex started from this workbench get Meridian’s browser tools (MCP) for that session only.\n' +
    'They follow the agent access level in Meridian → Settings → AI' + (access === 'off' ? ' — currently off, so they can’t see the browser.' : '.');
}

// ---------------------------------------------------------------- file tree

async function loadDir(rel, open = S.tree.get(rel)?.open ?? false) {
  try {
    const res = await wb.list(rel, { showHidden: S.showHidden });
    S.tree.set(rel, { entries: res.entries, truncated: res.truncated, open });
  } catch (err) {
    S.tree.set(rel, { entries: [], error: err.message, open });
  }
}

function renderTree() {
  const host = $('#tree');
  const frag = document.createDocumentFragment();
  const walk = (rel, depth) => {
    const dir = S.tree.get(rel);
    if (!dir) return;
    if (dir.error) frag.appendChild(note(dir.error, depth));
    for (const e of dir.entries) {
      const row = document.createElement('div');
      const isDir = e.type === 'dir' && !e.outside;
      const sub = S.tree.get(e.path);
      const open = isDir && sub?.open;
      row.className = `node ${isDir ? 'dir' : 'file'}${open ? ' open' : ''}${e.hidden ? ' hidden-entry' : ''}${e.outside ? ' outside' : ''}${S.selected === e.path ? ' selected' : ''}`;
      row.style.setProperty('--depth', depth);
      row.dataset.path = e.path;
      row.dataset.type = isDir ? 'dir' : e.outside ? 'outside' : e.type;
      row.setAttribute('role', 'treeitem');
      row.innerHTML = `<span class="twisty">${isDir ? icon('forward', 12) : ''}</span><span class="kind">${icon(isDir ? 'folder' : 'file', 14)}</span><span class="label"></span>`;
      $('.label', row).textContent = e.name;
      if (e.outside) row.title = 'Symlink to a location outside the project — not opened';
      else if (e.link) row.title = 'Symlink';
      const tab = S.tabs.find((t) => t.path === e.path);
      if (tab && isDirty(tab)) row.insertAdjacentHTML('beforeend', '<span class="dirty-dot"></span>');
      frag.appendChild(row);
      if (open) {
        walk(e.path, depth + 1);
        if (!S.tree.get(e.path).entries.length && !S.tree.get(e.path).error) frag.appendChild(note('Empty folder', depth + 1));
      }
    }
    if (dir.truncated) frag.appendChild(note('Too many entries — only the first 5000 are shown', depth));
  };
  walk('', 0);
  host.replaceChildren(frag);
}

function note(text, depth) {
  const n = document.createElement('div');
  n.className = 'tree-note';
  n.style.setProperty('--depth', depth);
  n.textContent = text;
  return n;
}

async function toggleDir(rel) {
  const d = S.tree.get(rel);
  if (d?.open) { d.open = false; renderTree(); return; }
  await loadDir(rel, true);
  renderTree();
}

function selectNode(rel) {
  S.selected = rel;
  for (const n of document.querySelectorAll('.node.selected')) n.classList.remove('selected');
  const row = [...document.querySelectorAll('.node')].find((n) => n.dataset.path === rel);
  row?.classList.add('selected');
  row?.scrollIntoView({ block: 'nearest' });
}

function initTree() {
  const tree = $('#tree');
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.node');
    if (!row) return;
    selectNode(row.dataset.path);
    if (row.dataset.type === 'dir') toggleDir(row.dataset.path);
    else if (row.dataset.type === 'file') openFile(row.dataset.path, { preview: true });
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.node');
    if (row?.dataset.type === 'file') openFile(row.dataset.path, { focus: true });
  });
  tree.addEventListener('keydown', (e) => {
    const rows = [...tree.querySelectorAll('.node')];
    const i = rows.findIndex((r) => r.dataset.path === S.selected);
    const cur = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) selectNode(next.dataset.path);
    } else if (e.key === 'ArrowRight' && cur?.dataset.type === 'dir' && !S.tree.get(cur.dataset.path)?.open) toggleDir(cur.dataset.path);
    else if (e.key === 'ArrowLeft' && cur) {
      if (cur.dataset.type === 'dir' && S.tree.get(cur.dataset.path)?.open) toggleDir(cur.dataset.path);
      else if (dirname(cur.dataset.path)) selectNode(dirname(cur.dataset.path));
    } else if (e.key === 'Enter' && cur) {
      if (cur.dataset.type === 'dir') toggleDir(cur.dataset.path); else if (cur.dataset.type === 'file') openFile(cur.dataset.path, { focus: true });
    } else if ((e.key === 'Backspace' && (IS_MAC ? e.metaKey : true)) || e.key === 'Delete') {
      if (cur) deleteEntry(cur.dataset.path, cur.dataset.type === 'dir');
    }
  });
  tree.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const row = e.target.closest('.node');
    const rel = row?.dataset.path || '';
    const isDir = !row || row.dataset.type === 'dir';
    if (row) selectNode(rel);
    const base = isDir ? rel : dirname(rel);
    const items = [
      { id: 'new-file', label: 'New File…' },
      { id: 'new-dir', label: 'New Folder…' },
      { type: 'separator' },
      ...(row ? [{ id: 'rename', label: 'Rename…' }, { id: 'delete', label: 'Move to Trash' }, { type: 'separator' }] : []),
      { id: 'copy-path', label: 'Copy Path' },
      { id: 'copy-rel', label: 'Copy Relative Path', enabled: !!row },
      { id: 'reveal', label: IS_MAC ? 'Reveal in Finder' : 'Show in Folder' },
    ];
    const choice = await wb.menu(items);
    if (choice === 'new-file') createEntry(base, 'file');
    if (choice === 'new-dir') createEntry(base, 'dir');
    if (choice === 'rename') renameEntry(rel);
    if (choice === 'delete') deleteEntry(rel, isDir);
    if (choice === 'copy-path') copyText(S.project.root + (rel ? '/' + rel : ''));
    if (choice === 'copy-rel') copyText(rel);
    if (choice === 'reveal') wb.reveal(rel);
  });
  $('#tree-new-file').addEventListener('click', () => {
    const sel = S.selected && [...document.querySelectorAll('.node')].find((n) => n.dataset.path === S.selected);
    createEntry(sel ? (sel.dataset.type === 'dir' ? S.selected : dirname(S.selected)) : '', 'file');
  });
  $('#tree-hidden').addEventListener('click', async () => {
    S.showHidden = !S.showHidden;
    $('#tree-hidden').classList.toggle('on', S.showHidden);
    $('#tree-hidden').title = S.showHidden ? 'Hide .git and node_modules' : 'Show hidden folders (.git, node_modules)';
    await refreshTree();
  });
  $('#tree-refresh').addEventListener('click', () => refreshTree());
}

async function refreshTree(dirs = null) {
  const targets = dirs || [...S.tree.keys()];
  await Promise.all(targets.filter((d) => S.tree.has(d) && (d === '' || S.tree.get(d).open)).map((d) => loadDir(d)));
  renderTree();
}

function validName(name) {
  return name && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..' && !name.includes('\0');
}

async function createEntry(dir, kind) {
  const name = await askText(kind === 'dir' ? 'New folder' : 'New file', '', dir ? `In ${dir}/` : 'In the project root');
  if (!name) return;
  // Allow "src/utils/new.js" style paths for files: create intermediate folders one by one.
  const parts = name.split('/').filter(Boolean);
  if (!parts.length || !parts.every(validName)) return toast('Invalid name');
  try {
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = joinPath(cur, parts[i]);
      const st = await wb.stat(cur);
      if (!st.exists) await wb.create(cur, 'dir');
      await loadDir(dirname(cur), true);
      S.tree.set(cur, { ...(S.tree.get(cur) || { entries: [] }), open: true });
    }
    const rel = joinPath(cur, parts[parts.length - 1]);
    await wb.create(rel, kind);
    if (dir) S.tree.set(dir, { ...(S.tree.get(dir) || { entries: [] }), open: true });
    await refreshTree([...new Set(['', dir, dirname(rel)])]);
    selectNode(rel);
    if (kind === 'file') openFile(rel, { focus: true });
  } catch (err) { toast(err.message); }
}

async function renameEntry(rel) {
  const name = await askText('Rename', basename(rel));
  if (!name || name === basename(rel)) return;
  if (!validName(name)) return toast('Invalid name');
  const to = joinPath(dirname(rel), name);
  try {
    await wb.rename(rel, to);
    for (const t of S.tabs) {
      if (t.path === rel || t.path.startsWith(rel + '/')) retargetTab(t, to + t.path.slice(rel.length));
    }
    await refreshTree([dirname(rel)]);
    selectNode(to);
  } catch (err) { toast(err.message); }
}

async function deleteEntry(rel, isDir) {
  if (!(await confirmBox(`Move “${basename(rel)}” to the Trash?`, isDir ? 'The folder and everything in it can be restored from the Trash.' : 'You can restore it from the Trash.', 'Move to Trash', true))) return;
  try {
    await wb.remove(rel);
    for (const t of [...S.tabs]) if (t.path === rel || t.path.startsWith(rel + '/')) closeTab(t, { force: true });
    await refreshTree([dirname(rel)]);
  } catch (err) { toast(err.message); }
}

// ---------------------------------------------------------------- Monaco

let monacoReady = null;
function loadMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve, reject) => {
    // eslint-disable-next-line no-undef
    require.config({ paths: { vs: '/vendor/monaco/vs' } });
    // eslint-disable-next-line no-undef
    require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
  }).then((monaco) => {
    S.monaco = monaco;
    defineThemes();
    S.editor = monaco.editor.create($('#editor-host'), {
      model: null,
      automaticLayout: true,
      theme: editorThemeName(),
      fontFamily: cssVar('--mono'),
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      padding: { top: 10 },
      renderLineHighlight: 'all',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active' },
      tabSize: 2,
      fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    });
    S.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
    S.editor.onDidChangeCursorPosition((e) => { $('#status-pos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`; });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { defineThemes(); monaco.editor.setTheme(editorThemeName()); });
    emit('editor-ready', S.editor);
    return monaco;
  });
  monacoReady.catch((err) => { console.error('Monaco failed to load', err); toast('The editor failed to load'); });
  return monacoReady;
}

// Workbench Pro: settings.json may pin a theme ('light' | 'dark' | 'hc-black' | 'hc-light'); default follows the system.
function editorThemeName() {
  const t = typeof proEditorTheme === 'function' ? proEditorTheme() : 'auto';
  if (t === 'light') return 'meridian-light';
  if (t === 'dark') return 'meridian-dark';
  if (t === 'hc-black' || t === 'hc-light') return t;
  return dark() ? 'meridian-dark' : 'meridian-light';
}

function defineThemes() {
  const m = S.monaco;
  if (!m) return;
  const space = (cssVar('--space') || '#8a8fe0').replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');
  const hex = /^#[0-9a-f]{6}$/i.test(space) ? space : '#8a8fe0';
  m.editor.defineTheme('meridian-light', { base: 'vs', inherit: true, rules: [], colors: {
    'editor.background': '#ffffff', 'editorCursor.foreground': hex, 'editor.selectionBackground': hex + '40',
    'editor.lineHighlightBackground': '#00000006', 'editor.lineHighlightBorder': '#00000000', 'editorLineNumber.activeForeground': hex,
    'focusBorder': hex + '80', 'editorGutter.background': '#ffffff',
  } });
  m.editor.defineTheme('meridian-dark', { base: 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': '#1f1f24', 'editorCursor.foreground': hex, 'editor.selectionBackground': hex + '55',
    'editor.lineHighlightBackground': '#ffffff08', 'editor.lineHighlightBorder': '#00000000', 'editorLineNumber.activeForeground': hex,
    'focusBorder': hex + '80', 'editorGutter.background': '#1f1f24',
  } });
}

function applySpace(color) {
  if (!/^#[0-9a-f]{3,8}$/i.test(color || '')) return;
  document.documentElement.style.setProperty('--space', color);
  if (S.monaco) { defineThemes(); S.monaco.editor.setTheme(editorThemeName()); }
  for (const t of S.terms) t.xterm.options.theme = termTheme();
}

// ---------------------------------------------------------------- editor tabs

const isDirty = (t) => !!t.model && t.model.getAlternativeVersionId() !== t.savedVersion;

async function openFile(rel, { preview = false, focus = false } = {}) {
  let tab = S.tabs.find((t) => t.path === rel);
  if (tab) { activateTab(tab, focus); return tab; }
  let file;
  try { file = await wb.read(rel); } catch (err) { toast(err.message); return null; }
  tab = { path: rel, model: null, savedVersion: 0, mtimeMs: file.mtimeMs, viewState: null, state: 'ok', special: null };
  if (file.tooLarge) tab.special = `This file is too large to open here (${(file.size / 1048576).toFixed(1)} MB).`;
  else if (file.binary) tab.special = 'This looks like a binary file.';
  else {
    const monaco = await loadMonaco();
    const uri = monaco.Uri.from({ scheme: 'file', path: '/' + rel });
    monaco.editor.getModel(uri)?.dispose();
    tab.model = monaco.editor.createModel(file.content, undefined, uri);
    tab.savedVersion = tab.model.getAlternativeVersionId();
    tab.model.onDidChangeContent(() => { renderTabs(); markTreeDirty(); });
  }
  emit('file-open', rel);
  // Single-click "preview" replaces a clean, untouched preview tab, like VS Code.
  const prev = S.tabs.find((t) => t.preview && !isDirty(t));
  tab.preview = preview;
  if (preview && prev) { const i = S.tabs.indexOf(prev); disposeTab(prev); S.tabs.splice(i, 1, tab); }
  else S.tabs.push(tab);
  activateTab(tab, focus);
  return tab;
}

function activateTab(tab, focus = false) {
  if (S.activeTab && S.activeTab !== tab && S.editor && S.activeTab.model) S.activeTab.viewState = S.editor.saveViewState();
  S.activeTab = tab;
  if (tab && focus) tab.preview = false;
  const placeholder = $('#editor-placeholder');
  if (tab?.model && S.editor) {
    S.editor.setModel(tab.model);
    if (tab.viewState) S.editor.restoreViewState(tab.viewState);
    if (focus) S.editor.focus();
    placeholder.hidden = true;
  } else {
    S.editor?.setModel(null);
    placeholder.hidden = !tab?.special;
    placeholder.textContent = tab?.special || '';
  }
  $('#editor-empty').hidden = !!tab;
  $('#status-file').textContent = tab ? tab.path : '';
  if (!tab) $('#status-pos').textContent = '';
  if (tab) selectNode(tab.path);
  renderTabs();
  renderBanner();
}

function renderTabs() {
  const bar = $('#editor-tabs');
  bar.replaceChildren(...S.tabs.map((t) => {
    const el = document.createElement('div');
    el.className = `etab${t === S.activeTab ? ' active' : ''}${isDirty(t) ? ' dirty' : ''}${t.state === 'deleted' ? ' deleted' : ''}`;
    el.setAttribute('role', 'tab');
    el.title = t.path + (t.state === 'deleted' ? ' (deleted on disk)' : '');
    el.innerHTML = `<span class="name"></span>${dupName(t) ? '<span class="hint"></span>' : ''}<button class="tab-close" title="Close">${icon('x', 12)}</button>`;
    const name = $('.name', el);
    name.textContent = basename(t.path);
    if (t.preview) name.style.fontStyle = 'italic';
    if (dupName(t)) $('.hint', el).textContent = dirname(t.path);
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    el.addEventListener('click', (e) => { if (e.target.closest('.tab-close')) closeTab(t); else activateTab(t, true); });
    el.addEventListener('dblclick', () => { t.preview = false; renderTabs(); });
    return el;
  }));
  bar.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const dupName = (t) => S.tabs.some((o) => o !== t && basename(o.path) === basename(t.path));

let treeDirtyTimer = null;
function markTreeDirty() { clearTimeout(treeDirtyTimer); treeDirtyTimer = setTimeout(renderTree, 200); }

async function closeTab(tab, { force = false } = {}) {
  if (!force && isDirty(tab)) {
    if (!(await confirmBox(`Close “${basename(tab.path)}” without saving?`, 'Your changes will be lost.', 'Don’t save', true))) return;
  }
  const i = S.tabs.indexOf(tab);
  if (i < 0) return;
  S.tabs.splice(i, 1);
  disposeTab(tab);
  if (S.activeTab === tab) activateTab(S.tabs[Math.min(i, S.tabs.length - 1)] || null);
  else renderTabs();
  renderTree();
}

function disposeTab(tab) { tab.model?.dispose(); tab.model = null; }

function retargetTab(tab, to) {
  if (!tab.model || !S.monaco) { tab.path = to; return; }
  const value = tab.model.getValue();
  const dirty = isDirty(tab);
  const wasActive = S.activeTab === tab;
  tab.model.dispose();
  tab.path = to;
  tab.model = S.monaco.editor.createModel(value, undefined, S.monaco.Uri.from({ scheme: 'file', path: '/' + to }));
  tab.savedVersion = dirty ? -1 : tab.model.getAlternativeVersionId();
  tab.model.onDidChangeContent(() => { renderTabs(); markTreeDirty(); });
  if (wasActive) activateTab(tab); else renderTabs();
}

async function saveActive() {
  const tab = S.activeTab;
  if (!tab?.model) return;
  // Someone (an agent?) changed the file since we loaded it: don't silently overwrite.
  const st = await wb.stat(tab.path).catch(() => ({ exists: false }));
  if (st.exists && st.mtimeMs !== tab.mtimeMs && tab.state !== 'ok-overwrite') {
    if (!(await confirmBox(`“${basename(tab.path)}” changed on disk`, 'It was modified outside the editor after you opened it. Overwrite it with your version?', 'Overwrite', true))) return;
  }
  try {
    const version = tab.model.getAlternativeVersionId();
    const res = await wb.write(tab.path, tab.model.getValue());
    tab.mtimeMs = res.mtimeMs;
    tab.savedVersion = version;
    tab.state = 'ok';
    tab.preview = false;
    renderTabs(); renderBanner(); renderTree();
    emit('file-save', tab.path);
  } catch (err) { toast(`Couldn’t save: ${err.message}`, 4000); }
}

// ---------------------------------------------------------------- external changes

function renderBanner() {
  const banner = $('#editor-banner');
  const t = S.activeTab;
  if (!t || (t.state !== 'conflict' && t.state !== 'deleted')) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = t.state === 'deleted'
    ? `<span class="msg">This file was deleted on disk. Save to recreate it.</span><button class="btn small" data-a="close">Close</button>`
    : `<span class="msg">This file changed on disk while you have unsaved edits.</span><button class="btn small" data-a="reload">Load disk version</button><button class="btn small" data-a="keep">Keep mine</button>`;
  banner.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') closeTab(t, { force: true });
    if (a === 'reload') { await reloadFromDisk(t, { force: true }); }
    if (a === 'keep') { t.state = 'ok-overwrite'; renderBanner(); }
  };
}

async function reloadFromDisk(tab, { force = false } = {}) {
  let file;
  try { file = await wb.read(tab.path); } catch { tab.state = 'deleted'; renderTabs(); renderBanner(); return; }
  if (!tab.model || file.content === undefined) { tab.mtimeMs = file.mtimeMs; return; }
  if (isDirty(tab) && !force) { tab.state = 'conflict'; tab.pendingMtime = file.mtimeMs; renderTabs(); renderBanner(); return; }
  if (tab.model.getValue() !== file.content) {
    // Replace as one undoable edit, keeping the cursor where it was.
    const sel = S.activeTab === tab ? S.editor.getSelections() : null;
    tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: file.content }], () => sel);
    tab.model.pushStackElement();
    if (sel) S.editor.setSelections(sel);
  }
  tab.savedVersion = tab.model.getAlternativeVersionId();
  tab.mtimeMs = file.mtimeMs;
  tab.state = 'ok';
  renderTabs(); renderBanner(); renderTree();
}

async function onFsChange({ paths }) {
  if (!S.project) return;
  const all = paths.includes('');
  // Folder listings: refresh every loaded folder that contains a changed path.
  const dirs = new Set();
  for (const p of paths) { dirs.add(dirname(p)); if (S.tree.has(p)) dirs.add(p); }
  await refreshTree(all ? null : [...dirs].filter((d) => S.tree.has(d)));
  // Open files: compare modification times.
  for (const tab of [...S.tabs]) {
    if (!all && !paths.some((p) => p === tab.path || tab.path.startsWith(p + '/'))) continue;
    const st = await wb.stat(tab.path).catch(() => ({ exists: false }));
    if (!st.exists) { if (tab.state !== 'deleted') { tab.state = 'deleted'; renderTabs(); renderBanner(); } continue; }
    if (tab.state === 'deleted') tab.state = 'ok';
    if (st.mtimeMs !== tab.mtimeMs && st.mtimeMs !== tab.pendingMtime) await reloadFromDisk(tab);
  }
}

// ---------------------------------------------------------------- terminals

function termTheme() {
  const d = dark();
  return {
    background: d ? '#1f1f24' : '#ffffff',
    foreground: d ? '#ececf1' : '#1d1d22',
    cursor: cssVar('--space') || '#8a8fe0',
    cursorAccent: d ? '#1f1f24' : '#ffffff',
    selectionBackground: (cssVar('--space') || '#8a8fe0') + '55',
    black: d ? '#3a3a44' : '#1d1d22', brightBlack: d ? '#6b6b78' : '#6b6b78',
    red: '#e5484d', green: '#30a46c', yellow: d ? '#f5d90a' : '#ad8a00', blue: '#3e63dd', magenta: '#8e4ec6', cyan: '#0f9cb8',
    white: d ? '#d0d0d8' : '#c8c8d0', brightWhite: '#ffffff',
  };
}

function newXterm() {
  // eslint-disable-next-line no-undef
  const ts = typeof proTerminalOptions === 'function' ? proTerminalOptions() : {}; // Workbench Pro: settings.json
  const xterm = new Terminal({
    fontFamily: ts.fontFamily || cssVar('--mono'),
    fontSize: ts.fontSize || 12.5,
    lineHeight: ts.lineHeight || 1.15,
    cursorBlink: true,
    allowTransparency: false,
    scrollback: 10000,
    macOptionIsMeta: false,
    theme: termTheme(),
  });
  // eslint-disable-next-line no-undef
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  return { xterm, fit };
}

// Scrolling as in a Mac app: the lines follow the fingers at a steady rate. xterm hands a program
// that takes the mouse (a full-screen agent) slow trackpad moves at a third of their size and quick
// ones whole, so the scroll crawled, then jumped. `terminal.scrollSpeed` in settings.json sets the
// rate; ⌥ scrolls five times faster.
const synthetic = new WeakSet();
function scrollSpeed() {
  // eslint-disable-next-line no-undef
  const v = typeof proTerminalOptions === 'function' ? proTerminalOptions().scrollSpeed : undefined;
  return v > 0 ? v : 1;
}
function termWheel(t, e) {
  if (synthetic.has(e) || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || !e.deltaY) return true;
  const ownMouse = t.xterm.modes.mouseTrackingMode !== 'none' || t.xterm.buffer.active.type === 'alternate';
  if (!ownMouse) {
    t.xterm.options.scrollSensitivity = scrollSpeed();
    return true;
  }
  const lineHeight = t.el.querySelector('.xterm-screen')?.getBoundingClientRect().height / t.xterm.rows || 16;
  t.wheelRest = (t.wheelRest || 0) + (e.deltaY / lineHeight) * scrollSpeed() * (e.altKey ? 5 : 1);
  const lines = Math.trunc(t.wheelRest);
  t.wheelRest -= lines;
  // The same wheel a line at a time: xterm tells the program one line for each wheel event.
  for (let i = 0; i < Math.min(Math.abs(lines), 300); i++) {
    const ev = new WheelEvent('wheel', { deltaY: Math.sign(lines), deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true });
    synthetic.add(ev);
    e.target.dispatchEvent(ev);
  }
  e.preventDefault();
  return false;
}

// Links in what programs print: web addresses open in a tab next to this one; a project file
// (src/app.ts, src/app.ts:42, ./README.md:3:7) opens in the editor at its line.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
const FILE_RE = /(?:^|[\s('"`[])((?:\.{1,2}\/|\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::(\d+))?/g;
function termLinks(t) {
  return {
    provideLinks(y, done) {
      const buf = t.xterm.buffer.active;
      // The whole logical line: a long address wraps over several rows.
      let first = y - 1;
      while (first > 0 && buf.getLine(first)?.isWrapped) first--;
      let last = y - 1;
      while (buf.getLine(last + 1)?.isWrapped) last++;
      const cols = t.xterm.cols;
      let text = '';
      for (let i = first; i <= last; i++) text += (buf.getLine(i)?.translateToString(i === last) || '').padEnd(i === last ? 0 : cols);
      const at = (offset) => ({ x: (offset % cols) + 1, y: first + Math.floor(offset / cols) + 1 });
      const range = (start, length) => ({ start: at(start), end: at(start + length - 1) });
      const onRow = (r) => r.start.y <= y && r.end.y >= y;
      const links = [];
      for (const m of text.matchAll(URL_RE)) {
        // Not the sentence's full stop or closing bracket (a bracket the address opened stays).
        let url = m[0].replace(/[.,;:!?'"]+$/, '');
        while (/[)\]}>]$/.test(url) && (url.match(/[([{<]/g) || []).length < (url.match(/[)\]}>]/g) || []).length) url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
        const r = range(m.index, url.length);
        if (onRow(r)) links.push({ range: r, text: url, open: () => wb.toHost({ type: 'link', url }), activate: () => {} });
      }
      const files = [];
      for (const m of text.matchAll(FILE_RE)) {
        if (/^https?:/.test(text.slice(Math.max(0, m.index - 8), m.index + 1)) || m[1].includes('//')) continue;
        const start = m.index + m[0].indexOf(m[1]);
        const length = m[0].length - (start - m.index);
        const r = range(start, length);
        if (onRow(r) && !links.some((l) => l.range.start.y === r.start.y && l.range.start.x <= r.start.x && l.range.end.x >= r.end.x)) files.push({ r, path: m[1], line: +m[2] || 0, col: +m[3] || 0 });
      }
      if (!files.length || !S.project) return done(links.length ? links : undefined);
      // Only paths that are files of the project.
      const root = S.project.root.replace(/\/$/, '') + '/';
      Promise.all(files.map(async (f) => {
        let rel = f.path.startsWith(root) ? f.path.slice(root.length) : f.path.replace(/^\.\//, '');
        if (rel.startsWith('/') || rel.startsWith('../')) return null;
        const st = await wb.stat(rel).catch(() => null);
        return st?.exists && !st.dir ? { range: f.r, text: f.path, open: () => openFileAt(rel, f.line, f.col), activate: () => {} } : null;
      })).then((found) => {
        const all = links.concat(found.filter(Boolean));
        done(all.length ? all : undefined);
      });
    },
  };
}
// A click opens the link under it. Not xterm's own activation: a click that focuses the terminal
// (back from another tab) redraws it, and xterm forgets the link it was over.
function termLinkClicks(t, provider) {
  let down = null;
  t.el.addEventListener('mousedown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
  t.el.addEventListener('mouseup', (e) => {
    if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || t.xterm.hasSelection()) return;
    // A program that takes the mouse gets plain clicks; ⌘-click still opens.
    if (t.xterm.modes.mouseTrackingMode !== 'none' && !e.metaKey) return;
    const screen = t.el.querySelector('.xterm-screen')?.getBoundingClientRect();
    const cell = t.xterm._core._renderService?.dimensions?.css?.cell;
    if (!screen || !cell?.width) return;
    const x = Math.floor((e.clientX - screen.left) / cell.width) + 1;
    const row = Math.floor((e.clientY - screen.top) / cell.height);
    if (x < 1 || row < 0 || row >= t.xterm.rows) return;
    const y = t.xterm.buffer.active.viewportY + row + 1;
    provider.provideLinks(y, (links) => {
      const hit = (links || []).find((l) => {
        const { start: a, end: b } = l.range;
        return (y > a.y || (y === a.y && x >= a.x)) && (y < b.y || (y === b.y && x <= b.x));
      });
      hit?.open();
    });
  }, true);
}
async function openFileAt(rel, line, col) {
  const tab = await openFile(rel, { focus: true });
  if (tab?.model && S.editor && line) {
    const pos = { lineNumber: line, column: col || 1 };
    S.editor.setPosition(pos);
    S.editor.revealPositionInCenter(pos);
  }
}

// Files dropped on a terminal, or an image pasted with ⌘V: their paths are typed into it, as
// Warp and iTerm do; Claude Code attaches an image from its path. A file with no path (an image
// from a page, a screenshot copied to the clipboard) is saved first.
// A path as the shell takes it: a backslash before each special on the Mac and Linux; on Windows
// (PowerShell, cmd) in double quotes when it has a space or a special, its backslashes kept.
const shellQuote = (p) => (wb.platform !== 'win32' ? p.replace(/([^\w@%+=:,./-])/g, '\\$1') : /[^\w@%+=:,./\\-]/.test(p) ? `"${p}"` : p);
async function pathsOf(t, files, dropped) {
  let paths = dropped ? await wb.droppedPaths(files.map((f) => ({ name: f.name, size: f.size }))).catch(() => []) : [];
  if (paths.length !== files.length) {
    paths = [];
    for (const f of files) {
      if (!f.size || f.size > 50 * 1024 * 1024) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      const saved = await wb.saveDrop(name, btoa(bin)).catch(() => null);
      if (saved) paths.push(saved);
    }
  }
  if (paths.length && !t.exited) t.xterm.paste(paths.map(shellQuote).join(' ') + ' ');
  t.xterm.focus();
}
function termDrops(t) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  t.el.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    t.el.classList.add('drop-target');
  });
  t.el.addEventListener('dragleave', () => t.el.classList.remove('drop-target'));
  t.el.addEventListener('drop', (e) => {
    t.el.classList.remove('drop-target');
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    pathsOf(t, [...e.dataTransfer.files], true);
  });
  // ⌘V with only an image on the clipboard (a screenshot): its saved path. Text pastes as before.
  t.el.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd || cd.getData('text/plain')) return;
    const images = [...cd.files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pathsOf(t, images, false);
  }, true);
}

function mountTerm(info) {
  const el = document.createElement('div');
  el.className = 'term hidden';
  $('#term-host').appendChild(el);
  const { xterm, fit } = newXterm();
  xterm.open(el);
  const t = { id: info.id, kind: info.kind, title: info.title, xterm, fit, el, exited: info.exited, browserTools: info.browserTools,
    secrets: info.secrets || [], guard: !!info.guard, sandbox: !!info.sandbox, then: info.then || null, root: S.project?.root || '' };
  if (typeof proGuardPaste === 'function') proGuardPaste(t); // Workbench Pro: secret paste guard
  t.custom = savedTermNames()[t.id] || '';
  // The title the program sets (OSC 0/2): Claude Code names it after the session, with a spinner or
  // ✳ in front; a shell, after the folder or the command running.
  xterm.onTitleChange((title) => {
    let clean = String(title).replace(/^[^\p{L}\p{N}~/.]+/u, '').trim().slice(0, 80);
    // On Windows a program that sets no title has its own path as one (ConPTY): that's no name.
    if (/^([a-z]:\\|\\\\)[^\n]*\.exe$/i.test(clean)) clean = '';
    if (clean === t.auto) return;
    t.auto = clean;
    renderTermTabs();
  });
  xterm.onData((data) => { if (!t.exited) wb.ptyWrite(t.id, data); else if (data === '\r') restartTerm(t); });
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && (IS_MAC ? e.metaKey : e.ctrlKey && e.shiftKey) && e.key.toLowerCase() === 'k') { xterm.clear(); return false; }
    // ⇧↩ is a new line in the prompt, not Enter (Claude Code, Codex): ESC ↩, as Warp and iTerm send.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.type === 'keydown' && !t.exited) wb.ptyWrite(t.id, '\x1b\r');
      return false;
    }
    return true;
  });
  xterm.attachCustomWheelEventHandler((e) => termWheel(t, e));
  const links = termExtraLinks(t, termLinks(t));
  xterm.registerLinkProvider(links);
  termLinkClicks(t, links);
  termExtras(t, links);
  termDrops(t);
  xterm.onResize(({ cols, rows }) => { if (!t.exited) wb.ptyResize(t.id, cols, rows); });
  S.terms.push(t);
  return t;
}

async function launch(kind, { resume = false, resumeId, resumeMode, name } = {}) {
  if (!S.project) { toast('Open a project first'); return null; }
  if (S.info?.terminals === false) { toast(`Terminals are unavailable: ${S.info.terminalError || ''}`, 5000); return null; }
  // Where it sends what you type, said first (not for a session reopened after a restart).
  if (!resumeId && !(await agentConsent(kind))) return null;
  // Workbench Pro: a sandbox gets only the vault secrets picked for this session.
  let secrets;
  if (String(kind).startsWith('sandbox-') && typeof proPickSandboxSecrets === 'function') {
    secrets = await proPickSandboxSecrets(kind);
    if (secrets === null) return null;
  }
  $('#term-area').classList.remove('collapsed');
  let info;
  try {
    // Size the pty right from the start so TUIs (Claude Code, Codex) draw correctly.
    const host = $('#term-host');
    const dims = estimateDims(host);
    info = await wb.ptyCreate({ kind, cols: dims.cols, rows: dims.rows, secrets, resume, resumeId, resumeMode });
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 5000);
    if (/not installed/i.test(err.message)) refreshInfo();
    return null;
  }
  const t = mountTerm(info);
  if (resumeId) { t.sessionId = resumeId; t.permissionMode = resumeMode || ''; if (name) saveTermName(t, name); }
  for (const n of info.notes || []) t.xterm.writeln(`\x1b[2m${n}\x1b[0m`);
  if (t.secrets.length && !t.sandbox) t.xterm.writeln(`\x1b[2mVault: ${t.secrets.join(', ')} ${t.secrets.length === 1 ? 'is' : 'are'} set in this session’s environment (values hidden).\x1b[0m`);
  // (A shell tab gets them too, for Claude Code started there: no notes in a plain shell.)
  if (t.guard && kind !== 'shell') t.xterm.writeln('\x1b[2mSecret-file guard: Meridian asks before Claude Code reads .env, keys or credentials (file tools by path; shell commands only by a name match, so it is a safety net, not a wall).\x1b[0m');
  if (info.browserTools && kind !== 'shell') t.xterm.writeln(`\x1b[2mMeridian browser tools are connected for this session (access: ${ACCESS_LABEL[S.info?.agentAccess] || 'off'} — change it in Settings → AI).\x1b[0m`);
  activateTerm(t);
  return t;
}

function estimateDims(host) {
  const w = Math.max(200, host.clientWidth - 24), h = Math.max(80, host.clientHeight - 12);
  return { cols: Math.max(20, Math.floor(w / 7.6)), rows: Math.max(5, Math.floor(h / 17)) };
}

async function restartTerm(t) {
  const kind = t.kind;
  await killTerm(t, { quiet: true });
  launch(kind);
}

// The same Claude Code session again, without permission prompts, in the same place on the tab bar.
// Asked first; the old process is gone before the new one opens the session.
async function restartWithBypass(t) {
  if (t.kind !== 'claude' || !t.sessionId) return;
  const ok = await confirmBox('Restart with bypass permissions?',
    'This Claude Code session continues, but it stops asking before it runs commands or changes files. Anything it is doing now is interrupted.',
    'Restart without asking', true);
  if (!ok) return;
  const { id, sessionId, custom } = t;
  const at = S.terms.indexOf(t);
  await killTerm(t, { quiet: true });
  for (let i = 0; i < 30; i++) {
    const list = await wb.ptyList().catch(() => []);
    const old = list.find((x) => x.id === id);
    if (!old || old.exited) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const next = await launch('claude', { resumeId: sessionId, resumeMode: 'bypassPermissions', name: custom || '' });
  if (!next) return;
  S.terms.splice(S.terms.indexOf(next), 1);
  S.terms.splice(Math.min(at, S.terms.length), 0, next);
  renderTermTabs();
  saveClaudeSessions();
}

async function killTerm(t, { quiet = false } = {}) {
  if (!quiet && !t.exited && t.kind !== 'shell') {
    if (!(await confirmBox(`Stop ${termName(t)}?`, 'The agent session in this terminal will end.', 'Stop', true))) return;
  }
  try { await wb.ptyKill(t.id); } catch {}
  t.closed = true;
  t.xterm.dispose();
  t.el.remove();
  const i = S.terms.indexOf(t);
  S.terms.splice(i, 1);
  if (S.activeTerm === t) S.activeTerm = S.terms[Math.min(i, S.terms.length - 1)] || null;
  if (S.activeTerm) activateTerm(S.activeTerm); else renderTermTabs();
  if (t.kind === 'claude') saveClaudeSessions();
}

function activateTerm(t) {
  const before = S.activeTerm;
  S.activeTerm = t;
  for (const o of S.terms) o.el.classList.toggle('hidden', o !== t);
  renderTermTabs();
  // Context Insights follows the agent tab picked.
  if (before !== t && typeof PRO !== 'undefined' && PRO.activePanel === 'insights' && typeof ciRedraw === 'function') ciRedraw();
  requestAnimationFrame(() => { fitActive(); t.xterm.focus(); });
}

function fitActive() {
  const t = S.activeTerm;
  if (!t || $('#term-area').classList.contains('collapsed')) return;
  try { t.fit.fit(); } catch {}
}

// Names given by hand (double click on a tab), by terminal, for as long as the terminals live.
function savedTermNames() {
  try { return JSON.parse(sessionStorage.getItem('termNames') || '{}'); } catch { return {}; }
}

function saveTermName(t, name) {
  t.custom = name;
  const all = savedTermNames();
  if (name) all[t.id] = name; else delete all[t.id];
  try { sessionStorage.setItem('termNames', JSON.stringify(all)); } catch {}
  if (t.kind === 'claude') saveClaudeSessions();
}

// A name given by hand, else the session's name (Claude Code's status line), else the terminal's title.
function termName(t) {
  return t.custom || (typeof termSessionName === 'function' && termSessionName(t)) || t.auto || t.title;
}

function renameTerm(t) {
  const nameEl = [...document.querySelectorAll('#term-tab-list .ttab')][S.terms.indexOf(t)]?.querySelector('.name');
  if (!nameEl) return;
  S.renamingTerm = t;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = termName(t);
  input.spellcheck = false;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    S.renamingTerm = null;
    // Empty: back to the name the program gives.
    if (keep) saveTermName(t, input.value.trim().slice(0, 80));
    renderTermTabs();
    t.xterm.focus();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Drag a terminal's tab along the strip to put it elsewhere (pointer events, so a mouse and a
// trackpad both do). The order is kept: Claude Code tabs come back in it after a restart.
function dragTermTab(el, t, e) {
  if (e.button !== 0 || e.target.closest('.tab-close, .ctx-badge, .rename')) return;
  const list = $('#term-tab-list');
  const startX = e.clientX;
  let dragging = false;
  const others = () => [...list.children].filter((x) => x !== el);
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientX - startX) < 5) return;
    if (!dragging) {
      dragging = true;
      S.draggingTerm = t;
      el.classList.add('dragging');
    }
    el.style.transform = `translateX(${ev.clientX - startX}px)`;
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    if (!dragging) return;
    S.draggingTerm = null;
    S.termDraggedAt = Date.now();
    // Its new place: after every other tab whose middle the pointer passed.
    const tabs = others();
    const index = tabs.filter((x) => { const r = x.getBoundingClientRect(); return r.left + r.width / 2 < ev.clientX; }).length;
    const order = S.terms.filter((x) => x !== t);
    const before = tabs[index] ? S.terms[[...list.children].indexOf(tabs[index])] : null;
    order.splice(before ? order.indexOf(before) : order.length, 0, t);
    S.terms = order;
    renderTermTabs();
    saveClaudeSessions();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
}

function renderTermTabs() {
  termStripRender();
  // Not under the name being typed (a status update would drop it), nor under a tab being dragged.
  if (S.renamingTerm || S.draggingTerm) return;
  const list = $('#term-tab-list');
  list.replaceChildren(...S.terms.map((t) => {
    const el = document.createElement('div');
    el.className = `ttab${t === S.activeTerm ? ' active' : ''}${t.exited ? ' exited' : ''}`;
    el.setAttribute('role', 'tab');
    // A shell tab with Claude Code running in it looks like a Claude Code tab.
    el.appendChild(agentMark(t.kind === 'shell' && t.sessionId ? 'claude' : AGENT_UI[t.kind] ? t.kind : 'shell'));
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = termName(t) + (t.exited ? ' (exited)' : '');
    el.title = `${termName(t)}\nDouble-click to rename`;
    el.appendChild(name);
    const badge = typeof termUsageBadge === 'function' ? termUsageBadge(t) : null;
    if (badge) el.appendChild(badge);
    if (t.browserTools) { const p = document.createElement('span'); p.className = 'plug'; p.title = 'Meridian browser tools connected'; p.innerHTML = icon('globe', 11); el.appendChild(p); }
    // Workbench Pro: sandbox and vault indicators (secret NAMES only)
    if (t.sandbox) { const p = document.createElement('span'); p.className = 'plug sbx'; p.title = 'Runs in a Docker sandbox: only this project is visible'; p.innerHTML = icon('shield', 11); el.appendChild(p); }
    if (t.secrets?.length) { const p = document.createElement('span'); p.className = 'plug keys'; p.title = `Vault secrets in this session’s environment:\n${t.secrets.join('\n')}`; p.innerHTML = icon('lock', 11) + `<span>${t.secrets.length}</span>`; el.appendChild(p); }
    if (t.kind === 'claude' && t.permissionMode === 'bypassPermissions') {
      const p = document.createElement('span');
      p.className = 'bypass-on';
      p.textContent = 'Bypass';
      p.title = 'This session runs without permission prompts';
      el.appendChild(p);
    } else if (t === S.activeTerm && t.kind === 'claude' && t.sessionId) {
      const b = document.createElement('button');
      b.className = 'tab-bypass';
      b.textContent = 'Bypass';
      b.title = 'Restart this session with bypass permissions';
      el.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'tab-close'; x.title = t.exited ? 'Close' : 'Stop and close'; x.innerHTML = icon('x', 12);
    el.appendChild(x);
    // A double click renames: told by the click count, since the first click redraws the tabs.
    el.addEventListener('pointerdown', (e) => dragTermTab(el, t, e));
    el.addEventListener('click', (e) => {
      // The click that ends a drag isn't one.
      if (Date.now() - (S.termDraggedAt || 0) < 300) return;
      if (e.target.closest('.tab-close')) killTerm(t);
      else if (e.target.closest('.tab-bypass')) restartWithBypass(t);
      else if (e.detail === 2 && !e.target.closest('.ctx-badge')) renameTerm(t);
      else if (e.detail < 2) activateTerm(t);
    });
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); killTerm(t); } });
    return el;
  }));
  $('#term-empty').hidden = S.terms.length > 0;
  renderTermStart();
  sendMissionNames();
}

// Mission Control shows each session under the name on its tab (only when one changes).
let lastMissionNames = '';
function sendMissionNames() {
  if (typeof wb.missionNames !== 'function') return;
  const names = Object.fromEntries(S.terms.filter((t) => t.id && !t.exited).map((t) => [t.id, termName(t) || '']));
  const key = JSON.stringify(names);
  if (key === lastMissionNames) return;
  lastMissionNames = key;
  wb.missionNames(names).catch(() => {});
}

// A project with no terminal yet: one big button for the agent that's installed (the first of Claude Code,
// Codex, Gemini), so starting takes one click.
function renderTermStart() {
  const box = $('#term-start');
  if (!box) return;
  const kind = agentKinds().find((id) => S.info?.agents?.[id]?.installed);
  box.innerHTML = '';
  if (!kind || S.terms.length) return;
  const b = document.createElement('button');
  b.className = 'btn accent big term-start-btn';
  b.append(agentMark(kind), document.createTextNode(`Start ${AGENT_UI[kind].label}`));
  b.addEventListener('click', () => launch(kind));
  box.appendChild(b);
  if (kind === 'claude') box.appendChild(resumeButton('btn big term-resume-btn'));
}

// Claude Code's list of this project's recent sessions (also ones whose tab was closed), to pick one up.
function resumeButton(className) {
  const b = document.createElement('button');
  b.className = className;
  const mark = agentMark('claude');
  mark.textContent = '↻';
  const label = document.createElement('span');
  label.textContent = 'Resume Claude Code…';
  b.append(mark, label);
  b.title = 'Pick up a recent Claude Code session in this project';
  b.addEventListener('click', () => launch('claude', { resume: true }));
  return b;
}

function layoutTerminals() { renderTermTabs(); fitActive(); }

async function reattachTerminals() {
  let list = [];
  try { list = await wb.ptyList(); } catch { return 0; }
  for (const info of list) {
    if (S.terms.some((t) => t.id === info.id)) continue;
    const t = mountTerm(info);
    if (info.scrollback) t.xterm.write(info.scrollback);
    if (info.exited) t.xterm.writeln(`\r\n\x1b[2m[process exited — press Enter to restart]\x1b[0m`);
  }
  if (S.terms.length) activateTerm(S.terms[S.terms.length - 1]);
  return list.length;
}

// Claude Code tabs come back after the browser restarts (an update, say): each project remembers
// its Claude sessions (the id Claude Code's status line gives, the permission mode its hooks report,
// and a name given by hand), and when
// the Workbench opens the project with no terminals running, they open again with `claude --resume`,
// in the same order. A tab closed by hand is forgotten.
function saveClaudeSessions() {
  const root = S.project?.root;
  if (!root || S.restoringSessions || typeof wb.saveClaudeSessions !== 'function') return;
  // (Claude Code started by hand in a shell tab too, while it runs there.)
  const list = S.terms.filter((t) => (t.kind === 'claude' || t.kind === 'shell') && t.root === root && t.sessionId && !t.closed)
    .map((t) => ({ id: t.sessionId, name: t.custom || '', mode: t.permissionMode || '' }));
  const key = JSON.stringify(list);
  if (S.savedSessions === key) return;
  S.savedSessions = key;
  wb.saveClaudeSessions(list).catch(() => { S.savedSessions = null; });
}

// The status line told us a terminal's session id (it changes on /clear, so keep following it).
function noteClaudeSessions(usage) {
  let changed = false;
  for (const t of S.terms) {
    const claude = t.kind === 'claude' || t.kind === 'shell';
    const id = usage?.[t.id]?.session_id;
    if (claude && typeof id === 'string' && id && id !== t.sessionId) { t.sessionId = id; changed = true; }
    // The permission mode it's in (bypass, auto, accept edits…), to resume it in the same one.
    const mode = usage?.[t.id]?.permission_mode;
    if (claude && typeof mode === 'string' && mode && mode !== t.permissionMode) { t.permissionMode = mode; changed = true; }
    // Claude Code quit in a shell tab: the shell stays, nothing to bring back.
    if (t.kind === 'shell' && t.sessionId && !usage?.[t.id]) { t.sessionId = ''; t.permissionMode = ''; changed = true; }
  }
  if (changed) { saveClaudeSessions(); renderTermTabs(); }
}

async function restoreClaudeSessions(root) {
  let list = [];
  try { list = (await wb.claudeSessions()) || []; } catch { return; }
  list = list.filter((s) => s && /^[\w-]{1,80}$/.test(String(s.id)));
  S.savedSessions = JSON.stringify(list);
  if (!list.length || S.info?.agents?.claude?.installed === false) return;
  S.restoringSessions = true;
  try {
    for (const s of list) {
      if (S.project?.root !== root) break;
      await launch('claude', { resumeId: String(s.id), resumeMode: typeof s.mode === 'string' ? s.mode : '', name: typeof s.name === 'string' ? s.name.slice(0, 80) : '' });
    }
  } finally { S.restoringSessions = false; }
  saveClaudeSessions();
}

function initTerminals() {
  wb.onPtyData(({ id, data }) => S.terms.find((t) => t.id === id)?.xterm.write(data));
  wb.onPtyExit(({ id, code }) => {
    const t = S.terms.find((x) => x.id === id);
    if (!t) return;
    t.exited = { code };
    t.xterm.writeln(`\r\n\x1b[2m[process exited${code ? ` with code ${code}` : ''} — press Enter to restart]\x1b[0m`);
    renderTermTabs();
    // Workbench Pro: the sandbox image build finished — start the sandbox it was built for.
    if (t.then && code === 0) { t.xterm.writeln(`\x1b[2mImage ready — starting ${AGENT_UI[t.then]?.label || t.then}…\x1b[0m`); launch(t.then); }
  });
  $('#term-new').addEventListener('click', () => launch('shell'));
  $('#term-toggle').addEventListener('click', () => {
    const area = $('#term-area');
    area.classList.toggle('collapsed');
    $('#term-toggle').title = area.classList.contains('collapsed') ? 'Show terminal' : 'Hide terminal';
    fitActive();
  });
  new ResizeObserver(() => fitActive()).observe($('#term-host'));
  // The launchers fit again whenever the bar or what shares it (the project's name, the buttons on
  // the right) changes size.
  {
    let queued = false;
    const refit = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fitLauncher(); }); };
    const ro = new ResizeObserver(refit);
    for (const el of $('#topbar')?.children || []) if (el.id !== 'launcher') ro.observe(el);
    if ($('#topbar')) ro.observe($('#topbar'));
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { for (const t of S.terms) t.xterm.options.theme = termTheme(); });
}

// ---------------------------------------------------------------- layout: resizable panes

function initGrips() {
  const drag = (grip, onMove) => grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    grip.classList.add('drag');
    document.body.classList.add('resizing');
    document.body.style.cursor = getComputedStyle(grip).cursor;
    const move = (ev) => onMove(ev);
    const up = () => {
      grip.classList.remove('drag'); document.body.classList.remove('resizing'); document.body.style.cursor = '';
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); fitActive();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  drag($('#tree-grip'), (ev) => {
    const w = Math.min(Math.max(160, ev.clientX), Math.max(200, window.innerWidth * 0.5));
    document.documentElement.style.setProperty('--tree-w', w + 'px');
    store('treeW', w);
  });
  drag($('#term-grip'), (ev) => {
    const rect = $('#center').getBoundingClientRect();
    const h = Math.min(rect.height - 120, Math.max(80, rect.bottom - ev.clientY));
    document.documentElement.style.setProperty('--term-h', h + 'px');
    store('termH', h);
    fitActive();
  });
  const tw = Number(load('treeW')); if (tw) document.documentElement.style.setProperty('--tree-w', tw + 'px');
  const th = Number(load('termH')); if (th) document.documentElement.style.setProperty('--term-h', th + 'px');
}

function store(k, v) { try { localStorage.setItem('wb.' + k, v); } catch {} }
function load(k) { try { return localStorage.getItem('wb.' + k); } catch { return null; } }

// ---------------------------------------------------------------- preview + host messages

function initPreview() {
  $('#preview-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = $('#preview-url').value.trim();
    if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/.*)?$/i.test(url)) url = 'http://' + url;
    if (/^:\d+/.test(url)) url = 'http://localhost' + url;
    if (!/^https?:\/\/\S+$/i.test(url)) return toast('Enter an http(s) URL, e.g. http://localhost:3000');
    $('#preview-url').value = url;
    if (S.project) wb.setPreviewUrl(url).catch(() => {});
    wb.toHost({ type: 'preview', url });
  });
}

function onHostCommand(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'theme') applySpace(msg.space);
  if (msg.type === 'init') {
    if (msg.space) applySpace(msg.space);
    if (S.initReceived) return;
    S.initReceived = true;
    if (!S.project && typeof msg.project === 'string') openRecent(msg.project);
  }
  if (msg.type === 'pick-project') pickProject();
  // Mission Control: "Open terminal" on an agent node, and the live counts for the topbar chip.
  if (msg.type === 'focus-term') {
    const t = S.terms.find((x) => x.id === String(msg.id));
    if (t) {
      $('#term-area').classList.remove('collapsed');
      activateTerm(t);
      // From Mission Control's "Context Insights".
      if (msg.panel === 'insights' && typeof openPanel === 'function') { CI.termId = t.id; openPanel('insights'); }
    }
  }
  if (msg.type === 'mission' && typeof missionChip === 'function') missionChip(msg);
  if (msg.type === 'mission' && typeof insightsUsage === 'function') insightsUsage(msg.usage);
  if (msg.type === 'mission') noteClaudeSessions(msg.usage);
  if (typeof proHostCommand === 'function') proHostCommand(msg); // Workbench Pro: new-hub, customize, safe-mode
}

// ---------------------------------------------------------------- keyboard + focus zones

function initKeys() {
  // Tell main which part has focus, so editor/terminal keys aren't eaten by browser menu shortcuts.
  let zone = '';
  const report = () => {
    const a = document.activeElement;
    const z = a?.closest?.('#editor-host') ? 'editor' : a?.closest?.('#term-host') ? 'terminal' : 'other';
    if (z !== zone) { zone = z; wb.focusZone(z); }
  };
  document.addEventListener('focusin', report);
  document.addEventListener('focusout', () => setTimeout(report, 0));
  document.addEventListener('keydown', (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 's' && !e.target.closest?.('#editor-host')) {
      if (S.activeTab?.model && zone !== 'terminal') { e.preventDefault(); saveActive(); }
    }
    if (e.key === 'Escape' && !$('#popover').hidden) $('#popover').hidden = true;
  });
  window.addEventListener('focus', () => refreshInfo());
  window.addEventListener('beforeunload', () => { /* terminals survive reloads; main re-attaches them */ });
}

// ---------------------------------------------------------------- boot

async function boot() {
  document.body.classList.add(IS_MAC ? 'plat-mac' : 'plat-other');
  iconize();
  $('.welcome-card .logo').innerHTML = icon('code', 28);
  if (!IS_MAC) for (const k of document.querySelectorAll('kbd')) if (k.textContent === '⌘') k.textContent = 'Ctrl';
  $('#open-folder').addEventListener('click', pickProject);
  $('#project-btn').addEventListener('click', projectMenu);
  initTree();
  initTerminals();
  initGrips();
  initPreview();
  initKeys();
  wb.onFsChange(onFsChange);
  wb.onHostCommand(onHostCommand);
  if (typeof proBoot === 'function') await proBoot(); // Workbench Pro: customizations, panels, vault, hubs
  loadMonaco();

  const info = await refreshInfo();
  if (info?.project) await setProject(info.project, { reattach: true }); // page reload: project and terminals are still alive
  else renderWelcome();
  wb.toHost({ type: 'ready' });
}

// After every script has loaded (workbench-pro.js comes after this file).
document.addEventListener('DOMContentLoaded', () => boot());
