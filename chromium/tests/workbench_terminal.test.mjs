// The Workbench's terminal as in Warp or iTerm, for an agent like Claude Code: ⇧↩ is a new line,
// web addresses and project files printed in it open on a click, files dropped on it are typed as
// their paths, and a trackpad scrolls a program that takes the mouse at a steady rate (it crawled,
// then jumped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// On Windows the Workbench's shell is PowerShell: node runs with its call operator, and the Unix
// tools used here (cat -v, printf) are a small node script or echo there.
const WIN = process.platform === 'win32';
const NODE = WIN ? `& ${JSON.stringify(process.execPath)}` : JSON.stringify(process.execPath);
const T = 'app.$.tabstrip';
const TEXT = `(() => { const b = S.activeTerm.xterm.buffer.active; return Array.from({ length: b.length }, (_, i) => { const l = b.getLine(i); return (l?.isWrapped ? '' : '\\n') + (l?.translateToString(true) || ''); }).join(''); })()`;

async function workbench(project, urls = ['about:blank']) {
  const b = await launch(urls, { args: [`--meridian-test-project=${project}`] });
  await b.waitFor(`typeof app !== 'undefined' && !!${T}?.state_`);
  await b.eval(`${T}.openUrl('chrome://workbench')`);
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor(`S.project?.root === ${JSON.stringify(project)}`);
  await wb.eval(`launch('shell').then((t) => !!t)`);
  await wb.waitFor('S.terms.length === 1 && !!S.activeTerm');
  await wb.eval(`S.activeTerm.xterm.focus()`);
  return { b, wb };
}
const run = (wb, cmd) => wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, ${JSON.stringify(cmd + '\r')}); return true; })()`);
// Where `needle` is on the terminal's screen (a little into it), once the layout has settled.
async function cell(wb, needle) {
  let at = null;
  for (let i = 0; i < 30; i++) {
    const now = await where(wb, needle);
    if (now && JSON.stringify(now) === JSON.stringify(at)) return now;
    at = now;
    await sleep(150);
  }
  return at;
}
async function where(wb, needle) {
  return wb.eval(`(() => {
    const t = S.activeTerm, b = t.xterm.buffer.active, r = t.el.querySelector('.xterm-screen').getBoundingClientRect();
    const c = t.xterm._core._renderService.dimensions.css.cell;
    for (let y = 0; y < t.xterm.rows; y++) {
      const x = (b.getLine(b.viewportY + y)?.translateToString() || '').indexOf(${JSON.stringify(needle)});
      if (x >= 0) return { x: r.left + (x + 2.5) * c.width, y: r.top + (y + 0.5) * c.height };
    }
    return null;
  })()`);
}
async function click(wb, at) {
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 3, y: at.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await sleep(400);  // xterm finds the link under the pointer
  for (const type of ['mousePressed', 'mouseReleased']) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
}

test('Workbench terminal: ⇧↩ is a new line for the program, ↩ is Enter', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wbt-')));
  const { b, wb } = await workbench(project);
  try {
    if (WIN) {
      // cat -v: ESC as ^[, Enter as a new line.
      fs.writeFileSync(path.join(project, 'catv.js'), String.raw`process.stdin.setRawMode(true);
process.stdin.on('data', (d) => { for (const c of d.toString()) process.stdout.write(c === '\x1b' ? '^[' : c === '\r' ? '\r\n' : c); });
process.stdout.write('READY\r\n');
`);
      await run(wb, `${NODE} catv.js`);
      // node starts slower than cat: the keys are its once it says so, not PowerShell's.
      await wb.waitFor(`${TEXT}.includes('\\nREADY')`, 10000);
    } else {
      await run(wb, 'cat -v');
    }
    await sleep(500);
    const key = (type, modifiers) => wb.cdp.send('Input.dispatchKeyEvent', { type, modifiers, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    for (const ch of 'ab') await wb.cdp.send('Input.insertText', { text: ch });
    await key('keyDown', 8); await key('keyUp', 8);  // ⇧↩
    await wb.cdp.send('Input.insertText', { text: 'c' });
    await key('keyDown', 0); await key('keyUp', 0);  // ↩
    // The whole line, not just its start: on Windows "c" and Enter can still be on their way.
    await wb.waitFor(`/\\nab\\^\\[\\nc\\n/.test(${TEXT})`, 5000, TEXT).catch(() => {});
    const text = await wb.eval(TEXT);
    // "ab" ESC, then a new line (⇧↩); "c", then Enter.
    assert.match(text, /\nab\^\[\nc\n/, `⇧↩ sent ESC ↩, ↩ a plain Enter: ${JSON.stringify(text.slice(-300))}`);
  } finally { wb.close(); await b.close(); fs.rmSync(project, { recursive: true, force: true }); }
});

test('Workbench terminal: a web address opens in a tab; a project file at its line in the editor', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wbt-')));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), 'one\ntwo\nthree\nfour\n');
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Docs page</title>'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/docs?a=1`;
  const { b, wb } = await workbench(project);
  try {
    await run(wb, WIN ? `clear; echo 'see ${url}. and src/app.ts:3 too'` : `clear; printf 'see ${url}. and src/app.ts:3 too\\n'`);
    await wb.waitFor(`${TEXT}.includes('src/app.ts:3 too')`, 5000);
    await click(wb, await cell(wb, 'http://127.0.0.1'));
    await b.waitFor(`[...${T}.tabs_.values()].some((t) => t.title === 'Docs page')`, 8000);
    assert.equal(await b.eval(`[...${T}.tabs_.values()].find((t) => t.title === 'Docs page').url`), url, 'the address without the full stop');

    // Back in the Workbench (a click on its row): a file named in the terminal opens at its line.
    await b.click(`[...app.$.tabstrip.shadowRoot.querySelectorAll('meridian-tab-row')].find((r) => r.tab.url.startsWith('chrome://workbench')).shadowRoot.querySelector('.row')`);
    await wb.waitFor('document.visibilityState === "visible"');
    // One click, though it also brings the focus back to the terminal (it lost that click).
    await click(wb, await cell(wb, 'src/app.ts:3'));
    await wb.waitFor(`S.activeTab?.path === 'src/app.ts' && S.editor?.getPosition()?.lineNumber === 3`, 10000, `[S.activeTab?.path, S.editor?.getPosition()?.lineNumber]`);
  } finally { wb.close(); await b.close(); s.close(); fs.rmSync(project, { recursive: true, force: true }); }
});

