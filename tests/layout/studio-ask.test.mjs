// Studio's permission and question cards, laid out by a real Chromium (headless shell) at three
// widths and with long text: the card is as tall as what it holds (nothing clipped), its stripe is
// not a stray pseudo-element, and the feed shows it whole above the composer, never under it.
// Needs a Chromium headless shell: MERIDIAN_LAYOUT_CHROME, else Playwright's cached one; skips without.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.MERIDIAN_LAYOUT_CHROME) return process.env.MERIDIAN_LAYOUT_CHROME;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  try {
    for (const d of fs.readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(cache, d))) {
        const bin = path.join(cache, d, sub, 'chrome-headless-shell');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return '';
}

async function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-layout-'));
  const proc = spawn(findChrome(), ['--headless', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--allow-file-access-from-files', '--lang=ru', 'about:blank'], { stdio: 'ignore' });
  let port = '';
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch {}
  }
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result?.result?.value;
  };
  const close = async () => {
    try { ws.close(); } catch {}
    const gone = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([gone, sleep(3000)]);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  };
  return { send, evaluate, close };
}

const LONG = 'Мне нужно сделать две картинки, чтобы я сравнил их сайд бай сайд: старый логотип и новый, в одном размере, на одном фоне, с подписями под каждой и без лишних отступов вокруг. '.repeat(3);

// A session with a long chat before the card, then the card: a permission (Write) or a question.
const SETUP = (kind) => `(async () => {
  ST.on = true; ST.lang = 'ru'; ST.view = 'studio'; ST.current = 't1';
  stBuild(); ST.el.hidden = false;
  const k = stTask(S.terms[0]);
  const lines = [];
  const at = '2026-11-27T10:00:00Z';
  for (let i = 0; i < 6; i++) {
    lines.push(JSON.stringify({ type: 'user', uuid: 'u' + i, sessionId: 's1', timestamp: at, message: { role: 'user', content: ${JSON.stringify(LONG)} } }));
    lines.push(JSON.stringify({ type: 'assistant', uuid: 'a' + i, sessionId: 's1', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(LONG)} }] } }));
  }
  const q = { questions: [{ question: ${JSON.stringify(LONG.slice(0, 160))} + '?', header: 'Картинки', multiSelect: false, options: [
    { label: 'Старый и новый логотип рядом, в одном размере', description: ${JSON.stringify(LONG.slice(0, 120))} },
    { label: 'Две версии баннера' }, { label: 'Что-то другое — опишу сам' }] }] };
  if (${JSON.stringify(kind)} === 'question') lines.push(JSON.stringify({ type: 'assistant', uuid: 'aq', sessionId: 's1', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: q }] } }));
  StudioTranscript.feed(k.model, lines.join('\\n') + '\\n', { root: S.project.path });
  k.loaded = true;
  ST.mission.t1 = { status: 'needs', asks: [${JSON.stringify(kind)} === 'question'
    ? { id: 'ask-q', tool: 'AskUserQuestion', summary: JSON.stringify(q).slice(0, 2000), answerable: false }
    : { id: 'ask-w', tool: 'Write', summary: '/Users/d/Brand/drafts/' + 'compare-old-and-new-logo-side-by-side-'.repeat(4) + 'final.html', answerable: true, canAlways: true }] };
  stRender();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (const n of document.querySelectorAll('.st-in')) n.classList.remove('st-in');
  stRenderFeed(S.terms[0]);
  await new Promise((r) => setTimeout(r, 50));
})()`;

const MEASURE = `(() => {
  const card = document.querySelector('#st-feed .st-ask');
  const feed = document.querySelector('#st-feed').getBoundingClientRect();
  const comp = document.querySelector('.st-composer').getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const out = [];
  for (const d of card.querySelectorAll('*')) {
    const b = d.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    if (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1) out.push(d.className || d.tagName);
  }
  return { top: r.top, bottom: r.bottom, height: r.height, width: r.width, scrollH: card.scrollHeight, clientH: card.clientHeight,
    feedTop: feed.top, feedBottom: feed.bottom, compTop: comp.top, outside: out, before: getComputedStyle(card, '::before').content,
    shadow: getComputedStyle(card).boxShadow, opts: card.querySelectorAll('.st-opt').length, title: card.querySelector('.st-ask-q').textContent.trim(),
    btns: [...card.querySelectorAll('.st-ask-btns button')].map((b) => b.textContent.trim()) };
})()`;

