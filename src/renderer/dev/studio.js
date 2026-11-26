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

// A camera for "took a screenshot" (icons.js has none).
if (typeof ICON_PATHS === 'object' && !ICON_PATHS.camera) {
  ICON_PATHS.camera = '<path d="M4.5 8.5a2 2 0 0 1 2-2h1.8l1.5-2h4.4l1.5 2h1.8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.3"/>';
}

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
  ST.info = info;
  if (['designer', 'manager', 'developer', 'everyday'].includes(info.persona)) ST.persona = info.persona;
  try { ST.board = localStorage.getItem('wb.studioBoard') === '1'; } catch {}
  document.body.classList.add('studio-on');
  stBuild();
  stSwitchInTopbar();
  const wanted = new URL(location.href).searchParams.get('view');
  stShow(wanted === 'workbench' ? 'workbench' : wanted === 'studio' || ST.persona !== 'developer' ? 'studio' : 'workbench');
  // "Кто вы?" once: the person's pick decides what the Workbench tab opens with.
  if (info.ask) stPersonaPicker({ guess: ST.persona });
  bus.addEventListener('project', () => { stRender(); });
  if (typeof SessionStatus !== 'undefined' && SessionStatus?.onChange) SessionStatus.onChange(() => stRender());
  document.addEventListener('visibilitychange', stReport);
  ST.timer = setInterval(stTick, 700);
  stTick();
}

function studioHostCommand(msg) {
  if (!ST.on || !msg) return;
  if (msg.type === 'studio-point') { stOnPoint(msg); return; }
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
      <div class="st-viewseg" role="tablist" aria-label="${esc(w.tasks)}">
        <button role="tab" data-mode="board">${icon('grid', 13)}<span>${esc(w.cards)}</span></button>
        <button role="tab" data-mode="list">${icon('chat', 13)}<span>${esc(w.chat)}</span></button></div>
      <button class="st-role-btn" id="st-role" title="${esc(w.roleChange)}">${icon('user', 14)}<span></span></button>
      ${stSwitchHtml()}
    </header>
    <div class="st-board" id="st-board" hidden></div>
    <div class="st-body">
      <aside class="st-tasks" aria-label="${esc(w.tasks)}">
        <button class="st-new" id="st-new">${icon('plus', 14)}<span>${esc(w.newTask)}</span></button>
        <button class="st-new st-allcards" id="st-allcards">${icon('grid', 14)}<span>${esc(w.allTasks)}</span></button>
        <div class="st-task-list" id="st-task-list" role="list"></div>
      </aside>
      <div class="st-chat">
        <div class="st-ctabs" role="tablist"><div class="st-seg">
          <button role="tab" data-pane="chat" class="on">${icon('chat', 14)}<span>${esc(w.chat)}</span></button>
          <button role="tab" data-pane="brand">${icon('palette', 14)}<span>${esc(w.brand)}</span></button>
        </div></div>
        <div class="st-brand" id="st-brand" hidden></div>
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
  $('#st-role', el).addEventListener('click', () => stPersonaPicker({ current: ST.persona }));
  $('.st-viewseg', el).addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) stSetBoard(m === 'board');
  });
  $('#st-board', el).addEventListener('click', stOnBoardClick);
  $('.st-ctabs', el).addEventListener('click', (e) => {
    const p = e.target.closest('[data-pane]')?.dataset.pane;
    if (!p) return;
    ST.pane = p;
    if (p === 'brand') stLoadBrand();
    stRender();
  });
  $('#st-brand', el).addEventListener('click', stOnBrandClick);
  $('#st-new', el).addEventListener('click', () => { ST.current = ''; ST.preview = null; stRender(); $('#st-input').focus(); });
  $('#st-allcards', el).addEventListener('click', () => stSetBoard(true));
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
    if (e.target.closest('[data-point]')) { stPoint(true); return; }
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    const input = $('#st-input');
    input.value = c.dataset.chip;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  $('#st-feed', el).addEventListener('click', stOnFeedClick);
  $('#st-result', el).addEventListener('click', stOnResultClick);
  $('#st-result', el).addEventListener('pointerdown', stWipeDrag);
  $('#st-result', el).addEventListener('dblclick', stWipeDrag);
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
  const terms = stTerms();
  // The board: every task as a card. It is where Studio starts when there are tasks and none is open.
  $('.st-body', ST.el).hidden = ST.board;
  $('#st-board').hidden = !ST.board;
  for (const b of ST.el.querySelectorAll('.st-viewseg button')) b.classList.toggle('on', (b.dataset.mode === 'board') === ST.board);
  if (ST.board) {
    $('#st-title').textContent = w.studio;
    $('#st-sub').textContent = `${S.project.name} · ${w.taskCount(terms.length)}`;
    $('#st-role span').textContent = w.personas[ST.persona]?.name || '';
    document.title = w.studio;
    stRenderBoard(terms);
    stReport();
    return;
  }
  if (ST.current && !terms.some((t) => t.id === ST.current)) ST.current = '';
  const t = stCurrent();
  $('#st-title').textContent = t ? stTitle(t) : w.newTask;
  $('#st-sub').textContent = `${S.project.name} · ${w.claude}`;
  $('#st-role span').textContent = w.personas[ST.persona]?.name || '';
  document.title = t ? stTitle(t) : w.studio;
  stRenderTasks(terms);
  stRenderPane();
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
        // One check, on the last step done: less noise than a column of them.
        const lastOk = steps.map((s) => s.state).lastIndexOf('ok');
        if (steps.length) parts.push(`<div class="st-steps" data-key="s${ti}.${ii}">${steps.map((s, si) => stStepHtml(s, last && (status === 'work' || status === 'needs'), progress, status, si === lastOk)).join('')}</div>`);
      }
    });
    for (const a of answeredHere.filter((x) => x.after >= turn.items.length)) parts.push(answeredHtml(a));
  });
  if (k.handNotes?.length) {
    parts.push(`<div class="st-hand" data-key="hand">${icon('pencil', 14)}<span><b>${esc(w.handTitle)}</b> ${esc(k.handNotes.map((n) => `${n.who} — ${n.what.join(', ')}`).join('; '))}. ${esc(w.handNext)}</span></div>`);
  }
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
  stFillImages(feed);
  stLoadThumbs(k);
  if (firstPaint) {
    // Opened: the person's last message at the top, the answer below it.
    const lastUser = [...feed.querySelectorAll('.st-msg-user')].pop();
    feed.scrollTop = lastUser ? Math.max(0, lastUser.offsetTop - feed.offsetTop - 12) : feed.scrollHeight;
  } else if (atBottom) feed.scrollTop = feed.scrollHeight;
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
const stInline = (s) => {
  // [[pin: selector | text]] reads as a numbered pin with its text.
  let n = 0;
  const out = esc(s).replace(/\[\[pin:\s*[^|\]]{1,300}\|\s*([^\]]{1,400})\]\]/g, (_, text) => `<span class="st-pin">${++n}</span> ${text}`);
  return out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '$1');
};

