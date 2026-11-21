// The Workbench's terminal as a place to look at what agents send: an image path printed in it opens
// large, wherever the file is; the images of a session sit as thumbnails above it, without resizing
// the program; a right click has Copy, Paste, Select All, Clear and the link's own actions. A program
// that takes the mouse keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === 'win32';
const T = 'app.$.tabstrip';
// A real 2×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8DAwMDAAAAMCAEB5rYvBAAAAABJRU5ErkJggg==', 'base64');

async function workbench(project, extra = []) {
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, ...extra] });
  await b.waitFor(`typeof app !== 'undefined' && !!${T}?.state_`);
  await b.eval(`${T}.openUrl('chrome://workbench')`);
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor(`S.project?.root === ${JSON.stringify(project)}`);
  await wb.eval(`launch('shell').then((t) => !!t)`);
  await wb.waitFor('S.terms.length === 1 && !!S.activeTerm');
  await wb.eval(`S.activeTerm.xterm.focus()`);
  await sleep(500);
  return { b, wb };
}
const run = (wb, cmd) => wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, ${JSON.stringify(cmd + '\r')}); return true; })()`);
const say = (wb, text) => run(wb, WIN ? `Write-Output '${text}'` : `printf '%s\\n' '${text}'`);
const printed = (wb, needle, n = 2) => wb.waitFor(`(() => { const b = S.activeTerm.xterm.buffer.active; let all = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); all += (l?.isWrapped ? '' : '\\n') + (l?.translateToString(true) || ''); } return all.split(${JSON.stringify(needle)}).length > ${n}; })()`, 10000);
async function cell(wb, needle) {
  // The last place it is printed: the command's output, not the command.
  return wb.eval(`(() => {
    const t = S.activeTerm, b = t.xterm.buffer.active, r = t.el.querySelector('.xterm-screen').getBoundingClientRect();
    const c = t.xterm._core._renderService.dimensions.css.cell;
    for (let y = t.xterm.rows - 1; y >= 0; y--) {
      const x = (b.getLine(b.viewportY + y)?.translateToString() || '').lastIndexOf(${JSON.stringify(needle)});
      if (x >= 0) return { x: r.left + (x + 1.5) * c.width, y: r.top + (y + 0.5) * c.height };
    }
    return null;
  })()`);
}
async function mouse(wb, at, button = 'left', modifiers = 0) {
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x - 2, y: at.y, modifiers });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, modifiers });
  await sleep(350);  // xterm finds the link under the pointer
  for (const type of ['mousePressed', 'mouseReleased']) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button, clickCount: 1, modifiers });
  }
}
const box = (wb, expr) => wb.waitFor(`(() => { const e = ${expr}; if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
const clickEl = async (wb, expr) => mouse(wb, await box(wb, expr));
const item = (label) => `[...document.querySelectorAll('.wb-menu-item')].find((e) => e.textContent === ${JSON.stringify(label)})`;
const key = async (wb, k, code, vk) => {
  await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await wb.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};
const stubClipboard = (wb, text = '') => wb.eval(`(() => { window.__copied = []; navigator.clipboard.writeText = (s) => { window.__copied.push(s); return Promise.resolve(); }; navigator.clipboard.readText = () => Promise.resolve(${JSON.stringify(text)}); return true; })()`);
function folders() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mwa-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mwo-')));
  return { project, outside, clean: () => { for (const d of [project, outside]) fs.rmSync(d, { recursive: true, force: true }); } };
}

test('an image path printed in the terminal opens large, also outside the project', async () => {
  const f = folders();
  const pic = path.join(f.outside, 'agent-shot.png');
  fs.writeFileSync(pic, PNG);
  const { b, wb } = await workbench(f.project);
  try {
    await stubClipboard(wb);
    await say(wb, pic);
    await printed(wb, 'agent-shot.png');
    await sleep(300);
    await mouse(wb, await cell(wb, 'agent-shot.png'));
    await wb.waitFor(`!document.getElementById('img-viewer')?.hidden && document.querySelector('#img-viewer img')?.naturalWidth === 2`, 8000);
    assert.equal(await wb.eval(`document.querySelector('#img-viewer .iv-name').textContent`), 'agent-shot.png');

    const w = () => wb.eval(`document.querySelector('#img-viewer img').getBoundingClientRect().width`);
    const before = await w();
    await clickEl(wb, `document.getElementById('iv-zoom-in')`);
    await wb.waitFor(`document.querySelector('#img-viewer img').getBoundingClientRect().width > ${before}`);
    await clickEl(wb, `document.getElementById('iv-copy-path')`);
    await wb.waitFor(`window.__copied.length === 1`);
    assert.equal(await wb.eval(`window.__copied[0]`), pic);
    assert.equal(await wb.eval(`!!document.getElementById('iv-copy-image') && !!document.getElementById('iv-reveal')`), true);

    await key(wb, 'Escape', 'Escape', 27);
    await wb.waitFor(`document.getElementById('img-viewer').hidden`);
    assert.equal(await wb.eval(`document.activeElement === S.activeTerm.xterm.textarea`), true, 'typing goes back to the terminal');
  } finally { wb.close(); await b.close(); f.clean(); }
});

test('image paths with spaces in their folders open whole, quoted or not', async () => {
  const f = folders();
  const dir = path.join(f.outside, 'Application Support', 'my shots');
  fs.mkdirSync(dir, { recursive: true });
  const pic = path.join(dir, 'agent shot.png');
  fs.writeFileSync(pic, PNG);
  const { b, wb } = await workbench(f.project);
  try {
    for (const printedAs of [pic, `"${pic}"`]) {
      await run(wb, WIN ? 'Clear-Host' : 'clear');
      await sleep(300);
      await say(wb, `saved ${printedAs} done`);
      await printed(wb, 'shot.png');
      await sleep(300);
      await mouse(wb, await cell(wb, 'shot.png'));
      await wb.waitFor(`!document.getElementById('img-viewer')?.hidden && document.querySelector('#img-viewer .iv-name')?.textContent === 'agent shot.png'`, 8000);
      await key(wb, 'Escape', 'Escape', 27);
      await wb.waitFor(`document.getElementById('img-viewer').hidden`);
    }
  } finally { wb.close(); await b.close(); f.clean(); }
});

test('thumbnails of a session sit above the terminal, latest first, and never resize it', async () => {
  const f = folders();
  const one = path.join(f.outside, 'first.png');
  const two = path.join(f.project, 'second.png');
  const three = path.join(f.outside, 'third.png');
  for (const p of [one, two, three]) fs.writeFileSync(p, PNG);
  const { b, wb } = await workbench(f.project);
  const size = `[S.activeTerm.xterm.cols, S.activeTerm.xterm.rows].join()`;
  const names = `[...document.querySelectorAll('#term-strip .term-thumb')].map((e) => e.dataset.path.split(/[\\\\/]/).pop()).join()`;
  try {
    const was = await wb.eval(size);
    await say(wb, one);
    await wb.waitFor(`${names} === 'first.png'`, 8000);
    await say(wb, 'second.png');
    await wb.waitFor(`${names} === 'second.png,first.png'`, 8000);
    await sleep(300);
    assert.equal(await wb.eval(size), was, 'the program keeps its size');

    await clickEl(wb, `document.querySelector('#term-strip .term-thumb[data-path$="first.png"]')`);
    await wb.waitFor(`!document.getElementById('img-viewer').hidden && document.querySelector('#img-viewer .iv-name').textContent === 'first.png'`, 8000);
    await key(wb, 'Escape', 'Escape', 27);
    await wb.waitFor(`document.getElementById('img-viewer').hidden`);

    // Closed, it stays closed until a new image comes.
    await clickEl(wb, `document.getElementById('term-strip-close')`);
    await wb.waitFor(`document.getElementById('term-strip').hidden`);
    await say(wb, one);
    await sleep(900);
    assert.equal(await wb.eval(`document.getElementById('term-strip').hidden`), true);
    await say(wb, three);
    await wb.waitFor(`!document.getElementById('term-strip').hidden && ${names}.startsWith('third.png')`, 8000);
    assert.equal(await wb.eval(size), was);
  } finally { wb.close(); await b.close(); f.clean(); }
});

test('only real images are read: a text file named .png, a link to a secret and an SVG are refused', async () => {
  const f = folders();
  const secret = path.join(f.outside, 'id_key');
  fs.writeFileSync(secret, 'PRIVATE KEY\n');
  fs.writeFileSync(path.join(f.outside, 'fake.png'), 'not an image at all\n');
  fs.writeFileSync(path.join(f.outside, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const good = path.join(f.outside, 'good.png');
  fs.writeFileSync(good, PNG);
  if (!WIN) fs.symlinkSync(secret, path.join(f.outside, 'link.png'));
  const { b, wb } = await workbench(f.project);
  const read = (p) => wb.eval(`window.workbench.termImage(${JSON.stringify(p)}).then((r) => r.data ? 'read' : 'empty', (e) => 'refused')`);
  try {
    assert.equal(await read(good), 'read');
    assert.equal(await read(path.join(f.outside, 'fake.png')), 'refused');
    assert.equal(await read(path.join(f.outside, 'pic.svg')), 'refused');
    assert.equal(await read(secret), 'refused');
    assert.equal(await read(f.outside), 'refused');
    if (!WIN) assert.equal(await read(path.join(f.outside, 'link.png')), 'refused');
  } finally { wb.close(); await b.close(); f.clean(); }
});

test('a right click: Copy joins wrapped lines, Paste, Select All, Clear; a link has Open and Copy Link', async () => {
  const f = folders();
  const { b, wb } = await workbench(f.project);
  const long = 'W'.repeat(40) + 'z'.repeat(400);
  try {
    await stubClipboard(wb, 'pasted-by-menu');
    await run(wb, WIN ? 'Clear-Host' : 'clear');
    await sleep(300);
    await say(wb, long);
    await printed(wb, 'zzzz', 1);
    await sleep(300);

    await mouse(wb, await cell(wb, 'zzzz'), 'right');
    await wb.waitFor(`!!${item('Select All')}`);
    await clickEl(wb, item('Select All'));
    await wb.waitFor(`S.activeTerm.xterm.hasSelection()`);
    await mouse(wb, await cell(wb, 'zzzz'), 'right');
    await wb.waitFor(`!!${item('Copy')} && !${item('Copy')}.disabled`);
    await clickEl(wb, item('Copy'));
    await wb.waitFor(`window.__copied.length === 1`);
    assert.ok((await wb.eval(`window.__copied[0]`)).includes(long), 'the long line in one piece');

    await wb.eval(`S.activeTerm.xterm.clearSelection()`);
    await mouse(wb, await cell(wb, 'zzzz'), 'right');
    await wb.waitFor(`!!${item('Paste')}`);
    await clickEl(wb, item('Paste'));
    await printed(wb, 'pasted-by-menu', 1);
    await run(wb, '');

    await say(wb, 'https://example.com/docs');
    await printed(wb, 'example.com/docs');
    await sleep(300);
    await mouse(wb, await cell(wb, 'example.com/docs'), 'right');
    await wb.waitFor(`!!${item('Copy Link')} && !!${item('Open')}`);
    await clickEl(wb, item('Copy Link'));
    await wb.waitFor(`window.__copied.includes('https://example.com/docs')`);

    await mouse(wb, await cell(wb, 'example.com/docs'), 'right');
    await wb.waitFor(`!!${item('Clear')}`);
    await clickEl(wb, item('Clear'));
    await wb.waitFor(`S.activeTerm.xterm.buffer.active.baseY === 0`);
  } finally { wb.close(); await b.close(); f.clean(); }
});

test('Copy Last Answer takes the agent’s whole answer from its session, not the wrapped screen', async () => {
  const f = folders();
  const transcript = path.join(f.outside, 'session.jsonl');
  const answer = `First paragraph ${'long '.repeat(120)}\n\n- a list item\n\`\`\`\ncode\n\`\`\``;
  fs.writeFileSync(transcript, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'An older answer' }] } },
    { type: 'user', message: { content: 'next' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: answer }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"assistant","mess');
  const { b, wb } = await workbench(f.project, [`--meridian-test-transcript=${transcript}`]);
  try {
    await stubClipboard(wb);
    await say(wb, 'marker-for-click');
    await printed(wb, 'marker-for-click');
    await sleep(300);
    await mouse(wb, await cell(wb, 'marker-for-click'), 'right');
    await wb.waitFor(`!!${item('Copy Last Answer')}`);
    await clickEl(wb, item('Copy Last Answer'));
    await wb.waitFor(`window.__copied.length === 1`);
    assert.equal(await wb.eval(`window.__copied[0]`), answer);
  } finally { wb.close(); await b.close(); f.clean(); }
});

test('a program that takes the mouse keeps the right click; ⇧ right click is the menu', { skip: WIN ? 'uses a POSIX raw terminal' : false }, async () => {
  const f = folders();
  const script = path.join(f.outside, 'mouse.js');
  fs.writeFileSync(script, `process.stdin.setRawMode(true);process.stdout.write('\\x1b[?1000h\\x1b[?1006hREADY\\n');process.stdin.on('data',(d)=>{if(d[0]===113){process.stdout.write('\\x1b[?1006l\\x1b[?1000l');process.exit(0)}process.stdout.write('GOT '+JSON.stringify(d.toString('latin1'))+'\\n')});`);
  const { b, wb } = await workbench(f.project);
  try {
    await run(wb, `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`);
    await printed(wb, 'READY', 1);
    await wb.waitFor(`S.activeTerm.xterm.modes.mouseTrackingMode !== 'none'`);
    const at = await cell(wb, 'READY');
    await mouse(wb, at, 'right');
    await printed(wb, 'GOT', 1);
    assert.equal(await wb.eval(`!!document.querySelector('.wb-menu')`), false, 'no menu over the program');
    await mouse(wb, at, 'right', 8);
    await wb.waitFor(`!!${item('Select All')}`);
    await key(wb, 'Escape', 'Escape', 27);
    await run(wb, 'q');
  } finally { wb.close(); await b.close(); f.clean(); }
});
