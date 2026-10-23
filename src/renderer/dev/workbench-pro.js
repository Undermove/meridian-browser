/* Meridian Workbench Pro — customizations + plugins, secrets vault, sandboxed agents, hubs.
 *
 * Loaded after workbench.js and shares its globals (S, wb, $, esc, modal, toast, launch, …).
 * Everything privileged goes through window.workbench; main re-validates every argument.
 * Text from disk, plugins or terminals is rendered with textContent / esc().
 */

const PRO = {
  info: null,
  custom: null,            // last state from main
  settings: null,          // effective, validated settings
  plugins: new Map(),      // file -> { file, id, name, status: loading|active|error|inactive, error, disposers: [] }
  reg: { toolbar: new Map(), commands: new Map(), panels: new Map(), launchers: new Map(), keys: new Map() },
  pluginSig: null,
  activePanel: null,
  panelCleanup: null,
  vault: { items: [], unavailable: null },
  secretFiles: [],
  sandbox: null,
  hub: null,
  noticeKey: null,
};

const SAFE_ICONS = new Set(['bolt', 'play', 'code', 'terminal', 'globe', 'file', 'folder', 'star', 'pin', 'layers', 'shield', 'lock', 'reload', 'search', 'settings', 'eye', 'history', 'copy', 'link', 'archive', 'download']);
const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ======================================================================== settings.json

const DEFAULTS = {
  editor: { fontSize: 13, fontFamily: '', lineHeight: 20, minimap: false, wordWrap: 'off', tabSize: 2, theme: 'auto' },
  terminal: { fontSize: 12.5, fontFamily: '', lineHeight: 1.15 },
  layout: { treeWidth: 240, terminalHeight: '38%', sidePanelWidth: 320, showTree: true },
  ui: { accent: '' },
};

function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, min, max, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
  const font = (v) => (typeof v === 'string' && v.length <= 200 && !/[;{}<>\\]/.test(v) ? v : '');
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const e = r.editor || {}, t = r.terminal || {}, l = r.layout || {}, u = r.ui || {};
  return {
    editor: {
      fontSize: num(e.fontSize, 8, 40, DEFAULTS.editor.fontSize), fontFamily: font(e.fontFamily), lineHeight: num(e.lineHeight, 0, 80, DEFAULTS.editor.lineHeight),
      minimap: typeof e.minimap === 'boolean' ? e.minimap : false, wordWrap: pick(e.wordWrap, ['off', 'on', 'bounded', 'wordWrapColumn'], 'off'),
      tabSize: Math.round(num(e.tabSize, 1, 16, 2)), theme: pick(e.theme, ['auto', 'light', 'dark', 'hc-black', 'hc-light'], 'auto'),
    },
    terminal: { fontSize: num(t.fontSize, 8, 40, DEFAULTS.terminal.fontSize), fontFamily: font(t.fontFamily), lineHeight: num(t.lineHeight, 1, 3, DEFAULTS.terminal.lineHeight) },
    layout: {
      treeWidth: Math.round(num(l.treeWidth, 120, 800, DEFAULTS.layout.treeWidth)),
      terminalHeight: typeof l.terminalHeight === 'string' && /^\d{1,4}(\.\d+)?(px|%|vh)$/.test(l.terminalHeight) ? l.terminalHeight : DEFAULTS.layout.terminalHeight,
      sidePanelWidth: Math.round(num(l.sidePanelWidth, 200, 900, DEFAULTS.layout.sidePanelWidth)),
      showTree: typeof l.showTree === 'boolean' ? l.showTree : true,
    },
    ui: { accent: typeof u.accent === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(u.accent) ? u.accent : '' },
  };
}

// Hooks read by workbench.js
function proEditorTheme() { return PRO.settings?.editor.theme || 'auto'; }
function proTerminalOptions() { const t = PRO.settings?.terminal; return t ? { fontSize: t.fontSize, fontFamily: t.fontFamily, lineHeight: t.lineHeight } : {}; }

function applySettings(prev) {
  const s = PRO.settings;
  const root = document.documentElement.style;
  if (S.editor && S.monaco) {
    S.editor.updateOptions({
      fontSize: s.editor.fontSize, fontFamily: s.editor.fontFamily || cssVar('--mono'), lineHeight: s.editor.lineHeight,
      minimap: { enabled: s.editor.minimap }, wordWrap: s.editor.wordWrap,
    });
    for (const t of S.tabs) t.model?.updateOptions({ tabSize: s.editor.tabSize });
    S.monaco.editor.setTheme(editorThemeName());
  }
  for (const t of S.terms) {
    t.xterm.options.fontSize = s.terminal.fontSize;
    t.xterm.options.fontFamily = s.terminal.fontFamily || cssVar('--mono');
    t.xterm.options.lineHeight = s.terminal.lineHeight;
  }
  fitActive();
  // Layout: only override what settings.json actually changes (dragging the grips still works).
  const changed = (k) => !prev || prev.layout[k] !== s.layout[k];
  if (changed('treeWidth') && (prev || s.layout.treeWidth !== DEFAULTS.layout.treeWidth)) root.setProperty('--tree-w', s.layout.treeWidth + 'px');
  if (changed('terminalHeight') && (prev || s.layout.terminalHeight !== DEFAULTS.layout.terminalHeight)) root.setProperty('--term-h', s.layout.terminalHeight);
  root.setProperty('--side-w', s.layout.sidePanelWidth + 'px');
  $('#tree-pane').hidden = !s.layout.showTree;
  $('#tree-grip').hidden = !s.layout.showTree;
  if (s.ui.accent) applySpace(s.ui.accent);
  else if (prev?.ui.accent && PRO.hostSpace) applySpace(PRO.hostSpace);
}

// The space colour from the host, unless settings.json pins an accent.
const baseApplySpace = applySpace;
// eslint-disable-next-line no-global-assign
applySpace = (color) => { if (color !== PRO.settings?.ui.accent) PRO.hostSpace = color; baseApplySpace(PRO.settings?.ui.accent || color); };

// ======================================================================== customizations: load + hot reload

async function reloadCustom({ quiet = false } = {}) {
  let st;
  try { st = await wb.customState(); } catch (err) { console.error(err); return; }
  PRO.custom = st;
  const prev = PRO.settings;
  PRO.settings = sanitizeSettings(st.safeMode ? null : st.settings);
  applySettings(prev);
  // user.css: swap the <link> (cache-busted by mtime)
  let link = $('#user-css');
  if (st.safeMode || st.unavailable) link?.remove();
  else {
    if (!link) { link = document.createElement('link'); link.id = 'user-css'; link.rel = 'stylesheet'; document.head.appendChild(link); }
    const href = `/custom/user.css?v=${Math.round(st.cssMtime)}`;
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }
  const sig = JSON.stringify([st.safeMode, st.disabled, (st.plugins || []).map((p) => [p.file, p.mtimeMs, p.sha256, p.approved])]);
  if (sig !== PRO.pluginSig) {
    const hadPlugins = PRO.plugins.size > 0;
    PRO.pluginSig = sig;
    await loadPlugins();
    if (!quiet && (hadPlugins || PRO.plugins.size)) toast(st.safeMode ? 'Safe Mode: customizations are off' : `Plugins reloaded (${[...PRO.plugins.values()].filter((p) => p.status === 'active').length} active)`);
  }
  renderCustomStatus();
  if (PRO.activePanel === 'customize') renderPanel();
  const pending = st.safeMode || st.unavailable ? [] : (st.plugins || []).filter((p) => !p.approved && !(st.disabled || []).includes(p.file));
  if (pending.length) {
    notice('plugins-pending', `${pending.length === 1 ? `Plugin ${pending[0].file} is` : `${pending.length} plugins are`} waiting for your approval before ${pending.length === 1 ? 'it runs' : 'they run'}.`, [
      { label: 'Review…', accent: true, run: approvePlugins },
      { label: 'Customize', run: () => openPanel('customize') },
    ]);
  } else hideNotice('plugins-pending');
}

function disposePlugin(rec) {
  for (const d of rec.disposers.splice(0).reverse()) { try { d(); } catch (err) { console.warn('plugin cleanup failed', rec.file, err); } }
}

async function loadPlugins() {
  PRO.reloading = true; // keep a plugin's open panel while its plugin reloads
  try { await loadPluginsInner(); } finally { PRO.reloading = false; }
  if (PRO.activePanel && !panelById(PRO.activePanel)) closePanel();
  else if (PRO.activePanel && PRO.reg.panels.has(PRO.activePanel)) renderPanel();
}