function stStepHtml(s, live, progress, status = 'work', checked = true) {
  const [ic, done, doing] = StudioWords.stepWords(s.tool, s.input, ST.lang);
  let text = s.state === 'running' ? doing : done;
  if (s.state === 'running' && progress && live && progress.total > 1) {
    text += ` — ${STW().step(progress.index, progress.total)}`;
  }
  const state = s.state === 'running' && !live ? 'stopped' : s.state;
  const mark = state === 'ok' ? (checked ? `<span class="st-ok">${icon('check', 12)}</span>` : '')
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
    return `<button class="st-fc" data-file="${esc(item.key)}" data-sig="${esc(item.key)}|${k.model.shots.length}" data-kind="shot" data-i="${item.i}" style="--i:${Math.min(i, 5)}">
      <span class="st-th img">${stImg(stShotKey(item.s))}</span><span class="st-fmeta"><span class="st-fn">${esc(item.i === 0 && k.model.shots.length > 1 ? w.shotBefore : item.i === k.model.shots.length - 1 && k.model.shots.length > 1 ? w.shotAfter : `${w.shot} ${item.i + 1}`)}</span><span class="st-fm">${esc(stAgo(item.s.at))}</span></span></button>`;
  }
  const f = item.f;
  const thumb = k.thumbs.get(f.rel);
  const th = f.image
    ? `<span class="st-th img">${thumb?.src ? stImg(thumb.src) : ''}</span>`
    : `<span class="st-th doc">${thumb?.lines ? thumb.lines.map((l) => `<i style="width:${l}%"></i>`).join('') : '<i></i><i></i><i></i>'}</span>`;
  const sig = `${f.rel}|${f.times}|${thumb ? 1 : 0}`;
  return `<button class="st-fc" data-file="${esc(f.rel)}" data-sig="${esc(sig)}" data-kind="file" style="--i:${Math.min(i, 5)}">${th}
    <span class="st-fmeta"><span class="st-fn">${esc(basename(f.rel))}</span><span class="st-fm">${esc(f.created ? w.created : w.changed)} · ${esc(dirname(f.rel) || S.project?.name || '')}</span></span></button>`;
}

// Pictures are kept here and set on <img data-img> after each render: the markup that is compared
// on every tick holds a short key, not megabytes of data: URLs.
const stImages = new Map();
const stImageKeys = new Map();
function stImage(src) {
  let key = stImageKeys.get(src);
  if (!key) { key = `i${stImageKeys.size + 1}`; stImageKeys.set(src, key); stImages.set(key, src); }
  return key;
}
const stImg = (key) => `<img alt="" data-img="${esc(key)}">`;
function stFillImages(root) {
  for (const img of root.querySelectorAll('img[data-img]:not([src])')) {
    const src = stImages.get(img.dataset.img);
    if (src) img.src = src;
  }
}
const stShotKey = (sh) => { if (!sh.key) sh.key = stImage(sh.src); return sh.key; };

