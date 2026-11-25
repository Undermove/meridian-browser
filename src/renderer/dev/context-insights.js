/* Meridian Workbench — usage limits and Context Insights for agent sessions.
 *
 * Claude Code: the numbers come from its own status line (Meridian runs it for Workbench sessions):
 * context used and the window's size, the 5-hour and weekly usage limits, prompt cache statistics,
 * the session's name. They arrive with Mission Control's updates (wb:command { type: 'mission',
 * usage: { <terminal id>: {...} } }). Context Insights reads the session's transcript in the browser
 * (wb.contextInsights) and says what the context holds and where the tokens went.
 * Codex, Qwen Code, Gemini, Copilot and OpenCode: the browser reads each one's own session record
 * (wb.contextInsights again), every 15 s while one runs: the context gauge on its tab and the same
 * panel. Agents that keep no readable record get a "not available" with the reason, never another
 * agent's session. All of it stays on this computer.
 */

const CI = { usage: {}, ctx: {}, termId: null, data: null, error: '', loading: false, timer: 0, lastFetch: 0, openSections: new Set(), unit: 'usd', account: '' };

// Agents read from their own session records (Claude Code comes through its status line).
const CI_RECORDS = new Set(['codex', 'qwen', 'gemini', 'copilot', 'opencode']);
const ciIsClaude = (t) => t?.kind === 'claude' || t?.kind === 'sandbox-claude';
const ciIsAgent = (t) => !!t && !['shell', 'sandbox-shell', 'workbench'].includes(t.kind);
const ciAgentName = (t) => (typeof AGENT_UI !== 'undefined' && AGENT_UI[t?.kind]?.label) || t?.kind || 'agent';

const CI_PARTS = [
  ['systemPrompt', 'System prompt', '#9a9aa6'],
  ['systemTools', 'System tools', '#8a8fe0'],
  ['mcpTools', 'MCP tools', '#2f9ea0'],
  ['mcpInstructions', 'MCP instructions', '#62c2c4'],
  ['skills', 'Skills', '#e0a400'],
  ['memoryFiles', 'Memory files', '#30a46c'],
  ['messages', 'Messages', '#6d5fd8'],
];

const CI_SPEND = [['cacheRead', 'Cache reads', '#8a8fe0'], ['cacheWrite', 'Cache writes', '#e0a400'], ['input', 'Uncached input', '#9a9aa6'], ['output', 'Output and thinking', '#6d5fd8'], ['subagents', 'Subagents', '#2f9ea0']];

// Why a turn cost what it did (the transcript has to prove it, else "unknown").
const CI_CAUSES = [['normal', 'Normal use', '#8a8fe0'], ['cold', 'Cold cache', '#3f8fe0'], ['compaction', 'Compaction', '#e5484d'], ['file', 'Big file read', '#e0a400'], ['tool', 'Big tool output', '#c2649a'], ['mcp', 'MCP load', '#2f9ea0'], ['subagents', 'Subagents', '#30a46c'], ['unknown', 'Unknown', '#7c7c88']];

