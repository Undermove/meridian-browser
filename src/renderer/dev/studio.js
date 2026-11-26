/* Meridian Studio — the Workbench's Claude Code sessions as a chat, for people who don't use a
 * terminal (designers, managers). A second view of the same page and the same terminals: the
 * "Студия | Workbench" switch shows one or the other, the session goes on underneath.
 *
 *   task list (each Claude Code terminal) | chat: steps in plain words, questions as cards, files |
 *   result: the site (in split view, Boost До/После + undo), pictures and documents
 *
 * Inert unless Meridian has Studio on (wb.studioInfo().enabled). Uses workbench.js's globals
 * (S, launch, termName, activateTerm, pickProject, openRecent, toast…), studio-words.js and
 * studio-transcript.js. Every text from the session is set with textContent or esc().
 */

const ST = {
  on: false,
  lang: /^ru\b/i.test(navigator.language || '') ? 'ru' : 'en',
  persona: 'designer',
  view: 'studio',        // 'studio' | 'workbench'
  current: '',           // the task (terminal id) shown
  tasks: new Map(),      // term id -> task state
  mission: {},           // term id -> Mission Control's status, questions, steps
  preview: null,         // { kind: 'file' | 'shot', key }
  timer: null,
  el: null,
  sending: false,
};
const STW = () => StudioWords.T[ST.lang];

function stTask(t) {
  let k = ST.tasks.get(t.id);
  if (!k) {
    k = { id: t.id, model: StudioTranscript.newModel(), offset: 0, loaded: false, queue: [], answered: [], seen: true,
      lastStatus: '', site: '', boost: null, siteOpened: false, thumbs: new Map(), reading: false };
    ST.tasks.set(t.id, k);
  }
  return k;
}

const stTerms = () => (typeof S !== 'undefined' ? S.terms.filter((t) => t.kind === 'claude' && !t.closed) : []);
const stCurrent = () => stTerms().find((t) => t.id === ST.current) || null;
const stReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- status (shared with the chats list)

// The four dots of the Workbench chats list. That module (when it's there) decides; else Mission
// Control's state for the terminal: a question → needs you; running → working; finished and not
// looked at → done; otherwise nothing.
function stStatus(t) {
  // The chats list's module (session-status.js), when this build has it.
  if (typeof SessionStatus !== 'undefined' && SessionStatus?.get) {
    try {
      const s = SessionStatus.get(t.id)?.state;
      if (s) return s === 'working' ? 'work' : s;
    } catch {}
  }
  const m = ST.mission[t.id];
  const k = ST.tasks.get(t.id);
  if (t.exited) return 'idle';
  if (m?.asks?.length || m?.status === 'waiting') return 'needs';
  if (m && ['thinking', 'tool', 'starting'].includes(m.status)) return m.status === 'starting' && !k?.model.turns.length ? 'idle' : 'work';
  if (k && !k.seen) return 'done';
  return 'idle';
}

function stDot(status) {
  if (status === 'work') return '<span class="st-dot work" aria-label="working"><svg viewBox="0 0 12 12" width="12" height="12"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width="1.7"/><path d="M6 1.4a4.6 4.6 0 0 1 4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>';
  return `<span class="st-dot ${status}"></span>`;
}

// ---------------------------------------------------------------- boot + switching

async function studioBoot() {
  if (typeof wb.studioInfo !== 'function') return;
  let info;
  try { info = await wb.studioInfo(); } catch { return; }
  if (!info?.enabled) return;
  ST.on = true;
  if (['designer', 'manager', 'developer', 'everyday'].includes(info.persona)) ST.persona = info.persona;
  document.body.classList.add('studio-on');
  stBuild();
  stSwitchInTopbar();
  const wanted = new URL(location.href).searchParams.get('view');
  stShow(wanted === 'workbench' ? 'workbench' : wanted === 'studio' || ST.persona !== 'developer' ? 'studio' : 'workbench');
  bus.addEventListener('project', () => { stRender(); });
  if (typeof SessionStatus !== 'undefined' && SessionStatus?.onChange) SessionStatus.onChange(() => stRender());
  document.addEventListener('visibilitychange', stReport);
  ST.timer = setInterval(stTick, 700);
  stTick();
}

function studioHostCommand(msg) {
  if (!ST.on || !msg) return;
  if (msg.type === 'mission' && msg.studio && typeof msg.studio === 'object') {
    const before = ST.mission;
    ST.mission = msg.studio;
    for (const t of stTerms()) {
      const k = stTask(t);
      const was = stStatusFrom(before[t.id]);
      const now = stStatusFrom(ST.mission[t.id]);
      // Finished while the person looked elsewhere: a blue dot until they open it.
      if (was === 'work' && now !== 'work' && !(ST.view === 'studio' && ST.current === t.id && !document.hidden)) k.seen = false;
      if (now === 'idle' && k.queue.length) stFlush(t);
    }
    stRender();
  }
}

const stStatusFrom = (m) => (!m ? '' : m.asks?.length || m.status === 'waiting' ? 'needs' : ['thinking', 'tool'].includes(m.status) ? 'work' : 'idle');