async function stLoadThumbs(k) {
  for (const f of k.model.files.values()) {
    const sig = `${f.rel}|${f.times}`;
    const have = k.thumbs.get(f.rel);
    if (have && (have.sig === sig || have.loading)) continue;
    k.thumbs.set(f.rel, { ...(have || {}), loading: true, sig });
    try {
      if (f.image) {
        const img = await wb.termImage(f.abs);
        if (img?.data) k.thumbs.set(f.rel, { sig, src: stImage(`data:${img.mime};base64,${img.data}`) });
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
  // With a site to show: the way to point at it, the hero of Studio.
  const site = t && stTask(t).site && !ST.pointing;
  const point = site ? `<button type="button" class="st-chip hero" data-point>${stCursorIcon()}<span>${esc(w.pointChip)}</span></button>` : '';
  const picked = ST.pointing && ST.picked?.length ? `<span class="st-picked">${stCursorIcon()}${esc(ST.picked[0].name)}${ST.picked.length > 1 ? ` ${esc(w.andMore(ST.picked.length - 1))}` : ''}</span>` : '';
  const html = (show ? `${w.chips[role].map((c) => `<button type="button" class="st-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}` : '') + point + picked;
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  box.hidden = !html;
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
      + (fileSel.image ? `<div class="st-r-img">${th?.src ? stImg(th.src) : ''}</div>`
        : `<div class="st-r-doc"><div class="st-paper">${stText(th?.text || '')}</div></div>`);
  } else if (sel?.kind === 'shot' && shots[sel.key]) {
    html = `<div class="st-r-head"><span class="st-r-name">${esc(w.shot)} ${sel.key + 1}</span></div><div class="st-r-img">${stImg(stShotKey(shots[sel.key]))}</div>`;
  } else if (k?.site) {
    const shot = shots[shots.length - 1];
    html = `<div class="st-r-head"><span class="st-url">${icon('lock', 12)}<b>${esc(StudioWords.host(k.site))}</b></span>${shot ? `<span class="st-r-sub">${esc(shots.length > 1 ? w.wipeHint : w.lastShot)}</span>` : ''}<div class="grow"></div>
      <button class="st-btn pri" data-r="site">${icon('layers', 14)}<span>${esc(w.showSite)}</span></button></div>`
      + (shot ? (shots.length > 1 ? stWipeHtml(shots[0], shot) : `<div class="st-r-img">${stImg(stShotKey(shot))}</div>`) : `<div class="st-r-site"><div class="st-r-site-ic">${icon('globe', 22)}</div><div class="st-r-host">${esc(StudioWords.host(k.site))}</div></div>`);
  } else if (shots.length) {
    html = shots.length > 1 ? stWipeHtml(shots[0], shots[shots.length - 1]) : `<div class="st-r-img">${stImg(stShotKey(shots[shots.length - 1]))}</div>`;
  } else {
    html = `<div class="st-r-empty">${icon('eye', 22)}<p>${esc(w.resultEmpty)}</p></div>`;
  }
  if (pane.dataset.html !== html) { pane.innerHTML = html; pane.dataset.html = html; pane.classList.remove('st-fade'); void pane.offsetWidth; pane.classList.add('st-fade'); }
  stFillImages(pane);
}

// До/После as a wipe: the first snapshot under the latest, a handle to drag (double click: half).
function stWipeHtml(before, after) {
  const w = STW();
  return `<div class="st-wipe" style="--x:50%"><div class="st-wipe-after">${stImg(stShotKey(after))}</div>
    <div class="st-wipe-before">${stImg(stShotKey(before))}</div>
    <span class="st-wipe-h" role="slider" aria-label="${esc(w.before)} / ${esc(w.after)}" tabindex="0"><i></i></span></div>`;
}
function stWipeDrag(e) {
  const box = e.target.closest('.st-wipe');
  if (!box) return;
  const set = (x) => { const r = box.getBoundingClientRect(); box.style.setProperty('--x', `${Math.max(0, Math.min(100, ((x - r.left) / r.width) * 100))}%`); };
  if (e.type === 'dblclick') { box.classList.add('snap'); box.style.setProperty('--x', '50%'); setTimeout(() => box.classList.remove('snap'), 200); return; }
  e.preventDefault();
  set(e.clientX);
  const move = (m) => set(m.clientX);
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
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
    <button class="st-point${ST.pointing ? ' on' : ''}" data-rb="point" aria-pressed="${ST.pointing ? 'true' : 'false'}" title="${esc(w.pointTitle)}">${stCursorIcon()}<span>${esc(w.point)}</span></button>
    <div class="grow"></div>
    ${changed ? `<span class="st-boost${b.undone ? ' undone' : ''}">${icon('bolt', 13)}<span>${esc(b.undone ? w.boostUndone : w.boostUndo)}</span>${b.undone ? '' : `<button class="st-undo" data-rb="undo" title="${esc(w.undoTitle)}" aria-label="${esc(w.undo)}">${stUndoIcon()}</button>`}</span>
    <div class="st-ba" role="group"><button data-rb="before" class="${b.showing === 'before' ? 'on' : ''}">${esc(w.before)}</button><button data-rb="after" class="${b.showing !== 'before' ? 'on' : ''}"${b.undone ? ' disabled' : ''}>${esc(w.after)}</button></div>` : ''}`;
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
  bar.hidden = false;
}

const stUndoIcon = () => '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14.5L4.5 10 9 5.5"/><path d="M4.5 10h10a5 5 0 0 1 0 10h-3"/></svg>';

const stCursorIcon = () => '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3.5l13 7-5.6 1.6L10 18z"/></svg>';

function stOpenSite(k) {
  if (!k?.site) return;
  k.siteOpened = true;
  // Studio remembers this tab: point and say works in it.
  wb.toHost({ type: 'studio-site', url: k.site });
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
  if (a === 'point') return stPoint(!ST.pointing);
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
      k.hand = new Map();
      k.handNotes = [];
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
    // Typed while something is picked on the page: about that; hand changes go first.
    const about = ST.pointing && ST.picked?.length ? STW().sayPrompt(StudioWords.host(k.site), ST.picked.map((x) => `${x.name} — \`${x.sel}\``).join('\n'), text) : text;
    stSend(t, about);
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

// ---------------------------------------------------------------- the brand (brand.json in the folder)

// The brand Studio keeps to: colours and fonts, from the live site or from Figma (read only), in
// brand.json in the task folder. «Проверить сайт» finds what on the page isn't in it.
async function stLoadBrand() {
  if (ST.brandLoaded || !S.project) return;
  ST.brandLoaded = true;
  try {
    const f = await wb.read('brand.json');
    const b = JSON.parse(f?.content || 'null');
    if (b && Array.isArray(b.colors)) ST.brand = { source: String(b.source || ''), name: String(b.name || ''), colors: b.colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c?.value || '')).slice(0, 16).map((c) => ({ value: c.value.toUpperCase(), name: String(c.name || '') })), fonts: (Array.isArray(b.fonts) ? b.fonts : []).slice(0, 6).map((x) => ({ family: String(x?.family || ''), use: String(x?.use || '') })) };
  } catch {}
  stRender();
}
async function stSaveBrand() {
  if (!ST.brand) return;
  try { await wb.write('brand.json', JSON.stringify(ST.brand, null, 2) + '\n'); } catch (err) { toast(err.message); }
}
const stBrandColors = () => (ST.brand?.colors || []).map((c) => c.value);

function stRenderPane() {
  const brand = ST.pane === 'brand';
  for (const b of ST.el.querySelectorAll('.st-ctabs button')) b.classList.toggle('on', (b.dataset.pane === 'brand') === brand);
  $('#st-brand').hidden = !brand;
  $('#st-feed').hidden = brand;
  $('.st-composer', ST.el).hidden = brand;
  $('#st-resultbar').classList.toggle('in-brand', brand);
  if (brand) stRenderBrand();
}

