// Preload for the Settings window (meridian://app/settings.html). Only settings:* channels; main checks
// every call comes from this window and validates what it changes.
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('meridianSettings', {
  get: call('settings:get'),
  set: call('settings:set'),
  action: call('settings:action'),
  record: call('settings:record'),
  isDefaultBrowser: call('settings:is-default'),
  setDefaultBrowser: call('settings:set-default'),
  arcAvailable: call('settings:arc-available'),
  arcLoginsAvailable: call('settings:arc-logins-available'),
  importArcLogins: call('settings:import-arc-logins'),
  pickExtension: call('settings:pick-extension'),
  resetPermissions: call('settings:reset-permissions'),
  clearProfileData: call('settings:clear-profile-data'),
  clearBrowsingData: call('settings:clear-browsing-data'),
  aiHasKey: call('settings:ai-has-key'),
  aiSetKey: call('settings:ai-set-key'),
  agentStatus: call('settings:agent-status'),
  mcpDetect: call('settings:mcp-detect'),
  agentsList: call('settings:agents-list'),
  agentsSetup: call('settings:agents-setup'),
  mcpConnect: call('settings:mcp-connect'),
  routeTest: call('settings:route-test'),
  copy: call('settings:copy'),
  openUrl: call('settings:open-url'),
  onState: (fn) => ipcRenderer.on('settings:state', (_e, s) => fn(s)),
  onSection: (fn) => ipcRenderer.on('settings:section', (_e, s) => fn(s)),
  onRecorded: (fn) => ipcRenderer.on('settings:recorded', (_e, r) => fn(r)),
  platform: process.platform,
});
