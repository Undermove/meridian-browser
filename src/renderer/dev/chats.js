/* Meridian Workbench — Chats: the agent sessions as a list in the left pane ("Chats | Files | Changes").
 * A preview, off unless turned on (Customize › Advanced › "Chats list (preview)"); while off this file
 * changes nothing on the page and tells Meridian nothing.
 *
 * The list is the terminals (the same sessions as the tabs over the terminal), in their order, never
 * reordered by status. Each row: the status mark, the agent, the name, how long it has been in that
 * state; below, the state in words and the context gauge. A click shows that session; the strip over
 * the terminal then shows just that one's tab. The states come from SessionStatus (session-status.js):
 * hooks only, nothing guessed.
 */
const CHATS = { on: false, open: true, timer: 0, dom: null, beta: false, renaming: null, renameTimer: 0 };

// Meridian Beta: on unless turned off here (wb.studioInfo().beta).
function chatsEnabled() { const v = load('chatsList'); return v === '1' || (v === null && CHATS.beta === true); }

function chatsSetEnabled(on) {
  store('chatsList', on ? '1' : '');
  if (on) chatsStart(); else chatsStop();
}

function chatsStart() {
  if (CHATS.on) return;
  CHATS.on = true;
  document.body.dataset.chats = 'on';
  const views = $('#left-views');
  const btn = document.createElement('button');
  btn.id = 'view-chats';
  btn.className = 'left-view';
  btn.setAttribute('role', 'tab');
  btn.title = 'Agent sessions';
  btn.innerHTML = `<span class="ic-slot">${icon('chat', 14)}</span><span>Chats</span><span id="chats-count"></span>`;
  views.insertBefore(btn, views.firstChild);
  // The list: its own header (with "+"), the sessions, then the ended ones folded away.
  const view = document.createElement('div');
  view.id = 'chats-view';
  const head = document.createElement('div');
  head.className = 'chats-head';
  const label = document.createElement('span');
  label.className = 'chats-head-label';
  label.textContent = 'Sessions';
  const add = document.createElement('button');
  add.className = 'icon-btn small';
  add.id = 'chats-new';
  add.title = 'New Claude Code session';
  add.setAttribute('aria-label', 'New Claude Code session');
  add.innerHTML = icon('plus', 14);
  add.addEventListener('click', () => { if (typeof launch === 'function') launch('claude'); });
  head.append(label, add);
  const list = document.createElement('div');
  list.className = 'chats-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Agent sessions');
  const ended = document.createElement('details');
  ended.className = 'chats-ended';
  ended.open = load('chatsEndedOpen') === '1';
  ended.addEventListener('toggle', () => store('chatsEndedOpen', ended.open ? '1' : ''));
  const summary = document.createElement('summary');
  const endedList = document.createElement('div');
  endedList.className = 'chats-list';
  ended.append(summary, endedList);
  view.append(head, list, ended);
  $('#scm-view').after(view);
  const onFiles = () => chatsOpen(false);
  btn.addEventListener('click', () => chatsOpen(true));
  $('#view-files').addEventListener('click', onFiles);
  $('#view-scm').addEventListener('click', onFiles);
  const unsub = SessionStatus.onChange(() => { chatsRefresh(); chatsFlushRenames(); });
  // Rename: a double click on a name, the row's menu, or F2 on the row.
  list.addEventListener('keydown', chatsKeys);
  endedList.addEventListener('keydown', chatsKeys);
  const onVis = () => chatsReport();
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', onVis);
  CHATS.timer = setInterval(() => chatsRender(), 30000);
  // The terminal folded away or shown again.
  const folds = new MutationObserver(() => chatsReport());
  folds.observe($('#term-area'), { attributes: true, attributeFilter: ['class'] });
  // Room for three views over the list, unless the pane was sized by hand.
  const roomy = !Number(load('treeW'));
  if (roomy) document.documentElement.style.setProperty('--tree-w', '290px');
  CHATS.dom = { btn, view, list, ended, summary, endedList, onFiles, unsub, onVis, folds, roomy };
  chatsOpen(load('chatsView') !== 'files');
  chatsRefresh();
}