function stRenderBrand() {
  const w = STW();
  const box = $('#st-brand');
  const b = ST.brand;
  const t = stCurrent();
  const k = t && stTask(t);
  const figma = ST.info?.figma;
  const figmaCard = figma
    ? `<div class="st-bsrc"><span class="st-fig">${stFigmaIcon()}</span><div><b>Figma</b> <span class="m">· ${esc(w.figmaOn)}</span></div><span class="ro">${icon('eye', 12)}${esc(w.readOnly)}</span></div>
       <form class="st-figform" id="st-figform"><input placeholder="${esc(w.figmaLink)}" aria-label="${esc(w.figmaLink)}"><button class="st-btn" type="submit">${esc(w.figmaTake)}</button></form>`
    : `<div class="st-bsrc"><span class="st-fig">${stFigmaIcon()}</span><div><b>Figma</b> <span class="m">· ${esc(w.figmaOff)}</span></div><button class="st-btn" data-b="figma">${esc(w.figmaConnect)}</button></div>`;
  let html;
  if (!b) {
    html = `<div class="st-bempty"><div class="st-empty-ic">${icon('palette', 22)}</div><h3>${esc(w.brandNone)}</h3><p>${esc(w.brandNoneHint)}</p>
      <button class="st-btn pri" data-b="site"${k?.site ? '' : ' disabled'}>${icon('globe', 14)}<span>${esc(k?.site ? w.brandFromSite(StudioWords.host(k.site)) : w.brandNeedSite)}</span></button></div>${figmaCard}`;
  } else {
    const drift = ST.drift;
    const groups = drift ? stDriftGroups(drift) : [];
    const driftHtml = !drift ? ''
      : !groups.length ? `<div class="st-bok">${icon('check', 14)}<span>${esc(w.brandAllGood)}</span></div>`
        : `<div class="st-drift st-in"><div class="st-ask-q">${stDot('needs')}<span>${esc(w.driftTitle(groups.length))}</span></div>
          <div class="st-drows">${groups.slice(0, 6).map((g) => `<div class="st-drow"><i style="background:${g.value}"></i><span class="ar">→</span><i style="background:${g.nearest}"></i><em>${esc(stBrandName(g.nearest))}</em><span>· ${esc(g.names.slice(0, 2).join(', '))}${g.names.length > 2 ? ` ${esc(w.andMore(g.names.length - 2))}` : ''}</span></div>`).join('')}</div>
          <div class="st-ask-btns"><button class="st-btn pri" data-b="fix">${esc(w.driftFix)}</button><button class="st-btn" data-b="where">${esc(w.driftWhere)}</button><button class="st-btn" data-b="keep">${esc(w.driftKeep)}</button></div></div>`;
    html = `<div class="st-bsrc"><span class="st-fig">${b.source === 'figma' ? stFigmaIcon() : icon('globe', 14)}</span><div><b>${esc(b.name || w.brand)}</b> <span class="m">· ${esc(b.source === 'figma' ? 'Figma' : w.fromSite)}</span></div></div>
      <div class="st-bcheck"><button class="st-btn pri" data-b="check"${k?.site ? '' : ' disabled'}>${icon('search', 14)}<span>${esc(w.brandCheck)}</span></button>${k?.site ? '' : `<span class="m">${esc(w.brandNeedSite)}</span>`}</div>
      ${driftHtml}
      <div class="st-bsec"><h4>${esc(w.palette)} <span>· ${b.colors.length}</span></h4><div class="st-sw">${b.colors.map((c, i) => `<div><i style="background:${c.value}"></i><b>${esc(c.name || c.value)}</b>${c.name ? `<span>${esc(c.value)}</span>` : ''}<button class="st-swx" data-b="drop" data-i="${i}" title="${esc(w.remove)}">${icon('x', 11)}</button></div>`).join('')}</div></div>
      ${b.fonts.length ? `<div class="st-bsec"><h4>${esc(w.fonts)}</h4>${b.fonts.map((f) => `<div class="st-font"><span class="ex" style="font-family:'${esc(f.family.replace(/'/g, ''))}'">Аа ${esc(w.fontSample)}</span><span class="fm">${esc(f.family)} · ${esc(f.use === 'head' ? w.headings : w.bodyText)}</span></div>`).join('')}</div>` : ''}
      ${figmaCard}
      <button class="st-link-btn" data-b="site"${k?.site ? '' : ' disabled'}>${esc(w.brandRetake)}</button>`;
  }
  if (box.dataset.html === html) return;
  box.innerHTML = html;
  box.dataset.html = html;
  const form = $('#st-figform', box);
  if (form) form.onsubmit = (e) => { e.preventDefault(); stFigmaBrand(form.querySelector('input').value.trim()); };
}

const stFigmaIcon = () => '<svg width="10" height="15" viewBox="0 0 38 57" aria-hidden="true"><path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1abcfe"/><path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" fill="#0acf83"/><path d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19z" fill="#ff7262"/><path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#f24e1e"/><path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#a259ff"/></svg>';
const stBrandName = (v) => ST.brand?.colors.find((c) => c.value === v)?.name || v;

// What isn't in the brand, by colour: [{value, nearest, prop, items: [{sel, name}], names}].
function stDriftGroups(drift) {
  const by = new Map();
  for (const d of drift) {
    const key = `${d.value}>${d.nearest}`;
    const g = by.get(key) || { value: d.value, nearest: d.nearest, items: [], names: [] };
    g.items.push({ sel: d.sel, name: d.name, prop: d.prop });
    if (!g.names.includes(d.name)) g.names.push(d.name);
    by.set(key, g);
  }
  return [...by.values()].sort((a, b) => b.items.length - a.items.length);
}