async function loadPluginsInner() {
  for (const rec of PRO.plugins.values()) disposePlugin(rec);
  PRO.plugins.clear();
  for (const el of document.querySelectorAll('script[data-plugin]')) el.remove();
  const st = PRO.custom;
  if (!st || st.safeMode || st.unavailable) { renderPluginUi(); return; }
  for (const p of st.plugins || []) {
    const rec = { file: p.file, id: p.file, name: p.file.replace(/\.js$/, ''), status: 'loading', error: null, disposers: [] };
    PRO.plugins.set(p.file, rec);
    if ((st.disabled || []).includes(p.file)) { rec.status = 'off'; continue; }
    if (!p.approved) { rec.status = 'pending'; rec.error = p.everApproved ? 'Changed since you approved it — approve again to run it' : 'New — approve it to run it'; continue; }
    PRO.everLoadedPlugins = true;
    await new Promise((resolve) => {
      const el = document.createElement('script');
      el.dataset.plugin = p.file;
      el.src = `/custom/plugins/${encodeURIComponent(p.file)}?v=${Math.round(p.mtimeMs)}`;
      el.onload = () => { if (rec.status === 'loading') { rec.status = 'inactive'; rec.error = 'The file didn’t call workbenchPlugin(...)'; } resolve(); };
      el.onerror = () => { rec.status = 'error'; rec.error = rec.error || 'Failed to load'; resolve(); };
      document.body.appendChild(el);
    });
  }
  renderPluginUi();
}

// Errors thrown at load time or later from plugin code are pinned on the plugin.
window.addEventListener('error', (e) => {
  const m = /\/custom\/plugins\/([^?#]+)/.exec(e.filename || '');
  if (!m) return;
  const rec = PRO.plugins.get(decodeURIComponent(m[1]));
  if (rec) { rec.status = 'error'; rec.error = `${e.message} (line ${e.lineno})`; renderCustomStatus(); if (PRO.activePanel === 'customize') renderPanel(); }
});

function guarded(rec, fn, what) {
  return (...args) => {
    try { return fn(...args); } catch (err) {
      rec.status = 'error'; rec.error = `${what}: ${err.message}`;
      toast(`Plugin ${rec.name}: ${err.message}`, 4000);
      renderCustomStatus();
      return undefined;
    }
  };
}

function makeApi(rec) {
  const key = (id) => `${rec.file}:${String(id || '').slice(0, 60)}`;
  const track = (map, k, v, rerender) => {
    map.set(k, v);
    rerender();
    rec.disposers.push(() => { if (map.get(k) === v) { map.delete(k); rerender(); } });
  };
  const api = {
    toolbar: {
      add: ({ id, label, icon: ic, title, onClick } = {}) => track(PRO.reg.toolbar, key(id), {
        label: String(label || '').slice(0, 40), icon: SAFE_ICONS.has(ic) ? ic : null, title: String(title || label || '').slice(0, 200), onClick: guarded(rec, onClick || (() => {}), 'toolbar'), plugin: rec,
      }, renderPluginToolbar),
    },
    commands: {
      add: ({ id, title, run, keybinding } = {}) => {
        const cmd = { id: key(id), title: String(title || id || '').slice(0, 100), run: guarded(rec, run || (() => {}), 'command'), plugin: rec, keybinding: keybinding ? String(keybinding) : null };
        track(PRO.reg.commands, cmd.id, cmd, () => {});
        if (cmd.keybinding) api.keybindings.add(cmd.keybinding, cmd.run);
      },
    },
    keybindings: {
      add: (combo, fn) => {
        const k = normalizeCombo(String(combo || ''));
        if (!k) throw new Error(`Invalid keybinding “${combo}”`);
        track(PRO.reg.keys, `${rec.file}:${k}`, { combo: k, run: guarded(rec, fn, 'keybinding') }, () => {});
      },
    },
    panels: {
      add: ({ id, title, icon: ic, render } = {}) => track(PRO.reg.panels, key(id), {
        title: String(title || id || 'Panel').slice(0, 40), icon: SAFE_ICONS.has(ic) ? ic : 'layers', render: guarded(rec, render || (() => {}), 'panel'), plugin: rec,
      }, () => { renderSideTabs(); if (PRO.activePanel === key(id) && !PRO.reloading) renderPanel(); }),
    },
    launchers: {
      add: ({ id, label, command, mark, color } = {}) => {
        if (typeof command !== 'string' || !command.trim() || command.length > 2000) throw new Error('launcher needs a command');
        track(PRO.reg.launchers, key(id), {
          label: String(label || id || 'Run').slice(0, 30), command, mark: String(mark || (label || 'R')[0]).slice(0, 2),
          color: /^#[0-9a-f]{3,8}$/i.test(color || '') ? color : '#7a808c', plugin: rec,
        }, renderLauncher);
      },
    },
    terminal: { run: (command, opts) => runInShell(String(command || ''), opts) },
    files: {
      read: async (rel) => { const f = await wb.read(String(rel)); if (f.content === undefined) throw new Error('not a text file'); return f.content; },
      write: (rel, text) => wb.write(String(rel), String(text)),
      open: (rel) => openFile(String(rel), { focus: true }),
    },
    project: () => (S.project ? { root: S.project.root, name: S.project.name } : null),
    settings: () => JSON.parse(JSON.stringify(PRO.settings)),
    on: (event, fn) => {
      if (!['project', 'file-open', 'file-save'].includes(event)) throw new Error(`Unknown event “${event}”`);
      const h = (e) => guarded(rec, fn, event)(e.detail);
      bus.addEventListener(event, h);
      rec.disposers.push(() => bus.removeEventListener(event, h));
    },
    toast: (text) => toast(String(text).slice(0, 300)),
    css: (text) => {
      const el = document.createElement('style');
      el.dataset.pluginStyle = rec.file;
      el.textContent = String(text);
      document.head.appendChild(el);
      rec.disposers.push(() => el.remove());
    },
    el: (tag, props, ...children) => {
      const el = document.createElement(String(tag));
      for (const [k, v] of Object.entries(props || {})) {
        if (/^(innerHTML|outerHTML|srcdoc)$/i.test(k)) throw new Error(`api.el: ${k} is not allowed — use text children`);
        if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), guarded(rec, v, k));
        else if (k in el) el[k] = v; else el.setAttribute(k, String(v));
      }
      for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : String(c));
      return el;
    },
  };
  return Object.freeze(api);
}

// workbenchPlugin({ id, name }, (api) => { ... }) — called by plugin files while they load.
window.workbenchPlugin = (meta, setup) => {
  const file = document.currentScript?.dataset.plugin;
  const rec = file && PRO.plugins.get(file);
  if (!rec) { console.warn('workbenchPlugin() must be called from a plugin file in plugins/ while it loads'); return; }
  if (rec.status !== 'loading') return; // one registration per file
  if (typeof meta === 'function') { setup = meta; meta = {}; }
  rec.id = String(meta?.id || rec.name).slice(0, 60);
  rec.name = String(meta?.name || rec.id).slice(0, 80);
  rec.status = 'active';
  try {
    const cleanup = setup(makeApi(rec));
    if (typeof cleanup === 'function') rec.disposers.push(cleanup);
  } catch (err) {
    rec.status = 'error';
    rec.error = err.message;
    disposePlugin(rec);
  }
};

function renderPluginUi() { renderPluginToolbar(); renderLauncher(); renderSideTabs(); renderCustomStatus(); }

function renderPluginToolbar() {
  const bar = $('#plugin-toolbar');
  bar.replaceChildren(...[...PRO.reg.toolbar.values()].map((b) => {
    const el = document.createElement('button');
    el.className = 'launch plugin-btn';
    el.title = `${b.title}\n(plugin: ${b.plugin.name})`;
    if (b.icon) { const i = document.createElement('span'); i.className = 'ic-slot'; i.dataset.icon = b.icon; el.appendChild(i); }
    if (b.label) { const l = document.createElement('span'); l.textContent = b.label; el.appendChild(l); }
    el.addEventListener('click', () => b.onClick());
    return el;
  }));
  iconize(bar);
}

async function runInShell(command, { title } = {}) {
  if (!command.trim()) return null;
  const t = await launch('shell');
  if (!t) return null;
  if (title) { t.title = String(title).slice(0, 40); renderTermTabs(); }
  wb.ptyWrite(t.id, command.replace(/[\r\n]+$/, '') + '\r');
  return { id: t.id };
}

