// What Hide cookie banners costs a page: node cookie_perf.mjs <cookie list file> [runs]
// (not a test; MERIDIAN_APP for another build; the list is the real EasyList Cookie List, downloaded once by hand). Local pages only:
// a 5,000-element news page, a page with 30 iframes (and one with 30 of other sites), a SPA adding 2,000 nodes over 5 s. For each,
// with the setting off and on: navigation to load, first contentful paint, style recalc time and
// script time (CDP Performance.getMetrics), and the renderer's memory (no spare renderer, so the
// tab's is the one that's new).
// Prints medians as a Markdown table.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { launch } from './harness.mjs';

const LIST = process.argv[2];
const RUNS = Number(process.argv[3] || 5);
if (!LIST) { console.error('usage: node cookie_perf.mjs <cookie list> [runs]'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const words = 'market policy city team report season energy health school river music science'.split(' ');
const para = (i) => `<p class="body-text p-${i % 7}">${Array.from({ length: 12 }, (_, k) => words[(i + k) % words.length]).join(' ')}</p>`;
function news() {
  // ≈5,000 elements: header, nav, 200 article cards of ~24 elements each, a footer.
  let cards = '';
  for (let i = 0; i < 200; i++) {
    cards += `<article class="card story-${i % 9}" data-id="${i}"><header class="card-head"><h2 class="title"><a href="#a${i}">Story ${i}</a></h2>
      <div class="meta"><span class="author">Author ${i % 13}</span><time>${i} min ago</time><span class="tag">${words[i % words.length]}</span></div></header>
      <figure class="thumb"><div class="img" style="height:40px;background:#ddd"></div><figcaption>Caption ${i}</figcaption></figure>
      <div class="excerpt">${para(i)}${para(i + 1)}</div>
      <ul class="links"><li><a href="#s${i}">Share</a></li><li><a href="#c${i}">Comments</a></li><li><a href="#m${i}">More</a></li></ul>
      <footer class="card-foot"><button class="btn like">Like</button><button class="btn save">Save</button><span class="count">${i * 3}</span></footer></article>`;
  }
  const nav = Array.from({ length: 40 }, (_, i) => `<li class="nav-item"><a href="#n${i}">${words[i % words.length]}</a></li>`).join('');
  return `<!doctype html><html><head><title>News</title><style>.card{margin:8px;padding:8px;border:1px solid #ccc}.meta span{margin-right:6px}</style></head>
    <body><header class="site-header"><nav><ul class="nav">${nav}</ul></nav></header><main class="grid">${cards}</main>
    <footer class="site-footer">${para(1)}</footer></body></html>`;
}
function iframes() {
  const frames = Array.from({ length: 30 }, (_, i) => `<iframe src="/frame?i=${i}" width="300" height="150"></iframe>`).join('');
  return `<!doctype html><html><head><title>Frames</title></head><body><h1>Thirty frames</h1>${frames}</body></html>`;
}
// 30 frames of other sites (ads, players): each in a renderer of its own.
function adframes() {
  const frames = Array.from({ length: 30 }, (_, i) => `<iframe src="//ad${i}.test:${PORT}/frame?i=${i}" width="300" height="150"></iframe>`).join('');
  return `<!doctype html><html><head><title>Ad frames</title></head><body><h1>Thirty frames of other sites</h1>${frames}</body></html>`;
}
function frame() {
  let s = '';
  for (let i = 0; i < 60; i++) s += `<div class="row r${i % 5}"><span class="label">${words[i % words.length]}</span>${para(i)}</div>`;
  return `<!doctype html><html><head><title>frame</title></head><body>${s}</body></html>`;
}
function spa() {
  // The load event comes first; the nodes (2,000 over 5 s, 40 every 100 ms) after it. Measured:
  // the style recalc time from load until the last batch is in.
  return `<!doctype html><html><head><title>SPA</title></head><body><div id="app"></div><script>
    let n = 0; const app = document.getElementById('app');
    addEventListener('load', () => { const t = setInterval(() => {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 40; i++, n++) { const d = document.createElement('div'); d.className = 'item item-' + (n % 11);
        d.innerHTML = '<span class="name">Item ' + n + '</span><button class="act">Open</button>'; frag.appendChild(d); }
      app.appendChild(frag); document.body.offsetHeight; if (n >= 2000) { clearInterval(t); window.spaDone = performance.now(); } }, 100); });
  </script></body></html>`;
}
let PORT = 0;
const PAGES = { news, iframes, adframes, spa };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
  if (u.pathname === '/frame') return res.end(frame());
  // A second before the page, for DevTools to be on before it commits.
  setTimeout(() => res.end(PAGES[u.pathname.slice(1)]?.() || 'nope'), u.searchParams.has('r') ? 1000 : 0);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
PORT = server.address().port;
const origin = `http://127.0.0.1:${PORT}`;

// A target's DevTools connection: send(method, params) and eval(expression).
async function attach(targetId) {
  let t;
  for (let i = 0; i < 100 && !t; i++) {
    t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.id === targetId);
    if (!t) await sleep(100);
  }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let n = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { wait.get(m.id)?.(m); wait.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++n; wait.set(id, (m) => m.error ? j(new Error(m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await evalJs(expr); if (v) return v; } catch {} await sleep(100); } throw new Error('timed out: ' + expr); };
  return { cdp: { send }, eval: evalJs, waitFor, close: () => ws.close() };
}
const metrics = async (page) => Object.fromEntries((await page.cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
// The browser's own DevTools connection (tabs, processes; no window needed).
let browserWs, browserId = 0;
const pending = new Map();
async function browser(method, params = {}) {
  if (!browserWs) {
    browserWs = new WebSocket((await (await fetch(`${b.base}/json/version`)).json()).webSocketDebuggerUrl);
    await new Promise((r) => { browserWs.onopen = r; });
    browserWs.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); pending.delete(m.id); };
  }
  const id = ++browserId;
  return new Promise((r) => { pending.set(id, r); browserWs.send(JSON.stringify({ id, method, params })); });
}
const rendererPids = async () => (await browser('SystemInfo.getProcessInfo')).processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
// macOS's own count of what a process costs (footprint), else its resident size.
function footprintMb(pid) {
  try {
    const out = execFileSync('footprint', ['-f', 'bytes', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /Footprint:\s*(\d+)\s*B/.exec(out);
    if (m) return Number(m[1]) / 1048576;
  } catch {}
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024;
}

async function measure(b, name) {
  // A fresh renderer for each run: a new tab on a site of its own (*.test is this server).
  const host = `s${++hosts}.test`;
  const url = `${origin.replace('127.0.0.1', host)}/${name}?r=${Math.random()}`;
  const before = new Set(await rendererPids());
  const { targetId } = await browser('Target.createTarget', { url });
  const page = await attach(targetId);
  await page.cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
  await page.waitFor(`location.href.startsWith(${JSON.stringify(url.slice(0, url.indexOf('?')))}) && document.readyState === 'complete'`, 30000);
  // A window in the background draws no frames (so no first contentful paint either): style and
  // layout once as the first frame would, in every frame (same-origin ones, as here), timed.
  const firstLayout = await page.eval(`(() => { const t = performance.now(); const all = (d) => { if (!d) return; d.body.offsetHeight; for (const f of d.querySelectorAll('iframe')) all(f.contentDocument); }; all(document); return performance.now() - t; })()`);
  const out = {};
  const nav = await page.eval(`(() => { const n = performance.getEntriesByType('navigation')[0]; return { load: n.loadEventStart - n.responseStart }; })()`);
  out.load = nav.load; out.firstLayout = firstLayout;
  let m = await metrics(page);
  if (name === 'spa') {
    const m0 = m;
    await page.waitFor('window.spaDone', 15000);
    await sleep(300);
    m = await metrics(page);
    out.spaRecalcMs = (m.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000;
  }
  await sleep(800);
  await page.eval(`(() => { const all = (d) => { if (!d) return; d.body.offsetHeight; for (const f of d.querySelectorAll('iframe')) all(f.contentDocument); }; all(document); return true; })()`);
  m = await metrics(page);
  out.recalcMs = m.RecalcStyleDuration * 1000;
  out.scriptMs = m.ScriptDuration * 1000;
  out.taskMs = m.TaskDuration * 1000;
  // The renderer that came with the tab.
  const fresh = (await rendererPids()).filter((p) => !before.has(p));
  await page.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  await sleep(300);
  out.memMb = fresh.length ? fresh.map(footprintMb).reduce((a, x) => a + x, 0) : NaN;
  out.rssMb = fresh.length ? fresh.map((pid) => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) / 1024).reduce((a, x) => a + x, 0) : NaN;
  out.renderers = fresh.length;
  page.close();
  await browser('Target.closeTarget', { targetId });
  await sleep(300);
  return out;
}

const median = (xs) => { const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
let b, hosts = 0;
process.env.MERIDIAN_TEST_DISABLE_FEATURES = [process.env.MERIDIAN_TEST_DISABLE_FEATURES, 'SpareRendererForSitePerProcess'].filter(Boolean).join(',');
b = await launch([`${origin}/warmup`], { args: [`--meridian-cookie-list=${LIST}`, '--host-resolver-rules=MAP *.test 127.0.0.1'] });
const results = {};
try {
  await sleep(3000); // the list is read once the first tab opens
  for (const mode of ['off', 'on', 'off', 'on']) {
    await b.eval(`app.$.tabstrip.handler_.getSettings().then(({settings}) => app.$.tabstrip.handler_.setSettings({...settings, hideCookieBanners: ${mode === 'on'}}))`);
    await sleep(500);
    for (const name of Object.keys(PAGES)) {
      for (let i = 0; i < Math.ceil(RUNS / 2); i++) {
        const r = await measure(b, name);
        // The CSS really went in (or didn't).
        ((results[name] ??= {})[mode] ??= []).push(r);
        process.stderr.write(`${name} ${mode} ${JSON.stringify(r)}\n`);
      }
    }
  }
} finally { browserWs?.close(); await b.close(); server.close(); }

const cols = [['load', 'load (ms)'], ['firstLayout', 'first style + layout (ms)'], ['recalcMs', 'style recalc (ms)'], ['scriptMs', 'script (ms)'], ['taskMs', 'main-thread tasks (ms)'], ['memMb', 'renderer footprint (MB)'], ['rssMb', 'renderer resident (MB)']];
console.log(`| page | metric | off | on | on − off |\n|---|---|---:|---:|---:|`);
for (const [name, byMode] of Object.entries(results)) {
  const cs = name === 'spa' ? [...cols, ['spaRecalcMs', 'recalc while adding 2,000 nodes (ms)']] : cols;
  for (const [k, label] of cs) {
    const off = median(byMode.off.map((r) => r[k])), on = median(byMode.on.map((r) => r[k]));
    console.log(`| ${name} | ${label} | ${off.toFixed(1)} | ${on.toFixed(1)} | ${(on - off >= 0 ? '+' : '')}${(on - off).toFixed(1)} |`);
  }
}
