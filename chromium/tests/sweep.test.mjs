// A sweep for crashes of the kind users found by hand: Chromium features that reach for parts of
// Chrome's own window Meridian's hasn't got. Every item of the page's context menu, right-clicked
// for real on a page, a link, a picture, selected text, a text field, a video and a PDF, and every
// browser command Chromium has (chrome_command_ids.h), run one after another: Meridian must stay up
// after each. Items that would open the Mac's own windows (save and print dialogs, Share, Speech,
// Look Up…) or leave the browser are skipped, so the test changes nothing outside its profile.
//
// MERIDIAN_SWEEP=menu|commands runs one half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const NAMES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'command_ids.json'), 'utf8'));
const name = (id) => NAMES[id] || `#${id}`;
const alive = (b) => b.proc.exitCode === null && b.proc.signalCode === null;
// The browser's log (MERIDIAN_LOG), so a crash says where it was.
const LOG = path.join(os.tmpdir(), `meridian-sweep-${process.pid}.log`);
process.env.MERIDIAN_LOG = LOG;
// An answer within `ms`, else 'timeout' (a command that left a dialog waiting, say).
const within = (promise, ms = 5000) => Promise.race([promise, new Promise((r) => setTimeout(() => r('timeout'), ms))]);
// What ran last, for a run that stops (MERIDIAN_SWEEP_PROGRESS=<file>).
const progress = (line) => { if (process.env.MERIDIAN_SWEEP_PROGRESS) fs.appendFileSync(process.env.MERIDIAN_SWEEP_PROGRESS, line + '\n'); };
const lastFatal = () => {
  try { return (fs.readFileSync(LOG, 'utf8').match(/FATAL:[^\n]*/g) || []).pop() || 'no FATAL line'; } catch { return ''; }
};

// Never run: the Mac's own windows (they'd wait for a person) or apps, quitting or restarting,
// the person's system or accounts, and what a test can't undo outside its profile.
const SKIP = /SAVE|PRINT|SPEECH|SPEAK|LOOK_UP|LOOKUP|EMOJI|SHARE|SERVICES|SPELL|WRITING_DIRECTION|OPEN_WITH|OPENLINKWITH|EXIT|QUIT|RESTART|RELAUNCH|CLOSE_WINDOW|CLOSE_PROFILE|NEW_INCOGNITO|UNINSTALL|INSTALL|DEFAULT_BROWSER|SIGN_?IN|SIGN_?OUT|SYNC|IMPORT|EXPORT|UPGRADE|EMAIL|SEND_TAB|SEND_TO|OPEN_FILE|OPEN_IN|DOWNLOAD|FILE_SYSTEM|DEV_TOOLS|INSPECT|TASK_MANAGER|FULLSCREEN|PRESENTATION|MINIMIZE|ZOOM_WINDOW|MAXIMIZE|HIDE_APP|HIDE_OTHERS|SHOW_ALL|TOGGLE_SPOKEN|MEDIA_ROUTER|ROUTE_MEDIA|CAST|SCREENSHOT|SCREEN|GLIC|LENS_OVERLAY_.*EXIT|MOVE_TAB_TO_NEW_WINDOW|NEW_WINDOW|WEB_APP|PWA|CREATE_SHORTCUT|DEBUG|CRASH|DUMP|PROFILING|CHROME_LABS|ABOUT|HELP|FEEDBACK|REPORT|PASSWORD|AUTOFILL|PAYMENT|ADDRESS|MANAGE|EXTENSION|ACCOUNT|AVATAR|PROFILE|SWITCH_INPUT|SELECT_ALL_AND_|NAME_WINDOW|COMPOSE|SHOW_READING_MODE_SIDE_PANEL_SPEECH/;