// ======================================================================== keybindings + command palette

function normalizeCombo(s) {
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop().toLowerCase();
  const mods = new Set();
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (['mod', 'cmdorctrl', 'commandorcontrol'].includes(p)) mods.add('mod');
    else if (['cmd', 'command', 'meta'].includes(p)) mods.add(IS_MAC ? 'mod' : 'meta');
    else if (['ctrl', 'control'].includes(p)) mods.add(IS_MAC ? 'ctrl' : 'mod');
    else if (['alt', 'option', 'opt'].includes(p)) mods.add('alt');
    else if (p === 'shift') mods.add('shift');
    else return null;
  }
  if (!key || key.length > 12) return null;
  return [...[...mods].sort(), key].join('+');
}

function comboOf(e) {
  const mods = [];
  if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (IS_MAC && e.ctrlKey) mods.push('ctrl');
  if (!IS_MAC && e.metaKey) mods.push('meta');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  let key = (e.code && /^Key[A-Z]$/.test(e.code)) ? e.code.slice(3).toLowerCase() : (e.code && /^Digit\d$/.test(e.code)) ? e.code.slice(5) : String(e.key || '').toLowerCase();
  return [...mods.sort(), key].join('+');
}

function builtinCommands() {
  const st = PRO.sandbox;
  const c = [
    { id: 'open-folder', title: 'Open Folder…', run: pickProject },
    { id: 'new-hub', title: 'New Hub…', run: newHubWizard },
    { id: 'open-as-hub', title: 'Open Existing Folder as Hub…', run: openAsHub },
    { id: 'hub-panel', title: 'Hub: Show Conventions and Recent Files', run: () => openPanel('hub') },
    { id: 'secrets', title: 'Secrets: Open Vault', run: () => openPanel('secrets') },
    { id: 'secret-add', title: 'Secrets: Add a Secret…', run: () => editSecret() },
    { id: 'secret-scan', title: 'Secrets: Scan Project for Secret Files', run: () => scanSecrets({ announce: true }) },
    { id: 'customize-claude', title: 'Customize Workbench with AI', run: customizeWithClaude },
    { id: 'customize', title: 'Customize: Plugins, Safe Mode and History', run: () => openPanel('customize') },
    { id: 'reload-custom', title: 'Customize: Reload Customizations', run: () => { PRO.pluginSig = null; reloadCustom(); } },
    { id: 'safe-mode', title: PRO.custom?.safeMode ? 'Safe Mode: Turn Off (load customizations)' : 'Safe Mode: Turn On (no customizations)', run: () => setSafeMode(!PRO.custom?.safeMode) },
    { id: 'shell', title: 'Terminal: New Shell', run: () => launch('shell') },
  ];
  if (st?.running) {
    for (const k of ['sandbox-claude', 'sandbox-codex', 'sandbox-shell']) c.push({ id: k, title: `Sandbox: ${AGENT_UI[k].label}`, run: () => launch(k) });
    c.push({ id: 'sandbox-net', title: `Sandbox: Turn Network ${PRO.info?.sandboxNetwork === false ? 'On' : 'Off'}`, run: () => setSandboxNetwork(PRO.info?.sandboxNetwork === false) });
  }
  for (const [id, l] of PRO.reg.launchers) c.push({ id, title: `Run: ${l.label} (${l.command.slice(0, 40)})`, run: () => runInShell(l.command, { title: l.label }) });
  return c;
}

function commandPalette() {
  const all = [...builtinCommands(), ...[...PRO.reg.commands.values()].map((x) => ({ ...x, title: x.title, hint: x.plugin.name }))];
  modal(`<input id="pal-input" spellcheck="false" placeholder="Type a command…"><div id="pal-list" class="pal-list"></div>`, (m, close) => {
    m.classList.add('palette');
    const input = $('#pal-input', m);
    const list = $('#pal-list', m);
    let idx = 0;
    let shown = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = all.filter((c) => !q || q.split(/\s+/).every((w) => c.title.toLowerCase().includes(w))).slice(0, 14);
      idx = Math.min(idx, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((c, i) => {
        const row = document.createElement('div');
        row.className = 'pal-row' + (i === idx ? ' active' : '');
        const t = document.createElement('span'); t.textContent = c.title; row.appendChild(t);
        if (c.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = c.hint; row.appendChild(h); }
        row.addEventListener('mousedown', (e) => { e.preventDefault(); run(c); });
        return row;
      }));
      if (!shown.length) list.innerHTML = '<div class="pal-empty muted">No matching commands</div>';
    };
    const run = (c) => { close(); setTimeout(() => c.run(), 0); };
    input.addEventListener('input', () => { idx = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(shown.length - 1, idx + 1); draw(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      if (e.key === 'Enter' && shown[idx]) run(shown[idx]);
      if (e.key === 'Escape') close();
    });
    draw();
    input.focus();
  });
}

function initProKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.type !== 'keydown' || e.repeat) return;
    const combo = comboOf(e);
    if (combo === 'mod+shift+p') { e.preventDefault(); e.stopPropagation(); commandPalette(); return; }
    for (const k of PRO.reg.keys.values()) {
      if (k.combo === combo) { e.preventDefault(); e.stopPropagation(); k.run(); return; }
    }
  }, true);
}

// ======================================================================== side panels

const BUILTIN_PANELS = {
  hub: { title: 'Hub', icon: 'layers', render: renderHubPanel },
  secrets: { title: 'Secrets', icon: 'lock', render: renderSecretsPanel },
  customize: { title: 'Customize', icon: 'settings', render: renderCustomizePanel },
};

function panelById(id) { return BUILTIN_PANELS[id] || PRO.reg.panels.get(id); }

function openPanel(id) {
  if (!S.project && id !== 'customize' && id !== 'secrets') { toast('Open a project first'); return; }
  if (!S.project) { $('#welcome').hidden = true; $('#main').hidden = false; }
  if (!panelById(id)) return;
  PRO.activePanel = id;
  $('#side-pane').hidden = false;
  $('#side-grip').hidden = false;
  renderSideTabs();
  renderPanel();
}

function closePanel() {
  try { PRO.panelCleanup?.(); } catch {}
  PRO.panelCleanup = null;
  PRO.activePanel = null;
  $('#side-pane').hidden = true;
  $('#side-grip').hidden = true;
  if (!S.project) renderWelcome();
  renderSideTabs();
  fitActive();
}

function renderSideTabs() {
  const tabs = $('#side-tabs');
  const ids = [...Object.keys(BUILTIN_PANELS), ...PRO.reg.panels.keys()];
  tabs.replaceChildren(...ids.map((id) => {
    const p = panelById(id);
    const b = document.createElement('button');
    b.className = 'side-tab' + (PRO.activePanel === id ? ' active' : '');
    b.title = p.plugin ? `${p.title} (plugin: ${p.plugin.name})` : p.title;
    b.innerHTML = icon(p.icon, 13);
    const l = document.createElement('span'); l.textContent = p.title; b.appendChild(l);
    b.addEventListener('click', () => openPanel(id));
    return b;
  }));
  for (const [id, btn] of [['hub', '#btn-hub'], ['secrets', '#btn-secrets'], ['customize', '#btn-customize']]) $(btn).classList.toggle('on', PRO.activePanel === id);
  if (PRO.activePanel && !panelById(PRO.activePanel) && !PRO.reloading) closePanel();
}

function renderPanel() {
  try { PRO.panelCleanup?.(); } catch {}
  PRO.panelCleanup = null;
  const body = $('#side-body');
  body.replaceChildren();
  const p = panelById(PRO.activePanel);
  if (!p) return;
  const el = document.createElement('div');
  el.className = 'panel';
  body.appendChild(el);
  const cleanup = p.render(el);
  if (typeof cleanup === 'function') PRO.panelCleanup = cleanup;
  iconize(el);
}