const ciK = (n) => {
  n = Number(n) || 0;
  const trim = (x) => x.replace(/\.0$/, '');
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(n >= 1e7 ? 0 : 1))}M`;
  if (n >= 1000) return `${trim((n / 1000).toFixed(n >= 1e5 ? 0 : 1))}k`;
  return String(Math.round(n));
};
const ciPct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const ciEscRaw = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Paths in the project read from its root (agents record them in full).
const ciEsc = (s) => ciEscRaw(S?.project?.root ? String(s ?? '').split(`${S.project.root}/`).join('') : s);

function ciIn(seconds) {
  const s = Math.max(0, Math.round(seconds - Date.now() / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) { const m = Math.round(s / 60); return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`; }
  const d = new Date(seconds * 1000);
  return d.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function ciLevel(pct) { return pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok'; }

// The usage limits are the account's, so any session's latest numbers do; the freshest one wins.
// The AI account a terminal runs as (several subscriptions: Settings › AI); 'Default' when the space didn't choose.
const ciAccount = (t) => t?.account || 'Default';
// The accounts among this Workbench's agent sessions (a filter once there are two).
function ciAccounts() { return [...new Set(S.terms.filter(ciIsAgent).map(ciAccount))]; }

function ciLimits() {
  let best = null;
  // Limits belong to one subscription: the shown session's account only.
  const shown = ciTerm();
  const mine = (id) => !shown || ciAccounts().length < 2 || ciAccount(S.terms.find((t) => t.id === id)) === ciAccount(shown);
  for (const [id, u] of Object.entries(CI.usage)) {
    if (!mine(id)) continue;
    if (u.five_hour_pct == null && u.seven_day_pct == null && u.spend_pct == null) continue;
    if (!best || (u.five_hour_reset || 0) >= (best.five_hour_reset || 0)) best = u;
  }
  return best;
}

// The terminal the panel is about: the active one if it's an agent's session, else the last one.
function ciTerm() {
  const agents = S.terms.filter(ciIsAgent).filter((t) => !CI.account || ciAccount(t) === CI.account);
  if (S.activeTerm && agents.includes(S.activeTerm)) return S.activeTerm;
  return agents.find((t) => t.id === CI.termId) || agents[agents.length - 1] || null;
}

// ------------------------------------------------------------------ live numbers

function insightsUsage(usage) {
  const before = JSON.stringify(CI.usage);
  CI.usage = usage && typeof usage === 'object' ? usage : {};
  if (JSON.stringify(CI.usage) === before) return;
  renderLimitsChip();
  if (typeof renderTermTabs === 'function') renderTermTabs();
  if (PRO.activePanel === 'insights') {
    ciRedraw();
    // The transcript grew: read the new part (not more often than every 15 s).
    if (Date.now() - CI.lastFetch > 15000) ciFetch();
  }
}

function renderLimitsChip() {
  let chip = document.getElementById('limits-chip');
  if (!chip) {
    const side = document.getElementById('side-buttons');
    if (!side) return;
    chip = document.createElement('button');
    chip.id = 'limits-chip';
    chip.className = 'chip limits-chip';
    chip.addEventListener('click', () => (PRO.activePanel === 'insights' ? closePanel() : openPanel('insights')));
    side.insertBefore(chip, document.getElementById('btn-hub'));
  }
  const l = ciLimits();
  chip.classList.toggle('on', PRO.activePanel === 'insights');
  if (!l) {
    chip.innerHTML = `${icon('clock', 13)}<span>Usage</span>`;
    chip.title = 'Usage limits and Context Insights (the limits show after a Claude Code session’s first answer)';
    return;
  }
  const bits = [];
  if (l.five_hour_pct != null) bits.push(`<span class="lim ${ciLevel(l.five_hour_pct)}"><i style="--p:${Math.min(100, l.five_hour_pct)}%"></i>5h ${Math.round(l.five_hour_pct)}%</span>`);
  if (l.seven_day_pct != null) bits.push(`<span class="lim ${ciLevel(l.seven_day_pct)}"><i style="--p:${Math.min(100, l.seven_day_pct)}%"></i>week ${Math.round(l.seven_day_pct)}%</span>`);
  if (l.spend_pct != null) bits.push(`<span class="lim ${ciLevel(l.spend_pct)}"><i style="--p:${Math.min(100, l.spend_pct)}%"></i>spend ${Math.round(l.spend_pct)}%</span>`);
  chip.innerHTML = bits.join('');
  const lines = [];
  if (l.five_hour_pct != null) lines.push(`5-hour limit: ${Math.round(l.five_hour_pct)}% used, resets in ${ciIn(l.five_hour_reset)}`);
  if (l.seven_day_pct != null) lines.push(`Weekly limit: ${Math.round(l.seven_day_pct)}% used, resets ${ciIn(l.seven_day_reset)}`);
  chip.title = lines.join('\n') + '\nClick for Context Insights';
}

// The context gauge on an agent terminal's tab (Claude Code: its status line; others: their record).
function termUsageBadge(t) {
  const u = CI.usage[t.id]?.context_pct != null ? CI.usage[t.id] : CI.ctx[t.id];
  if (!u || u.context_pct == null) return null;
  const pct = Math.round(u.context_pct);
  const b = document.createElement('span');
  b.className = `ctx-badge ${ciLevel(pct)}`;
  b.style.setProperty('--p', `${Math.min(100, pct)}%`);
  b.textContent = `${pct}%`;
  b.title = `Context: ${pct}% used${u.context_tokens ? ` · ${ciK(u.context_tokens)} / ${ciK(u.context_size)}` : ''}${u.compactions ? ` · compacted ${u.compactions}×` : ''}\nClick for Context Insights`;
  b.addEventListener('click', (e) => { e.stopPropagation(); CI.termId = t.id; activateTerm(t); openPanel('insights'); });
  return b;
}

function termSessionName(t) { return CI.usage[t.id]?.session_name || ''; }

// ------------------------------------------------------------------ the panel

// A redraw replaces the chart, so it waits while the mouse is dragging over it.
function ciRedraw() {
  if (CI.dragging) { CI.redrawAfterDrag = true; return; }
  renderPanel();
}

// The bars span the whole session, so they shift as it grows: the selection follows the time.
function ciKeepRange(before, after) {
  if (!CI.range || !before?.length || !after?.length) return;
  const start = before[CI.range.from]?.ts;
  const end = before[CI.range.to + 1]?.ts ?? Infinity;
  if (start == null) { CI.range = null; return; }
  let from = 0, to = 0;
  after.forEach((b, i) => { if (b.ts <= start) from = i; if (b.ts < end) to = i; });
  CI.range = { from, to: Math.max(from, to) };
}

async function ciFetch() {
  const t = ciTerm();
  if (!t || typeof wb.contextInsights !== 'function') return;
  CI.loading = true;
  CI.lastFetch = Date.now();
  const id = t.id;
  try {
    const data = await wb.contextInsights(id, { contextSize: CI.usage[id]?.context_size });
    ciNoteContext(id, data);
    if (ciTerm()?.id === id) { ciKeepRange(CI.data?.moneySeries, data?.moneySeries); CI.data = data; CI.dataTerm = id; CI.error = ''; }
  } catch (e) {
    if (ciTerm()?.id === id) { CI.data = null; CI.dataTerm = id; }
    CI.error = String(e?.message || e).replace(/^Error: /, '');
  }
  CI.loading = false;
  if (PRO.activePanel === 'insights') ciRedraw();
}

function renderInsightsPanel(el) {
  const t = ciTerm();
  if (t && CI.dataTerm !== t.id && !CI.loading) { CI.data = null; CI.range = null; CI.error = ''; ciFetch(); }
  const claude = !t || ciIsClaude(t);
  const agent = t ? ciAgentName(t) : 'Claude Code';
  const u = t ? CI.usage[t.id] || {} : {};
  const d = CI.dataTerm === t?.id ? CI.data : null;
  CI.unit = d?.unit || 'usd';
  CI.agent = d?.agent || agent;
  const l = ciLimits();
  const parts = [];
  const bar = (label, pct, reset, sub) => `<div class="ci-limit"><div class="ci-row"><span>${label}</span><b>${Math.round(pct)}%</b></div><div class="ci-bar ${ciLevel(pct)}"><i style="width:${Math.min(100, pct)}%"></i></div><div class="muted small">${sub || (reset ? `Resets in ${ciIn(reset)}` : '')}</div></div>`;

  parts.push(`<div class="panel-head"><h2>Context Insights</h2>${t ? `<button class="icon-btn small" id="ci-refresh" title="Read the session again">${icon('reload', 13)}</button>` : ''}</div>`);
  const model = u.model || d?.model;
  const accounts = ciAccounts();
  if (accounts.length > 1) {
    parts.push(`<div class="ci-accounts" role="group" aria-label="Account">${['', ...accounts].map((a) => `<button class="chip small${CI.account === a ? ' on' : ''}" data-account="${ciEscRaw(a)}">${a ? ciEscRaw(a) : 'All accounts'}</button>`).join('')}</div>`);
  }
  if (t) parts.push(`<p class="muted ci-session">${ciEsc(termName(t))}${claude || termName(t).startsWith(agent) ? '' : ` · ${ciEsc(agent)}`}${t.account ? ` · <span class="ci-account">${ciEscRaw(t.account)} account</span>` : ''}${model ? ` · ${ciEsc(model)}` : ''}</p>`);

  // Usage limits: Claude Code's from its status line; Codex's plan limits from its record.
  if (claude) {
    parts.push('<div class="section"><div class="panel-head"><h3>Usage limits</h3></div>');
    if (l) {
      if (l.five_hour_pct != null) parts.push(bar('5-hour window', l.five_hour_pct, l.five_hour_reset));
      if (l.seven_day_pct != null) parts.push(bar('Week', l.seven_day_pct, l.seven_day_reset).replace('Resets in', 'Resets'));
      if (l.spend_pct != null) parts.push(bar('Spend limit', l.spend_pct, l.spend_reset, l.spend_usd != null ? `$${l.spend_usd.toFixed(2)} of $${(l.spend_limit_usd || 0).toFixed(0)} this ${ciEsc(l.spend_period || 'period')}` : ''));
    } else {
      parts.push('<p class="muted">Shows after a Claude Code session’s first answer (Pro, Max and team plans; API keys have no such limits).</p>');
    }
    parts.push('</div>');
  } else if (d?.limits?.length) {
    parts.push(`<div class="section"><div class="panel-head"><h3>Usage limits</h3><span class="muted small">${ciEsc(agent)}’s plan</span></div>`);
    for (const x of d.limits) {
      const label = x.minutes === 300 ? '5-hour window' : x.minutes === 10080 ? 'Week' : x.minutes ? `${Math.round(x.minutes / 60)}-hour window` : 'Limit';
      const html = bar(label, x.pct, x.resetsAt && x.resetsAt > Date.now() / 1000 ? x.resetsAt : 0);
      parts.push(x.minutes >= 1440 ? html.replace('Resets in', 'Resets') : html);
    }
    parts.push(`<p class="muted small">As ${ciEsc(agent)} last recorded them.</p></div>`);
  }

  if (!t) {
    parts.push('<div class="section"><p class="muted">Start an agent in a terminal below: its context and where its tokens go show here.</p></div>');
    el.innerHTML = parts.join('');
    return () => {};
  }

  // An agent with nothing Meridian can read: say so (never another agent's session).
  if (d && d.available === false) {
    parts.push(`<div class="section ci-unavailable"><div class="panel-head"><h3>Not available for ${ciEsc(agent)}</h3></div><p class="muted">${ciEsc(d.reason || '')}</p><p class="muted small">Context Insights reads Claude Code, Codex, Qwen Code, Gemini, Copilot and OpenCode sessions.</p></div>`);
    el.innerHTML = parts.join('');
    el.querySelector('#ci-refresh')?.addEventListener('click', () => ciFetch());
    return () => {};
  }

  // Another agent's session not read yet (or not begun): one line, not empty gauges.
  if (!claude && !d) {
    parts.push(`<div class="section"><div class="panel-head"><h3>Context window</h3></div><p class="muted">${ciEsc(CI.error || 'Reading the session…')}</p></div>`);
    el.innerHTML = parts.join('');
    el.querySelector('#ci-refresh')?.addEventListener('click', () => ciFetch());
    return () => {};
  }

  // Context window
  const size = u.context_size || d?.contextSize || 0;
  const used = u.context_tokens ?? d?.contextTokens ?? 0;
  const pct = u.context_pct ?? (size ? (used / size) * 100 : 0);
  parts.push(`<div class="section"><div class="panel-head"><h3>Context window</h3><span class="muted small">${size ? `${ciK(used)} / ${ciK(size)}` : ''}</span></div>`);
  if (d?.contextSizeGuessed && !u.context_size) parts.push(`<p class="muted small">${ciEsc(CI.agent)} doesn’t record its window here: ${ciK(size)} is a guess.</p>`);
  parts.push(`<div class="ci-big ${ciLevel(pct)}">${Math.round(pct)}<small>% used</small></div>`);
  if (d?.breakdown && size) {
    // The parts are estimates from the text; the messages, the rest of Claude Code's exact count.
    const b = { ...d.breakdown };
    const fixed = CI_PARTS.reduce((s, [k]) => s + (k === 'messages' ? 0 : b[k] || 0), 0);
    if (used) b.messages = Math.max(0, used - fixed);
    parts.push('<div class="ci-stack">' + CI_PARTS.map(([k, , c]) => `<i style="width:${((b[k] || 0) / size) * 100}%;background:${c}"></i>`).join('') + '</div>');
    parts.push('<div class="ci-legend">' + CI_PARTS.filter(([k]) => b[k] > 0).map(([k, label, c]) => {
      const v = b[k];
      return `<div class="ci-row"><span><i class="sw" style="background:${c}"></i>${label}</span><span class="muted">${ciK(v)} · ${((v / size) * 100).toFixed(1)}%</span></div>`;
    }).join('') + `<div class="ci-row"><span><i class="sw free"></i>Free space</span><span class="muted">${ciK(Math.max(0, size - used))} · ${(Math.max(0, size - used) / size * 100).toFixed(1)}%</span></div></div>`);
    parts.push(`<p class="muted small">The parts are estimated from the session’s text (about 4 characters a token); the total is ${ciEsc(CI.agent)}’s own count.</p>`);
  }
  const comp = d?.compactions?.length ?? u.compactions ?? 0;
  parts.push(`<p class="muted small">${comp ? `Compacted ${comp}× in this session.` : 'Not compacted yet.'}</p>`);
  if (d?.growth?.length > 1) parts.push(ciGrowth(d, size));
  if (d?.mcpServers?.length) {
    parts.push(ciFold('mcp', `MCP tools · ${ciK(d.breakdown.mcpTools)}`, d.mcpServers.map((s) => `<div class="ci-row"><b>${ciEsc(s.server)}</b><span class="muted">${ciK(s.tokens)}</span></div>` + s.tools.map((x) => `<div class="ci-row sub"><span>${ciEsc(x.name)}</span><span class="muted">${ciK(x.tokens)}</span></div>`).join('')).join('')));
  }
  if (d?.memoryFiles?.length) {
    parts.push(ciFold('memory', `Memory files · ${ciK(d.breakdown.memoryFiles)}`, d.memoryFiles.map((m) => `<div class="ci-row"><span class="ci-path" title="${ciEsc(m.path)}">${ciEsc(m.path)}</span><span class="muted">${ciK(m.tokens)}</span></div>`).join('')));
  }
  parts.push('</div>');

  // Insights
  parts.push('<div class="section"><div class="panel-head"><h3>Insights</h3></div>');
  if (CI.error) parts.push(`<p class="muted">${ciEsc(CI.error)}</p>`);
  else if (!d) parts.push('<p class="muted">Reading the session…</p>');
  else if (!d.insights.length) parts.push('<p class="muted">Nothing stands out: the tokens go where they should.</p>');
  else parts.push(d.insights.map((i) => `<div class="ci-insight ci-${i.level}"><div class="t">${ciEsc(i.title)}</div><div class="muted">${ciEsc(i.detail)}</div></div>`).join(''));
  const cache = u.cache;
  if (cache && cache.requests) {
    const causes = Object.entries(cache.miss_causes || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/_/g, ' ')} ×${v}`).join(', ');
    parts.push(`<div class="ci-insight ${cache.misses ? 'ci-warn' : 'ci-ok'}"><div class="t">Prompt cache: ${ciPct(cache.hit_ratio)} of input read from cache</div><div class="muted">${cache.misses ? `${cache.misses} of ${cache.requests} requests sent cached content again${causes ? ` (${ciEsc(causes)})` : ''}. ` : `No misses in ${cache.requests} requests. `}${cache.warm && cache.expires_at ? `Warm for ${ciIn(cache.expires_at)} more (${ciEsc(cache.ttl || '5m')} cache).` : 'Cold now: the next request writes the context again.'}</div></div>`);
  }
  parts.push('</div>');

  // Where the usage went
  if (d && d.requests) {
    const w = d.spend.weights;
    const kinds = CI_SPEND;
    parts.push(`<div class="section"><div class="panel-head"><h3>Where the usage went</h3><span class="muted small">${d.requests} requests${d.costUsd ? ` · ≈$${d.costUsd.toFixed(2)}` : ''}</span></div>`);
    const tokens = d.unit === 'tokens';
    parts.push('<div class="ci-stack">' + kinds.map(([k, , c]) => `<i style="width:${(w[k] || 0) * 100}%;background:${c}"></i>`).join('') + '</div>');
    parts.push('<div class="ci-legend">' + kinds.filter(([k]) => w[k] > 0.005).map(([k, label, c]) => `<div class="ci-row"><span><i class="sw" style="background:${c}"></i>${label}</span><span class="muted">${ciPct(w[k])}</span></div>`).join('') + '</div>');
    parts.push(claude ? '<p class="muted small">Weighted as limits count them: a cache read is a tenth of plain input, a cache write 1.25×, output 5×.</p>'
      : tokens ? `<p class="muted small">Shares of the tokens ${ciEsc(CI.agent)} recorded. No price is known for this model here, so this counts tokens, not money.</p>`
      : `<p class="muted small">Weighted by the model’s prices in ${ciEsc(CI.agent)}’s price list.</p>`);
    if (d.moneySeries?.length) parts.push(ciMoney(d.moneySeries));
    if (d.tools?.length) parts.push(ciFold('tools', 'By tool', d.tools.map((x) => `<div class="ci-row"><span>${ciEsc(x.name)} <span class="muted">×${x.calls}</span></span><span class="muted">${ciK(x.tokens)} · ${ciPct(x.share)}</span></div>`).join('')));
    if (d.heavyResults?.length) parts.push(ciFold('heavy', 'Heaviest tool results', d.heavyResults.map((x) => `<div class="ci-row"><span class="ci-path" title="${ciEsc(x.target)}">${ciEsc(x.tool)} ${ciEsc(x.target)}</span><span class="muted">${ciK(x.tokens)} ×${x.requests} · ${ciPct(x.share)}</span></div>`).join('')));
    if (d.rereads?.length) parts.push(ciFold('rereads', 'Files read more than once', d.rereads.map((x) => `<div class="ci-row"><span class="ci-path" title="${ciEsc(x.path)}">${ciEsc(x.path)}</span><span class="muted">${x.times}× · ${ciK(x.tokens)}</span></div>`).join('')));
    if (d.prompts?.length) parts.push(ciFold('prompts', 'Costliest prompts', d.prompts.map((x) => `<div class="ci-row"><span class="ci-path" title="${ciEsc(x.text)}">${ciEsc(x.text)}</span><span class="muted">${x.requests} req · ${ciPct(x.share)}</span></div>`).join('')));
    if (d.coldCache?.count) parts.push(ciFold('cold', `Cache went cold ${d.coldCache.count}×`, d.coldCache.list.map((x) => `<div class="ci-row"><span>${new Date(x.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} after ${x.pauseMinutes} min</span><span class="muted">${ciK(x.tokens)} rewritten</span></div>`).join('')));
    parts.push('</div>');
  }

  el.innerHTML = parts.join('');
  el.querySelector('#ci-refresh')?.addEventListener('click', () => ciFetch());
  ciWireMoney(el);
  for (const f of el.querySelectorAll('.ci-fold > button')) {
    f.addEventListener('click', () => {
      const id = f.parentElement.dataset.id;
      if (CI.openSections.has(id)) CI.openSections.delete(id); else CI.openSections.add(id);
      f.parentElement.classList.toggle('open');
    });
  }
  // The reset countdowns and the cache's warmth move on their own.
  const tick = setInterval(() => { if (PRO.activePanel === 'insights') ciRedraw(); }, 30000);
  return () => clearInterval(tick);
}

function ciFold(id, title, body) {
  return `<div class="ci-fold${CI.openSections.has(id) ? ' open' : ''}" data-id="${id}"><button>${icon('chevronRight', 12)}<span>${title}</span></button><div class="ci-fold-body">${body}</div></div>`;
}

const ciUsd = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
const ciTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const ciCauseName = (id) => CI_CAUSES.find(([k]) => k === id)?.[1] || 'Unknown';

// An amount in the chart's unit: dollars, or tokens where no price is known.
const ciAmt = (n) => (CI.unit === 'tokens' ? ciK(n) : ciUsd(n));

// Dollars (or tokens) over the session, each bar coloured by why it cost that.
function ciMoney(series) {
  const sum = (b) => CI_SPEND.reduce((n, [k]) => n + (b[k] || 0), 0);
  const max = Math.max(...series.map(sum)) || 1;
  const peak = series.reduce((a, b) => (sum(b) > sum(a) ? b : a));
  const range = CI.range && CI.range.to < series.length ? CI.range : null;
  const bars = series.map((b, i) => {
    const total = sum(b);
    const kinds = CI_SPEND.filter(([k]) => b[k] > 0).map(([k, label]) => `${label}: ${ciAmt(b[k])}`);
    const causes = CI_CAUSES.filter(([k]) => b.causes?.[k] > 0).map(([k, label]) => `${label}: ${ciAmt(b.causes[k])}`);
    const title = total ? `${ciTime(b.ts)} · ${ciAmt(total)}\n${causes.join('\n')}\n\n${kinds.join('\n')}` : ciTime(b.ts);
    const parts = CI_CAUSES.map(([k, , c]) => (b.causes?.[k] > 0 ? `<i style="height:${(b.causes[k] / max) * 100}%;background:${c}"></i>` : '')).join('');
    const on = range && i >= range.from && i <= range.to;
    return `<div class="bar${on ? ' sel' : ''}" data-i="${i}" title="${ciEsc(title)}">${parts}</div>`;
  }).join('');
  const totals = Object.fromEntries(CI_CAUSES.map(([k]) => [k, series.reduce((n, b) => n + (b.causes?.[k] || 0), 0)]));
  const legend = CI_CAUSES.filter(([k]) => totals[k] > 0).map(([k, label, c]) => `<div class="ci-row"><span><i class="sw" style="background:${c}"></i>${label}</span><span class="muted">${ciAmt(totals[k])}</span></div>`).join('');
  const tokens = CI.unit === 'tokens';
  const agent = ciEsc(CI.agent || 'Claude Code');
  const note = CI.agent === 'Claude Code' || !CI.agent
    ? 'API price: Claude Code’s cost for this session, shared out by usage. On Pro and Max it’s what this work would cost on the API, not a charge. A cause is named only when the transcript shows it.'
    : tokens ? `Tokens: what each request sent, read from the cache and wrote, as ${agent} recorded them. No price is known for this model here, so no money is shown. A cause is named only when the session’s record shows it.`
      : `${agent}’s own cost for each request, from its price list. A cause is named only when the session’s record shows it.`;
  return `<div class="ci-money-head"><span>${tokens ? 'Tokens over time' : 'Cost over time'}</span><span class="muted small">peak ${ciAmt(sum(peak))} at ${ciTime(peak.ts)}</span></div>
    <div class="ci-money" role="img" aria-label="Session ${tokens ? 'tokens' : 'cost'} over time, coloured by cause. Click a bar or drag across bars to see the turns.">${bars}</div>
    <div class="ci-row muted small"><span>${ciTime(series[0].ts)}</span><span>${ciTime(series[series.length - 1].ts)}</span></div>
    <div class="ci-legend">${legend}</div>
    ${range ? ciRange(series, range) : '<p class="muted small">Click a bar or drag across several to see the turns and what made them cost.</p>'}
    <p class="muted small">${note}</p>`;
}

// The selected bars: their turns, the costliest first, and what made them cost.
function ciRange(series, { from, to }) {
  const picked = series.slice(from, to + 1);
  const total = picked.reduce((n, b) => n + CI_SPEND.reduce((m, [k]) => m + (b[k] || 0), 0), 0);
  const count = picked.reduce((n, b) => n + (b.turnCount || 0), 0);
  const listed = picked.flatMap((b) => b.turns || []).sort((a, b) => b.usd - a.usd);
  const shown = listed.slice(0, 30);
  const restUsd = picked.reduce((n, b) => n + (b.moreUsd || 0), 0) + listed.slice(30).reduce((n, t) => n + t.usd, 0);
  const rest = count - shown.length;
  const causes = CI_CAUSES.map(([k, label, c]) => [label, c, picked.reduce((n, b) => n + (b.causes?.[k] || 0), 0)]).filter(([, , v]) => v > 0)
    .map(([label, c, v]) => `<div class="ci-row"><span><i class="sw" style="background:${c}"></i>${label}</span><span class="muted">${ciAmt(v)}</span></div>`).join('');
  const end = series[to + 1]?.ts;
  const when = from === to && !end ? ciTime(series[from].ts) : `${ciTime(series[from].ts)}–${ciTime(end || series[to].ts)}`;
  const turns = shown.map((t) => {
    const colour = CI_CAUSES.find(([k]) => k === t.cause)?.[2] || '#7c7c88';
    return `<div class="ci-turn"><div class="ci-row"><span><i class="sw" style="background:${colour}"></i>Turn ${t.index} · ${ciEsc(ciCauseName(t.cause))}</span><b>${ciAmt(t.usd)}</b></div>${t.why ? `<div class="muted small">${ciEsc(t.why)}</div>` : ''}${t.prompt ? `<div class="muted small ci-path" title="${ciEsc(t.prompt)}">${ciEsc(t.prompt)}</div>` : ''}</div>`;
  }).join('');
  return `<div class="ci-range"><div class="ci-range-head"><b>${when} · ${count} ${count === 1 ? 'turn' : 'turns'} · ${ciAmt(total)}</b><button class="ci-range-clear">Clear</button></div>
    <div class="ci-legend">${causes}</div>${turns || '<p class="muted small">No turns of the main session here.</p>'}
    ${rest > 0 ? `<p class="muted small">And ${rest} smaller ${rest === 1 ? 'turn' : 'turns'}, ${ciAmt(restUsd)}.</p>` : ''}</div>`;
}

// A click picks one bar (again: clears it); a drag picks a range.
function ciWireMoney(el) {
  const chart = el.querySelector('.ci-money');
  el.querySelector('.ci-range-clear')?.addEventListener('click', () => { CI.range = null; renderPanel(); });
  if (!chart) return;
  const bars = [...chart.querySelectorAll('.bar')];
  const barAt = (x) => {
    const r = chart.getBoundingClientRect();
    return Math.max(0, Math.min(bars.length - 1, Math.floor(((x - r.left) / r.width) * bars.length)));
  };
  const paint = (from, to) => bars.forEach((b, i) => b.classList.toggle('sel', i >= from && i <= to));
  chart.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const anchor = barAt(e.clientX);
    const was = CI.range;
    let at = anchor;
    CI.dragging = true;
    chart.setPointerCapture(e.pointerId);
    paint(anchor, anchor);
    const move = (m) => { at = barAt(m.clientX); paint(Math.min(anchor, at), Math.max(anchor, at)); };
    const up = () => {
      chart.removeEventListener('pointermove', move);
      chart.removeEventListener('pointerup', up);
      chart.removeEventListener('pointercancel', up);
      CI.dragging = false;
      CI.redrawAfterDrag = false;
      const same = at === anchor && was && was.from === anchor && was.to === anchor;
      CI.range = same ? null : { from: Math.min(anchor, at), to: Math.max(anchor, at) };
      renderPanel();
    };
    chart.addEventListener('pointermove', move);
    chart.addEventListener('pointerup', up);
    chart.addEventListener('pointercancel', up);
  });
}

// How the context grew, with the compactions marked.
function ciGrowth(d, size) {
  const pts = d.growth;
  const t0 = pts[0].ts, t1 = pts[pts.length - 1].ts || t0 + 1;
  const max = Math.max(size || 0, ...pts.map((p) => p.tokens)) || 1;
  const x = (ts) => ((ts - t0) / Math.max(1, t1 - t0)) * 280;
  const y = (v) => 56 - (v / max) * 52;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.tokens).toFixed(1)}`).join('');
  const marks = (d.compactions || []).filter((c) => c.ts >= t0).map((c) => `<line x1="${x(c.ts).toFixed(1)}" x2="${x(c.ts).toFixed(1)}" y1="2" y2="58" class="cmp"><title>Compacted: ${ciK(c.before)} → ${ciK(c.after)}</title></line>`).join('');
  return `<svg class="ci-growth" viewBox="0 0 280 60" preserveAspectRatio="none" role="img" aria-label="Context size over the session">${marks}<path d="${line}"/></svg>`;
}

// ------------------------------------------------------------------ other agents' records

// A non-Claude session's context, for the gauge on its tab.
function ciNoteContext(id, data) {
  const t = S.terms.find((x) => x.id === id);
  if (!t || ciIsClaude(t) || !data || data.available === false || !data.contextSize || !data.requests) return;
  const next = { context_pct: (data.contextTokens / data.contextSize) * 100, context_tokens: data.contextTokens, context_size: data.contextSize, compactions: data.compactions?.length || 0 };
  if (JSON.stringify(CI.ctx[id]) === JSON.stringify(next)) return;
  CI.ctx[id] = next;
  if (typeof renderTermTabs === 'function') renderTermTabs();
}

// Every 15 s: the open panel's session (if it isn't Claude Code's, which its status line updates)
// and the gauges of the other agents' tabs. Their records only grow, so each read is short.
async function ciPoll() {
  if (typeof wb?.contextInsights !== 'function') return;
  const shown = PRO.activePanel === 'insights' ? ciTerm() : null;
  if (shown && !ciIsClaude(shown) && !CI.loading && !CI.dragging) await ciFetch();
  for (const t of S.terms.filter((x) => CI_RECORDS.has(x.kind) && !x.closed && x !== shown)) {
    try { ciNoteContext(t.id, await wb.contextInsights(t.id, {})); } catch { /* no session yet */ }
  }
}

BUILTIN_PANELS.insights = { title: 'Insights', icon: 'clock', render: renderInsightsPanel };

document.addEventListener('DOMContentLoaded', () => {
  renderLimitsChip();
  setInterval(ciPoll, 15000);
});

// "All accounts · Work · Personal": which subscription's sessions (and limits) the panel shows.
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('.ci-accounts [data-account]');
  if (!b) return;
  CI.account = b.dataset.account || '';
  CI.range = null;
  ciRedraw();
});