function pdf() {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 24 Tf 72 700 Td (A page of a PDF) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAALUlEQVR4nO3NMQkAAAwDsPo3vckolED+5JKKzioWi8VisVgsFovFYrFYLB6NH6r1OhvW1o1iAAAAAElFTkSuQmCC', 'base64');

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (req.url === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(pdf()); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Sweep</title><body style="margin:0;font:16px sans-serif">
      <p id=text style="position:absolute;left:20px;top:20px;margin:0">Some words of an article to select</p>
      <a id=link href="/other" style="position:absolute;left:20px;top:70px">A link to another page</a>
      <img id=pic src="/pic.png" width=120 height=120 style="position:absolute;left:20px;top:120px">
      <input id=field value="typed text" style="position:absolute;left:20px;top:270px;width:200px;height:24px">
      <video id=v width=200 height=120 muted style="position:absolute;left:300px;top:120px"></video>
      <script>
        const c = document.createElement('canvas'); c.width = 200; c.height = 120; const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); g.fillRect(0, 0, 200, 120); }, 50);
        const v = document.getElementById('v'); v.srcObject = c.captureStream(20); v.play();
      </script>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function rightClick(page, x, y) {
  for (const [type, button] of [['mouseMoved', 'none'], ['mousePressed', 'right'], ['mouseReleased', 'right']]) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 });
  }
}

const PLACES = [
  // [what, path, x, y, before the click]
  ['the page', '/article', 600, 400, null],
  ['a link', '/article', 60, 78, null],
  ['a picture', '/article', 80, 180, null],
  ['selected text', '/article', 80, 28, `(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('text')); getSelection().removeAllRanges(); getSelection().addRange(r); return true; })()`],
  ['a text field', '/article', 100, 282, `(() => { const f = document.getElementById('field'); f.focus(); f.select(); return true; })()`],
  ['a video', '/article', 400, 180, null],
  ['a PDF', '/doc.pdf', 300, 200, null],
];

