// Agent videos for posts: the real Claude Code drives a test Meridian over MCP ("Ask first"),
// on made-up local sites (no one's accounts or data). The script plays the person: it presses
// Allow on the first two questions, then "Always allow". Recorded at 1600 px, sped up to ≤ 25 s.
// Usage: node tools/linkedin_agent_videos.mjs <out folder> [admin|weekly|deploy…]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APP, launch, SB } from '../tests/harness.mjs';

const [out, ...only] = process.argv.slice(2);
if (!out) { console.error('usage: node tools/linkedin_agent_videos.mjs <out folder> [scene…]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTH = 1600;
const MAX_SECONDS = 24;
const AG = 'app.$.agent.shadowRoot';

// ------------------------------------------------------------------ demo sites

const CSS = `body{font:15px/1.5 -apple-system,system-ui;margin:0;background:#f7f7f5;color:#1f2328}
header{display:flex;align-items:center;gap:20px;padding:14px 32px;background:#fff;border-bottom:1px solid #e6e6e2}
header b{font-size:18px;margin-right:auto}header span{color:#666}
main{max-width:1100px;margin:28px auto;padding:0 24px}h1{font-size:26px;margin:0 0 16px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px #0001}
th,td{text-align:left;padding:8px 14px;border-bottom:1px solid #f0f0ec}th{background:#fafaf8;font-weight:600;color:#555}
.tag{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:#eef}
.tag.Winter{background:#dbeafe;color:#1e40af}.tag.Summer{background:#fef3c7;color:#92400e}.tag.Kitchen{background:#dcfce7;color:#166534}
.bar{display:flex;gap:10px;align-items:center;margin:0 0 14px;background:#fff;padding:12px 14px;border-radius:12px;box-shadow:0 1px 3px #0001}
select,input,textarea{font:inherit;padding:7px 10px;border:1px solid #d6d6d0;border-radius:8px;background:#fff}
button{font:inherit;background:#1f2328;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer}
.ok{background:#dcfce7;color:#166534;padding:12px 16px;border-radius:10px;margin:0 0 14px;font-weight:600}
.err{background:#fee2e2;color:#991b1b;padding:16px 20px;border-radius:10px}
.card{background:#fff;border-radius:12px;padding:18px 22px;box-shadow:0 1px 3px #0001;margin:0 0 14px}
label{display:block;font-weight:600;margin:12px 0 4px}form input,form textarea{width:100%;box-sizing:border-box}
.muted{color:#777}.price s{color:#999;margin-right:6px}`;
const page = (title, brand, nav, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><style>${CSS}</style>
<header><b>${brand}</b>${nav.map((n) => `<span>${n}</span>`).join('')}</header><main>${body}</main>`;

// The shop's products: 30, of which 12 are Winter.
const NAMES = {
  Winter: ['Wool scarf', 'Down jacket', 'Ski gloves', 'Thermal socks', 'Knit beanie', 'Snow boots', 'Fleece blanket', 'Hot water bottle', 'Cashmere sweater', 'Ice scraper', 'Hand warmers', 'Flannel pajamas'],
  Summer: ['Beach towel', 'Sun hat', 'Linen shirt', 'Sandals', 'Picnic basket', 'Cooler bag', 'Sunglasses', 'Swim shorts', 'Hammock'],
  Kitchen: ['Ceramic mug', 'Oak board', 'Chef knife', 'Cast iron pan', 'Tea kettle', 'Linen apron', 'Salad bowl', 'Pepper mill', 'Measuring cups'],
};
function products() {
  const all = [];
  let id = 1001;
  const order = [];
  for (let i = 0; i < 12; i++) for (const c of ['Winter', 'Summer', 'Kitchen']) if (NAMES[c][i]) order.push([c, NAMES[c][i]]);
  for (const [category, name] of order) all.push({ id: id++, name, category, price: 12 + ((id * 37) % 140), sale: 0 });
  return all;
}

function adminSite(state) {
  return (req, res, body) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/admin/products/bulk') {
      const f = new URLSearchParams(body);
      const ids = f.getAll('id').map(Number);
      const pct = Math.max(0, Math.min(90, Number(f.get('discount')) || 0));
      for (const p of state.products) if (ids.includes(p.id)) p.sale = pct;
      res.writeHead(303, { location: `/admin/products?category=${encodeURIComponent(f.get('category') || '')}&updated=${ids.length}` });
      return res.end();
    }
    const cat = u.searchParams.get('category') || '';
    const list = state.products.filter((p) => !cat || p.category === cat);
    const updated = u.searchParams.get('updated');
    const price = (p) => p.sale ? `<s>$${p.price}</s>$${(p.price * (100 - p.sale) / 100).toFixed(2)}` : `$${p.price}`;
    res.end(page('Products — Acme Shop Admin', 'Acme Shop Admin', ['Orders', 'Products', 'Customers', 'Settings'], `
<h1>Products</h1>
${updated ? `<div class="ok">Updated ${updated} products</div>` : ''}
<form class="bar" method="get" action="/admin/products">
  <label for="category" style="margin:0">Category</label>
  <select id="category" name="category" onchange="this.form.submit()">
    <option value="">All (${state.products.length})</option>
    ${['Winter', 'Summer', 'Kitchen'].map((c) => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}
  </select>
  <span class="muted">${list.length} shown</span>
</form>
<form method="post" action="/admin/products/bulk">
  <input type="hidden" name="category" value="${cat}">
  <div class="bar">
    <label style="margin:0"><input type="checkbox" id="all" style="width:auto" onchange="for (const c of document.querySelectorAll('input[name=id]')) c.checked = this.checked"> Select all shown</label>
    <span style="margin-left:auto">Discount</span>
    <input id="discount" name="discount" type="number" min="0" max="90" placeholder="%" style="width:80px">
    <button id="apply">Apply to selected</button>
  </div>
  <table><tr><th></th><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Sale</th></tr>
  ${list.map((p) => `<tr><td><input type="checkbox" name="id" value="${p.id}" aria-label="Select ${p.name}" style="width:auto"></td><td>${p.name}</td><td class="muted">AC-${p.id}</td><td><span class="tag ${p.category}">${p.category}</span></td><td class="price">${price(p)}</td><td>${p.sale ? `−${p.sale}%` : ''}</td></tr>`).join('')}
  </table>
</form>`));
  };
}

const ISSUES = [
  ['ACME-412', 'Checkout: Apple Pay button on Safari', 'Maya', 'Done'],
  ['ACME-418', 'Search results load 2× faster (index on title)', 'Leo', 'Done'],
  ['ACME-421', 'Fix: order emails sent twice', 'Priya', 'Done'],
  ['ACME-425', 'Winter campaign landing page', 'Sam', 'Done'],
  ['ACME-427', 'Gift cards: partial refunds', 'Leo', 'In review'],
  ['ACME-430', 'Flaky test in cart totals', 'Maya', 'In progress'],
  ['ACME-433', 'Migrate image CDN', 'Priya', 'Blocked: waiting for vendor keys'],
];
function weeklySite(state) {
  return (req, res, body) => {
    const u = new URL(req.url, 'http://x');
    const nav = ['Board', 'Issues', 'Updates'];
    if (u.pathname === '/tracker') {
      return res.end(page('This week — Acme Tracker', 'Acme Tracker', nav, `
<h1>Sprint 23 · this week</h1>
<table><tr><th>Key</th><th>Title</th><th>Owner</th><th>Status</th></tr>
${ISSUES.map(([k, t, o, s]) => `<tr><td class="muted">${k}</td><td>${t}</td><td>${o}</td><td>${s}</td></tr>`).join('')}
</table>
<p class="muted">Open pull request: <a href="/pr/142">#142 Gift cards: partial refunds</a></p>`));
    }
    if (u.pathname === '/pr/142') {
      return res.end(page('#142 Gift cards: partial refunds — Acme Code', 'Acme Code', ['Pull requests', 'Issues', 'Actions'], `
<h1>#142 Gift cards: partial refunds</h1>
<div class="card"><b>Leo</b> wants to merge 6 commits into <code>main</code> · <span class="tag Kitchen">Checks passed</span> · 1 approval of 2</div>
<div class="card"><p>Lets support refund part of a gift card order. The unused balance goes back to the card; the rest is refunded to the original payment.</p>
<ul><li>New <code>refundPartial()</code> in the payments service</li><li>Admin: "Refund amount" field on the order page</li><li>Tests for mixed gift card + card orders</li></ul>
<p class="muted">Needs a second review from payments before merge (Priya).</p></div>`));
    }
    if (u.pathname === '/updates/new' && req.method === 'POST') {
      state.draft = new URLSearchParams(body).get('text') || '';
      res.writeHead(303, { location: '/updates/new?saved=1' });
      return res.end();
    }
    if (u.pathname === '/updates/new') {
      return res.end(page('New update — Acme Tracker', 'Acme Tracker', nav, `
<h1>Weekly update</h1>
${u.searchParams.get('saved') ? '<div class="ok">Draft saved. Not published yet.</div>' : ''}
<form class="card" method="post">
  <label for="text">Update for the team</label>
  <textarea id="text" name="text" rows="16" placeholder="What shipped, what's next, what's blocked…">${(state.draft || '').replace(/</g, '&lt;')}</textarea>
  <p><button id="save">Save draft</button></p>
</form>`));
    }
    res.writeHead(404); res.end('not found');
  };
}

function deploySite(state) {
  return (req, res, body) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/signup' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (!f.get('phone')) {
        res.writeHead(500);
        return res.end(page('Error — Acme Shop (staging)', 'Acme Shop · STAGING', [], `
<div class="err"><h1>500 · Something went wrong</h1><p>We couldn’t create your account. Please try again later.</p>
<p class="muted">request id 7f3a-c21 · TypeError: Cannot read properties of null (reading 'replace') at normalizePhone (signup.ts:48)</p></div>`));
      }
      return res.end(page('Welcome — Acme Shop (staging)', 'Acme Shop · STAGING', [], `<div class="ok">Welcome, ${f.get('name') || 'friend'}! Your account is ready.</div>`));
    }
    if (u.pathname === '/signup') {
      return res.end(page('Sign up — Acme Shop (staging)', 'Acme Shop · STAGING', ['Build 2026.11.20-3'], `
<h1>Create your account</h1>
<form class="card" method="post" style="max-width:420px">
  <label for="name">Name</label><input id="name" name="name">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="phone">Phone <span class="muted">(optional)</span></label><input id="phone" name="phone">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <p><button id="create">Create account</button></p>
</form>`));
    }
    if (u.pathname === '/bugs/new' && req.method === 'POST') {
      state.bug = Object.fromEntries(new URLSearchParams(body));
      res.writeHead(303, { location: '/bugs/318' });
      return res.end();
    }
    if (u.pathname === '/bugs/318') {
      return res.end(page('ACME-318 — Acme Tracker', 'Acme Tracker', ['Board', 'Issues'], `
<div class="ok">Bug ACME-318 filed</div>
<div class="card"><h1>${(state.bug?.title || '').replace(/</g, '&lt;')}</h1><pre style="white-space:pre-wrap;font:inherit">${(state.bug?.details || '').replace(/</g, '&lt;')}</pre></div>`));
    }
    if (u.pathname === '/bugs/new') {
      return res.end(page('New bug — Acme Tracker', 'Acme Tracker', ['Board', 'Issues'], `
<h1>Report a bug</h1>
<form class="card" method="post">
  <label for="title">Title</label><input id="title" name="title">
  <label for="details">Steps, expected, actual</label><textarea id="details" name="details" rows="12"></textarea>
  <p><button id="file">File bug</button></p>
</form>`));
    }
    res.writeHead(404); res.end('not found');
  };
}

