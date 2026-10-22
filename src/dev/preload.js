// Preload for the internal Workbench page ONLY (main sets it in will-attach-webview; nothing else gets it).
// Exposes the workbench API and nothing else. Main re-checks the sender on every call.

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('workbench', {
  platform: process.platform,
  info: () => ipcRenderer.invoke('wb:info'),

  pickProject: () => ipcRenderer.invoke('wb:pick-project'),
  openProject: (p) => ipcRenderer.invoke('wb:open-project', String(p)),
  closeProject: () => ipcRenderer.invoke('wb:close-project'),
  forgetRecent: (p) => ipcRenderer.invoke('wb:forget-recent', String(p)),
  setPreviewUrl: (url) => ipcRenderer.invoke('wb:set-preview-url', String(url)),

  list: (rel, opts) => ipcRenderer.invoke('wb:list', String(rel || ''), { showHidden: !!opts?.showHidden }),
  read: (rel) => ipcRenderer.invoke('wb:read', String(rel)),
  stat: (rel) => ipcRenderer.invoke('wb:stat', String(rel)),
  write: (rel, content) => ipcRenderer.invoke('wb:write', String(rel), String(content)),
  create: (rel, kind) => ipcRenderer.invoke('wb:create', String(rel), kind === 'dir' ? 'dir' : 'file'),
  rename: (from, to) => ipcRenderer.invoke('wb:rename', String(from), String(to)),
  remove: (rel) => ipcRenderer.invoke('wb:delete', String(rel)),
  reveal: (rel) => ipcRenderer.invoke('wb:reveal', String(rel || '')),
  onFsChange: listen('wb:fs-change'),

  ptyCreate: (opts) => ipcRenderer.invoke('wb:pty-create', { kind: String(opts?.kind || 'shell'), cols: Number(opts?.cols) || 80, rows: Number(opts?.rows) || 24 }),
  ptyList: () => ipcRenderer.invoke('wb:pty-list'),
  ptyKill: (id) => ipcRenderer.invoke('wb:pty-kill', String(id)),
  ptyWrite: (id, data) => ipcRenderer.send('wb:pty-write', String(id), String(data)),
  ptyResize: (id, cols, rows) => ipcRenderer.send('wb:pty-resize', String(id), Number(cols), Number(rows)),
  onPtyData: listen('wb:pty-data'),
  onPtyExit: listen('wb:pty-exit'),

  focusZone: (zone) => ipcRenderer.send('wb:focus-zone', String(zone)),
  menu: (items) => ipcRenderer.invoke('wb:menu', JSON.parse(JSON.stringify(items || []))),

  // To/from the Meridian window that hosts this page (no main-process privileges involved):
  // open a preview in split view, open a link as a browser tab, report the project name.
  toHost: (msg) => ipcRenderer.sendToHost('wb:host', JSON.parse(JSON.stringify(msg || {}))),
  onHostCommand: listen('wb:command'),
});
