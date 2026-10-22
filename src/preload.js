const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meridian', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (s) => ipcRenderer.invoke('state:save', s),
  saveStateSync: (s) => ipcRenderer.sendSync('state:save-sync', s),

  onCommand: (fn) => ipcRenderer.on('command', (_e, name, ...args) => fn(name, ...args)),
  onWebviewOpen: (fn) => ipcRenderer.on('webview:open', (_e, p) => fn(p)),
  onWebviewAction: (fn) => ipcRenderer.on('webview:action', (_e, p) => fn(p)),
  onWebviewEscape: (fn) => ipcRenderer.on('webview:escape', (_e, p) => fn(p)),
  onDownload: (fn) => ipcRenderer.on('download', (_e, p) => fn(p)),

  popupMenu: (items) => ipcRenderer.invoke('menu:popup', items),
  copy: (text) => ipcRenderer.send('clipboard:write', text),
  revealDownload: (p) => ipcRenderer.send('download:reveal', p),
  openDevTools: (id) => ipcRenderer.invoke('devtools:open', id),

  setAdblock: (on) => ipcRenderer.invoke('adblock:set', on),
  setExtensions: (paths) => ipcRenderer.invoke('extensions:set', paths),
  pickExtension: () => ipcRenderer.invoke('extensions:pick'),
  clearProfileData: (partition) => ipcRenderer.invoke('profile:clear-data', partition),

  arcAvailable: () => ipcRenderer.invoke('import:arc-available'),
  importArc: () => ipcRenderer.invoke('import:arc'),

  setDefaultBrowser: () => ipcRenderer.invoke('default-browser:set'),
  isDefaultBrowser: () => ipcRenderer.invoke('default-browser:is'),

  promoteMini: (url) => ipcRenderer.send('mini:promote', url),
  platform: process.platform,
});
