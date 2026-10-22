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

  agentConfig: (cfg) => ipcRenderer.invoke('agent:config', cfg),
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentPause: (paused) => ipcRenderer.invoke('agent:pause', paused),
  onAgentRpc: (fn) => ipcRenderer.on('agent:rpc', (_e, req) => fn(req)),
  replyAgent: (payload) => ipcRenderer.send('agent:rpc-result', payload),
  onAgentActivity: (fn) => ipcRenderer.on('agent:activity', (_e, a) => fn(a)),

  aiHasKey: () => ipcRenderer.invoke('ai:has-key'),
  aiSetKey: (key) => ipcRenderer.invoke('ai:set-key', key),
  aiChat: (req) => ipcRenderer.send('ai:chat', req),
  aiStop: (sessionId) => ipcRenderer.send('ai:stop', sessionId),
  aiReset: (sessionId) => ipcRenderer.send('ai:reset', sessionId),
  onAiEvent: (fn) => ipcRenderer.on('ai:event', (_e, ev) => fn(ev)),

  fetchFavicon: (url, partition) => ipcRenderer.invoke('favicon:fetch', url, partition),
  aiPageText: (wcId) => ipcRenderer.invoke('ai:page-text', wcId),
  resetPermissions: () => ipcRenderer.invoke('permissions:reset'),

  promoteMini: (url) => ipcRenderer.send('mini:promote', url),

  // Mission Control + Arc Max-style AI features
  missionSnapshot: () => ipcRenderer.invoke('mission:snapshot'),
  missionDismiss: (id) => ipcRenderer.invoke('mission:dismiss', String(id)),
  missionClearHistory: () => ipcRenderer.invoke('mission:clear-history'),
  onMission: (fn) => ipcRenderer.on('mission:state', (_e, s) => fn(s)),
  onMissionToast: (fn) => ipcRenderer.on('mission:toast', (_e, t) => fn(t)),
  aiTidy: (tabs) => ipcRenderer.invoke('ai:tidy', tabs),
  onLinkPreview: (fn) => ipcRenderer.on('link-preview', (_e, p) => fn(p)),
  linkPreviewTest: (url) => ipcRenderer.invoke('ai:link-preview-test', String(url)),

  // Settings window, windows, onboarding
  snapshot: (snap) => ipcRenderer.send('ui:snapshot', snap),
  openSettings: (section) => ipcRenderer.send('settings:open', section),
  openWindow: (kind, url) => ipcRenderer.send('window:open', kind, url),
  arcPreview: () => ipcRenderer.invoke('import:arc-preview'),
  mcpDetect: () => ipcRenderer.invoke('mcp:detect'),
  mcpConnect: (cli) => ipcRenderer.invoke('mcp:connect', cli),
  platform: process.platform,
});