async function stBrandFromSite(k) {
  const w = STW();
  if (!k?.site) return toast(w.brandNeedSite);
  let site = await wb.studioPoint('site').catch(() => null);
  if (!site?.open) {
    stOpenSite(k);
    for (let i = 0; i < 40 && !site?.open; i++) { await new Promise((r) => setTimeout(r, 150)); site = await wb.studioPoint('site').catch(() => null); }
  }
  for (let i = 0; i < 20; i++) {
    const got = await wb.studioPoint('brand', { op: 'read' }).catch(() => null);
    if (got?.colors?.length) {
      ST.brand = { source: 'site', name: StudioWords.host(k.site), colors: got.colors.map((c) => ({ value: c.value, name: '' })), fonts: got.fonts || [] };
      ST.drift = null;
      await stSaveBrand();
      return stRender();
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  toast(w.brandNoColors);
}

async function stOnBrandClick(e) {
  const a = e.target.closest('[data-b]');
  if (!a || a.disabled) return;
  const t = stCurrent();
  const k = t && stTask(t);
  const w = STW();
  const op = a.dataset.b;
  if (op === 'site') return stBrandFromSite(k);
  if (op === 'figma') {
    try { ST.info.figma = await wb.studioFigma(true); } catch (err) { toast(err.message); }
    toast(w.figmaHow, 7000);
    return stRender();
  }
  if (op === 'drop') {
    ST.brand.colors.splice(Number(a.dataset.i), 1);
    await stSaveBrand();
    return stRender();
  }
  if (op === 'check') {
    a.disabled = true;
    const got = await wb.studioPoint('brand', { op: 'check', arg: stBrandColors() }).catch(() => null);
    ST.drift = Array.isArray(got) ? got : [];
    return stRender();
  }
  if (op === 'keep') { ST.drift = null; wb.studioPoint('brand', { op: 'show', arg: [] }).catch(() => {}); return stRender(); }
  if (op === 'where') {
    const groups = stDriftGroups(ST.drift || []);
    const marks = groups.flatMap((g) => g.items.slice(0, 3).map((it) => ({ sel: it.sel, text: `${g.value} → ${stBrandName(g.nearest)}`, who: w.brand })));
    wb.studioPoint('brand', { op: 'show', arg: marks }).catch(() => {});
    return;
  }
  if (op === 'fix' && t) {
    // Each one to its nearest brand colour, by hand (Studio's Boost): at once, and undoable.
    for (const g of stDriftGroups(ST.drift || [])) {
      for (const it of g.items) await stHand(t, k, [{ sel: it.sel, name: it.name }], { [it.prop]: g.nearest });
    }
    ST.drift = [];
    wb.studioPoint('brand', { op: 'show', arg: [] }).catch(() => {});
    stRender();
  }
}

// Brand from Figma: a task of its own (sessions get Figma when they start), read only.
async function stFigmaBrand(link) {
  const w = STW();
  if (!/^https:\/\/(www\.)?figma\.com\//.test(link)) return toast(w.figmaBadLink);
  ST.current = '';
  ST.pane = 'chat';
  $('#st-input').value = w.figmaPrompt(link);
  stRender();
  stSubmit();
}

// ---------------------------------------------------------------- the board (tasks as cards)

function stSetBoard(on) {
  ST.board = !!on;
  try { localStorage.setItem('wb.studioBoard', ST.board ? '1' : '0'); } catch {}
  stRender();
}

// The picture a task's card shows: its latest snapshot, else its latest picture file.
function stCardPicture(k) {
  const shots = k.model.shots;
  if (shots.length) return { after: stShotKey(shots[shots.length - 1]), before: shots.length > 1 ? stShotKey(shots[0]) : '' };
  const img = [...k.model.files.values()].filter((f) => f.image).sort((a, b) => b.at - a.at)[0];
  const th = img && k.thumbs.get(img.rel);
  if (th?.src) return { after: th.src, before: '' };
  return null;
}

function stCardLine(t, k, status) {
  const w = STW();
  const ask = ST.mission[t.id]?.asks?.[0];
  if (status === 'needs' && ask) return `<b>${esc(w.waiting)}:</b> ${esc(StudioWords.askWords(ask.tool, ask.summary, ST.lang)[0])}`;
  if (status === 'work') {
    const p = StudioTranscript.planProgress(k.model.plan);
    const turn = k.model.turns[k.model.turns.length - 1];
    const step = turn?.items.filter((x) => x.type === 'steps').flatMap((x) => x.steps).filter((s) => s.tool !== 'TodoWrite').pop();
    const words = step ? StudioWords.stepWords(step.tool, step.input, ST.lang)[2] : w.working;
    return esc(p?.now || words) + (p && p.total > 1 ? ` · ${esc(w.step(p.index, p.total))}` : '');
  }
  const text = k.model.turns.flatMap((x) => x.items).filter((x) => x.type === 'text').pop()?.text || '';
  const first = text.replace(/\[\[pin:[^\]]*\]\]/g, '').split('\n').find((l) => l.trim()) || '';
  const files = k.model.files.size;
  return esc(first.length > 110 ? `${first.slice(0, 109)}…` : first) || esc(files ? w.filesCount(files) : '');
}

function stRenderBoard(terms) {
  const w = STW();
  const board = $('#st-board');
  const counts = { needs: 0, work: 0, done: 0 };
  const items = terms.map((t) => {
    const k = stTask(t);
    if (!k.loaded) stRead(t, k);
    const status = stStatus(t);
    if (counts[status] !== undefined) counts[status]++;
    return { t, k, status };
  });
  // Needs you first, then working, then the rest, newest first.
  const order = { needs: 0, work: 1, done: 2, idle: 3 };
  items.sort((a, b) => order[a.status] - order[b.status] || (b.k.model.turns.at(-1)?.at || 0) - (a.k.model.turns.at(-1)?.at || 0));
  const filter = ST.boardFilter || 'all';
  const shown = items.filter((x) => filter === 'all' || x.status === filter || (filter === 'done' && x.status === 'idle'));
  const chips = w.chips[ST.persona in w.chips ? ST.persona : 'designer'];
  const newCard = `<div class="st-card st-newcard" data-key="new"><div class="st-nc-ttl"><span class="st-nc-pl">${icon('plus', 15)}</span>${esc(w.newTask)}</div>
    ${chips.map((c) => `<button class="st-chip" data-newchip="${esc(c)}">${esc(c)}</button>`).join('')}
    <button class="st-nc-blank" data-new>${esc(w.ownWords)}</button></div>`;
  const cards = shown.map(({ t, k, status }) => {
    const pic = stCardPicture(k);
    const ask = ST.mission[t.id]?.asks?.[0];
    const when = stAgo(k.model.turns.at(-1)?.at);
    const pv = pic
      ? `<div class="st-cpv">${stImg(pic.after)}${pic.before ? `<span class="st-cpv-before">${stImg(pic.before)}</span><span class="st-cba"><button data-ba="before">${esc(w.before)}</button><button data-ba="after" class="on">${esc(w.after)}</button></span>` : ''}</div>`
      : `<div class="st-cpv empty">${k.site ? icon('globe', 22) : icon('file', 22)}${k.site ? `<span>${esc(StudioWords.host(k.site))}</span>` : ''}</div>`;
    const acts = status === 'needs' && ask && ask.answerable !== false
      ? `<div class="st-cacts"><button class="st-btn pri" data-answer="${ask.canAlways ? 'session' : 'allow'}" data-ask="${esc(ask.id)}">${esc(w.allow)}</button>${ask.canAlways ? `<button class="st-btn" data-answer="allow" data-ask="${esc(ask.id)}">${esc(w.once)}</button>` : ''}<button class="st-btn" data-answer="deny" data-ask="${esc(ask.id)}">${esc(w.no)}</button></div>`
      : (status === 'done' || status === 'idle') && (k.model.files.size || k.boost?.changed)
        ? `<div class="st-cacts"><button class="st-btn" data-open>${icon('eye', 13)}<span>${esc(w.look)}</span></button><button class="st-btn" data-handoff>${icon('arrowRight', 13)}<span>${esc(w.handoff)}</span></button></div>`
        : '';
    return `<div class="st-card ${status}" data-term="${esc(t.id)}" data-key="c${esc(t.id)}" tabindex="0">${pv}
      <div class="st-cbody"><div class="st-ct1">${stDot(status)}<span class="st-cttl">${esc(stTitle(t))}</span><span class="st-cwhen">${esc(when)}</span></div>
      <div class="st-ct2">${stCardLine(t, k, status)}</div>${acts}</div></div>`;
  });
  const f = (id, label, n) => `<button class="st-filter${filter === id ? ' on' : ''}" data-filter="${id}">${id !== 'all' ? stDot(id === 'done' ? 'done' : id) : ''}${esc(label)}${n !== undefined ? ` · ${n}` : ''}</button>`;
  const html = `<div class="st-bhead"><h2>${esc(w.tasks)}</h2>${counts.needs ? `<span class="st-bcount">${esc(w.needsCount(counts.needs))}</span>` : ''}
    <div class="st-filters">${f('all', w.all)}${counts.needs ? f('needs', w.waiting, counts.needs) : ''}${counts.work ? f('work', w.inWork, counts.work) : ''}${f('done', w.done)}</div></div>
    <div class="st-grid">${newCard}${cards.join('')}</div>`;
  if (board.dataset.html === html) return;
  const first = !board.dataset.html;
  board.innerHTML = html;
  board.dataset.html = html;
  if (first) board.querySelectorAll('.st-card').forEach((c, i) => { c.classList.add('st-in'); c.style.animationDelay = `${Math.min(i, 8) * 30}ms`; });
  stFillImages(board);
}

async function stOnBoardClick(e) {
  const w = STW();
  const flt = e.target.closest('[data-filter]');
  if (flt) { ST.boardFilter = flt.dataset.filter; return stRender(); }
  const chip = e.target.closest('[data-newchip]');
  if (chip || e.target.closest('[data-new]')) {
    ST.current = '';
    ST.preview = null;
    stSetBoard(false);
    $('#st-input').value = chip ? chip.dataset.newchip : '';
    $('#st-input').focus();
    return;
  }
  const card = e.target.closest('.st-card[data-term]');
  if (!card) return;
  const t = stTerms().find((x) => x.id === card.dataset.term);
  if (!t) return;
  const ba = e.target.closest('[data-ba]');
  if (ba) {
    // До/После on the card: the first snapshot over the latest one, crossfaded.
    card.classList.toggle('show-before', ba.dataset.ba === 'before');
    for (const b of card.querySelectorAll('[data-ba]')) b.classList.toggle('on', b === ba);
    return;
  }
  const ans = e.target.closest('[data-answer]');
  if (ans) {
    for (const b of card.querySelectorAll('[data-answer]')) b.disabled = true;
    try {
      if (await wb.studioAnswer(ans.dataset.ask, ans.dataset.answer)) {
        const k = stTask(t);
        const ti = Math.max(0, k.model.turns.length - 1);
        const ask = ST.mission[t.id]?.asks?.find((x) => x.id === ans.dataset.ask);
        const what = ask ? StudioWords.askWords(ask.tool, ask.summary, ST.lang)[0].replace(/^(Разрешить|Allow)\s+/, '').replace(/\?$/, '') : '';
        k.answered.push({ id: ans.dataset.ask, choice: ans.dataset.answer, title: what, turn: ti, after: k.model.turns[ti]?.items.length || 0 });
        if (ST.mission[t.id]?.asks) ST.mission[t.id].asks = ST.mission[t.id].asks.filter((x) => x.id !== ans.dataset.ask);
        card.classList.add('st-answered-card');
      }
    } catch {}
    setTimeout(stRender, stReduced() ? 0 : 200);
    return;
  }
  if (e.target.closest('[data-handoff]')) { stSend(t, w.handoffPrompt); }
  // Anything else on the card opens the task.
  ST.current = t.id;
  ST.preview = null;
  stTask(t).seen = true;
  stSetBoard(false);
}

// ---------------------------------------------------------------- "Кто вы?" (the persona picker)

const ST_PERSONAS = [['developer', 'dev'], ['designer', 'des'], ['manager', 'man'], ['everyday', 'use']];

// Four heroes, as a game's character select (art and effects: studio-persona-fx.js, studio-persona.css):
// the guess (or the current one) picked already. The pick decides what the Workbench tab shows first
// (Studio, or the Workbench for developers); both stay a click away.
function stPersonaPicker({ guess = '', current = '' } = {}) {
  const w = STW();
  $('#st-persona')?.remove();
  const sel = w.personas[current] ? current : w.personas[guess] ? guess : 'designer';
  const box = document.createElement('section');
  box.id = 'st-persona';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', w.whoTitle);
  const svg = (name, size = 15, sw = 1.8) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(typeof STUDIO_PERSONA_ICONS === 'object' && STUDIO_PERSONA_ICONS[name]) || ''}</svg>`;
  const cards = ST_PERSONAS.map(([id, k], i) => {
    const p = w.personas[id];
    const col = (typeof STUDIO_PERSONA_COLORS === 'object' && STUDIO_PERSONA_COLORS[k]) || { c: '#8a8fe0', c2: '#ffffff', bg: ['#1d1b49', '#0c0b22'] };
    const art = `studio-art/hero-${k}.webp`;
    const frame = (typeof STUDIO_PERSONA_FRAMES === 'object' && STUDIO_PERSONA_FRAMES[k]) || '';
    const rgb = k === 'dev' ? `<img class="rgb r" src="${art}" alt=""><img class="rgb b" src="${art}" alt="">` : '';
    const scan = k === 'dev' ? '<span class="mask scan"><i></i></span>' : '';
    return `<div class="pc${id === sel ? ' sel' : ''}" data-k="${k}" data-id="${id}" data-cta="${esc(p.cta)}" style="--c:${col.c};--c2:${col.c2};--hc:${col.c};--i:${i}" tabindex="0" role="button" aria-label="${esc(p.name)}">
      <div class="beam"></div><div class="floor"></div>${frame}
      <div class="art"><div class="tilt"><div class="stk" style="--img:url(${art})"><canvas class="back"></canvas>
        <div class="bust"><img class="hero" src="${art}" alt="">${rgb}<span class="mask foil"><i></i></span>${scan}<span class="mask flash-m"><span class="flash"></span></span></div>
        <canvas class="front"></canvas></div></div></div>
      <div class="plate"><svg class="ribbon" width="292" height="46" viewBox="0 0 292 46" aria-hidden="true"><path d="M0 10 h20 v-6 h252 v6 h20 l-10 13 10 13 h-20 v6 h-252 v-6 h-20 l10 -13z" fill="${col.bg[1]}" stroke="${col.c}" stroke-opacity=".7"/><path d="M20 4 v6 M272 4 v6 M20 36 v6 M272 36 v6" stroke="${col.c}" stroke-opacity=".7"/></svg><h3>${esc(p.name)}</h3></div>
      <div class="cls"><b>${esc(p.cls)}</b> · ${esc(p.role)}</div>
      <ul class="perks">${p.perks.map(([icn, t]) => `<li><span class="pi">${svg(icn)}</span><span>${esc(t)}</span></li>`).join('')}</ul>
      <div class="opens">${svg('arrow', 13)}<span>${p.gets}</span></div>
      ${id === guess && !current ? `<div class="guess"><span class="seal">${svg('spark', 12, 2.2)}</span>${esc(w.guess)}</div>` : ''}
    </div>`;
  }).join('');
  box.innerHTML = `<canvas class="dust"></canvas><h2>${esc(w.whoTitle)}</h2><p class="lead">${esc(w.whoLead)}</p>
    <div class="cards">${cards}</div>
    <div class="foot">${current ? '' : `<button class="btn ghost" data-a="skip">${esc(w.skip)}</button>`}<button class="btn pri" data-a="go">${esc(w.personas[sel].cta)}</button></div>
    <div class="note">${esc(current ? w.whoChange : w.whoNote)}</div>`;
  document.body.appendChild(box);
  if (typeof studioPersonaDust === 'function') studioPersonaDust(box);
  let picked = sel;
  const fx = typeof studioPersonaFx === 'function'
    ? studioPersonaFx(box, (k) => { picked = ST_PERSONAS.find((x) => x[1] === k)?.[0] || picked; })
    : null;
  // Keys: arrows move, Enter/Space picks (no motion for keys).
  box.addEventListener('keydown', (e) => {
    const card = e.target.closest('.pc');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); card.click(); }
    if (card && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); (e.key === 'ArrowRight' ? card.nextElementSibling : card.previousElementSibling)?.focus(); }
    if (e.key === 'Escape' && current) box.remove();
  });
  if (!fx) box.querySelector('.cards').addEventListener('click', (e) => {
    const card = e.target.closest('.pc');
    if (!card) return;
    picked = card.dataset.id;
    for (const c of box.querySelectorAll('.pc')) { c.classList.toggle('sel', c === card); c.classList.toggle('dim', c !== card); }
    box.querySelector('.btn.pri').textContent = card.dataset.cta;
  });
  box.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const persona = a === 'skip' ? (w.personas[guess] ? guess : 'designer') : picked;
    try { await wb.studioSetPersona(persona); } catch {}
    ST.persona = persona;
    box.classList.add('out');
    setTimeout(() => box.remove(), stReduced() ? 0 : 220);
    stShow(persona === 'developer' ? 'workbench' : 'studio');
  });
  setTimeout(() => box.querySelector('.pc.sel')?.focus(), 0);
}

// ---------------------------------------------------------------- point and say (the site next to Studio)

// On: the overlay in the site's tab (studio_point.js): hover, click (Shift: more), say or change by
// hand. Opens the site next to Studio first if it isn't.
async function stPoint(on) {
  const t = stCurrent();
  const k = t && stTask(t);
  if (!on) { ST.pointing = false; wb.studioPoint?.('stop').catch(() => {}); stRender(); return; }
  if (!k?.site) return;
  let site = await wb.studioPoint('site').catch(() => null);
  if (!site?.open) {
    stOpenSite(k);
    for (let i = 0; i < 40 && !site?.open; i++) { await new Promise((r) => setTimeout(r, 150)); site = await wb.studioPoint('site').catch(() => null); }
  }
  if (!site?.open) { toast(STW().pointNoSite); return; }
  await stBoostSnapshot(k, StudioWords.host(k.site));
  await stLoadBrand();
  ST.pointing = !!(await wb.studioPoint('start', { lang: ST.lang, colors: stBrandColors() }).catch(() => false));
  stSendPins(t, k, true);
  stRender();
}

// What the person did on the page.
async function stOnPoint(msg) {
  if (msg.gone || msg.on === false) ST.pointing = false;
  const t = stCurrent();
  if (!t) return stRender();
  const k = stTask(t);
  for (const ev of Array.isArray(msg.events) ? msg.events : []) {
    const items = (Array.isArray(ev.items) ? ev.items : []).filter((x) => typeof x?.sel === 'string').slice(0, 60);
    if (ev.type === 'select') ST.picked = items;
    if (ev.type === 'edit' && items.length && ev.props && typeof ev.props === 'object') await stHand(t, k, items, ev.props);
    if (ev.type === 'say' && typeof ev.text === 'string' && ev.text.trim()) stSayAbout(t, k, items, ev.text.trim());
    if (ev.type === 'pin' && ev.kind === 'brand') continue;
    if (ev.type === 'pin' && Number.isFinite(+ev.n)) {
      const pin = (k.pins || []).find((p) => p.n === +ev.n);
      if (pin && ev.answer === 'yes') stSend(t, STW().pinYes(pin.n, pin.text));
      if (pin) { k.pinsDone = new Set([...(k.pinsDone || []), pin.n]); stSendPins(t, k, true); }
    }
  }
  stRender();
}

// A change by hand: into the site's Boost (Studio's own, so Claude's restyles don't overwrite it),
// remembered so Claude hears of it with the next message.
async function stHand(t, k, items, props) {
  const clean = Object.fromEntries(Object.entries(props).filter(([p, v]) => /^[a-z-]{1,40}$/.test(p) && typeof v === 'string' && /^[#\w\s.,()%-]{1,60}$/.test(v)));
  if (!Object.keys(clean).length) return;
  k.hand = k.hand || new Map();
  for (const it of items) k.hand.set(it.sel, { name: it.name, props: { ...(k.hand.get(it.sel)?.props || {}), ...clean } });
  const css = [...k.hand.entries()].map(([sel, h]) => `${sel} { ${Object.entries(h.props).map(([p, v]) => `${p}: ${v} !important;`).join(' ')} }`).join('\n');
  const host = StudioWords.host(k.site);
  await stBoostSnapshot(k, host);
  try {
    await wb.studioBoost('hand', host, css);
    await wb.studioPoint('settled');
  } catch (err) { toast(err.message); return; }
  if (k.boost) { k.boost.changed = true; k.boost.undone = false; k.boost.showing = 'after'; }
  k.handNotes = k.handNotes || [];
  const what = StudioWords.handWords(clean, ST.lang);
  const who = items.length > 1 ? `${items[0].name} ${STW().andMore(items.length - 1)}` : items[0].name;
  const last = k.handNotes[k.handNotes.length - 1];
  if (last && last.who === who) last.what = [...new Set([...last.what, ...what])];
  else k.handNotes.push({ who, what, sels: items.map((x) => x.sel) });
}

// The hand changes in words, for Claude (sent before the next message) and for the chat.
function stHandPrompt(k) {
  if (!k.handNotes?.length) return '';
  const lines = k.handNotes.map((n) => `- ${n.who} (${n.sels.slice(0, 3).join(', ')}): ${n.what.join(', ')}`);
  return STW().handPrompt(StudioWords.host(k.site), lines.join('\n'));
}

function stSayAbout(t, k, items, text) {
  const host = StudioWords.host(k.site);
  const list = items.map((x) => `${x.name} — \`${x.sel}\``).join('\n');
  stSend(t, STW().sayPrompt(host, list, text));
}