function stShow(view) {
  ST.view = view;
  const studio = view === 'studio';
  ST.el.hidden = !studio;
  document.body.classList.toggle('studio-view', studio);
  for (const b of document.querySelectorAll('.st-switch button')) {
    const on = b.dataset.view === view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  try { const u = new URL(location.href); u.searchParams.set('view', view); history.replaceState(history.state, '', u.href); } catch {}
  if (!studio) window.dispatchEvent(new Event('studio-hidden'));
  stFavicon(studio);
  stReport();
  if (studio) {
    document.title = (stCurrent() && stTitle(stCurrent())) || STW().studio;
    stRender();
    setTimeout(() => $('#st-input')?.focus(), 0);
  } else {
    document.title = S.project?.name || 'Workbench';
    // The same session, in its terminal.
    const t = stCurrent();
    if (t && typeof activateTerm === 'function') { $('#term-area')?.classList.remove('collapsed'); activateTerm(t); }
  }
}

// Tells Meridian which session is on screen (its "done, not seen" dot), while Studio is in sight.
let stReported = '';
function stReport() {
  if (typeof SessionStatus === 'undefined' || !SessionStatus?.report) return;
  if (ST.view !== 'studio') { stReported = ''; return; }
  const msg = { on: true, onScreen: document.hidden ? '' : ST.current || '', order: stTerms().map((t) => t.id) };
  const key = JSON.stringify(msg);
  if (key === stReported) return;
  stReported = key;
  try { SessionStatus.report(msg); } catch {}
}

// The tab's icon: Studio's sparkle while Studio shows, the Workbench's </> otherwise.
let stWorkbenchIcon = null;
function stFavicon(studio) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (stWorkbenchIcon === null) stWorkbenchIcon = link.getAttribute('href');
  link.setAttribute('href', studio
    ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%237c7fe0'/%3E%3Cpath d='M16 7.5l2.2 5.6 5.6 2.2-5.6 2.2L16 23.1l-2.2-5.6-5.6-2.2 5.6-2.2z' fill='white'/%3E%3C/svg%3E"
    : stWorkbenchIcon);
}

function stSwitchHtml() {
  const w = STW();
  return `<div class="st-switch" role="tablist" aria-label="${esc(w.studio)} / ${esc(w.workbench)}">
    <button role="tab" data-view="studio">${icon('sparkles', 13)}<span>${esc(w.studio)}</span></button>
    <button role="tab" data-view="workbench">${icon('code', 13)}<span>${esc(w.workbench)}</span></button></div>`;
}

// The same switch in the Workbench's own top bar, to come back.
function stSwitchInTopbar() {
  const bar = $('#topbar');
  if (!bar || $('.st-switch', bar)) return;
  const holder = document.createElement('div');
  holder.innerHTML = stSwitchHtml();
  const sw = holder.firstElementChild;
  sw.classList.add('in-topbar');
  bar.insertBefore(sw, bar.querySelector('.grow'));
  sw.addEventListener('click', stOnSwitch);
}

function stOnSwitch(e) {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  if (b.dataset.view === 'workbench' && !ST.current && stTerms().length) ST.current = stTerms()[0].id;
  stShow(b.dataset.view);
}

// ---------------------------------------------------------------- the page

function stBuild() {
  const w = STW();
  const el = document.createElement('section');
  el.id = 'studio';
  el.hidden = true;
  el.lang = ST.lang;
  el.innerHTML = `
    <header class="st-head">
      <div class="st-titles"><span class="st-ttl" id="st-title"></span><span class="st-sub" id="st-sub"></span></div>
      <div class="grow"></div>
      ${stSwitchHtml()}
    </header>
    <div class="st-body">
      <aside class="st-tasks" aria-label="${esc(w.tasks)}">
        <button class="st-new" id="st-new">${icon('plus', 14)}<span>${esc(w.newTask)}</span></button>
        <div class="st-task-list" id="st-task-list" role="list"></div>
      </aside>
      <div class="st-chat">
        <div class="st-resultbar" id="st-resultbar" hidden></div>
        <div class="st-feed" id="st-feed" aria-live="polite"></div>
        <div class="st-composer">
          <div class="st-chips" id="st-chips"></div>
          <form class="st-input" id="st-form">
            <textarea id="st-input" rows="1" placeholder="${esc(w.placeholder)}" aria-label="${esc(w.placeholder)}"></textarea>
            <div class="st-input-row"><div class="grow"></div>
              <button type="submit" class="st-send" id="st-send" title="${esc(w.send)}" aria-label="${esc(w.send)}">${icon('arrowUp', 16)}</button></div>
          </form>
        </div>
      </div>
      <div class="st-result" id="st-result"></div>
    </div>
    <div class="st-pick" id="st-pick" hidden></div>`;
  document.body.appendChild(el);
  ST.el = el;
  $('.st-switch', el).addEventListener('click', stOnSwitch);
  $('#st-new', el).addEventListener('click', () => { ST.current = ''; ST.preview = null; stRender(); $('#st-input').focus(); });
  $('#st-task-list', el).addEventListener('click', (e) => {
    const row = e.target.closest('[data-term]');
    if (!row) return;
    ST.current = row.dataset.term;
    ST.preview = null;
    const k = ST.tasks.get(ST.current);
    if (k) k.seen = true;
    stRender();
  });
  $('#st-form', el).addEventListener('submit', (e) => { e.preventDefault(); stSubmit(); });
  $('#st-input', el).addEventListener('input', () => { stGrow(); stRenderSend(stCurrent()); });
  $('#st-input', el).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); stSubmit(); }
  });
  $('#st-chips', el).addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    const input = $('#st-input');
    input.value = c.dataset.chip;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  $('#st-feed', el).addEventListener('click', stOnFeedClick);
  $('#st-result', el).addEventListener('click', stOnResultClick);
  $('#st-resultbar', el).addEventListener('click', stOnResultBarClick);
  // Pressed look (scale .97) for every button, by pointer only: keys don't animate.
  el.addEventListener('pointerdown', (e) => { const b = e.target.closest('button'); if (b) b.classList.add('st-press'); });
  addEventListener('pointerup', () => { for (const b of el.querySelectorAll('.st-press')) b.classList.remove('st-press'); });
}

