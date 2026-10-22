// Dev-only: renders a contact sheet of every icon in an icons.js file (plus the inline logo SVG) at
// 14px and 16px, light and dark, with names, and saves a PNG.
//   npx electron scripts/icon-sheet.js [path/to/icons.js] [out.png]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'renderer', 'icons.js'));
const out = path.resolve(process.argv[3] || 'icon-sheet.png');
const sandbox = {};
vm.runInNewContext(`${fs.readFileSync(src, 'utf8')}\nthis.ICON_PATHS = ICON_PATHS; this.icon = icon;`, sandbox);
const names = Object.keys(sandbox.ICON_PATHS);
const LOGO = '<svg width="16" height="16" viewBox="0 0 64 64"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="50" r="4" fill="currentColor"/></svg>';

const cell = (n) => `<div class="c"><div class="ics">${sandbox.icon(n, 14)}${sandbox.icon(n, 16)}<span class="t">Aa</span>${sandbox.icon(n, 24)}</div><div class="n">${n}</div></div>`;
const sheet = (cls) => `<div class="sheet ${cls}">${names.map(cell).join('')}<div class="c"><div class="ics">${LOGO}${LOGO.replace(/16/g, '24')}</div><div class="n">logo (inline)</div></div></div>`;
const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; font: 11px -apple-system, system-ui, sans-serif; }
  .sheet { display: grid; grid-template-columns: repeat(8, 1fr); gap: 1px; padding: 14px; }
  .light { background: #f4f4f7; color: #1d1d22; } .dark { background: #1d1d22; color: #ececf1; }
  .c { padding: 8px 6px; display: flex; flex-direction: column; align-items: center; gap: 5px; }
  .ics { display: flex; align-items: center; gap: 8px; height: 26px; }
  .t { font-size: 13px; line-height: 16px; } .n { opacity: 0.6; }
  .ics svg { display: block; }
</style>${sheet('light')}${sheet('dark')}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 400, show: false, webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const h = await win.webContents.executeJavaScript('document.body.scrollHeight');
  win.setContentSize(1100, h);
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
  console.log(out, names.length, 'icons');
  app.exit(0);
});