async function serve(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: (p) => `http://localhost:${server.address().port}${p}` };
}

// ------------------------------------------------------------------ scenes

const SCENES = {
  admin: {
    file: '05-admin-bulk.mp4',
    site: adminSite,
    start: '/admin/products',
    state: () => ({ products: products() }),
    task: (url) => `In our shop admin (${url('/admin/products')}), put a 15% discount on every product in the Winter category. Use the admin's own filter and bulk action. Tell me how many products were updated.`,
    done: (s) => s.products.filter((p) => p.sale === 15).length === 12,
  },
  weekly: {
    file: '06-weekly-update.mp4',
    site: weeklySite,
    start: '/tracker',
    state: () => ({}),
    task: (url) => `Draft this week's team update. What happened is on our tracker board (${url('/tracker')}) and in the open pull request it links to. Write a short update (shipped / in progress / blocked) into the form at ${url('/updates/new')} and save it as a draft. Don't publish anything.`,
    done: (s) => (s.draft || '').length > 80,
  },
  deploy: {
    file: '07-deploy-check.mp4',
    site: deploySite,
    start: '/signup',
    state: () => ({}),
    task: (url) => `We just deployed to staging. Check that signup works at ${url('/signup')}: once with every field filled in, and once leaving the optional phone empty (use test emails like qa+1@example.com). If something breaks, file a bug at ${url('/bugs/new')} with the steps and the error you saw.`,
    done: (s) => !!s.bug,
  },
};