function stGrow() {
  const i = $('#st-input');
  if (!i) return;
  i.style.height = 'auto';
  i.style.height = `${Math.min(160, i.scrollHeight)}px`;
}

function stTitle(t) {
  const k = ST.tasks.get(t.id);
  const name = t.custom || k?.model.title || (typeof termName === 'function' && t.auto ? t.auto : '');
  const first = k?.model.turns.find((x) => x.prompt)?.prompt || '';
  const pick = name && !/^claude( code)?$/i.test(name) && !/^\*?\s*claude/i.test(name) ? name : first;
  const one = (pick || STW().taskFallback).replace(/\s+/g, ' ').trim();
  return one.length > 48 ? `${one.slice(0, 47).replace(/[\s,.:;—-]+\S*$/, '')}…` : one;
}

function stRender() {
  if (!ST.on || !ST.el || ST.view !== 'studio') return;
  const w = STW();
  if (!S.project) return stRenderPick();
  $('#st-pick').hidden = true;
  $('.st-body', ST.el).hidden = false;
  const terms = stTerms();
  if (ST.current && !terms.some((t) => t.id === ST.current)) ST.current = '';
  const t = stCurrent();
  $('#st-title').textContent = t ? stTitle(t) : w.newTask;
  $('#st-sub').textContent = `${S.project.name} · ${w.claude}`;
  document.title = t ? stTitle(t) : w.studio;
  stRenderTasks(terms);
  stRenderFeed(t);
  stRenderChips(t);
  stRenderResult(t);
  stRenderResultBar(t);
  stRenderSend(t);
  stReport();
}

// While Claude works and nothing is typed, the send button stops it (Esc, as in the terminal).
function stRenderSend(t) {
  const b = $('#st-send');
  const stop = !!t && stStatus(t) === 'work' && !$('#st-input').value.trim();
  if (b.classList.contains('stop') === stop) return;
  b.classList.toggle('stop', stop);
  b.innerHTML = icon(stop ? 'stop' : 'arrowUp', 16);
  b.title = stop ? STW().stop : STW().send;
  b.setAttribute('aria-label', b.title);
}

function stRenderPick() {
  const w = STW();
  $('.st-body', ST.el).hidden = true;
  const pick = $('#st-pick');
  pick.hidden = false;
  const recents = (S.info?.recents || []).slice(0, 5);
  pick.innerHTML = `<div class="st-pick-card">
    <div class="st-pick-ic">${icon('folder', 26)}</div>
    <h2>${esc(w.pickFolder)}</h2><p>${esc(w.pickFolderHint)}</p>
    <button class="st-btn pri" data-a="choose">${esc(w.chooseFolder)}</button>
    ${recents.length ? `<div class="st-recents"><div class="st-label">${esc(w.recent)}</div>${recents.map((r) => `<button class="st-recent" data-path="${esc(r.root || r.path || '')}">${icon('folder', 14)}<span>${esc(r.name || basename(r.root || r.path || ''))}</span></button>`).join('')}</div>` : ''}
  </div>`;
  pick.onclick = (e) => {
    if (e.target.closest('[data-a="choose"]')) pickProject();
    const r = e.target.closest('[data-path]');
    if (r?.dataset.path) openRecent(r.dataset.path);
  };
}

function stRenderTasks(terms) {
  const list = $('#st-task-list');
  const html = terms.map((t) => {
    const s = stStatus(t);
    return `<div class="st-task ${s}${t.id === ST.current ? ' active' : ''}" role="listitem" data-term="${esc(t.id)}" tabindex="0">${stDot(s)}<span class="st-task-name">${esc(stTitle(t))}</span></div>`;
  }).join('');
  if (list.dataset.html !== html) { list.innerHTML = html; list.dataset.html = html; }
  $('#st-new').classList.toggle('active', !ST.current);
}

function stAgo(at) {
  if (!at) return '';
  return STW().minutes(Math.max(0, Math.round((Date.now() - at) / 60000)));
}