function initSidePane() {
  $('#btn-hub').addEventListener('click', () => (PRO.activePanel === 'hub' ? closePanel() : openPanel('hub')));
  $('#btn-secrets').addEventListener('click', () => (PRO.activePanel === 'secrets' ? closePanel() : openPanel('secrets')));
  $('#btn-customize').addEventListener('click', () => (PRO.activePanel === 'customize' ? closePanel() : openPanel('customize')));
  $('#side-close').addEventListener('click', closePanel);
  $('#side-grip').addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const move = (ev) => document.documentElement.style.setProperty('--side-w', Math.min(Math.max(220, window.innerWidth - ev.clientX), window.innerWidth * 0.6) + 'px');
    const up = () => { document.body.classList.remove('resizing'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); fitActive(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// small DOM helpers for panels
function h(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function btn(label, cls, onClick, title) { const b = h('button', `btn small ${cls || ''}`, label); if (title) b.title = title; b.addEventListener('click', onClick); return b; }
const fmtTime = (ms) => { const d = new Date(ms); return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`; };

// ======================================================================== notice bar

function notice(key, text, actions = []) {
  const bar = $('#notice');
  PRO.noticeKey = key;
  bar.replaceChildren();
  bar.className = '';
  const msg = h('span', 'msg', text);
  bar.append(h('span', 'ic-slot', ''), msg);
  bar.firstChild.dataset.icon = 'shield';
  for (const a of actions) bar.appendChild(btn(a.label, a.accent ? 'accent' : '', () => { if (!a.keep) hideNotice(key); a.run(); }));
  const x = h('button', 'icon-btn small');
  x.title = 'Dismiss';
  x.innerHTML = icon('x', 12);
  x.addEventListener('click', () => { hideNotice(key); try { localStorage.setItem('wb.dismiss.' + key, '1'); } catch {} });
  bar.appendChild(x);
  bar.hidden = false;
  iconize(bar);
}
// hideNotice(key) hides that notice if it's showing; hideNotice('*') hides whatever is showing.
function hideNotice(key) { if (key && (key === '*' || PRO.noticeKey === key)) { $('#notice').hidden = true; PRO.noticeKey = null; } }
const dismissed = (key) => { try { return localStorage.getItem('wb.dismiss.' + key) === '1'; } catch { return false; } };

// ======================================================================== secrets vault

async function refreshVault() {
  try { PRO.vault = await wb.vaultList(); } catch (err) { PRO.vault = { items: [], unavailable: cleanErr(err) }; }
  renderVaultStatus();
  if (PRO.activePanel === 'secrets') renderPanel();
  return PRO.vault;
}

function renderVaultStatus() {
  const el = $('#status-vault');
  const n = PRO.vault.items?.length || 0;
  el.hidden = !n;
  el.innerHTML = `${icon('lock', 11)}<span></span>`;
  el.lastChild.textContent = `${n} secret${n === 1 ? '' : 's'}`;
  el.title = `Vault secrets available to terminals and agents in this project (names only):\n${(PRO.vault.items || []).map((i) => `${i.name}${i.scope === 'project' ? ' (project)' : ''}`).join('\n')}`;
}

function editSecret(existing = null, preset = {}) {
  const unavailable = PRO.vault.unavailable;
  if (unavailable) { toast(unavailable, 5000); return; }
  const hasProject = !!S.project;
  modal(`<h3>${existing ? 'Edit secret' : 'Add a secret'}</h3>
    <label class="field"><span>Name</span><input id="sec-name" spellcheck="false" placeholder="OPENAI_API_KEY"></label>
    <label class="field"><span>Value${existing ? ' <em class="muted">(leave empty to keep the current value)</em>' : ''}</span><input id="sec-value" type="password" spellcheck="false" autocomplete="off"></label>
    <label class="field"><span>Available in</span><select id="sec-scope"><option value="project">This project only</option><option value="global">All projects</option></select></label>
    <label class="field"><span>Note — where it’s used</span><input id="sec-note" spellcheck="false" placeholder="e.g. deploy script, Claude in sandbox"></label>
    <label class="check"><input type="checkbox" id="sec-sandbox"> Pass to sandboxed agents in this project by default <span class="muted small">(project secrets only)</span></label>
    <p class="muted small">Encrypted with your system keychain. It reaches terminals and agents that Meridian starts on this computer as the environment variable of this name — never as text in files or chat. Sandboxes only get the secrets you pick when you start one.</p>
    <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn accent" data-a="ok">${existing ? 'Save' : 'Add to vault'}</button></div>`, (m, close) => {
    const name = $('#sec-name', m), value = $('#sec-value', m), scope = $('#sec-scope', m), note = $('#sec-note', m);
    name.value = existing?.name || preset.name || '';
    note.value = existing?.note || preset.note || '';
    scope.value = existing ? existing.scope : (preset.scope || (hasProject ? 'project' : 'global'));
    if (!hasProject) { scope.querySelector('[value="project"]').disabled = true; scope.value = existing?.scope === 'project' ? 'project' : 'global'; }
    if (preset.value) value.value = preset.value;
    const sbx = $('#sec-sandbox', m);
    sbx.checked = !!existing?.sandbox;
    const syncSbx = () => { sbx.disabled = scope.value !== 'project'; if (sbx.disabled) sbx.checked = false; };
    scope.addEventListener('change', syncSbx);
    syncSbx();
    (existing || preset.name ? value : name).focus();
    name.addEventListener('input', () => { const p = name.selectionStart; name.value = name.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); name.setSelectionRange(p, p); });
    const submit = async () => {
      try {
        await wb.vaultSet({ id: existing?.id, name: name.value.trim(), value: value.value ? value.value : (existing ? undefined : ''), scope: scope.value, note: note.value.trim(), sandbox: sbx.checked });
        value.value = '';
        close();
        toast(`${name.value.trim()} saved — new terminals and agents get it`);
        refreshVault();
      } catch (err) { toast(cleanErr(err), 5000); }
    };
    m.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit(); if (e.key === 'Escape') close(); });
    m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a === 'ok') submit(); if (a === 'cancel') close(); });
  });
}

function renderSecretsPanel(el) {
  const v = PRO.vault;
  const head = h('div', 'panel-head');
  head.append(h('h2', '', 'Secrets vault'), btn('Add…', 'accent', () => editSecret()));
  el.appendChild(head);
  el.appendChild(h('p', 'muted small', 'API keys and tokens, encrypted with your system keychain. Terminals and agents started here get them as environment variables; agents never see them as text.'));
  if (v.unavailable) el.appendChild(h('p', 'warn-box', v.unavailable));
  const list = h('div', 'sec-list');
  if (!v.items?.length && !v.unavailable) list.appendChild(h('div', 'empty muted', 'No secrets yet. Paste a key into a terminal and Meridian will offer to store it, or click Add.'));
  for (const it of v.items || []) {
    const row = h('div', 'sec-row');
    const top = h('div', 'sec-top');
    top.append(h('span', 'sec-name', it.name), h('span', `badge ${it.scope}`, it.scope === 'project' ? 'project' : 'all projects'));
    const actions = h('div', 'sec-actions');
    const val = h('div', 'sec-value', '••••••••••••');
    let timer = null;
    const reveal = btn('Reveal', '', async () => {
      if (val.classList.contains('shown')) { val.textContent = '••••••••••••'; val.classList.remove('shown'); reveal.textContent = 'Reveal'; clearTimeout(timer); return; }
      try {
        val.textContent = await wb.vaultReveal(it.id);
        val.classList.add('shown');
        reveal.textContent = 'Hide';
        timer = setTimeout(() => { val.textContent = '••••••••••••'; val.classList.remove('shown'); reveal.textContent = 'Reveal'; }, 20000);
      } catch (err) { toast(cleanErr(err)); }
    }, 'Show the value for 20 seconds');
    actions.append(reveal, btn('Edit', '', () => editSecret(it)), btn('Delete', '', async () => {
      if (!(await confirmBox(`Delete ${it.name}?`, 'Terminals started from now on won’t get it. This can’t be undone.', 'Delete', true))) return;
      try { await wb.vaultDelete(it.id); refreshVault(); } catch (err) { toast(cleanErr(err)); }
    }));
    row.append(top, val);
    if (it.note) row.appendChild(h('div', 'sec-note muted small', it.note));
    row.appendChild(actions);
    list.appendChild(row);
  }
  el.appendChild(list);

  if (S.project) {
    const files = h('div', 'section');
    const fh = h('div', 'panel-head');
    fh.append(h('h3', '', 'Secret files in this project'), btn('Rescan', '', () => scanSecrets({ announce: true })));
    files.appendChild(fh);
    if (!PRO.secretFiles.length) files.appendChild(h('div', 'empty muted small', 'None found (.env, keys, credentials files).'));
    for (const f of PRO.secretFiles) {
      const row = h('div', 'file-row');
      const name = h('button', 'link mono', f.path);
      name.addEventListener('click', () => openFile(f.path, { focus: true }));
      row.appendChild(name);
      if (f.dotenv) {
        row.appendChild(h('span', 'muted small', `${f.keys.length} key${f.keys.length === 1 ? '' : 's'}: ${f.keys.slice(0, 4).join(', ')}${f.keys.length > 4 ? '…' : ''}`));
        row.appendChild(btn('Move to vault', 'accent', () => migrateFile(f)));
      } else row.appendChild(h('span', 'muted small', 'Agents can read this file. Keep it out of the project if you can.'));
      files.appendChild(row);
    }
    el.appendChild(files);
  }
  el.appendChild(h('p', 'muted small foot', 'New or changed secrets reach terminals started after you save. Claude Code sessions started here also ask you before reading .env, keys or credentials files. File tools are checked by path (symlinks resolved); shell commands only by a name match — a command that reads a secret indirectly isn’t caught.'));
}