// The person's side: Allow the first two questions, then "Always allow".
function approver(b) {
  let on = true;
  let answered = 0;
  const loop = (async () => {
    while (on) {
      try {
        if (await b.eval(`!!${AG}.getElementById('ask')`)) {
          await sleep(1300);
          const id = answered < 2 ? 'allow' : 'always';
          await b.eval(`${AG}.getElementById(${JSON.stringify(id)})?.click()`);
          answered++;
        }
      } catch {}
      await sleep(250);
    }
  })();
  return { async stop() { on = false; await loop; }, get answered() { return answered; } };
}

function recorder(b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-rec-agent-'));
  const frames = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      try {
        const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
        const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ file, t });
      } catch {}
      await sleep(Math.max(0, 120 - (Date.now() - t)));
    }
  })();
  return {
    dir, frames,
    async stop() { on = false; await loop; },
  };
}

// The "sped up ×N" chip, drawn by the browser itself (ffmpeg here has no drawtext).
async function chip(b, text, file) {
  await b.eval(`(() => { const d = document.createElement('div'); d.id = 'speedchip'; d.textContent = ${JSON.stringify(text)};
    Object.assign(d.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999, font: '600 26px -apple-system, system-ui', color: '#fff', background: 'rgba(20,20,24,.82)', padding: '10px 20px', borderRadius: '0', letterSpacing: '.2px' });
    document.body.append(d); return true; })()`);
  const r = await b.eval(`(() => { const r = document.getElementById('speedchip').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  await b.eval(`document.getElementById('speedchip').remove() || true`);
}

function encode(rec, chipFile, file) {
  const frames = rec.frames;
  const real = (frames.at(-1).t - frames[0].t) / 1000;
  const speed = Math.max(1, Math.ceil(real / MAX_SECONDS));
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(((frames[i + 1]?.t ?? f.t + 2000 * speed) - f.t) / 1000 / speed).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  const concat = path.join(rec.dir, 'frames.txt');
  fs.writeFileSync(concat, list);
  const inputs = ['-f', 'concat', '-safe', '0', '-i', concat];
  let vf = `fps=30,scale=${WIDTH}:-2:flags=lanczos`;
  if (speed > 1) {
    inputs.push('-i', chipFile);
    const frameWidth = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', frames[0].file]).toString().trim());
    vf = `[0:v]${vf}[v];[1:v]scale=iw*${WIDTH}/${frameWidth}:-1[c];[v][c]overlay=W-w-24:24`;
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, speed > 1 ? '-filter_complex' : '-vf', vf,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', file]);
  return { real, speed };
}

async function run(name) {
  const scene = SCENES[name];
  const state = scene.state();
  const site = await serve(scene.site(state));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'ask', mission_notify_intro: true } }));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-agent-demo-'));
  const mcp = path.join(work, 'mcp.json');
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { meridian: { command: APP, args: ['--mcp-bridge', `--user-data-dir=${profile}`] } } }));
  const b = await launch([site.url(scene.start)], { profile, args: ['--meridian-no-notify', '--window-size=1600,1000'] });
  let agent;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await sleep(1500);
    const rec = recorder(b);
    const ok = approver(b);
    await sleep(1000);
    const t0 = Date.now();
    const task = scene.task(site.url) + ' Work in Meridian with the meridian tools, opening pages with activate: true so I can watch.';
    agent = spawn('claude', ['-p', task, '--mcp-config', mcp, '--strict-mcp-config', '--allowedTools', 'mcp__meridian__*',
      '--disallowedTools', 'Bash,Read,Write,Edit,WebFetch,WebSearch,Task', '--setting-sources', 'project', '--output-format', 'json'],
      { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    agent.stdout.on('data', (d) => { stdout += d; });
    agent.stderr.on('data', (d) => process.stderr.write(d));
    const code = await new Promise((r) => agent.on('exit', r));
    const agentSeconds = (Date.now() - t0) / 1000;
    await sleep(2500);
    await ok.stop();
    await rec.stop();
    let result = {};
    try { result = JSON.parse(stdout); } catch {}
    const chipFile = path.join(rec.dir, 'chip.png');
    const real = (rec.frames.at(-1).t - rec.frames[0].t) / 1000;
    const speed = Math.max(1, Math.ceil(real / MAX_SECONDS));
    await chip(b, `sped up ×${speed}`, chipFile);
    const enc = encode(rec, chipFile, path.join(out, scene.file));
    fs.rmSync(rec.dir, { recursive: true, force: true });
    const report = { scene: name, file: scene.file, exit: code, done: scene.done(state), agentSeconds: Math.round(agentSeconds), recordedSeconds: Math.round(enc.real), speed: enc.speed, videoSeconds: Math.round(enc.real / enc.speed), questionsAnswered: ok.answered, cost: result.total_cost_usd, turns: result.num_turns, answer: result.result, state };
    fs.writeFileSync(path.join(out, scene.file.replace('.mp4', '.json')), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, state: undefined, answer: (report.answer || '').slice(0, 400) }, null, 2));
  } finally {
    agent?.kill();
    await b.close(); site.server.close();
    fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
  }
}

for (const name of only.length ? only : Object.keys(SCENES)) {
  console.log('scene', name);
  await run(name);
}