// The chat: each turn as the person's message, then Claude's text and steps in order; the open
// question as a card; the files at the end.
function stRenderFeed(t) {
  const w = STW();
  const feed = $('#st-feed');
  if (!t) {
    const html = `<div class="st-empty"><div class="st-empty-ic">${icon('sparkles', 22)}</div><h2>${esc(w.emptyTitle)}</h2><p>${esc(w.emptyHint)}</p></div>`;
    if (feed.dataset.html !== html) { feed.innerHTML = html; feed.dataset.html = html; }
    return;
  }
  const k = stTask(t);
  const m = k.model;
  const mission = ST.mission[t.id] || {};
  const status = stStatus(t);
  const progress = StudioTranscript.planProgress(m.plan);
  const parts = [];
  if (!t.studio && m.turns.length) parts.push(`<div class="st-note">${esc(w.startedInWorkbench)}</div>`);
  m.turns.forEach((turn, ti) => {
    if (turn.prompt) parts.push(`<div class="st-msg-user" data-key="u${ti}">${esc(turn.prompt)}</div>`);
    if (turn.items.length) {
      parts.push(`<div class="st-who" data-key="w${ti}"><span class="st-av">${icon('sparkles', 12)}</span>${esc(w.claude)}<span class="st-when">· ${esc(stAgo(turn.items[0].at || turn.at))}</span></div>`);
    }
    const last = ti === m.turns.length - 1;
    const answeredHere = k.answered.filter((x) => x.turn === ti);
    const answeredHtml = (a) => `<div class="st-answered ${a.choice === 'deny' ? 'no' : 'yes'}" data-key="a${esc(a.id)}">${icon(a.choice === 'deny' ? 'x' : 'check', 13)}<span>${esc(a.choice === 'deny' ? w.denied : w.allowed)}: ${esc(a.title)}</span></div>`;
    turn.items.forEach((it, ii) => {
      // An answer goes right after what was there when it was given.
      for (const a of answeredHere.filter((x) => x.after === ii)) parts.push(answeredHtml(a));
      if (it.type === 'text') parts.push(`<div class="st-say" data-key="t${ti}.${ii}">${stText(it.text)}</div>`);
      else if (it.type === 'steps') {
        // The plan itself isn't a step: it shows as "step i of n" on the step being done.
        const steps = it.steps.filter((s) => s.tool !== 'TodoWrite');
        if (steps.length) parts.push(`<div class="st-steps" data-key="s${ti}.${ii}">${steps.map((s) => stStepHtml(s, last && (status === 'work' || status === 'needs'), progress, status)).join('')}</div>`);
      }
    });
    for (const a of answeredHere.filter((x) => x.after >= turn.items.length)) parts.push(answeredHtml(a));
  });
  for (const q of k.queue) parts.push(`<div class="st-msg-user queued" data-key="q${esc(q.id)}">${esc(q.text)}<span class="st-queued">${esc(w.queued)}</span></div>`);
  if (k.trust) {
    parts.push(`<div class="st-ask" data-key="trust" data-title="${esc(w.trustTitle)}">
      <div class="st-ask-q">${stDot('needs')}<span>${esc(w.trustTitle)}</span></div>
      <div class="st-ask-d">${esc(w.trustDetail(S.project?.name || ''))}</div>
      <div class="st-ask-btns"><button class="st-btn pri" data-trust="yes">${esc(w.allow)}</button><button class="st-btn" data-trust="no">${esc(w.no)}</button></div></div>`);
  }
  for (const ask of mission.asks || []) parts.push(stAskHtml(ask));
  if (status === 'work' && !(mission.asks || []).length && !stHasRunningStep(m)) {
    parts.push(`<div class="st-thinking" data-key="thinking"><span class="st-shimmer">${esc(progress?.now || w.working)}</span></div>`);
  }
  const files = stFiles(k);
  if (files.length) {
    parts.push(`<div class="st-files-l" data-key="fl">${esc(w.filesTitle)}</div><div class="st-files" data-key="files">${files.map((f, i) => stFileCard(k, f, i)).join('')}</div>`);
  }
  const html = parts.join('');
  if (feed.dataset.html === html) return;
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60 || feed.dataset.term !== t.id;
  // Keyed morph: what was there stays (no animation again), new parts come in with theirs.
  const old = new Map([...feed.children].filter((c) => c.dataset.key).map((c) => [c.dataset.key, c]));
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const next = [...tmp.children];
  const firstPaint = feed.dataset.term !== t.id;
  feed.dataset.term = t.id;
  feed.replaceChildren(...next.map((n) => {
    const o = old.get(n.dataset.key);
    if (o && o.outerHTML === n.outerHTML) return o;
    if (o) { stMorph(o, n); return o; }
    if (!firstPaint) n.classList.add('st-in');
    return n;
  }));
  feed.dataset.html = html;
  stLoadThumbs(k);
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

// Same element, new content: steps keep their rows so a spinner turns into a check in place.
function stMorph(o, n) {
  if (o.classList.contains('st-steps')) {
    const rows = new Map([...o.children].map((c) => [c.dataset.step, c]));
    o.replaceChildren(...[...n.children].map((c) => {
      const r = rows.get(c.dataset.step);
      if (!r) { c.classList.add('st-in'); return c; }
      if (r.outerHTML !== c.outerHTML) {
        if (r.classList.contains('running') && c.classList.contains('ok')) c.classList.add('st-ticked');
        return c;
      }
      return r;
    }));
    return;
  }
  if (o.classList.contains('st-files')) {
    const cards = new Map([...o.children].map((c) => [c.dataset.file, c]));
    o.replaceChildren(...[...n.children].map((c, i) => {
      const r = cards.get(c.dataset.file);
      if (r && r.dataset.sig === c.dataset.sig) return r;
      if (!r) { c.classList.add('st-in'); c.style.setProperty('--i', String(Math.min(i, 5))); }
      return c;
    }));
    return;
  }
  o.className = n.className;
  o.innerHTML = n.innerHTML;
}

function stHasRunningStep(m) {
  const turn = m.turns[m.turns.length - 1];
  return !!turn?.items.some((it) => it.type === 'steps' && it.steps.some((s) => s.state === 'running'));
}

// Light formatting of Claude's text: paragraphs, **bold**, `code` shown plain, lists.
function stText(text) {
  const lines = String(text).split('\n');
  let out = '', list = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (li) { if (!list) { out += '<ul>'; list = true; } out += `<li>${stInline(li[1])}</li>`; continue; }
    if (list) { out += '</ul>'; list = false; }
    if (!line.trim()) continue;
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    out += h ? `<p class="h">${stInline(h[1])}</p>` : `<p>${stInline(line)}</p>`;
  }
  if (list) out += '</ul>';
  return out;
}
const stInline = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '$1');