async function scanSecrets({ announce = false } = {}) {
  if (!S.project) return;
  const root = S.project.root;
  try { PRO.secretFiles = await wb.secretScan(); } catch { PRO.secretFiles = []; }
  if (S.project?.root !== root) return;
  if (PRO.activePanel === 'secrets') renderPanel();
  const dotenvs = PRO.secretFiles.filter((f) => f.dotenv);
  const key = 'secrets:' + root + ':' + dotenvs.map((f) => f.path).join(',');
  if (dotenvs.length && (announce || !dismissed(key))) {
    const n = dotenvs.reduce((a, f) => a + f.keys.length, 0);
    notice(key, `${dotenvs.map((f) => f.path).join(', ')} ${dotenvs.length === 1 ? 'has' : 'have'} ${n} key${n === 1 ? '' : 's'} in plain text that coding agents can read. Move them into the vault? Agents then get them as environment variables.`, [
      { label: 'Move to vault', accent: true, run: async () => { for (const f of dotenvs) await migrateFile(f, { confirm: false }); } },
      { label: 'Review', run: () => openPanel('secrets') },
    ]);
  } else if (announce && !PRO.secretFiles.length) toast('No secret files found');
  else if (!dotenvs.length) hideNotice(PRO.noticeKey?.startsWith('secrets:') ? PRO.noticeKey : null);
}

async function migrateFile(f, { confirm = true } = {}) {
  if (PRO.vault.unavailable) { toast(PRO.vault.unavailable, 5000); return; }
  if (confirm && !(await confirmBox(`Move the keys in ${f.path} to the vault?`, `${f.keys.join(', ')} will be stored encrypted (this project only) and left empty in ${f.path}. Terminals and agents started from now on get them as environment variables. Apps that read ${f.path} with dotenv keep working inside Meridian’s terminals.`, 'Move to vault'))) return;
  try {
    const res = await wb.secretMigrate(f.path);
    toast(`Moved ${res.imported.length} key${res.imported.length === 1 ? '' : 's'} to the vault${res.gitignored ? `; ${f.path} added to .gitignore` : ''}${res.skipped.length ? ` (skipped: ${res.skipped.join(', ')})` : ''}`, 5000);
    await refreshVault();
    await scanSecrets();
  } catch (err) { toast(cleanErr(err), 5000); }
}

// ----- paste guard (terminals) -----

function proGuardPaste(t) {
  t.el.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    const found = window.MeridianSecrets ? MeridianSecrets.find(text) : [];
    if (!found.length || t.exited) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pasteSecretDialog(t, text, found);
  }, true);
}

function pasteSecretDialog(t, text, found) {
  const unavailable = PRO.vault.unavailable;
  const win = IS_MAC ? false : (S.info?.platform === 'win32');
  const ref = (n) => (win && t.kind === 'shell' ? `$env:${n}` : `$${n}`);
  const names = found.map((f) => MeridianSecrets.cleanName(f.name));
  modal(`<h3>This looks like a secret</h3>
    <p>Pasting it into ${esc(t.title)} puts it in the scrollback${t.kind !== 'shell' && !t.kind.endsWith('shell') ? ' and sends it to the agent’s model' : ' and maybe your shell history'}. Store it in the vault and paste a reference instead?</p>
    <div id="paste-items"></div>
    ${S.project ? '<label class="field inline"><span>Available in</span><select id="paste-scope"><option value="project">This project only</option><option value="global">All projects</option></select></label>' : ''}
    ${unavailable ? `<p class="warn-box">${esc(unavailable)}</p>` : ''}
    <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn" data-a="anyway">Paste anyway</button><button class="btn accent" data-a="save" ${unavailable ? 'disabled' : ''}>Save &amp; paste reference</button></div>`, (m, close) => {
    const items = $('#paste-items', m);
    found.forEach((f, i) => {
      const row = h('div', 'paste-item');
      const kind = h('div', 'muted small', `${f.kind} · ${MeridianSecrets.mask(f.value)}`);
      const input = h('input');
      input.value = names[i];
      input.spellcheck = false;
      input.dataset.i = i;
      const existsNote = h('div', 'small muted', '');
      const sync = () => {
        input.value = input.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        existsNote.textContent = (PRO.vault.items || []).some((x) => x.name === input.value) ? 'Replaces the stored value with this name.' : `Pastes ${ref(input.value || 'NAME')}`;
      };
      input.addEventListener('input', sync);
      sync();
      row.append(kind, input, existsNote);
      items.appendChild(row);
    });
    const finish = (pasteText) => { close(); if (pasteText !== null) t.xterm.paste(pasteText); setTimeout(() => t.xterm.focus(), 0); };
    m.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') finish(null);
      if (a === 'anyway') finish(text);
      if (a !== 'save') return;
      const scope = $('#paste-scope', m)?.value || 'global';
      const chosen = [...items.querySelectorAll('input')].map((inp) => inp.value.trim());
      try {
        for (let i = 0; i < found.length; i++) await wb.vaultSet({ name: chosen[i], value: found[i].value, scope, note: `Pasted into ${t.title} on ${new Date().toLocaleDateString()}` });
      } catch (err) { toast(cleanErr(err), 5000); return; }
      // Replace from the end so offsets stay valid.
      let out = text;
      for (let i = found.length - 1; i >= 0; i--) out = out.slice(0, found[i].start) + ref(chosen[i]) + out.slice(found[i].end);
      finish(out);
      await refreshVault();
      notice('pasted:' + t.id, `Saved ${chosen.join(', ')} to the vault. Terminals and agents started from now on have ${chosen.length === 1 ? 'it' : 'them'}; ${t.title} started before, so ${ref(chosen[0])} is empty there until you restart it.`, [
        { label: `Restart ${t.title}`, run: () => restartTerm(t) },
      ]);
    });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
    setTimeout(() => (unavailable ? $('[data-a="cancel"]', m) : $('[data-a="save"]', m)).focus(), 0);
  });
}

// ======================================================================== sandbox (Docker / OrbStack)

async function refreshSandbox(fresh = false) {
  try { PRO.sandbox = await wb.sandboxStatus(fresh); } catch { PRO.sandbox = null; }
  renderLauncher();
  return PRO.sandbox;
}

async function setSandboxNetwork(on) {
  await wb.sandboxNetwork(on);
  if (PRO.info) PRO.info.sandboxNetwork = on;
  if (S.info) S.info.sandboxNetwork = on;
  toast(on ? 'Sandbox network on (needed for Claude Code / Codex to reach their APIs)' : 'Sandbox network off — containers start with no network');
}

// Called from renderLauncher(): the sandbox menu and plugin launchers.
function proLauncherExtras(bar) {
  for (const [id, l] of PRO.reg.launchers) {
    const b = document.createElement('button');
    b.className = 'launch plugin-launch';
    const mk = document.createElement('span');
    mk.className = 'mark';
    mk.style.setProperty('--mark', l.color);
    mk.textContent = l.mark;
    const label = document.createElement('span');
    label.textContent = l.label;
    b.append(mk, label);
    b.title = `${l.command}\n(plugin: ${l.plugin.name})`;
    b.dataset.launcher = id;
    b.addEventListener('click', () => runInShell(l.command, { title: l.label }));
    bar.appendChild(b);
  }
  const st = PRO.sandbox;
  const b = document.createElement('button');
  b.className = 'launch sandbox-btn' + (st?.running ? '' : ' missing');
  b.id = 'sandbox-btn';
  b.innerHTML = `<span class="ic-slot" data-icon="shield"></span><span>Sandbox</span><span class="ic-slot caret" data-icon="chevronDown" data-size="12"></span>`;
  b.title = !st ? 'Checking for Docker…' : !st.installed ? 'Run agents in a container — install OrbStack or Docker Desktop' : !st.running ? 'Docker is installed but not running' : 'Run Claude Code, Codex or a shell in a Docker sandbox';
  b.addEventListener('click', () => sandboxMenu(b));
  bar.appendChild(b);
}

