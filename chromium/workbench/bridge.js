// The Workbench page's `window.workbench` (what the Electron build's preload
// gave it), over chrome.send to Meridian's WorkbenchHandler (C++). The handler
// checks every argument again; this file only shapes the calls.
(() => {
  'use strict';
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;

  // ResolveJavascriptCallback / FireWebUIListener call these.
  window.cr = window.cr || {};
  window.cr.webUIResponse = (id, ok, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(value);
    else p.reject(new Error(typeof value === 'string' ? value : 'Failed'));
  };
  window.cr.webUIListenerCallback = (event, ...args) => {
    for (const fn of listeners.get(event) || []) {
      try { fn(...args); } catch (err) { console.error(err); }
    }
  };

  const invoke = (method, ...args) => new Promise((resolve, reject) => {
    const id = `wb${++seq}`;
    pending.set(id, { resolve, reject });
    chrome.send('invoke', [id, method, args]);
  });
  const send = (method, ...args) => chrome.send('send', [method, args]);
  const listen = (channel) => (fn) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel)?.delete(fn);
  };

  // A context menu drawn in the page (no privileges involved): resolves with
  // the chosen item's id, or null.
  let lastPointer = { x: 40, y: 40 };
  addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  addEventListener('contextmenu', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  function menu(items) {
    return new Promise((resolve) => {
      const shield = document.createElement('div');
      shield.className = 'wb-menu-shield';
      const box = document.createElement('div');
      box.className = 'wb-menu';
      box.setAttribute('role', 'menu');
      let done = false;
      const finish = (id) => {
        if (done) return;
        done = true;
        shield.remove();
        removeEventListener('keydown', onKey, true);
        resolve(id);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } };
      for (const it of (Array.isArray(items) ? items : []).slice(0, 40)) {
        if (it?.type === 'separator') {
          box.append(Object.assign(document.createElement('div'), { className: 'wb-menu-sep' }));
          continue;
        }
        const b = document.createElement('button');
        b.className = 'wb-menu-item';
        b.setAttribute('role', 'menuitem');
        b.textContent = String(it?.label || '').slice(0, 100);
        b.disabled = it?.enabled === false;
        b.addEventListener('click', () => finish(String(it?.id || '')));
        box.append(b);
      }
      shield.addEventListener('pointerdown', (e) => { if (e.target === shield) finish(null); });
      shield.append(box);
      document.body.append(shield);
      addEventListener('keydown', onKey, true);
      const r = box.getBoundingClientRect();
      box.style.left = `${Math.max(4, Math.min(lastPointer.x, innerWidth - r.width - 4))}px`;
      box.style.top = `${Math.max(4, Math.min(lastPointer.y, innerHeight - r.height - 4))}px`;
    });
  }
  const style = document.createElement('style');
  style.textContent = `
    .wb-menu-shield { position: fixed; inset: 0; z-index: 10000; }
    .wb-menu { position: fixed; min-width: 180px; padding: 4px; border-radius: 9px;
      background: var(--panel, Canvas); color: var(--text, CanvasText);
      box-shadow: 0 10px 30px rgba(0,0,0,.28), 0 0 0 .5px rgba(127,127,127,.35); font: 13px system-ui; }
    .wb-menu-item { display: block; width: 100%; padding: 5px 10px; border: 0; border-radius: 6px;
      background: none; color: inherit; font: inherit; text-align: left; }
    .wb-menu-item:hover:not(:disabled) { background: rgba(127,127,127,.18); }
    .wb-menu-item:disabled { opacity: .45; }
    .wb-menu-sep { height: 1px; margin: 4px 6px; background: rgba(127,127,127,.3); }`;
  document.documentElement.append(style);

  const str = (v) => String(v ?? '');
  window.workbench = {
    platform: 'darwin',
    info: () => invoke('info'),

    pickProject: () => invoke('pickProject'),
    openProject: (p) => invoke('openProject', str(p)),
    closeProject: () => invoke('closeProject'),
    forgetRecent: (p) => invoke('forgetRecent', str(p)),
    setPreviewUrl: (url) => invoke('setPreviewUrl', str(url)),

    list: (rel, opts) => invoke('list', str(rel), { showHidden: !!opts?.showHidden }),
    read: (rel) => invoke('read', str(rel)),
    stat: (rel) => invoke('stat', str(rel)),
    write: (rel, content) => invoke('write', str(rel), str(content)),
    create: (rel, kind) => invoke('create', str(rel), kind === 'dir' ? 'dir' : 'file'),
    rename: (from, to) => invoke('rename', str(from), str(to)),
    remove: (rel) => invoke('remove', str(rel)),
    reveal: (rel) => invoke('reveal', str(rel)),
    onFsChange: listen('wb:fs-change'),

    ptyCreate: (opts) => invoke('ptyCreate', {
      kind: str(opts?.kind || 'shell'), cols: Number(opts?.cols) || 80, rows: Number(opts?.rows) || 24,
      secrets: Array.isArray(opts?.secrets) ? opts.secrets.slice(0, 200).map(String) : undefined,
    }),
    ptyList: () => invoke('ptyList'),
    ptyKill: (id) => invoke('ptyKill', str(id)),
    ptyWrite: (id, data) => send('ptyWrite', str(id), str(data)),
    ptyResize: (id, cols, rows) => send('ptyResize', str(id), Math.round(Number(cols)) || 80, Math.round(Number(rows)) || 24),
    onPtyData: listen('wb:pty-data'),
    onPtyExit: listen('wb:pty-exit'),

    focusZone: () => {},
    menu,

    customState: () => invoke('customState'),
    customSafeMode: (on) => invoke('customSafeMode', !!on),
    customTogglePlugin: (file, enabled) => invoke('customTogglePlugin', str(file), !!enabled),
    customRestore: (id) => invoke('customRestore', str(id)),
    customOpen: () => invoke('customOpen'),
    customApprovePlugins: () => invoke('customApprovePlugins'),
    customReveal: () => invoke('customReveal'),
    onCustomChange: listen('wb:custom-change'),

    vaultList: () => invoke('vaultList'),
    vaultSet: (item) => invoke('vaultSet', {
      id: item?.id ? str(item.id) : undefined, name: str(item?.name), scope: item?.scope === 'project' ? 'project' : 'global',
      note: str(item?.note), value: typeof item?.value === 'string' ? item.value : undefined, sandbox: item?.sandbox === true,
    }),
    vaultReveal: (id) => invoke('vaultReveal', str(id)),
    vaultDelete: (id) => invoke('vaultDelete', str(id)),
    secretScan: () => invoke('secretScan'),
    secretMigrate: (rel) => invoke('secretMigrate', str(rel)),
    onVaultChange: listen('wb:vault-change'),

    sandboxStatus: (fresh) => invoke('sandboxStatus', !!fresh),
    sandboxNetwork: (on) => invoke('sandboxNetwork', !!on),

    hubPickParent: () => invoke('hubPickParent'),
    hubCreate: (opts) => invoke('hubCreate', { name: str(opts?.name), template: str(opts?.template), git: opts?.git !== false, skills: opts?.skills !== false }),
    hubInfo: () => invoke('hubInfo'),

    toHost: (msg) => send('toHost', JSON.parse(JSON.stringify(msg || {}))),
    onHostCommand: listen('wb:command'),
  };
})();
