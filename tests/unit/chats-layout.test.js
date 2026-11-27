// The Workbench's Chats panel lays out without overlaps from the left pane's narrowest width up:
// the real workbench.css + chats.css + chats.js + session-status.js in a headless page, with stand-ins
// for the rest of the Workbench. At 160 px (the grip's minimum), 290 px (the default with Chats on) and
// 480 px, in the Chats view and the Files view: no two controls of the pane's head overlap, nothing of
// the head or the list sits outside the pane, the rows' parts don't overlap, the context gauge's fill
// stays inside its chip, and the pane doesn't scroll sideways.
// Needs Playwright's Chromium (npx playwright install chromium); skipped without it.
// Run: node --test 'tests/unit/*.test.js'
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DEV = path.join(__dirname, '../../src/renderer/dev');
const read = (f) => fs.readFileSync(path.join(DEV, f), 'utf8');

// The Workbench page's markup without its scripts.
function page() {
  const html = read('workbench.html');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<!-- xterm'));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${read('workbench.css')}</style><style>${read('chats.css')}</style></head><body>${body}</body></html>`;
}

// What chats.js uses from workbench.js, context-insights.js and terminal code.
const STANDINS = `
const wb = { platform: 'darwin', onHostCommand(fn) { window.__host = fn; }, toHost() {}, termLastAnswer: async () => '' };
const $ = (s, root = document) => root.querySelector(s);
const MEM = new Map();
const load = (k) => (MEM.has(k) ? MEM.get(k) : null);
const store = (k, v) => MEM.set(k, v);
const AGENT_UI = { claude: { label: 'Claude Code', mark: 'Cl', color: '#d97757' }, codex: { label: 'Codex', mark: 'Cx', color: '#3c3c46' }, shell: { label: 'Shell', mark: '$', color: '#7a808c' } };
function agentMark(kind) { const m = document.createElement('span'); m.className = 'mark'; m.style.setProperty('--mark', AGENT_UI[kind].color); m.textContent = AGENT_UI[kind].mark; return m; }
const termIsClaude = (t) => t.kind === 'claude';
const termName = (t) => t.name;
function termRcBadge(t) { const el = document.createElement('span'); el.className = 'tab-rc on'; el.textContent = 'RC'; return el; }
function termUsageBadge(t) {
  if (t.pct == null) return null;
  const box = document.createElement('span'); box.className = 'tab-usage';
  const b = document.createElement('span'); b.className = 'ctx-badge ' + (t.pct < 50 ? 'ok' : t.pct < 80 ? 'warn' : 'bad');
  b.style.setProperty('--p', t.pct + '%'); b.textContent = t.pct + '%'; box.appendChild(b); return box;
}
const S = { project: { root: '/p' }, terms: [], activeTerm: null };
function renderTermTabs() { if (typeof chatsAfterTabs === 'function') chatsAfterTabs(); }
function activateTerm(t) { S.activeTerm = t; renderTermTabs(); }
function launch() {}
`;

const TERMS = [
  { id: '1', kind: 'claude', name: 'Работа: Выполнение задач по очереди', pct: 6 },
  { id: '2', kind: 'claude', name: 'Meridian: boost', pct: 72, rc: 'on' },
  { id: '3', kind: 'claude', name: 'TraleBot: push schedule', pct: 18 },
  { id: '4', kind: 'codex', name: 'Codex: ревью PR #1102', pct: 100 },
  { id: '5', kind: 'shell', name: 'zsh' },
  { id: '6', kind: 'claude', name: 'Claude Code', pct: 41, exited: true },
];

// Every visible box under `root` (elements only), with its path for messages.
const MEASURE = `(sel) => {
  const pane = document.querySelector('#tree-pane').getBoundingClientRect();
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0.5 && r.height > 0.5 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const name = (el) => el.id ? '#' + el.id : el.className ? el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] : el.tagName.toLowerCase();
  const out = [];
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
  const outside = (r, box) => r.left < box.left - 0.5 || r.right > box.right + 0.5;
  // Siblings that must not overlap: the head's controls, each row's columns and the parts of its two lines.
  const groups = [
    [...document.querySelectorAll('#tree-pane > .pane-head > *, #left-views > .left-view, #tree-tools > button')],
    ...[...document.querySelectorAll('#left-views > .left-view')].map((v) => [...v.children]),
    [...document.querySelectorAll('.chats-head > *')],
    ...[...document.querySelectorAll('.chat-row, .chat-top, .chat-sub')].map((r) => [...r.children]),
  ];
  for (const g of groups) {
    const vis = g.filter(visible);
    for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
      if (vis[i].contains(vis[j]) || vis[j].contains(vis[i])) continue;
      if (overlap(vis[i].getBoundingClientRect(), vis[j].getBoundingClientRect())) out.push('overlap: ' + name(vis[i]) + ' / ' + name(vis[j]));
    }
  }
  for (const el of document.querySelectorAll('#tree-pane .pane-head *, #chats-view *')) {
    if (!visible(el)) continue;
    // Text clipped by an ellipsis is inside its parent's box.
    const r = el.getBoundingClientRect();
    if (outside(r, pane)) out.push('outside the pane: ' + name(el) + ' ' + Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + Math.round(pane.left) + '..' + Math.round(pane.right));
  }
  for (const b of document.querySelectorAll('.chat-row .ctx-badge')) {
    if (!visible(b)) continue;
    const box = b.getBoundingClientRect();
    const fill = getComputedStyle(b, '::before');
    const w = parseFloat(fill.width), l = parseFloat(fill.left);
    if (!(l >= 1.5 && l + w <= box.width - 1.5)) out.push('gauge fill outside its chip: ' + b.textContent + ' left ' + l + ' width ' + w + ' of ' + box.width);
  }
  const p = document.querySelector('#tree-pane');
  if (p.scrollLeft !== 0) out.push('the pane is scrolled sideways: ' + p.scrollLeft);
  return out;
}`;