function stStepHtml(s, live, progress, status = 'work') {
  const [ic, done, doing] = StudioWords.stepWords(s.tool, s.input, ST.lang);
  let text = s.state === 'running' ? doing : done;
  if (s.state === 'running' && progress && live && progress.total > 1) {
    text += ` — ${STW().step(progress.index, progress.total)}`;
  }
  const state = s.state === 'running' && !live ? 'stopped' : s.state;
  const mark = state === 'ok' ? `<span class="st-ok">${icon('check', 14)}</span>`
    : state === 'running' ? stDot(status === 'needs' ? 'needs' : 'work')
      : state === 'denied' ? `<span class="st-no">${icon('x', 13)}</span>`
        : state === 'error' ? `<span class="st-no">${icon('x', 13)}</span>` : '';
  return `<div class="st-step ${state}" data-step="${esc(s.id)}"><span class="st-si">${icon(ic, 13)}</span><span class="st-st">${esc(text)}</span>${mark}</div>`;
}

function stAskHtml(ask) {
  const w = STW();
  const [title, detail] = StudioWords.askWords(ask.tool, ask.summary, ST.lang);
  const showDetail = ask.summary && (ask.tool === 'Bash' || ask.tool === 'PowerShell' || /^mcp__/.test(ask.tool || ''));
  const buttons = ask.answerable === false
    ? `<span class="st-ask-note">${esc(w.answerInWorkbench)}</span><button class="st-btn" data-go="workbench">${esc(w.openWorkbench)}</button>`
    : `<button class="st-btn pri" data-answer="${ask.canAlways ? 'session' : 'allow'}" data-ask="${esc(ask.id)}">${esc(w.allow)}</button>`
      + (ask.canAlways ? `<button class="st-btn" data-answer="allow" data-ask="${esc(ask.id)}">${esc(w.once)}</button>` : '')
      + `<button class="st-btn" data-answer="deny" data-ask="${esc(ask.id)}">${esc(w.no)}</button>`;
  return `<div class="st-ask" data-key="ask${esc(ask.id)}" data-title="${esc(title)}">
    <div class="st-ask-q">${stDot('needs')}<span>${esc(title)}</span></div>
    ${detail ? `<div class="st-ask-d">${esc(detail)}</div>` : ''}
    ${showDetail ? `<details class="st-ask-more"><summary>${esc(w.details)}</summary><pre>${esc(String(ask.summary).slice(0, 1200))}</pre></details>` : ''}
    <div class="st-ask-btns">${buttons}</div></div>`;
}

// Only files the task created or changed, and its pictures; newest first.
function stFiles(k) {
  const out = [];
  for (const f of [...k.model.files.values()].sort((a, b) => b.at - a.at)) out.push({ kind: 'file', key: f.rel, f });
  k.model.shots.forEach((s, i) => out.push({ kind: 'shot', key: `shot${i}`, s, i }));
  return out.slice(0, 12);
}

function stFileCard(k, item, i) {
  const w = STW();
  if (item.kind === 'shot') {
    return `<button class="st-fc" data-file="${esc(item.key)}" data-sig="${esc(item.key)}" data-kind="shot" data-i="${item.i}" style="--i:${Math.min(i, 5)}">
      <span class="st-th img"><img alt="" src="${item.s.src}"></span><span class="st-fmeta"><span class="st-fn">${esc(w.shot)} ${item.i + 1}</span><span class="st-fm">${esc(stAgo(item.s.at))}</span></span></button>`;
  }
  const f = item.f;
  const thumb = k.thumbs.get(f.rel);
  const th = f.image
    ? `<span class="st-th img">${thumb?.src ? `<img alt="" src="${thumb.src}">` : ''}</span>`
    : `<span class="st-th doc">${thumb?.lines ? thumb.lines.map((l) => `<i style="width:${l}%"></i>`).join('') : '<i></i><i></i><i></i>'}</span>`;
  const sig = `${f.rel}|${f.times}|${thumb ? 1 : 0}`;
  return `<button class="st-fc" data-file="${esc(f.rel)}" data-sig="${esc(sig)}" data-kind="file" style="--i:${Math.min(i, 5)}">${th}
    <span class="st-fmeta"><span class="st-fn">${esc(basename(f.rel))}</span><span class="st-fm">${esc(f.created ? w.created : w.changed)} · ${esc(dirname(f.rel) || S.project?.name || '')}</span></span></button>`;
}