test('every context menu item, on a page, a link, a picture, selected text, a field, a video and a PDF: Meridian stays up', { skip: process.env.MERIDIAN_SWEEP === 'commands' }, async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-sweep-'));
  const file = path.join(dir, 'pick');
  fs.writeFileSync(file, '0');
  const ran = [];
  const crashes = [];
  const gone = [];
  let b;
  try {
    for (const [what, p, x, y, before] of PLACES) {
      const url = base + p;
      b = await launch([url], { args: [`--meridian-test-context-menu-command=@${file}`] });
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
      let page = await b.page(url);
      const prepare = async () => {
        if (p === '/article') await page.waitFor(`document.getElementById('pic').complete && document.getElementById('v').readyState >= 2`, 15000).catch(() => {});
        else await sleep(2500);
        if (before) await page.eval(before);
      };
      await prepare();
      // The menu's items here.
      fs.writeFileSync(file, 'list');
      fs.rmSync(file + '.ids', { force: true });
      await rightClick(page, x, y);
      for (let i = 0; i < 30 && !fs.existsSync(file + '.ids'); i++) await sleep(100);
      const ids = fs.existsSync(file + '.ids') ? fs.readFileSync(file + '.ids', 'utf8').split('\n').filter(Boolean).map(Number) : [];
      assert.ok(ids.length > 0, `the menu on ${what} has items`);
      for (const id of ids) {
        if (SKIP.test(name(id))) continue;
        fs.writeFileSync(file, String(id));
        progress(`${what}: ${name(id)}`);
        await rightClick(page, x, y).catch(() => {});
        await sleep(700);
        ran.push(`${what}: ${name(id)}`);
        if (!alive(b) || await b.eval('1 + 1').catch(() => 0) !== 2) {
          if (!alive(b)) crashes.push(`${what}: ${name(id)} (${id}): ${lastFatal()}`);
          await b.close();
          b = await launch([url], { args: [`--meridian-test-context-menu-command=@${file}`] });
          await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
          page = await b.page(url);
          await prepare();
          continue;
        }
        // Back to the page, for the next item.
        fs.writeFileSync(file, '0');
        await b.eval(`(() => { const t = [...${T}.tabs_.values()].find((t) => t.url.startsWith(${JSON.stringify(url)})); if (t && !t.isActive) ${T}.handler_.activateTab?.(t.id); return true; })()`).catch(() => {});
        const row = `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url.startsWith(${JSON.stringify(url)}))`;
        if (await b.eval(`!!${row} && !${row}.tab.isActive`).catch(() => false)) await b.click(`${row}.shadowRoot.querySelector('.row')`).catch(() => {});
        // A page that navigated away (Back, Reload, a link opened here) comes back.
        if (!(await within(page.eval('location.href').catch(() => ''))).startsWith?.(url)) {
          page.close();
          await within(b.eval(`${T}.openUrl(${JSON.stringify(url)})`).catch(() => {}));
          page = await b.page(url, 5000).catch(() => null);
          if (!page) {
            // The page is gone for good (its process ended, say): a new start.
            gone.push(`${what}: ${name(id)}`);
            await b.close();
            b = await launch([url], { args: [`--meridian-test-context-menu-command=@${file}`] });
            await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
            page = await b.page(url);
          }
          await prepare();
        } else if (before) {
          await page.eval(before).catch(() => {});
        }
      }
      page.close();
      await b.close();
      b = null;
    }
    console.log(`ran ${ran.length} items; the page went away after: ${gone.join(', ') || 'none'}`);
    assert.deepEqual(crashes, [], `crashes:\n${crashes.join('\n')}`);
  } finally {
    await b?.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every browser command Chromium has, run on a page: Meridian stays up', { skip: process.env.MERIDIAN_SWEEP === 'menu' }, async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/article`;
  let ids = Object.keys(NAMES).map(Number).filter((id) => id < 50000 && !SKIP.test(name(id)));
  // MERIDIAN_SWEEP_FROM=<IDC name>: go on from there.
  if (process.env.MERIDIAN_SWEEP_FROM) ids = ids.slice(Math.max(0, ids.findIndex((id) => name(id) === process.env.MERIDIAN_SWEEP_FROM)));
  const ran = [];
  const crashes = [];
  let b;
  const start = async () => {
    b = await launch([url], { args: ['--meridian-test-keys'] });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
  };
  try {
    await start();
    const hung = [];
    for (const id of ids) {
      progress(name(id));
      await within(b.eval(`${T}.handler_.testCommand(${id})`).catch(() => {}));
      await sleep(300);
      ran.push(name(id));
      if (alive(b) && await within(b.eval('1 + 1').catch(() => 0)) === 'timeout') {
        hung.push(name(id));
        await b.close(); await start();
        continue;
      }
      if (!alive(b)) { crashes.push(`${name(id)} (${id}): ${lastFatal()}`); await b.close(); await start(); continue; }
      // A command that closed the window (the last tab, say): Meridian runs on without one; a new
      // start for the next.
      if (await b.eval('1 + 1').catch(() => 0) !== 2) {
        if (!alive(b)) crashes.push(`${name(id)} (${id}): ${lastFatal()}`);
        await b.close(); await start();
        continue;
      }
      // Overlays a command opened (Settings, Mission Control, the command bar…) close again.
      await within(b.eval(`(() => { for (const id of ['settings', 'mission', 'commandBar', 'updateSheet', 'ask', 'chat']) { const e = app.$[id]; if (e && e.open) { if (e.hide) e.hide(); else e.open = false; } } return true; })()`).catch(() => {}));
      // Too many tabs or windows: start again.
      if ((await b.eval(`${T}.tabs_.size`).catch(() => 0)) > 12) { await b.close(); await start(); }
    }
    console.log(`ran ${ran.length} commands; hung: ${hung.join(', ') || 'none'}`);
    assert.deepEqual(crashes, [], `crashes:\n${crashes.join('\n')}`);
  } finally {
    await b?.close();
    server.close();
  }
});
