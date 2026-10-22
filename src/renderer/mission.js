/* Meridian — Mission Control (main UI).
 *
 * A live tree of every agent working with Meridian: Workbench sessions (Claude Code, Codex, Gemini;
 * local or in a Docker sandbox) with their subagents, MCP clients driving the browser, and ⌘J
 * assistant chats. State comes from the main process (src/agents/mission.js) as snapshots; this file
 * only draws them. Every string from an agent is set with textContent (never as HTML).
 *
 * Entry points: ⇧⌘M, View → Mission Control, the command bar, and the sidebar indicator. Also draws
 * the compact "N agents working" indicator in the sidebar bottom bar and feeds the Workbench topbar
 * chip (src/renderer/dev/mission-chip.js). Loaded after app.js / ai.js and uses their globals.
 */

// An icon of our own (the shared set is in icons.js).
ICON_PATHS.agents = '<circle cx="12" cy="12" r="2.2"/><path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5"/><path d="M4.5 12A7.5 7.5 0 0 1 12 4.5" opacity=".55"/><path d="M19.5 12A7.5 7.5 0 0 1 12 19.5"/><path d="M12 19.5A7.5 7.5 0 0 1 4.5 12" opacity=".55"/><circle cx="19.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>';

const mc = {
  snap: { nodes: [], history: [], counts: { working: 0, waiting: 0, live: 0 }, now: Date.now() },
  skew: 0,           // main clock − our clock
  byId: new Map(),
  els: new Map(),    // node id -> element refs
  open: false,
  selected: null,
  tick: null,
  lastCountsSig: '',
};

const MC_SOURCE = {
  claude: { mark: 'C', name: 'Claude Code' },
  codex: { mark: 'X', name: 'Codex' },
  gemini: { mark: 'G', name: 'Gemini' },
  mcp: { mark: '', name: 'MCP' },
  assistant: { mark: '', name: 'Assistant' },
};
const MC_WHERE = { local: 'Local', sandbox: 'Sandbox', mcp: 'MCP', assistant: 'Assistant' };

function mcStatusText(n) {
  if (n.status === 'tool' && n.tool) return n.tool.name === 'Compacting' ? 'Compacting context' : `Running ${prettyTool(n.tool.name)}`;
  if (n.statusText) return n.statusText;
  return { starting: 'Starting', thinking: 'Thinking', tool: 'Running a tool', waiting: 'Waiting for you', idle: 'Idle', done: 'Done', error: 'Error' }[n.status] || n.status;
}

function prettyTool(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  if (m) return m[2].replace(/_/g, ' ');
  return String(name || '').replace(/_/g, ' ');
}