async function stLoadThumbs(k) {
  for (const f of k.model.files.values()) {
    const sig = `${f.rel}|${f.times}`;
    const have = k.thumbs.get(f.rel);
    if (have && (have.sig === sig || have.loading)) continue;
    k.thumbs.set(f.rel, { ...(have || {}), loading: true, sig });
    try {
      if (f.image) {
        const img = await wb.termImage(f.abs);
        if (img?.data) k.thumbs.set(f.rel, { sig, src: `data:${img.mime};base64,${img.data}` });
        else k.thumbs.set(f.rel, { sig });
      } else {
        const file = await wb.read(f.rel);
        const text = String(file?.content || '');
        const lines = text.split('\n').filter((l) => l.trim()).slice(0, 4).map((l) => Math.max(30, Math.min(100, Math.round(l.length * 2.2))));
        k.thumbs.set(f.rel, { sig, lines, text: text.slice(0, 20000) });
      }
    } catch { k.thumbs.set(f.rel, { sig }); }
    stRender();
  }
}

function stRenderChips(t) {
  const w = STW();
  const box = $('#st-chips');
  // Suggestions start a task; once it runs they'd only get in the way.
  const show = !t || !stTask(t).model.turns.length;
  const role = ST.persona in w.chips ? ST.persona : 'designer';
  const html = show ? `<span class="st-role">${esc(w.roles[role])}</span>${w.chips[role].map((c) => `<button type="button" class="st-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}` : '';
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  box.hidden = !show;
}

// ---------------------------------------------------------------- result: site, pictures, documents

function stRenderResult(t) {
  const w = STW();
  const pane = $('#st-result');
  const k = t ? stTask(t) : null;
  let html;
  const sel = ST.preview;
  const shots = k?.model.shots || [];
  const fileSel = sel?.kind === 'file' && k?.model.files.get(sel.key);
  if (fileSel) {
    const th = k.thumbs.get(fileSel.rel);
    html = `<div class="st-r-head"><span class="st-r-name">${esc(basename(fileSel.rel))}</span><span class="st-r-sub">${esc(dirname(fileSel.rel))}</span><div class="grow"></div>
      <button class="st-btn" data-r="reveal" data-rel="${esc(fileSel.rel)}">${esc(w.openFile)}</button></div>`
      + (fileSel.image ? `<div class="st-r-img">${th?.src ? `<img alt="" src="${th.src}">` : ''}</div>`
        : `<div class="st-r-doc"><div class="st-paper">${stText(th?.text || '')}</div></div>`);
  } else if (sel?.kind === 'shot' && shots[sel.key]) {
    html = `<div class="st-r-head"><span class="st-r-name">${esc(w.shot)} ${sel.key + 1}</span></div><div class="st-r-img"><img alt="" src="${shots[sel.key].src}"></div>`;
  } else if (k?.site) {
    const shot = shots[shots.length - 1];
    html = `<div class="st-r-head"><span class="st-url">${icon('lock', 12)}<b>${esc(StudioWords.host(k.site))}</b></span>${shot ? `<span class="st-r-sub">${esc(w.lastShot)}</span>` : ''}<div class="grow"></div>
      <button class="st-btn pri" data-r="site">${icon('layers', 14)}<span>${esc(w.showSite)}</span></button></div>`
      + (shot ? `<div class="st-r-img"><img alt="" src="${shot.src}"></div>` : `<div class="st-r-site"><div class="st-r-site-ic">${icon('globe', 22)}</div><div class="st-r-host">${esc(StudioWords.host(k.site))}</div></div>`);
  } else if (shots.length) {
    html = `<div class="st-r-img"><img alt="" src="${shots[shots.length - 1].src}"></div>`;
  } else {
    html = `<div class="st-r-empty">${icon('eye', 22)}<p>${esc(w.resultEmpty)}</p></div>`;
  }
  if (pane.dataset.html !== html) { pane.innerHTML = html; pane.dataset.html = html; pane.classList.remove('st-fade'); void pane.offsetWidth; pane.classList.add('st-fade'); }
}