test('Workbench terminal: a file dropped on it is typed as its path, quoted for the shell', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wbt-')));
  const pics = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wbt-pics-')));
  const file = path.join(pics, 'my shot.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const { b, wb } = await workbench(project);
  try {
    const at = await wb.eval(`(() => { const r = S.activeTerm.el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const data = { items: [], files: [file], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) await wb.cdp.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
    await wb.waitFor(`${TEXT}.includes('shot.png')`, 8000, TEXT);
    const typed = (await wb.eval(TEXT)).split('\n').reverse().find((l) => l.includes('shot.png'));
    // Quoted for the shell: a backslash before a space on the Mac, double quotes on Windows.
    const m = WIN ? /"([^"]*shot\.png)"/.exec(typed) : /(\/\S*(?:\\ \S*)*shot\.png)/.exec(typed);
    assert.ok(m, `a path was typed: ${typed}`);
    const p = WIN ? m[1] : m[1].replace(/\\(.)/g, '$1');
    assert.equal(path.basename(p), 'my shot.png');
    assert.deepEqual(fs.readFileSync(p), fs.readFileSync(file), 'the path is the file (or its copy)');
  } finally { wb.close(); await b.close(); fs.rmSync(project, { recursive: true, force: true }); fs.rmSync(pics, { recursive: true, force: true }); }
});

// Not on Windows: there the console (ConPTY) keeps a program's mouse mode (\e[?1000h) to itself
// unless the program reads VT input, which node's raw mode doesn't; the terminal never sees it.
test('Workbench terminal: a program that takes the mouse scrolls as far for small trackpad moves as for one big one', { skip: WIN && 'ConPTY keeps node\'s mouse mode' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wbt-')));
  // A full-screen program with the mouse on (SGR), counting the wheel's lines.
  fs.writeFileSync(path.join(project, 'wheel.js'), `
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h');
process.stdin.setRawMode(true);
let n = 0;
process.stdin.on('data', (d) => {
  for (const m of d.toString().matchAll(/\\x1b\\[<(\\d+);\\d+;\\d+M/g)) if (m[1] === '65') n++;
  if (d.includes('q')) { process.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l'); console.log('WHEEL=' + n); process.exit(0); }
  process.stdout.write('\\x1b[H\\x1b[2Klines ' + n);
});
`);
  const { b, wb } = await workbench(project);
  try {
    const count = async (moves) => {
      await run(wb, `${NODE} wheel.js`);
      await wb.waitFor(`S.activeTerm.xterm.modes.mouseTrackingMode !== 'none'`, 8000, TEXT);
      const at = await wb.eval(`(() => { const r = S.activeTerm.el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (const deltaY of moves) {
        await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY });
        await sleep(15);
      }
      await sleep(300);
      await wb.cdp.send('Input.insertText', { text: 'q' });
      await wb.waitFor(`/WHEEL=\\d+\\s*$/.test(${TEXT}.trim().split('\\n').filter((l) => l.includes('WHEEL=')).pop() || '')`, 8000, TEXT);
      const last = (await wb.eval(TEXT)).split('\n').filter((l) => l.includes('WHEEL=')).pop();
      await run(wb, 'clear');
      return Number(/WHEEL=(\d+)/.exec(last)[1]);
    };
    const lineHeight = await wb.eval(`S.activeTerm.el.querySelector('.xterm-screen').getBoundingClientRect().height / S.activeTerm.xterm.rows`);
    const slow = await count(Array(40).fill(Math.round(lineHeight / 4)));  // 10 lines' worth in small moves
    const fast = await count([Math.round(lineHeight * 10)]);                // the same in one move
    assert.ok(Math.abs(slow - 10) <= 1, `small moves: ${slow} lines for 10 lines' worth`);
    assert.ok(Math.abs(fast - 10) <= 1, `one big move: ${fast} lines for 10 lines' worth`);
  } finally { wb.close(); await b.close(); fs.rmSync(project, { recursive: true, force: true }); }
});
