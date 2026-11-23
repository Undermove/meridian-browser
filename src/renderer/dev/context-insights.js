/* Meridian Workbench — usage limits and Context Insights for Claude Code sessions.
 *
 * The numbers come from Claude Code's own status line (Meridian runs it for Workbench sessions):
 * context used and the window's size, the 5-hour and weekly usage limits, prompt cache statistics,
 * the session's name. They arrive with Mission Control's updates (wb:command { type: 'mission',
 * usage: { <terminal id>: {...} } }). Context Insights reads the session's transcript in the browser
 * (wb.contextInsights) and says what the context holds and where the tokens went. All of it stays
 * on this computer.
 */

const CI = { usage: {}, termId: null, data: null, error: '', loading: false, timer: 0, lastFetch: 0, openSections: new Set() };

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

const ciK = (n) => {
  n = Number(n) || 0;
  const trim = (x) => x.replace(/\.0$/, '');
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(n >= 1e7 ? 0 : 1))}M`;
  if (n >= 1000) return `${trim((n / 1000).toFixed(n >= 1e5 ? 0 : 1))}k`;
  return String(Math.round(n));
};
const ciPct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
const ciEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ciIn(seconds) {
  const s = Math.max(0, Math.round(seconds - Date.now() / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) { const m = Math.round(s / 60); return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`; }
  const d = new Date(seconds * 1000);
  return d.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function ciLevel(pct) { return pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok'; }

// The usage limits are the account's, so any session's latest numbers do; the freshest one wins.
function ciLimits() {
  let best = null;
  for (const u of Object.values(CI.usage)) {
    if (u.five_hour_pct == null && u.seven_day_pct == null && u.spend_pct == null) continue;
    if (!best || (u.five_hour_reset || 0) >= (best.five_hour_reset || 0)) best = u;
  }
  return best;
}

// The terminal the panel is about: the active one if it's a Claude Code session, else the last one.
function ciTerm() {
  const claude = S.terms.filter((t) => t.kind === 'claude' || t.kind === 'sandbox-claude');
  if (S.activeTerm && claude.includes(S.activeTerm)) return S.activeTerm;
  return claude.find((t) => t.id === CI.termId) || claude[claude.length - 1] || null;
}

// ------------------------------------------------------------------ live numbers

function insightsUsage(usage) {
  const before = JSON.stringify(CI.usage);
  CI.usage = usage && typeof usage === 'object' ? usage : {};
  if (JSON.stringify(CI.usage) === before) return;
  renderLimitsChip();
  if (typeof renderTermTabs === 'function') renderTermTabs();
  if (PRO.activePanel === 'insights') {
    renderPanel();
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

// The context gauge on a Claude Code terminal's tab.
function termUsageBadge(t) {
  const u = CI.usage[t.id];
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

async function ciFetch() {
  const t = ciTerm();
  if (!t || typeof wb.contextInsights !== 'function') return;
  CI.loading = true;
  CI.lastFetch = Date.now();
  const id = t.id;
  try {
    const data = await wb.contextInsights(id, { contextSize: CI.usage[id]?.context_size });
    if (ciTerm()?.id === id) { CI.data = data; CI.dataTerm = id; CI.error = ''; }
  } catch (e) {
    CI.error = String(e?.message || e).replace(/^Error: /, '');
  }
  CI.loading = false;
  if (PRO.activePanel === 'insights') renderPanel();
}

function renderInsightsPanel(el) {
  const t = ciTerm();
  if (t && CI.dataTerm !== t.id && !CI.loading) { CI.data = null; ciFetch(); }
  const u = t ? CI.usage[t.id] || {} : {};
  const d = CI.dataTerm === t?.id ? CI.data : null;
  const l = ciLimits();
  const parts = [];

  parts.push(`<div class="panel-head"><h2>Context Insights</h2>${t ? `<button class="icon-btn small" id="ci-refresh" title="Read the session again">${icon('reload', 13)}</button>` : ''}</div>`);
  if (t) parts.push(`<p class="muted ci-session">${ciEsc(termName(t))}${u.model ? ` · ${ciEsc(u.model)}` : ''}</p>`);

  // Usage limits
  parts.push('<div class="section"><div class="panel-head"><h3>Usage limits</h3></div>');
  if (l) {
    const bar = (label, pct, reset, sub) => `<div class="ci-limit"><div class="ci-row"><span>${label}</span><b>${Math.round(pct)}%</b></div><div class="ci-bar ${ciLevel(pct)}"><i style="width:${Math.min(100, pct)}%"></i></div><div class="muted small">${sub || (reset ? `Resets in ${ciIn(reset)}` : '')}</div></div>`;
    if (l.five_hour_pct != null) parts.push(bar('5-hour window', l.five_hour_pct, l.five_hour_reset));
    if (l.seven_day_pct != null) parts.push(bar('Week', l.seven_day_pct, l.seven_day_reset).replace('Resets in', 'Resets'));
    if (l.spend_pct != null) parts.push(bar('Spend limit', l.spend_pct, l.spend_reset, l.spend_usd != null ? `$${l.spend_usd.toFixed(2)} of $${(l.spend_limit_usd || 0).toFixed(0)} this ${ciEsc(l.spend_period || 'period')}` : ''));
  } else {
    parts.push('<p class="muted">Shows after a Claude Code session’s first answer (Pro, Max and team plans; API keys have no such limits).</p>');
  }
  parts.push('</div>');

  if (!t) {
    parts.push('<div class="section"><p class="muted">Start Claude Code in a terminal below: its context and where its tokens go show here.</p></div>');
    el.innerHTML = parts.join('');
    return () => {};
  }

  // Context window
  const size = u.context_size || d?.contextSize || 0;
  const used = u.context_tokens ?? d?.contextTokens ?? 0;
  const pct = u.context_pct ?? (size ? (used / size) * 100 : 0);
  parts.push(`<div class="section"><div class="panel-head"><h3>Context window</h3><span class="muted small">${size ? `${ciK(used)} / ${ciK(size)}` : ''}</span></div>`);
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
    parts.push('<p class="muted small">The parts are estimated from the session’s text (about 4 characters a token); the total is Claude Code’s own count.</p>');
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
    parts.push('<div class="ci-stack">' + kinds.map(([k, , c]) => `<i style="width:${(w[k] || 0) * 100}%;background:${c}"></i>`).join('') + '</div>');
    parts.push('<div class="ci-legend">' + kinds.filter(([k]) => w[k] > 0.005).map(([k, label, c]) => `<div class="ci-row"><span><i class="sw" style="background:${c}"></i>${label}</span><span class="muted">${ciPct(w[k])}</span></div>`).join('') + '</div>');
    parts.push('<p class="muted small">Weighted as limits count them: a cache read is a tenth of plain input, a cache write 1.25×, output 5×.</p>');
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
  for (const f of el.querySelectorAll('.ci-fold > button')) {
    f.addEventListener('click', () => {
      const id = f.parentElement.dataset.id;
      if (CI.openSections.has(id)) CI.openSections.delete(id); else CI.openSections.add(id);
      f.parentElement.classList.toggle('open');
    });
  }
  // The reset countdowns and the cache's warmth move on their own.
  const tick = setInterval(() => { if (PRO.activePanel === 'insights') renderPanel(); }, 30000);
  return () => clearInterval(tick);
}

function ciFold(id, title, body) {
  return `<div class="ci-fold${CI.openSections.has(id) ? ' open' : ''}" data-id="${id}"><button>${icon('chevronRight', 12)}<span>${title}</span></button><div class="ci-fold-body">${body}</div></div>`;
}

// Dollars over the session, split the same way as the bar above.
function ciMoney(series) {
  const sum = (b) => CI_SPEND.reduce((n, [k]) => n + (b[k] || 0), 0);
  const usd = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
  const time = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const max = Math.max(...series.map(sum)) || 1;
  const peak = series.reduce((a, b) => (sum(b) > sum(a) ? b : a));
  const bars = series.map((b) => {
    const total = sum(b);
    const lines = CI_SPEND.filter(([k]) => b[k] > 0).map(([k, label]) => `${label}: ${usd(b[k])}`);
    const title = total ? `${time(b.ts)} · ${usd(total)}\n${lines.join('\n')}` : time(b.ts);
    const parts = CI_SPEND.map(([k, , c]) => (b[k] > 0 ? `<i style="height:${(b[k] / max) * 100}%;background:${c}"></i>` : '')).join('');
    return `<div class="bar" title="${ciEsc(title)}">${parts}</div>`;
  }).join('');
  return `<div class="ci-money-head"><span>Cost over time</span><span class="muted small">peak ${usd(sum(peak))} at ${time(peak.ts)}</span></div>
    <div class="ci-money" role="img" aria-label="Session cost over time, by kind of usage">${bars}</div>
    <div class="ci-row muted small"><span>${time(series[0].ts)}</span><span>${time(series[series.length - 1].ts)}</span></div>
    <p class="muted small">Claude Code’s cost for this session, shared out by usage. On Pro and Max it’s the API price of this work, not a charge.</p>`;
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

BUILTIN_PANELS.insights = { title: 'Insights', icon: 'clock', render: renderInsightsPanel };

document.addEventListener('DOMContentLoaded', () => renderLimitsChip());