let chromium;
try { ({ chromium } = require('playwright')); } catch {}

test('Chats panel: no overlaps and nothing outside the pane at 160, 290 and 480 px, in Chats and Files', async (t) => {
  let browser;
  try { browser = chromium && await chromium.launch({ headless: true }); } catch {}
  if (!browser) { t.skip('Playwright Chromium is not installed'); return; }
  try {
    for (const scheme of ['light', 'dark']) {
      for (const width of [160, 290, 480]) {
        // A page of its own each time: the scripts declare globals.
        const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.setContent(page());
        await p.addScriptTag({ content: read('../icons.js') });
        await p.addScriptTag({ content: STANDINS });
        await p.addScriptTag({ content: read('session-status.js') });
        await p.addScriptTag({ content: read('chats.js') });
        await p.evaluate(({ terms, width }) => {
          document.querySelector('#main').hidden = false;
          document.querySelector('#welcome').hidden = true;
          // The tree's own icons (workbench.js iconize()).
          for (const s of document.querySelectorAll('.ic-slot[data-icon]')) s.innerHTML = icon(s.dataset.icon, 14);
          const n = document.querySelector('#scm-count'); n.hidden = false; n.textContent = '11';
          store('treeW', String(width));
          document.documentElement.style.setProperty('--tree-w', width + 'px');
          S.terms = terms.map((x) => ({ ...x }));
          S.activeTerm = S.terms[1];
          chatsStart();
          // Statuses as Mission Control sends them.
          SessionStatus.report({ on: true, onScreen: '2', order: S.terms.map((x) => x.id) });
        }, { terms: TERMS, width });
        await p.evaluate(() => window.__host({ type: 'mission', sessions: {
          1: { chat: 'needs', ask: { tool: 'Bash', summary: '$ dotnet test --filter Integration' } },
          2: { chat: 'working', tool: { name: 'Bash', summary: '$ npm run e2e -- --grep boost' } },
          3: { chat: 'done' },
        } }));
        assert.deepEqual(errors, [], 'the page threw');
        for (const view of ['chats', 'files']) {
          await p.evaluate((view) => { document.querySelector(view === 'chats' ? '#view-chats' : '#view-files').click(); const e = document.querySelector('details.chats-ended'); if (e) e.open = true; }, view);
          const problems = await p.evaluate(`(${MEASURE})()`);
          // The view shows what it says: the list (every row on screen) or the tree, not both.
          const shown = await p.evaluate(() => {
            const on = (sel) => { const e = document.querySelector(sel); const r = e && e.getBoundingClientRect(); return !!e && getComputedStyle(e).display !== 'none' && r.height > 0; };
            const rows = [...document.querySelectorAll('#chats-view .chat-row')].filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.top >= 0 && b.bottom <= innerHeight; }).length;
            return { list: on('#chats-view'), tree: on('#tree'), tools: on('#tree-tools'), rows };
          });
          assert.deepEqual(shown, view === 'chats' ? { list: true, tree: false, tools: false, rows: 6 } : { list: false, tree: true, tools: true, rows: 0 }, `${scheme}, ${width}px, ${view} view`);
          assert.deepEqual(problems, [], `${scheme}, ${width}px, ${view} view`);
        }
        // The ended session is folded under "Ended", after the running ones.
        await p.evaluate(() => document.querySelector('#view-chats').click());
        const order = await p.evaluate(() => [...document.querySelectorAll('#chats-view .chat-row')].map((r) => r.dataset.term));
        assert.deepEqual(order, ['1', '2', '3', '4', '5', '6']);
        assert.equal(await p.evaluate(() => document.querySelector('.chats-ended summary').textContent), 'Ended · 1');
        assert.equal(await p.evaluate(() => !!document.querySelector('.chats-ended .chat-row[data-term="6"]')), true);
        if (process.env.MERIDIAN_SHOTS) {
          const box = await p.evaluate(() => { const r = document.querySelector('#tree-pane').getBoundingClientRect(); return { x: r.x, y: 0, width: r.width, height: 420 }; });
          await p.screenshot({ path: path.join(process.env.MERIDIAN_SHOTS, `chats-pane-${width}-${scheme}.png`), clip: box });
        }
        await p.close();
      }
    }
  } finally {
    await browser.close();
  }
});