function mcElapsed(n) {
  const end = n.endedAt || (Date.now() + mc.skew);
  const s = Math.max(0, Math.round((end - n.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const mcCalls = (n) => (n.source === 'codex' ? `${n.turns || 0} turn${n.turns === 1 ? '' : 's'}` : `${n.toolCalls} call${n.toolCalls === 1 ? '' : 's'}`);
const mcLive = (n) => !n.endedAt && ['starting', 'thinking', 'tool'].includes(n.status);

// ---------------------------------------------------------------- state in

function onMissionState(snap) {
  if (!snap || !Array.isArray(snap.nodes)) return;
  mc.snap = snap;
  mc.skew = (snap.now || Date.now()) - Date.now();
  mc.byId = new Map(snap.nodes.map((n) => [n.id, n]));
  renderMissionIndicator();
  broadcastMissionToWorkbenches();
  if (mc.open) drawMission();
}

// ---------------------------------------------------------------- sidebar indicator

function renderMissionIndicator() {
  let btn = $('#mc-indicator');
  if (!btn) {
    const bottom = $('.sb-bottom');
    if (!bottom) return;
    btn = document.createElement('button');
    btn.id = 'mc-indicator';
    btn.className = 'mc-ind';
    btn.innerHTML = `<span class="mc-ind-ic">${icon('agents', 16)}</span><span class="mc-ind-text"></span><span class="mc-ind-badge" hidden></span>`;
    btn.addEventListener('click', () => toggleMissionControl());
    bottom.insertBefore(btn, $('#space-dots'));
  }
  const { working, waiting, live } = mc.snap.counts;
  btn.classList.toggle('busy', working > 0);
  btn.classList.toggle('waiting', waiting > 0);
  btn.classList.toggle('has-live', live > 0);
  setText($('.mc-ind-text', btn), working ? `${working} working` : '');
  const badge = $('.mc-ind-badge', btn);
  badge.hidden = !waiting;
  setText(badge, String(waiting));
  btn.title = `Mission Control (${keys('⇧⌘M')})${working ? ` — ${working} agent${working === 1 ? '' : 's'} working` : ''}${waiting ? `, ${waiting} waiting for you` : ''}`;
  btn.setAttribute('aria-label', btn.title);
}

function broadcastMissionToWorkbenches() {
  if (typeof wbViews === 'undefined') return;
  const c = mc.snap.counts;
  const sig = `${c.working}/${c.waiting}/${c.live}`;
  if (sig === mc.lastCountsSig) return;
  mc.lastCountsSig = sig;
  for (const id of wbViews.keys()) sendWorkbench(id, { type: 'mission', working: c.working, waiting: c.waiting, live: c.live });
}

// ---------------------------------------------------------------- the view

function toggleMissionControl(force) {
  const open = force ?? !mc.open;
  if (open) openMissionControl(); else closeMissionControl();
}

function openMissionControl(selectId) {
  if (typeof closePanels === 'function') closePanels();
  if (selectId) mc.selected = selectId;
  if (mc.open) { drawMission(); return; }
  mc.open = true;
  mc.els.clear();
  const overlay = document.createElement('div');
  overlay.id = 'mission-overlay';
  overlay.className = 'panel-overlay mc-overlay';
  overlay.innerHTML = `
    <div class="mc-card" role="dialog" aria-label="Mission Control">
      <header class="mc-head">
        <span class="mc-title-main">${icon('agents', 18)} Mission Control</span>
        <div class="mc-chips">
          <span class="mc-chip working"><i></i><b data-k="working">0</b> working</span>
          <span class="mc-chip waiting"><i></i><b data-k="waiting">0</b> waiting for you</span>
          <span class="mc-chip calls"><b data-k="calls">0</b> tool calls</span>
        </div>
        <div class="grow"></div>
        <span class="mc-kbd">${esc(keys('⇧⌘M'))}</span>
        <button class="icon-btn small" id="mc-close" title="Close (Esc)">${icon('x', 14)}</button>
      </header>
      <div class="mc-body">
        <section class="mc-tree-wrap">
          <div class="mc-tree" id="mc-tree"></div>
          <div class="mc-empty" id="mc-empty" hidden>
            <div class="mc-orbit"><i></i><i></i><i></i><span>${icon('agents', 26)}</span></div>
            <div class="pe-title">No agents at work</div>
            <div class="pe-sub">Start Claude Code or Codex in the Workbench, connect an MCP client, or ask Claude with ${esc(keys('⌘J'))}. They show up here live, with their subagents.</div>
            <button class="btn small" id="mc-open-wb">${icon('code', 13)} Open Workbench</button>
          </div>
          <div class="mc-history" id="mc-history"></div>
        </section>
        <aside class="mc-detail" id="mc-detail"></aside>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeMissionControl(); });
  $('#mc-close', overlay).onclick = closeMissionControl;
  $('#mc-open-wb', overlay).onclick = () => { closeMissionControl(); openWorkbench(); };
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMissionControl(); } });
  $('#mc-tree', overlay).addEventListener('click', (e) => {
    const row = e.target.closest('.mc-row');
    if (!row) return;
    const id = row.parentElement.dataset.id;
    if (e.target.closest('[data-act="reveal"]')) return revealMissionNode(id);
    mc.selected = id;
    drawMission();
  });
  $('#mc-tree', overlay).addEventListener('dblclick', (e) => { const row = e.target.closest('.mc-row'); if (row) revealMissionNode(row.parentElement.dataset.id); });
  $('#mc-detail', overlay).addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'reveal') revealMissionNode(mc.selected);
    if (a === 'dismiss') { await api.missionDismiss(mc.selected); mc.selected = null; }
  });
  $('#mc-history', overlay).addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="clear-history"]')) await api.missionClearHistory();
  });
  overlay.tabIndex = -1;
  setTimeout(() => overlay.focus(), 0);
  api.missionSnapshot().then(onMissionState).catch(() => {});
  drawMission();
  mc.tick = setInterval(tickMission, 1000);
}

function closeMissionControl() {
  mc.open = false;
  clearInterval(mc.tick);
  const el = $('#mission-overlay');
  if (!el) return;
  el.classList.add('closing');
  setTimeout(() => el.remove(), 140);
  const t = activeTab();
  if (t) rt.views.get(t.id)?.focus();
}

function tickMission() {
  for (const [id, refs] of mc.els) {
    const n = mc.byId.get(id);
    if (n) setText(refs.elapsed, mcElapsed(n));
  }
  const sel = mc.selected && mc.byId.get(mc.selected);
  if (sel) { const el = $('#mc-detail [data-k="elapsed"]'); if (el) setText(el, mcElapsed(sel)); }
}

function mcChildren() {
  const kids = new Map();
  const roots = [];
  for (const n of mc.snap.nodes) {
    if (n.parentId && mc.byId.has(n.parentId)) { if (!kids.has(n.parentId)) kids.set(n.parentId, []); kids.get(n.parentId).push(n); }
    else roots.push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  roots.sort((a, b) => b.startedAt - a.startedAt);
  return { roots, kids };
}

function drawMission() {
  const overlay = $('#mission-overlay');
  if (!overlay) return;
  const { counts, nodes, history } = mc.snap;
  setText($('[data-k="working"]', overlay), String(counts.working));
  setText($('[data-k="waiting"]', overlay), String(counts.waiting));
  setText($('[data-k="calls"]', overlay), String(nodes.reduce((a, n) => a + (n.source === 'codex' ? 0 : n.toolCalls), 0)));
  $('.mc-chip.waiting', overlay).classList.toggle('on', counts.waiting > 0);
  $('.mc-chip.working', overlay).classList.toggle('on', counts.working > 0);

  const { roots, kids } = mcChildren();
  const tree = $('#mc-tree', overlay);
  $('#mc-empty', overlay).hidden = roots.length > 0;
  if (mc.selected && !mc.byId.has(mc.selected)) mc.selected = null;
  if (!mc.selected && roots.length) mc.selected = (roots.find((r) => r.status === 'waiting') || roots.find((r) => !r.endedAt) || roots[0]).id;

  const seen = new Set();
  const place = (container, list) => {
    list.forEach((n, i) => {
      seen.add(n.id);
      const refs = mcNodeEl(n);
      updateMcNode(refs, n, kids.get(n.id)?.length || 0);
      const cur = [...container.children].filter((c) => !c.classList.contains('mc-leave'));
      if (cur[i] !== refs.el) container.insertBefore(refs.el, cur[i] || null);
      place(refs.kids, kids.get(n.id) || []);
    });
    // anything after the expected children is stale
    for (const el of [...container.children].filter((c) => !c.classList.contains('mc-leave')).slice(list.length)) leaveMcNode(el);
  };
  place(tree, roots);
  for (const [id, refs] of mc.els) if (!seen.has(id) && !refs.el.classList.contains('mc-leave')) leaveMcNode(refs.el);
  drawMissionDetail();
  drawMissionHistory(history);
}

function mcNodeEl(n) {
  let refs = mc.els.get(n.id);
  if (refs) return refs;
  const el = document.createElement('div');
  el.className = 'mc-node mc-enter';
  el.dataset.id = n.id;
  el.innerHTML = `
    <div class="mc-row" tabindex="0">
      <span class="mc-avatar"><i class="mc-ring"></i><span class="mc-mark"></span></span>
      <div class="mc-main">
        <div class="mc-line1"><span class="mc-label"></span><span class="mc-sub"></span><span class="mc-where"></span><span class="mc-proj"></span></div>
        <div class="mc-line2"><span class="mc-pill"><i></i><span class="mc-pill-text"></span></span><span class="mc-tool"></span></div>
      </div>
      <div class="mc-meta"><span class="mc-elapsed"></span><span class="mc-count"></span></div>
      <button class="mc-go" data-act="reveal" title="Show">${icon('arrowRight', 14)}</button>
    </div>
    <div class="mc-kids"></div>`;
  refs = {
    el, row: el.firstElementChild, kids: el.lastElementChild,
    avatar: $('.mc-avatar', el), mark: $('.mc-mark', el), label: $('.mc-label', el), sub: $('.mc-sub', el), where: $('.mc-where', el),
    proj: $('.mc-proj', el), pill: $('.mc-pill', el), pillText: $('.mc-pill-text', el), tool: $('.mc-tool', el), elapsed: $('.mc-elapsed', el), count: $('.mc-count', el),
  };
  el.addEventListener('animationend', (e) => { if (e.animationName === 'mc-enter') el.classList.remove('mc-enter'); });
  mc.els.set(n.id, refs);
  return refs;
}

function updateMcNode(r, n, kidCount) {
  const src = MC_SOURCE[n.source] || { mark: '•' };
  r.el.dataset.status = n.status;
  r.el.dataset.source = n.source;
  r.el.dataset.kind = n.kind;
  r.el.classList.toggle('live', mcLive(n));
  r.el.classList.toggle('ended', !!n.endedAt);
  r.el.classList.toggle('sel', mc.selected === n.id);
  r.el.classList.toggle('has-kids', kidCount > 0);
  const mark = n.kind === 'subagent' ? '' : src.mark;
  if (r.mark.dataset.v !== n.source + n.kind) {
    r.mark.dataset.v = n.source + n.kind;
    if (n.kind === 'subagent') r.mark.innerHTML = icon('sparkles', 14);
    else if (n.source === 'mcp') r.mark.innerHTML = icon('globe', 13);
    else if (n.source === 'assistant') r.mark.innerHTML = icon('bolt', 13);
    else r.mark.textContent = mark;
  }
  setText(r.label, n.label || '');
  setText(r.sub, n.sublabel && n.sublabel !== n.label ? n.sublabel : '');
  setText(r.where, n.kind === 'subagent' ? '' : (MC_WHERE[n.where] || ''));
  r.where.dataset.where = n.where || '';
  setText(r.proj, n.kind === 'subagent' ? '' : (n.project || ''));
  setText(r.pillText, mcStatusText(n));
  setText(r.tool, n.status === 'tool' && n.tool?.summary ? n.tool.summary : (n.status === 'waiting' && n.tool?.summary ? n.tool.summary : ''));
  r.tool.title = r.tool.textContent;
  setText(r.elapsed, mcElapsed(n));
  setText(r.count, mcCalls(n));
}

function leaveMcNode(el) {
  el.classList.add('mc-leave');
  for (const [id, refs] of mc.els) if (refs.el === el) mc.els.delete(id);
  setTimeout(() => el.remove(), 260);
}

function mcFmtTime(ts) { return new Date(ts - mc.skew).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }); }

function drawMissionDetail() {
  const box = $('#mc-detail');
  if (!box) return;
  const n = mc.selected && mc.byId.get(mc.selected);
  if (!n) { box.innerHTML = `<div class="mc-detail-empty muted">Select an agent to see what it’s doing.</div>`; box._sig = ''; return; }
  const root = mc.byId.get(n.parentId ? (mcRootOf(n)?.id || n.id) : n.id) || n;
  const canReveal = !!((n.termId && n.ownerWcId) || n.tabId || n.kind === 'assistant');
  const sig = JSON.stringify([n.id, n.status, n.statusText, n.tool, n.toolCalls, n.errors, n.log.length, n.log.at(-1)?.ok, n.endedAt, n.project]);
  if (box._sig === sig) return;
  box._sig = sig;
  box.dataset.status = n.status;
  box.innerHTML = `
    <div class="mc-d-head">
      <div class="mc-d-title"></div>
      <div class="mc-d-sub"></div>
      <div class="mc-d-status"><span class="mc-pill"><i></i><span></span></span></div>
    </div>
    <dl class="mc-d-facts">
      <div><dt>Runs</dt><dd data-k="where"></dd></div>
      <div><dt>Project</dt><dd data-k="project"></dd></div>
      <div><dt>Elapsed</dt><dd data-k="elapsed"></dd></div>
      <div><dt>${n.source === 'codex' ? 'Turns' : 'Tool calls'}</dt><dd data-k="calls"></dd></div>
    </dl>
    <div class="mc-d-actions">
      ${canReveal ? `<button class="btn small accent" data-act="reveal">${icon(n.termId ? 'terminal' : n.kind === 'assistant' ? 'sparkles' : 'arrowRight', 13)} ${n.termId ? 'Open terminal' : n.kind === 'assistant' ? 'Open chat' : 'Show tab'}</button>` : ''}
      ${!n.parentId && n.endedAt ? `<button class="btn small" data-act="dismiss">Dismiss</button>` : ''}
    </div>
    <div class="mc-d-log-title">Recent activity</div>
    <ol class="mc-d-log"></ol>`;
  $('.mc-d-title', box).textContent = n.label || '';
  $('.mc-d-sub', box).textContent = [n.sublabel !== n.label ? n.sublabel : null, n.parentId ? `in ${root.label}` : null].filter(Boolean).join(' · ');
  $('.mc-d-status .mc-pill span', box).textContent = mcStatusText(n);
  $('.mc-d-status .mc-pill', box).dataset.status = n.status;
  $('[data-k="where"]', box).textContent = { local: 'On this Mac', sandbox: 'Docker sandbox', mcp: 'MCP client', assistant: 'Built-in assistant' }[n.where] || n.where || '—';
  if (!IS_MAC && n.where === 'local') $('[data-k="where"]', box).textContent = 'On this computer';
  $('[data-k="project"]', box).textContent = n.project || root.project || '—';
  $('[data-k="elapsed"]', box).textContent = mcElapsed(n);
  $('[data-k="calls"]', box).textContent = n.source === 'codex' ? String(n.turns || 0) : `${n.toolCalls}${n.errors ? ` · ${n.errors} failed` : ''}`;
  const log = $('.mc-d-log', box);
  const entries = n.log.slice().reverse();
  if (!entries.length) { const li = document.createElement('li'); li.className = 'muted empty'; li.textContent = n.status === 'starting' ? 'Starting up…' : 'No tool calls yet.'; log.appendChild(li); }
  for (const e of entries) {
    const li = document.createElement('li');
    li.dataset.ok = e.ok === null ? 'pending' : String(e.ok);
    const dot = document.createElement('i');
    const name = document.createElement('b'); name.textContent = prettyTool(e.name);
    const sum = document.createElement('span'); sum.textContent = e.summary || ''; sum.title = e.summary || '';
    const time = document.createElement('time'); time.textContent = mcFmtTime(e.ts);
    li.append(dot, name, sum, time);
    log.appendChild(li);
  }
}

function mcRootOf(n) {
  let cur = n;
  for (let i = 0; i < 20 && cur?.parentId; i++) cur = mc.byId.get(cur.parentId) || null;
  return cur;
}

function drawMissionHistory(history) {
  const box = $('#mc-history');
  if (!box) return;
  const sig = JSON.stringify(history.map((h) => h.id + h.endedAt));
  if (box._sig === sig) return;
  box._sig = sig;
  if (!history.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="mc-h-head"><span>Recent sessions</span><div class="grow"></div><button class="link-btn" data-act="clear-history">Clear</button></div><div class="mc-h-list"></div>`;
  const list = $('.mc-h-list', box);
  for (const h of history.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'mc-h-row';
    row.dataset.status = h.status;
    row.dataset.source = h.source;
    const dur = Math.max(0, Math.round(((h.endedAt || 0) - (h.startedAt || 0)) / 1000));
    const durText = dur < 60 ? `${dur}s` : dur < 3600 ? `${Math.floor(dur / 60)}m` : `${Math.floor(dur / 3600)}h ${Math.floor((dur % 3600) / 60)}m`;
    const cells = [
      ['mc-h-dot', ''], ['mc-h-label', h.label], ['mc-h-proj', h.project || ''], ['mc-h-where', MC_WHERE[h.where] || ''],
      ['mc-h-n', `${h.source === 'codex' ? '' : `${h.toolCalls} calls`}${h.subagents ? ` · ${h.subagents} subagent${h.subagents === 1 ? '' : 's'}` : ''}`],
      ['mc-h-dur', durText], ['mc-h-time', new Date(h.endedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })],
    ];
    for (const [cls, text] of cells) { const s = document.createElement('span'); s.className = cls; s.textContent = text; row.appendChild(s); }
    list.appendChild(row);
  }
}

// ---------------------------------------------------------------- jump to where an agent works

function revealMissionNode(id) {
  const n = mc.byId.get(String(id || ''));
  if (!n) return openMissionControl();
  const go = (tabId) => {
    const l = locateAnywhere(tabId);
    if (!l) return false;
    closeMissionControl();
    if (typeof ensureSpaceActive === 'function') ensureSpaceActive(l.space);
    activate(tabId);
    return true;
  };
  if (n.termId && n.ownerWcId) {
    const tabId = rt.wcToTab.get(n.ownerWcId);
    if (tabId && go(tabId)) { sendWorkbench(tabId, { type: 'focus-term', id: n.termId }); return; }
  }
  if (n.tabId && go(n.tabId)) return;
  if (n.kind === 'assistant') { closeMissionControl(); toggleAiPanel(true); return; }
  openMissionControl(n.id);
  toast('That agent’s terminal or tab is no longer open');
}

// ---------------------------------------------------------------- boot

function initMission() {
  if (typeof EPHEMERAL !== 'undefined' && EPHEMERAL) return;
  api.onMission(onMissionState);
  api.onMissionToast(({ nodeId, title }) => toast(title, { action: 'Show', onClick: () => revealMissionNode(nodeId), timeout: 8000, id: 'mission-wait' }));
  api.missionSnapshot().then(onMissionState).catch(() => {});
  renderMissionIndicator();
}

window.addEventListener('DOMContentLoaded', () => setTimeout(initMission, 0));