function chatsStop() {
  if (!CHATS.on) return;
  CHATS.on = false;
  const d = CHATS.dom;
  CHATS.dom = null;
  clearInterval(CHATS.timer);
  clearTimeout(CHATS.renameTimer);
  CHATS_RENAMES.clear();
  d.unsub();
  d.folds.disconnect();
  document.removeEventListener('visibilitychange', d.onVis);
  window.removeEventListener('focus', d.onVis);
  $('#view-files').removeEventListener('click', d.onFiles);
  $('#view-scm').removeEventListener('click', d.onFiles);
  d.btn.remove(); d.view.remove();
  delete document.body.dataset.chats;
  if (d.roomy && !Number(load('treeW'))) document.documentElement.style.removeProperty('--tree-w');
  delete $('#tree-pane').dataset.left;
  // Back to what the Files | Changes switch says.
  $('#view-files').classList.toggle('on', !(typeof SCM !== 'undefined' && SCM.open));
  SessionStatus.report({ on: false });
  renderTermTabs();
}

function chatsOpen(open) {
  if (!CHATS.on) return;
  CHATS.open = open;
  store('chatsView', open ? '' : 'files');
  const pane = $('#tree-pane');
  if (open) pane.dataset.left = 'chats'; else delete pane.dataset.left;
  CHATS.dom.btn.classList.toggle('on', open);
  if (open) { $('#view-files').classList.remove('on'); $('#view-scm').classList.remove('on'); }
  else if (!$('#view-scm').classList.contains('on')) $('#view-files').classList.add('on');
  chatsRender();
}

// What the person sees: the session on screen ('' while this tab is hidden or the terminal folded).
function chatsReport() {
  if (!CHATS.on) return;
  // Studio (studio.js) reports while it is the view in sight.
  if (document.body.classList.contains('studio-view')) return;
  const t = S.activeTerm;
  const shown = document.visibilityState === 'visible' && t && !$('#term-area').classList.contains('collapsed');
  SessionStatus.report({ on: true, onScreen: shown ? t.id : '', order: S.terms.map((x) => x.id) });
}

// After the terminals' tabs are drawn (renderTermTabs): their marks, then the list.
function chatsAfterTabs() {
  if (!CHATS.on) return;
  const tabs = [...document.querySelectorAll('#term-tab-list .ttab')];
  S.terms.forEach((t, i) => {
    const el = tabs[i];
    if (!el) return;
    const m = SessionStatus.mark(SessionStatus.get(t.id).state);
    if (m) el.querySelector('.mark')?.after(m);
  });
  chatsRender();
  chatsReport();
}

// A state change: the tabs again (which draws the list), unless a tab is being renamed or dragged.
function chatsRefresh() {
  if (!CHATS.on) return;
  if (S.renamingTerm || S.draggingTerm) { chatsRender(); return; }
  renderTermTabs();
}

function chatsWhen(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The second line when no hook tells the state.
function chatsQuietWords(t) {
  if (t.exited) return 'Exited';
  if (t.kind === 'shell' && !t.sessionId) return 'Shell';
  if (termIsClaude(t)) return 'Starting';
  return AGENT_UI[t.kind]?.label || 'Agent';
}

function chatsRender() {
  if (!CHATS.on || CHATS.renaming) return;
  const count = $('#chats-count');
  const live = S.terms.filter((t) => !t.exited).length;
  count.textContent = live ? String(live) : '';
  count.hidden = !live;
  if (!CHATS.open) return;
  const { list, ended, summary, endedList } = CHATS.dom;
  const running = S.terms.filter((t) => !t.exited);
  const over = S.terms.filter((t) => t.exited);
  if (!running.length) {
    const empty = document.createElement('div');
    empty.id = 'chats-empty';
    empty.textContent = S.project ? 'No sessions running. Start one with + or from the toolbar.' : 'Open a project to start a session.';
    list.replaceChildren(empty);
  } else list.replaceChildren(...running.map(chatsRow));
  // Ended sessions: at the bottom, folded unless opened (or the one on screen is there).
  ended.hidden = !over.length;
  summary.textContent = `Ended · ${over.length}`;
  if (over.includes(S.activeTerm)) ended.open = true;
  endedList.replaceChildren(...over.map(chatsRow));
}

function chatsRow(t) {
  const st = SessionStatus.get(t.id);
  const row = document.createElement('div');
  row.className = `chat-row${t === S.activeTerm ? ' active' : ''}${st.state ? ' ' + st.state : ''}${t.exited ? ' exited' : ''}`;
  row.dataset.term = t.id;
  row.dataset.state = st.state || 'none';
  row.setAttribute('role', 'option');
  row.tabIndex = t === S.activeTerm ? 0 : -1;
  row.setAttribute('aria-selected', String(t === S.activeTerm));
  const status = document.createElement('span');
  status.className = 'chat-status';
  const m = SessionStatus.mark(st.state);
  if (m) status.appendChild(m);
  row.appendChild(status);
  row.appendChild(agentMark(t.kind === 'shell' && t.sessionId ? 'claude' : AGENT_UI[t.kind] ? t.kind : 'shell'));
  const main = document.createElement('div');
  main.className = 'chat-main';
  const top = document.createElement('div');
  top.className = 'chat-top';
  const name = document.createElement('span');
  name.className = 'chat-name';
  name.textContent = termName(t);
  top.appendChild(name);
  if (t.rc === 'on') { const rc = termRcBadge(t); if (rc) top.appendChild(rc); }
  const when = document.createElement('span');
  when.className = 'chat-when';
  when.textContent = st.state ? chatsWhen(st.since) : '';
  top.appendChild(when);
  const sub = document.createElement('div');
  sub.className = 'chat-sub';
  const words = document.createElement('span');
  words.className = 'chat-words';
  words.textContent = st.state ? SessionStatus.words(t.id) : chatsQuietWords(t);
  words.title = words.textContent;
  sub.appendChild(words);
  const gauge = typeof termUsageBadge === 'function' ? termUsageBadge(t) : null;
  if (gauge) sub.appendChild(gauge);
  main.append(top, sub);
  row.appendChild(main);
  row.title = termName(t);
  row.addEventListener('click', (e) => {
    if (e.target.closest('.tab-usage, .chat-rename')) return;
    // A double click on the name renames (told by the click count: the first click redraws the list).
    if (e.detail === 2 && e.target.closest('.chat-name')) { chatsRename(t); return; }
    if (e.detail > 1) return;
    $('#term-area').classList.remove('collapsed');
    activateTerm(t);
  });
  row.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (typeof wb.menu !== 'function') return;
    const choice = await wb.menu([{ id: 'rename', label: 'Rename…' }]);
    if (choice === 'rename') chatsRename(t);
  });
  return row;
}