function stRenderResultBar(t) {
  const w = STW();
  const bar = $('#st-resultbar');
  const k = t ? stTask(t) : null;
  if (!k?.site) { bar.hidden = true; bar.innerHTML = ''; bar.dataset.html = ''; return; }
  const host = StudioWords.host(k.site);
  const b = k.boost;
  const changed = !!b?.changed;
  const html = `<span class="st-url">${icon('lock', 12)}<b>${esc(host)}</b></span>
    <button class="st-link" data-rb="site" title="${esc(w.showSite)}">${icon('layers', 13)}</button>
    <div class="grow"></div>
    ${changed ? `<span class="st-boost${b.undone ? ' undone' : ''}">${icon('bolt', 13)}<span>${esc(b.undone ? w.boostUndone : w.boostUndo)}</span>${b.undone ? '' : `<button class="st-undo" data-rb="undo" title="${esc(w.undoTitle)}" aria-label="${esc(w.undo)}">${stUndoIcon()}</button>`}</span>
    <div class="st-ba" role="group"><button data-rb="before" class="${b.showing === 'before' ? 'on' : ''}">${esc(w.before)}</button><button data-rb="after" class="${b.showing !== 'before' ? 'on' : ''}"${b.undone ? ' disabled' : ''}>${esc(w.after)}</button></div>` : ''}`;
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
  bar.hidden = false;
}

const stUndoIcon = () => '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10h10a5 5 0 0 1 0 10h-3"/></svg>';

function stOpenSite(k) {
  if (!k?.site) return;
  k.siteOpened = true;
  wb.toHost({ type: 'preview', url: k.site });
}

async function stBoostSnapshot(k, host) {
  if (!host || k.boost?.host === host) return;
  k.boost = { host, before: [], after: null, changed: false, showing: 'after', undone: false };
  try { k.boost.before = await wb.studioBoost('get', host); } catch {}
}

async function stOnResultBarClick(e) {
  const a = e.target.closest('[data-rb]')?.dataset.rb;
  const t = stCurrent();
  if (!a || !t) return;
  const k = stTask(t);
  const b = k.boost;
  if (a === 'site') return stOpenSite(k);
  if (!b) return;
  try {
    if (a === 'before' && b.showing !== 'before') {
      b.after = await wb.studioBoost('get', b.host);
      await wb.studioBoost('restore', b.host, b.before);
      b.showing = 'before';
    } else if (a === 'after' && b.showing === 'before' && b.after) {
      await wb.studioBoost('restore', b.host, b.after);
      b.showing = 'after';
    } else if (a === 'undo') {
      await wb.studioBoost('restore', b.host, b.before);
      b.showing = 'before';
      b.undone = true;
      b.after = null;
    }
  } catch (err) { toast(err.message); }
  stRender();
}

function stOnResultClick(e) {
  const r = e.target.closest('[data-r]');
  if (!r) return;
  const t = stCurrent();
  if (r.dataset.r === 'site' && t) stOpenSite(stTask(t));
  if (r.dataset.r === 'reveal') wb.reveal(r.dataset.rel).catch(() => {});
}

// ---------------------------------------------------------------- chat actions

async function stOnFeedClick(e) {
  const fc = e.target.closest('.st-fc');
  if (fc) {
    ST.preview = fc.dataset.kind === 'shot' ? { kind: 'shot', key: Number(fc.dataset.i) } : { kind: 'file', key: fc.dataset.file };
    for (const c of document.querySelectorAll('.st-fc.sel')) c.classList.remove('sel');
    fc.classList.add('sel');
    stRender();
    return;
  }
  if (e.target.closest('[data-go="workbench"]')) return stShow('workbench');
  const trust = e.target.closest('[data-trust]');
  if (trust) {
    const t = stCurrent();
    const k = t && stTask(t);
    if (!k?.trust) return;
    const text = k.trust;
    k.trust = '';
    if (trust.dataset.trust === 'yes') {
      // Claude Code's own choice: the first one is "Yes, proceed".
      wb.ptyWrite(t.id, '\r');
      stRender();
      for (let i = 0; i < 40 && stTrustAsked(t); i++) await new Promise((r) => setTimeout(r, 150));
      await stWhenReady(t);
      stType(t, text);
    } else {
      wb.ptyWrite(t.id, '\x1b');
      $('#st-input').value = text;
    }
    stRender();
    return;
  }
  const btn = e.target.closest('[data-answer]');
  if (!btn) return;
  const card = btn.closest('.st-ask');
  const t = stCurrent();
  if (!card || !t || card.classList.contains('answering')) return;
  card.classList.add('answering');
  for (const b of card.querySelectorAll('button')) b.disabled = true;
  const choice = btn.dataset.answer;
  try {
    const ok = await wb.studioAnswer(btn.dataset.ask, choice);
    if (!ok) throw new Error('gone');
    const k = stTask(t);
    const what = (card.dataset.title || '').replace(/^(Разрешить|Allow)\s+/, '').replace(/\?$/, '');
    const ti = Math.max(0, k.model.turns.length - 1);
    k.answered.push({ id: btn.dataset.ask, choice, title: what, turn: ti, after: k.model.turns[ti]?.items.length || 0 });
    // Collapses into one calm line (the check draws itself); the snapshot then drops the question.
    card.classList.add(choice === 'deny' ? 'st-denied' : 'st-allowed');
    const m = ST.mission[t.id];
    if (m?.asks) m.asks = m.asks.filter((x) => x.id !== btn.dataset.ask);
    setTimeout(() => stRender(), stReduced() ? 0 : 240);
  } catch {
    card.classList.remove('answering');
    for (const b of card.querySelectorAll('button')) b.disabled = false;
    stRender();
  }
}