// A message from Studio itself (point and say, a pin): with the hand changes first, as typed ones.
function stSend(t, text) {
  const k = stTask(t);
  const full = [stHandPrompt(k), text].filter(Boolean).join('\n\n');
  k.handNotes = [];
  if (stStatus(t) === 'work' || stStatus(t) === 'needs') { k.queue.push({ id: `q${++stQueueSeq}`, text: full }); return; }
  stType(t, full);
}

// Claude's remarks about elements ([[pin: selector | text]] in its answers) as numbered pins.
function stPinsOf(k) {
  const out = [];
  const seen = new Set();
  for (const turn of k.model.turns) for (const it of turn.items) {
    if (it.type !== 'text') continue;
    for (const m of it.text.matchAll(/\[\[pin:\s*([^|\]]{1,300})\|\s*([^\]]{1,400})\]\]/g)) {
      const sel = m[1].trim(), text = m[2].trim();
      if (seen.has(sel + text)) continue;
      seen.add(sel + text);
      out.push({ n: out.length + 1, sel, text });
    }
  }
  return out;
}
function stSendPins(t, k, force = false) {
  const pins = stPinsOf(k);
  k.pins = pins;
  const shown = pins.filter((p) => !k.pinsDone?.has(p.n));
  const key = JSON.stringify(shown);
  if (!force && key === k.pinsKey) return;
  k.pinsKey = key;
  if (typeof wb.studioPoint === 'function') wb.studioPoint('pins', shown).catch(() => {});
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
  stSendPins(t, k);
  // Claude wrote the brand (from Figma): read it again.
  const bf = k.model.files.get('brand.json');
  if (bf && bf.times !== k.brandSeen) { k.brandSeen = bf.times; ST.brandLoaded = false; stLoadBrand(); }
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