async function sandboxMenu(anchor) {
  const st = await refreshSandbox(true);
  anchor = $('#sandbox-btn') || anchor;
  if (!st || !st.installed) {
    popover(anchor, `<h3>Run agents in a sandbox</h3>
      <p>Install OrbStack or Docker Desktop to run Claude Code, Codex or a shell in a container that only sees this project — no home folder, no SSH keys, no Docker socket.</p>
      <div class="row"><button class="btn small" data-a="docker">Docker Desktop</button><button class="btn small accent" data-a="orb">Get OrbStack</button></div>`, (pop, close) => {
      pop.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'orb') { close(); wb.toHost({ type: 'open-url', url: 'https://orbstack.dev/download' }); }
        if (a === 'docker') { close(); wb.toHost({ type: 'open-url', url: 'https://www.docker.com/products/docker-desktop/' }); }
      });
    });
    return;
  }
  if (!st.running) {
    popover(anchor, `<h3>Docker isn’t running</h3><p>Start OrbStack or Docker Desktop, then check again.</p><code></code>
      <div class="row"><button class="btn small accent" data-a="recheck">Check again</button></div>`, (pop, close) => {
      $('code', pop).textContent = st.error || 'docker info failed';
      pop.addEventListener('click', (e) => { if (e.target.closest('[data-a]')) { close(); sandboxMenu(anchor); } });
    });
    return;
  }
  const names = new Set((PRO.vault.items || []).map((i) => i.name));
  const net = S.info?.sandboxNetwork !== false;
  popover(anchor, `<h3>Sandbox</h3>
    <p>Only <b>this project</b> is mounted (read-write, at /workspace) — except .git, .claude, .vscode and other files your computer runs automatically, which are read-only. No home folder, no Docker socket, non-root user, 2 CPUs / 4 GB. You pick which vault secrets go in each time.</p>
    <div class="sbx-list"></div>
    <label class="check"><input type="checkbox" id="sbx-net" ${net ? 'checked' : ''}> Network access <span class="muted small">(on by default: agents need it to reach their API — it also lets them reach any site)</span></label>
    <p class="muted small sbx-image"></p>`, (pop, close) => {
    const list = $('.sbx-list', pop);
    for (const [k, need] of [['sandbox-claude', 'ANTHROPIC_API_KEY'], ['sandbox-codex', 'OPENAI_API_KEY'], ['sandbox-shell', null]]) {
      const row = h('button', 'sbx-row');
      row.appendChild(agentMark(k));
      row.appendChild(h('span', 'label', AGENT_UI[k].label));
      if (need && !names.has(need)) {
        const warn = h('span', 'need small', `needs ${need}`);
        warn.title = `Add ${need} to the vault (Secrets panel) so the CLI can sign in inside the container.`;
        row.appendChild(warn);
      }
      row.addEventListener('click', (e) => {
        if (e.target.closest('.need')) { close(); editSecret(null, { name: need, scope: 'global', note: 'Used by sandboxed agents' }); return; }
        close();
        launch(k);
      });
      list.appendChild(row);
    }
    $('.sbx-image', pop).textContent = st.imagePresent ? `Image ${st.image} is ready.` : `First start builds ${st.image} (a few minutes, shown in the terminal).`;
    $('#sbx-net', pop).addEventListener('change', (e) => setSandboxNetwork(e.target.checked));
  });
}

// Per-session choice of the vault secrets a sandbox gets. Pre-checked: what the agent needs to sign
// in plus project secrets marked "pass to sandboxes". Resolves to an array of names, or null (cancel).
const SANDBOX_NEEDS = { 'sandbox-claude': ['ANTHROPIC_API_KEY'], 'sandbox-codex': ['OPENAI_API_KEY'], 'sandbox-shell': [] };
function proPickSandboxSecrets(kind) {
  const items = PRO.vault.items || [];
  if (PRO.sandbox && PRO.sandbox.imagePresent === false) return Promise.resolve([]); // first run builds the image (no secrets)
  const byName = new Map();
  for (const i of items) { const cur = byName.get(i.name); if (!cur || i.scope === 'project') byName.set(i.name, i); }
  const needs = SANDBOX_NEEDS[kind] || [];
  const isDefault = (i) => needs.includes(i.name) || (i.scope === 'project' && i.sandbox);
  if (!byName.size) return Promise.resolve([]);
  const net = S.info?.sandboxNetwork !== false;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    modal(`<h3>Secrets for ${esc(AGENT_UI[kind]?.label || 'the sandbox')}</h3>
      <p class="muted small">Only the checked secrets are passed into this container (as environment variables of the agent, not visible in <code>docker inspect</code>). Network is <b>${net ? 'on' : 'off'}</b>${net ? ': the agent can send anything it has to any site' : ''}.</p>
      <div class="sbx-secrets"></div>
      <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn accent" data-a="ok">Start sandbox</button></div>`, (m, close) => {
      const list = $('.sbx-secrets', m);
      for (const i of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const lab = h('label', 'check');
        const cb = h('input');
        cb.type = 'checkbox'; cb.value = i.name; cb.checked = isDefault(i);
        lab.append(cb, h('span', 'mono', ` ${i.name}`), h('span', 'muted small', ` ${i.scope === 'project' ? 'project' : 'all projects'}${needs.includes(i.name) ? ' · needed to sign in' : ''}`));
        list.appendChild(lab);
      }
      m.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        const picked = [...m.querySelectorAll('.sbx-secrets input:checked')].map((x) => x.value);
        close();
        done(a === 'ok' ? picked : null);
      });
      m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); done(null); } });
      $('#modal-overlay').addEventListener('dismiss', () => done(null), { once: true });
    });
  });
}

// ======================================================================== hubs

function newHubWizard() {
  const templates = PRO.info?.hubTemplates || [];
  let parent = null;
  modal(`<h3>New hub</h3>
    <p>A folder for your posts, notes or code that you work on with agents. Meridian creates the structure, AGENTS.md / CLAUDE.md conventions and a git repository.</p>
    <label class="field"><span>Name</span><input id="hub-name" spellcheck="false" placeholder="my-hub"></label>
    <div class="field"><span>Location</span><div class="loc-row"><span id="hub-parent" class="muted">Not chosen</span><button class="btn small" data-a="pick">Choose…</button></div></div>
    <div class="field"><span>Template</span><div id="hub-templates" class="tpl-list"></div></div>
    <label class="check"><input type="checkbox" id="hub-git" checked> Initialize a git repository</label>
    <label class="check"><input type="checkbox" id="hub-skills" checked> Add a starter Claude Code skill (.claude/skills/)</label>
    <div class="modal-actions"><button class="btn" data-a="cancel">Cancel</button><button class="btn accent" data-a="create">Create hub</button></div>`, (m, close) => {
    m.classList.add('wide');
    const list = $('#hub-templates', m);
    templates.forEach((t, i) => {
      const lab = h('label', 'tpl');
      const r = h('input');
      r.type = 'radio'; r.name = 'tpl'; r.value = t.id; r.checked = i === 0;
      const txt = h('span', 'tpl-text');
      txt.append(h('b', '', t.label), h('span', 'muted small', t.description));
      lab.append(r, txt);
      list.appendChild(lab);
    });
    $('#hub-name', m).focus();
    m.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close();
      if (a === 'pick') {
        try { const p = await wb.hubPickParent(); if (p) { parent = p; $('#hub-parent', m).textContent = p; $('#hub-parent', m).classList.remove('muted'); } } catch (err) { toast(cleanErr(err)); }
      }
      if (a === 'create') {
        const name = $('#hub-name', m).value.trim();
        if (!name) { toast('Give the hub a name'); return; }
        if (!parent) { toast('Choose where to create it'); return; }
        const template = m.querySelector('input[name="tpl"]:checked')?.value;
        try {
          const res = await wb.hubCreate({ name, template, git: $('#hub-git', m).checked, skills: $('#hub-skills', m).checked });
          close();
          await setProject(res.project);
          await refreshInfo();
          openPanel('hub');
          const gitNote = res.git ? (res.committed ? 'git repository with a first commit' : 'git repository (first commit skipped — set git user.name/email)') : `no git (${res.gitReason || 'off'})`;
          notice('hub-created:' + res.project.root, `Hub “${res.project.name}” is ready: ${gitNote}. Keep it one click away?`, [
            { label: 'Pin to sidebar', accent: true, run: () => wb.toHost({ type: 'pin-hub', where: 'pinned' }) },
            { label: 'Add to Favorites', run: () => wb.toHost({ type: 'pin-hub', where: 'fav' }) },
          ]);
        } catch (err) { toast(cleanErr(err), 5000); }
      }
    });
  });
}

