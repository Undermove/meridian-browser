// Test-only main-process preload, injected with NODE_OPTIONS=--require (dev Electron only; the
// packaged app has the NODE_OPTIONS fuse off). It keeps Meridian test windows from stealing the
// user's keyboard focus: show() becomes showInactive() and focus() is a no-op, so whatever the
// user is typing keeps going to their own app instead of into the test run.
// It also stops Chromium from throttling the (possibly covered) unfocused window, so timers and
// animation frames keep running while the user works in other windows.

const electron = require('electron');
const { app, BrowserWindow } = electron;

if (process.env.MERIDIAN_E2E_NO_FOCUS === '1' && BrowserWindow) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  const proto = BrowserWindow.prototype;
  proto.show = function show() { if (!this.isVisible()) this.showInactive(); };
  proto.focus = function focus() {};
  proto.moveTop = function moveTop() {};
  app.focus = () => {};
  if (app.dock) app.on('ready', () => { try { app.dock.hide(); } catch {} });
}