// ---------------------------------------------------------------- renaming a session

function chatsKeys(e) {
  if (e.key !== 'F2' || e.target.closest('.chat-rename')) return;
  const row = e.target.closest('.chat-row');
  const t = row ? S.terms.find((x) => x.id === row.dataset.term) : S.activeTerm;
  if (!t) return;
  e.preventDefault();
  chatsRename(t);
}

// The name in place: Enter keeps it, Esc goes back, leaving the field keeps it (as on the tab).
function chatsRename(t) {
  if (!CHATS.on || CHATS.renaming) return;
  const nameEl = CHATS.dom.view.querySelector(`.chat-row[data-term="${CSS.escape(t.id)}"] .chat-name`);
  if (!nameEl) return;
  CHATS.renaming = t;
  S.renamingTerm = t;
  const input = document.createElement('input');
  input.className = 'chat-rename';
  input.value = termName(t);
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Session name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    CHATS.renaming = null;
    S.renamingTerm = null;
    // Empty: back to the name the program gives (saveTermName's rule).
    if (keep && input.value.trim() !== termName(t)) saveTermName(t, input.value.trim().slice(0, 80));
    renderTermTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// A name given by hand becomes Claude Code's own name too (/rename: what `claude --resume` and
// claude.ai show), typed into the session only while it is idle with an empty prompt, so a running
// turn or half-typed text is never touched. Until then it waits; a newer name replaces it.
const CHATS_RENAMES = new Map(); // termId -> name
function chatsRenamed(t, name) {
  if (!CHATS.on || !termIsClaude(t) || t.exited) return;
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);
  if (!clean) { CHATS_RENAMES.delete(t.id); return; }
  CHATS_RENAMES.set(t.id, clean);
  chatsFlushRenames();
}

function chatsFlushRenames() {
  clearTimeout(CHATS.renameTimer);
  for (const [id, name] of CHATS_RENAMES) {
    const t = S.terms.find((x) => x.id === id);
    if (!t || t.exited || !termIsClaude(t)) { CHATS_RENAMES.delete(id); continue; }
    const state = SessionStatus.get(id).state;
    if ((state !== 'idle' && state !== 'done') || (t.typed || '').length) continue;
    CHATS_RENAMES.delete(id);
    wb.ptyWrite(id, `/rename ${name}\r`);
  }
  // Waiting on an empty prompt: the status says when it's idle; typing is looked at again shortly.
  if (CHATS_RENAMES.size) CHATS.renameTimer = setTimeout(chatsFlushRenames, 1000);
}

document.addEventListener('DOMContentLoaded', async () => {
  if (chatsEnabled()) return chatsStart();
  if (load('chatsList') !== null || typeof wb?.studioInfo !== 'function') return;
  try { CHATS.beta = (await wb.studioInfo())?.beta === true; } catch { return; }
  if (chatsEnabled()) chatsStart();
});

// Studio went out of sight: the list says what is on screen again.
addEventListener('studio-hidden', () => chatsReport());