async function openAsHub() {
  const before = S.project?.root;
  await pickProject();
  if (S.project && S.project.root !== before) openPanel('hub');
}

async function refreshHub() {
  if (!S.project) { PRO.hub = null; return null; }
  const root = S.project.root;
  try { const info = await wb.hubInfo(); if (S.project?.root === root) PRO.hub = info; } catch { PRO.hub = null; }
  $('#btn-hub').classList.toggle('dot', !!PRO.hub?.isHub && PRO.activePanel !== 'hub');
  return PRO.hub;
}

async function revealLine(rel, line) {
  const tab = await openFile(rel, { focus: true });
  if (tab?.model && S.editor) { S.editor.revealLineInCenter(line); S.editor.setPosition({ lineNumber: line, column: 1 }); S.editor.focus(); }
}

function renderHubPanel(el) {
  let alive = true;
  const draw = () => {
    if (!alive) return;
    el.replaceChildren();
    const hub = PRO.hub;
    const head = h('div', 'panel-head');
    head.append(h('h2', '', S.project?.name || 'Hub'), btn('Pin to sidebar', '', () => wb.toHost({ type: 'pin-hub', where: 'pinned' }), 'Pin this workbench tab in the sidebar'));
    el.appendChild(head);
    if (!hub) { el.appendChild(h('div', 'empty muted', 'Loading…')); return; }
    if (!hub.isHub) {
      el.appendChild(h('p', 'muted small', 'This folder has no AGENTS.md or CLAUDE.md yet. Those files tell coding agents how to work here (where things go, naming, what not to touch).'));
      el.appendChild(btn('Create AGENTS.md + CLAUDE.md', 'accent', createConventions));
    } else el.appendChild(h('p', 'muted small', 'Agents read these conventions before working here. Click a heading to jump to it.'));
    for (const c of hub.conventions) {
      const sec = h('div', 'conv');
      const name = h('button', 'link conv-file', c.path);
      name.addEventListener('click', () => openFile(c.path, { focus: true }));
      sec.appendChild(name);
      for (const hd of c.headings) {
        if (hd.level === 1) continue;
        const row = h('button', `link conv-h l${hd.level}`, hd.text);
        row.addEventListener('click', () => revealLine(c.path, hd.line));
        sec.appendChild(row);
      }
      el.appendChild(sec);
    }
    if (hub.skills.length) {
      const s = h('div', 'section');
      s.appendChild(h('h3', '', 'Claude Code skills'));
      for (const sk of hub.skills) {
        const r = h('button', 'link file-link', sk);
        r.addEventListener('click', () => openFile(`.claude/skills/${sk}/SKILL.md`, { focus: true }));
        s.appendChild(r);
      }
      el.appendChild(s);
    }
    const rec = h('div', 'section');
    rec.appendChild(h('h3', '', 'Recent files'));
    for (const f of hub.recent) {
      const r = h('button', 'link file-link recent-file');
      r.append(h('span', 'fname', f.path), h('span', 'muted small', fmtTime(f.mtimeMs)));
      r.addEventListener('click', () => openFile(f.path, { focus: true }));
      rec.appendChild(r);
    }
    if (!hub.recent.length) rec.appendChild(h('div', 'empty muted small', 'No files yet.'));
    el.appendChild(rec);
    const go = h('div', 'section row-actions');
    go.append(btn('Start Claude Code here', 'accent', () => launch('claude')), btn('Refresh', '', async () => { await refreshHub(); draw(); }));
    el.appendChild(go);
  };
  draw();
  refreshHub().then(draw);
  $('#btn-hub').classList.remove('dot');
  const onSave = () => refreshHub().then(draw);
  bus.addEventListener('file-save', onSave);
  return () => { alive = false; bus.removeEventListener('file-save', onSave); };
}

async function createConventions() {
  const name = S.project?.name || 'Project';
  try {
    const agents = `# ${name} — instructions for agents\n\nDescribe what this folder is for and how an agent should work here.\n\n## Where things live\n\n- \n\n## Conventions\n\n- Keep the user's wording; don't invent facts.\n- Never delete files without asking.\n- Secrets come from environment variables Meridian injects from its vault — never write them into files.\n`;
    const st = await wb.stat('AGENTS.md');
    if (!st.exists) { await wb.create('AGENTS.md', 'file'); await wb.write('AGENTS.md', agents); }
    const st2 = await wb.stat('CLAUDE.md');
    if (!st2.exists) { await wb.create('CLAUDE.md', 'file'); await wb.write('CLAUDE.md', '# CLAUDE.md\n\nAll instructions live in [AGENTS.md](AGENTS.md).\n\n@AGENTS.md\n'); }
    await refreshHub();
    renderPanel();
    openFile('AGENTS.md', { focus: true });
  } catch (err) { toast(cleanErr(err)); }
}

// ======================================================================== customize panel + Safe Mode

async function customizeWithClaude() {
  try {
    if (!S.project || S.project.root !== PRO.info?.customRoot) {
      const p = await wb.customOpen();
      await setProject(p);
      if (S.project?.root !== p.root) return; // the user kept their unsaved files
    }
    openPanel('customize');
    if (PRO.custom?.safeMode) notice('custom-safe', 'Safe Mode is on, so changes won’t show up live. Turn it off to see them.', [{ label: 'Turn off Safe Mode', accent: true, run: () => setSafeMode(false) }]);
    const claude = S.info?.agents?.claude;
    if (!claude?.installed) { toast('Claude Code isn’t installed — install it, or edit the files here yourself', 5000); return; }
    const t = await launch('claude');
    if (t) t.xterm.writeln('\x1b[2mTell Claude what to change, e.g. “make the editor font 15px” or “add a Deploy button that runs npm run deploy”. Changes apply live.\x1b[0m');
  } catch (err) { toast(cleanErr(err), 5000); }
}

async function setSafeMode(on) {
  try { await wb.customSafeMode(on); } catch (err) { toast(cleanErr(err)); return; }
  try { localStorage.setItem('wb.bootCount', '0'); } catch {}
  PRO.pluginSig = null;
  await reloadCustom({ quiet: true });
  if (!on) toast('Safe Mode off — customizations loaded');
  // on: main broadcasts the change to every Workbench page, which then reloads (reloadForSafeMode).
}

// Tearing plugins down removes what they registered through the API, but not timers, listeners or
// patched globals they set up themselves. Safe Mode therefore reloads the page; terminals and agent
// sessions live in main and re-attach (same path as any page reload).
let safeReloading = false;
async function reloadForSafeMode() {
  if (safeReloading) return;
  safeReloading = true;
  try { await reloadForSafeModeInner(); } finally { safeReloading = false; }
}
async function reloadForSafeModeInner() {
  const ranPlugins = PRO.everLoadedPlugins || [...PRO.plugins.values()].some((p) => p.status !== 'off' && p.status !== 'pending');
  if (!ranPlugins) { toast('Safe Mode on — no plugins, user.css or settings.json'); return; }
  const dirty = (S.tabs || []).filter((t) => typeof isDirty === 'function' && isDirty(t));
  if (dirty.length && !(await confirmBox('Reload the Workbench to stop plugins?', `Safe Mode is on. Plugins that already ran may still have timers or listeners; a reload stops them (terminals keep running). Unsaved changes in ${dirty.length} file${dirty.length === 1 ? '' : 's'} will be lost.`, 'Reload now', true))) {
    toast('Safe Mode on. Reload the Workbench to fully stop plugins that already ran.', 5000);
    return;
  }
  location.reload();
  await new Promise(() => {}); // keep the guard up until the page goes away
}

// Plugins that changed (or are new) don't run until the user approves them in Meridian's own dialog.
async function approvePlugins() {
  try {
    const res = await wb.customApprovePlugins();
    if (res?.approved?.length) toast(`Approved ${res.approved.length} plugin${res.approved.length === 1 ? '' : 's'}`);
  } catch (err) { toast(cleanErr(err), 5000); }
}