const chrome = findChrome();
for (const kind of ['permission', 'question']) {
  for (const [w, h] of [[760, 640], [1100, 760], [1600, 900]]) {
    test(`${kind} card at ${w}px: whole, unclipped, above the composer`, { skip: !chrome && 'no Chromium headless shell' }, async () => {
      const page = await open();
      try {
        await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await page.send('Page.enable');
        await page.send('Page.navigate', { url: pathToFileURL(path.join(here, 'studio-ask.html')).href });
        for (let i = 0; i < 50 && (await page.evaluate('typeof stBuild === "function" && document.readyState')) !== 'complete'; i++) await sleep(100);
        await page.evaluate(SETUP(kind));
        const m = await page.evaluate(MEASURE);
        if (process.env.MERIDIAN_LAYOUT_SHOTS) {
          const shot = await page.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(path.join(process.env.MERIDIAN_LAYOUT_SHOTS, `${kind}-${w}.png`), Buffer.from(shot.result.data, 'base64'));
        }
        assert.ok(m.height > 70, `card is a strip: ${m.height}px`);
        assert.ok(m.scrollH <= m.clientH + 1, `card clips its content: ${m.scrollH} > ${m.clientH}`);
        assert.deepEqual(m.outside, [], 'parts of the card stick out of it');
        assert.equal(m.before, 'none', 'the stripe is a pseudo-element again');
        assert.match(m.shadow, /inset/, 'the stripe is an inset shadow');
        assert.ok(m.top >= m.feedTop - 1, `card starts above the feed: ${m.top} < ${m.feedTop}`);
        assert.ok(m.bottom <= m.compTop + 1, `card goes under the composer: ${m.bottom} > ${m.compTop}`);
        assert.ok(m.bottom <= m.feedBottom + 1, 'card is cut by the feed');
        if (kind === 'question') {
          assert.equal(m.opts, 3, 'the options are buttons');
          assert.match(m.title, /^Мне нужно сделать две картинки/);
        } else {
          assert.match(m.title, /^Разрешить: создать файл compare-old/);
          assert.deepEqual(m.btns, ['Разрешить', 'Только в этот раз', 'Нет']);
        }
      } finally { await page.close(); }
    });
  }
}

// A new task in Studio's own folder: no folder talk, the composer with suggestions, one small link to
// the person's own files; a task's menu («Показать в Finder») opens whole on screen.
test('new task: no folder question, the own-files link, the task menu on screen', { skip: !chrome && 'no Chromium headless shell' }, async () => {
  const page = await open();
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: pathToFileURL(path.join(here, 'studio-ask.html')).href });
    for (let i = 0; i < 50 && (await page.evaluate('typeof stBuild === "function" && document.readyState')) !== 'complete'; i++) await sleep(100);
    const m = await page.evaluate(`(async () => {
      ST.on = true; ST.lang = 'ru'; ST.view = 'studio'; ST.current = ''; ST.info = { home: S.project.path };
      S.project.root = S.project.path;
      stBuild(); ST.el.hidden = false;
      stRender();
      const own = document.querySelector('#st-own');
      const text = document.querySelector('#studio').innerText;
      ST.menuFor = 't1';
      stRender();
      const menu = document.querySelector('.st-tmenu').getBoundingClientRect();
      return { own: own.hidden ? '' : own.innerText.trim(), chips: document.querySelectorAll('#st-chips .st-chip').length, folderTalk: /Выберите папку|Pick a folder/.test(text),
        menu: document.querySelector('.st-tmenu').innerText.trim(), inView: menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight && menu.height > 20,
        sub: document.querySelector('#st-sub').textContent };
    })()`);
    assert.equal(m.own, 'Работать с моими файлами…');
    assert.ok(m.chips > 0);
    assert.equal(m.folderTalk, false);
    assert.equal(m.menu, 'Показать в Finder');
    assert.equal(m.inView, true);
    assert.equal(m.sub, 'Claude');
  } finally { await page.close(); }
});
