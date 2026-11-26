// Screenshots of the new features from the real Meridian Beta app (headless: the Mac's screen is
// locked at night and draws no frames for windows). A throwaway profile; nothing real is touched.
//   node shots.mjs "<Meridian Beta.app>/Contents/MacOS/Meridian" <out-dir> [only]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { start, sleep } from './cdp.mjs';

const APP = process.argv[2];
const OUT = process.argv[3];
const ONLY = process.argv[4] || '';
fs.mkdirSync(OUT, { recursive: true });
const want = (n) => !ONLY || ONLY.split(',').includes(n);

const DEMO = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Зерно — кофейня</title>
<style>
:root{--brand:#5b3fa8;--ink:#1f1a2e;--paper:#f6eee3}
body{margin:0;font:16px/1.5 -apple-system,Helvetica,sans-serif;background:var(--paper);color:var(--ink)}
header{display:flex;justify-content:space-between;align-items:center;padding:18px 48px;background:#fff}
header b{font-size:22px;color:var(--brand)} nav a{margin-left:22px;color:var(--ink);text-decoration:none}
.hero{display:grid;grid-template-columns:1.2fr 1fr;gap:40px;padding:64px 48px;align-items:center}
h1{font-size:52px;line-height:1.05;margin:0 0 16px} p.lead{font-size:19px;color:#5a536b;max-width:520px}
.btn{display:inline-block;padding:14px 26px;border-radius:24px;background:var(--brand);color:#fff;text-decoration:none;font-weight:600}
.btn.ghost{background:transparent;color:#b9b2c6;border:1px solid #ddd;margin-left:10px}
.card{background:#fff;border-radius:20px;padding:28px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:0 48px 64px}
.price{color:var(--brand);font-weight:700;font-size:20px}
</style></head><body>
<header><b>Зерно</b><nav><a href="#">Меню</a><a href="#">Кофейни</a><a href="#">Доставка</a></nav></header>
<section class="hero"><div><h1>Кофе, который<br>обжарили вчера</h1><p class="lead">Свежая обжарка каждый день, доставка за 30 минут по городу.</p>
<a id="btn" class="btn" href="#">Выбрать зёрна</a><a class="btn ghost" href="#">Подробнее</a></div>
<div class="card"><h3>Эфиопия Иргачеффе</h3><p>Цитрус, жасмин, бергамот.</p><div class="price">890 ₽</div></div></section>
<section class="grid"><div class="card"><h3>Колумбия</h3><p>Карамель, орех.</p><div class="price">790 ₽</div></div>
<div class="card"><h3>Кения</h3><p>Смородина, грейпфрут.</p><div class="price">950 ₽</div></div>
<div class="card"><h3>Бразилия</h3><p>Шоколад, какао.</p><div class="price">690 ₽</div></div></section>
</body></html>`;

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(DEMO); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}/`;

// A stand-in Claude Code: says it is ready and waits (nothing reaches a real AI).
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "Claude Code (stand-in) — ready"\nwhile true; do sleep 1; done\n', { mode: 0o755 });
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-studio-')));
fs.mkdirSync(path.join(project, 'Brand'));
fs.writeFileSync(path.join(project, 'brief.md'), '# Бриф\nЛендинг кофейни «Зерно».\n');
fs.writeFileSync(path.join(project, 'Brand', 'colors.css'), ':root { --brand: #5b3fa8; }\n');

const results = [];
const step = async (name, fn) => {
  if (!want(name)) return;
  try { await fn(); results.push(`ok ${name}`); } catch (e) { results.push(`FAIL ${name}: ${String(e.message || e).slice(0, 300)}`); }
};
const shot = (page, name, clip) => page.shot(path.join(OUT, name), clip);
const click = async (page, sel) => {
  const r = await page.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
};
const key = (page, k, code, modifiers, vk) => page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, modifiers, windowsVirtualKeyCode: vk }).then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers, windowsVirtualKeyCode: vk }));

const b = await start(APP, [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--lang=ru']);
try {
  const blank = await b.attach((u) => u === 'about:blank');
  await blank.send('Page.navigate', { url: 'chrome://workbench' });
  const wb = await b.attach((u) => u.startsWith('chrome://workbench'));
  await wb.waitFor(`!!S.project || (document.querySelector('#welcome') && !document.querySelector('#welcome').hidden) || !!document.querySelector('#st-persona')`, 20000);

  await step('persona', async () => {
    await wb.waitFor(`document.querySelectorAll('#st-persona .pc').length === 4`, 20000);
    await sleep(2500);
    await shot(wb, 'persona-picker.png');
    await click(wb, '#st-persona .pc[data-id="designer"]');
    await sleep(800);
    await shot(wb, 'persona-picker-hover.png');
    await click(wb, '#st-persona .btn.pri');
    await wb.waitFor(`!document.querySelector('#st-persona')`);
    if (!(await wb.eval('!!S.project'))) { await wb.eval(`document.querySelector('#open-folder')?.click(), true`); }
    await wb.waitFor('!!S.project', 15000);
  });

  await step('studio', async () => {
    await wb.waitFor(`document.querySelector('#studio') && !document.querySelector('#studio').hidden`, 15000);
    await sleep(1500);
    await shot(wb, 'studio.png');
  });

  await step('point', async () => {
    await wb.eval(`(() => { window.__pts = []; window.workbench.onHostCommand((m) => { if (m?.type === 'studio-point') window.__pts.push(m); }); return true; })()`);
    await wb.eval(`(() => { window.workbench.toHost({ type: 'studio-site', url: ${JSON.stringify(SITE)} }); return true; })()`);
    const site = await b.attach((u) => u.startsWith(SITE));
    await site.waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn')`);
    await wb.waitFor(`window.workbench.studioPoint('site').then((s) => s.open)`, 15000);
    await wb.eval(`window.workbench.studioPoint('start', { lang: 'ru', colors: [] })`);
    await sleep(600);
    const r = await site.waitFor(`(() => { const r = document.querySelector('#btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await site.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
    await sleep(700);
    await shot(site, 'point-and-say-hover.png');
    for (const type of ['mousePressed', 'mouseReleased']) await site.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await wb.waitFor(`window.__pts.flatMap((m) => m.events).find((e) => e.type === 'select')`, 10000);
    await sleep(1200);
    await shot(site, 'point-and-say-picked.png');
    await shot(wb, 'point-and-say-studio.png');
    await wb.eval(`window.workbench.studioPoint('stop')`);
  });

  await step('chats', async () => {
    await wb.eval(`(() => { const btn = document.querySelector('.st-switch button[data-view="workbench"]'); btn?.click(); return !!btn; })()`);
    await wb.waitFor(`!!document.querySelector('#view-chats')`, 15000);
    await wb.eval(`launch('claude').then(() => true)`);
    await sleep(1500);
    await wb.eval(`launch('claude', { name: 'Лендинг: hero' }).then(() => true)`);
    await sleep(1500);
    await wb.eval(`document.querySelector('#view-chats').click(), true`);
    await sleep(1500);
    await shot(wb, 'chats-list.png');
  });

  await step('toolkit', async () => {
    await blank.send('Target.createTarget', { url: SITE + '?tk' });
    const page = await b.attach((u) => u.startsWith(SITE + '?tk'));
    await page.waitFor(`document.readyState === 'complete'`);
    await sleep(800);
    await key(page, 'X', 'KeyX', 4 | 8, 88);
    await page.waitFor(`!!document.querySelector('meridian-toolkit')`, 10000);
    await sleep(800);
    await shot(page, 'toolkit-dock.png');
    for (const [k, code, vk, name] of [['c', 'KeyC', 67, 'toolkit-contrast.png'], ['b', 'KeyB', 66, 'toolkit-brand-check.png'], ['g', 'KeyG', 71, 'toolkit-site-system.png'], ['t', 'KeyT', 84, 'toolkit-stress-text.png']]) {
      await key(page, k, code, 0, vk);
      await sleep(1500);
      await shot(page, name);
      await key(page, 'Escape', 'Escape', 0, 27);
      await sleep(300);
      if (!(await page.eval(`!!document.querySelector('meridian-toolkit')`))) { await key(page, 'X', 'KeyX', 4 | 8, 88); await sleep(500); }
    }
    await key(page, 'l', 'KeyL', 0, 76);
    const r = await page.eval(`(() => { const r = document.querySelector('#btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none' });
    await sleep(900);
    await shot(page, 'toolkit-lens.png');
    await key(page, 'Escape', 'Escape', 0, 27);
  });
} finally {
  console.log(results.join('\n'));
  await b.stop();
  server.close();
  for (const d of [bin, project]) fs.rmSync(d, { recursive: true, force: true });
  process.exit(0);
}