function renderCustomStatus() {
  const el = $('#status-custom');
  const st = PRO.custom;
  if (!st) { el.hidden = true; return; }
  const all = [...PRO.plugins.values()];
  const active = all.filter((p) => p.status === 'active').length;
  const broken = all.filter((p) => p.status === 'error' || p.status === 'inactive').length;
  el.hidden = !st.safeMode && !all.length && !st.settingsError;
  el.className = 'status-chip link-chip' + (st.safeMode ? ' safe' : broken || st.settingsError ? ' bad' : '');
  el.innerHTML = `${icon(st.safeMode ? 'shield' : 'settings', 11)}<span></span>`;
  el.lastChild.textContent = st.safeMode ? 'Safe Mode' : `${active} plugin${active === 1 ? '' : 's'}${broken ? `, ${broken} failing` : ''}${st.settingsError ? ' · settings.json error' : ''}`;
  el.title = st.safeMode ? 'Customizations are off (Safe Mode). Click to manage.' : `Active plugins:\n${all.filter((p) => p.status === 'active').map((p) => `${p.name} (${p.file})`).join('\n') || 'none'}`;
}

function renderCustomizePanel(el) {
  const st = PRO.custom || {};
  const head = h('div', 'panel-head');
  head.append(h('h2', '', 'Customize'));
  el.appendChild(head);
  if (st.unavailable) { el.appendChild(h('p', 'warn-box', 'The customization folder is unavailable.')); return; }
  el.appendChild(h('p', 'muted small', 'Plugins, styles and settings for this Workbench live in one folder. Ask Claude to change them — every save applies live.'));
  const actions = h('div', 'row-actions');
  actions.append(btn('Customize with AI', 'accent', customizeWithClaude), btn('Open folder', '', async () => { try { await setProject(await wb.customOpen()); openPanel('customize'); } catch (err) { toast(cleanErr(err)); } }), btn(IS_MAC ? 'Finder' : 'Folder', '', () => wb.customReveal()));
  el.appendChild(actions);
  el.appendChild(h('div', 'path mono small', st.root || ''));

  // Safe Mode
  const safe = h('label', 'switch-row');
  const cb = h('input');
  cb.type = 'checkbox';
  cb.checked = !!st.safeMode;
  cb.addEventListener('change', () => setSafeMode(cb.checked));
  const txt = h('span');
  txt.append(h('b', '', 'Safe Mode'), h('span', 'muted small', ' — start without plugins, user.css and settings.json. Use it if a plugin breaks the Workbench.'));
  safe.append(cb, txt);
  el.appendChild(safe);

  // Plugins
  const pl = h('div', 'section');
  pl.appendChild(h('h3', '', 'Plugins'));
  if (!st.plugins?.length) pl.appendChild(h('div', 'empty muted small', 'No plugins yet. Ask Claude to add one, or copy examples/hello-button.js into plugins/.'));
  for (const p of st.plugins || []) {
    const rec = PRO.plugins.get(p.file);
    const off = (st.disabled || []).includes(p.file);
    const status = st.safeMode ? 'safe' : off ? 'off' : rec?.status || 'loading';
    const row = h('div', 'plugin-row');
    const toggle = h('input');
    toggle.type = 'checkbox';
    toggle.checked = !off;
    toggle.title = off ? 'Switched off — click to enable' : 'Enabled — click to switch off';
    toggle.addEventListener('change', () => wb.customTogglePlugin(p.file, toggle.checked).catch((err) => toast(cleanErr(err))));
    const info = h('div', 'plugin-info');
    const title = h('button', 'link', rec?.name && rec.name !== p.file.replace(/\.js$/, '') ? `${rec.name} (${p.file})` : p.file);
    title.addEventListener('click', async () => { if (S.project?.root !== st.root) { await setProject(await wb.customOpen()); openPanel('customize'); } openFile(`plugins/${p.file}`, { focus: true }); });
    info.appendChild(title);
    const label = { active: 'active', error: 'error', inactive: 'not registered', off: 'off', safe: 'Safe Mode', loading: 'loading', pending: 'needs approval' }[status];
    info.appendChild(h('span', `pstatus ${status}`, label));
    if (status === 'pending') info.appendChild(btn('Approve…', 'small', approvePlugins));
    if (rec?.error && !off && !st.safeMode) info.appendChild(h('div', 'perr small', rec.error));
    info.appendChild(h('div', 'muted small', `changed ${fmtTime(p.mtimeMs)} · ${p.size} bytes${p.approved ? ' · approved' : ''}`));
    row.append(toggle, info);
    pl.appendChild(row);
  }
  el.appendChild(pl);

  if (st.settingsError) el.appendChild(h('p', 'warn-box', `settings.json isn’t valid JSON (${st.settingsError}); using defaults.`));

  // History
  const hist = h('div', 'section');
  const hh = h('div', 'panel-head');
  hh.appendChild(h('h3', '', 'History'));
  const snaps = st.snapshots || [];
  if (snaps.length > 1) hh.appendChild(btn('Undo last change', '', () => restoreSnapshot(snaps[1])));
  hist.appendChild(hh);
  hist.appendChild(h('p', 'muted small', 'Every change to this folder is snapshotted. Restoring keeps a snapshot of the current state, so you can go back again.'));
  snaps.forEach((s, i) => {
    const row = h('div', 'snap-row');
    const txt = h('div');
    txt.append(h('span', '', fmtTime(s.at)), h('span', 'muted small', ` · ${i === 0 ? 'current' : s.reason.replace('-', ' ')} · ${s.files.length} file${s.files.length === 1 ? '' : 's'}`));
    txt.title = s.files.join('\n');
    row.appendChild(txt);
    if (i > 0) row.appendChild(btn('Restore', '', () => restoreSnapshot(s)));
    hist.appendChild(row);
  });
  el.appendChild(hist);
}

async function restoreSnapshot(s) {
  if (!(await confirmBox(`Restore the customizations from ${fmtTime(s.at)}?`, `user.css, settings.json, AGENTS.md and plugins/ go back to that state (${s.files.length} files). The current state is kept as a snapshot.`, 'Restore'))) return;
  try { await wb.customRestore(s.id); toast('Restored'); } catch (err) { toast(cleanErr(err), 5000); }
}

// ======================================================================== host commands + boot

function proHostCommand(msg) {
  if (msg.type === 'new-hub') newHubWizard();
  if (msg.type === 'customize') customizeWithClaude();
  if (msg.type === 'customize-panel') openPanel('customize');
  if (msg.type === 'safe-mode') setSafeMode(msg.on !== false);
  if (msg.type === 'secrets') openPanel('secrets');
}

async function proBoot() {
  // Crash guard: if the page went down twice in a row while plugins were loading, start in Safe Mode.
  let boots = 0;
  try { boots = Number(localStorage.getItem('wb.bootCount') || 0); localStorage.setItem('wb.bootCount', String(boots + 1)); } catch {}
  try { PRO.info = await wb.info(); } catch {}
  if (boots >= 2 && PRO.info && !PRO.info.safeMode) {
    await wb.customSafeMode(true).catch(() => {});
    setTimeout(() => notice('crash-safe', 'The Workbench didn’t finish starting twice in a row, so it started in Safe Mode (no plugins). Check the Customize panel.', [{ label: 'Open Customize', accent: true, run: () => openPanel('customize') }]), 500);
  }
  PRO.settings = sanitizeSettings(null);
  initSidePane();
  initProKeys();
  $('#new-hub').addEventListener('click', newHubWizard);
  $('#open-as-hub').addEventListener('click', openAsHub);
  $('#welcome-customize').addEventListener('click', customizeWithClaude);
  $('#status-custom').addEventListener('click', () => openPanel('customize'));
  $('#status-vault').addEventListener('click', () => openPanel('secrets'));
  wb.onCustomChange((p) => { if (p?.safeMode === true) reloadCustom({ quiet: true }).then(reloadForSafeMode); else reloadCustom(); });
  wb.onVaultChange(() => refreshVault());
  bus.addEventListener('info', (e) => { PRO.info = e.detail; });
  bus.addEventListener('editor-ready', () => applySettings(null));
  bus.addEventListener('project', () => { refreshVault(); scanSecrets(); refreshHub(); hideNotice(PRO.noticeKey?.startsWith('pasted:') ? PRO.noticeKey : null); });
  await reloadCustom({ quiet: true });
  refreshVault();
  refreshSandbox(false);
  // Started fine: reset the crash counter once the page has been up for a few seconds.
  setTimeout(() => { try { localStorage.setItem('wb.bootCount', '0'); } catch {} }, 4000);
}