let stQueueSeq = 0;
async function stSubmit() {
  const input = $('#st-input');
  const text = input.value.trim();
  let t = stCurrent();
  if (!text && t && $('#st-send').classList.contains('stop')) { wb.ptyWrite(t.id, '\x1b'); return; }
  if (!text || ST.sending) return;
  ST.sending = true;
  try {
    if (!t || t.exited) {
      t = await launch('claude', { studio: true });
      if (!t) { toast(STW().notStarted); return; }
      ST.current = t.id;
      stTask(t);
      // Back to Studio: launch shows the terminal underneath.
      stShow('studio');
      input.value = '';
      await stWhenReady(t);
      if (stTrustAsked(t)) {
        // Asked in plain words first; the message goes once the folder is trusted.
        stTask(t).trust = text;
        stRender();
        return;
      }
      stType(t, text);
      stTask(t).seen = true;
      stRender();
      return;
    }
    input.value = '';
    const k = stTask(t);
    if (stStatus(t) === 'work' || stStatus(t) === 'needs') {
      k.queue.push({ id: `q${++stQueueSeq}`, text });
      stRender();
      return;
    }
    stType(t, text);
    stRender();
  } finally { ST.sending = false; }
}

// The terminal's screen as text (the last rows), for the questions Claude Code asks there itself.
function stScreen(t, rows = 40) {
  try {
    const b = t.xterm.buffer.active;
    const out = [];
    for (let i = Math.max(0, b.length - rows); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) || '');
    return out.join('\n');
  } catch { return ''; }
}
// Claude Code's first question in a new folder: whether to trust it.
const stTrustAsked = (t) => /Do you trust the files in this folder|trust this folder|Is this a project you/i.test(stScreen(t));

// Claude Code is ready for a message once its session has started (Mission Control saw it), or
// when it asks about the folder first.
async function stWhenReady(t) {
  for (let i = 0; i < 100; i++) {
    const m = ST.mission[t.id];
    if (m && m.status && m.status !== 'starting') break;
    if (stTrustAsked(t)) return;
    if (t.exited) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 350));
}

// What the person wrote, into the session as if pasted, then Enter.
function stType(t, text) {
  wb.ptyWrite(t.id, `\x1b[200~${text.replace(/\x1b/g, '')}\x1b[201~`);
  setTimeout(() => wb.ptyWrite(t.id, '\r'), 120);
  const k = stTask(t);
  k.seen = true;
}

function stFlush(t) {
  const k = stTask(t);
  const q = k.queue.shift();
  if (q) stType(t, q.text);
}

// ---------------------------------------------------------------- the loop: transcripts in

async function stRead(t, k) {
  if (k.reading) return;
  k.reading = true;
  try {
    for (let i = 0; i < 4; i++) {
      const chunk = await wb.studioTranscript(t.id, k.offset);
      if (!chunk) break;
      if (chunk.reset) { k.model = StudioTranscript.newModel(); k.thumbs.clear(); }
      const changed = StudioTranscript.feed(k.model, chunk.text, { root: S.project?.root || '' });
      k.offset = chunk.next;
      k.loaded = true;
      if (changed) stOnModel(t, k);
      if (chunk.next >= chunk.size || !chunk.text) break;
    }
  } catch {} finally { k.reading = false; }
}

function stOnModel(t, k) {
  // The site this task works on: the last one it opened.
  const sites = StudioTranscript.sitesOf(k.model);
  const site = sites[sites.length - 1] || '';
  if (site && site !== k.site) {
    k.site = site;
    stBoostSnapshot(k, StudioWords.host(site));
    // The result, in sight: the site opens next to Studio once per task.
    if (!k.siteOpened && ST.view === 'studio' && ST.current === t.id && !document.hidden) stOpenSite(k);
  }
  // A restyle that went through: Before/After and Undo for it.
  for (const turn of k.model.turns) for (const it of turn.items) {
    if (it.type === 'steps' && it.steps.some((s) => s.tool === 'mcp__meridian__set_boost' && s.state === 'ok') && k.boost) {
      if (!k.boost.changed) { k.boost.changed = true; k.boost.undone = false; k.boost.showing = 'after'; }
    }
  }
  stRender();
}

let stTickN = 0;
function stTick() {
  if (!ST.on || !S.project) return;
  stTickN++;
  for (const t of stTerms()) {
    const k = stTask(t);
    // A restyle is about to happen: what the site looked like before it (for Undo).
    const asks = ST.mission[t.id]?.asks || [];
    for (const a of asks) {
      if (a.tool === 'mcp__meridian__set_boost' && k.site && !k.boost) stBoostSnapshot(k, StudioWords.host(k.site));
    }
    // The task in sight often; the others now and then (titles, dots).
    if (t.id === ST.current && ST.view === 'studio' ? true : stTickN % 6 === 0 || !k.loaded) stRead(t, k);
  }
  if (ST.view === 'studio') {
    if (!ST.current && stTerms().length && !ST.chosen) { ST.current = stTerms()[stTerms().length - 1].id; ST.chosen = true; }
    stRender();
  }
}

// For tests (node): nothing to export here; the parts are in studio-words.js and studio-transcript.js.
