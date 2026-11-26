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
const CHATS = { on: false, open: true, timer: 0, dom: null };

function chatsEnabled() { return load('chatsList') === '1'; }

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
  btn.innerHTML = `${icon('chat', 14)}<span>Chats</span><span id="chats-count"></span>`;
  views.insertBefore(btn, views.firstChild);
  const tools = document.createElement('div');
  tools.id = 'chats-tools';
  const add = document.createElement('button');
  add.className = 'icon-btn small';
  add.id = 'chats-new';
  add.title = 'New Claude Code session';
  add.innerHTML = icon('plus', 14);
  add.addEventListener('click', () => { if (typeof launch === 'function') launch('claude'); });
  tools.appendChild(add);
  $('#tree-tools').after(tools);
  const view = document.createElement('div');
  view.id = 'chats-view';
  view.setAttribute('role', 'listbox');
  view.setAttribute('aria-label', 'Agent sessions');
  $('#scm-view').after(view);
  const onFiles = () => chatsOpen(false);
  btn.addEventListener('click', () => chatsOpen(true));
  $('#view-files').addEventListener('click', onFiles);
  $('#view-scm').addEventListener('click', onFiles);
  const unsub = SessionStatus.onChange(() => chatsRefresh());
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
  CHATS.dom = { btn, tools, view, onFiles, unsub, onVis, folds, roomy };
  chatsOpen(load('chatsView') !== 'files');
  chatsRefresh();
}

function chatsStop() {
  if (!CHATS.on) return;
  CHATS.on = false;
  const d = CHATS.dom;
  CHATS.dom = null;
  clearInterval(CHATS.timer);
  d.unsub();
  d.folds.disconnect();
  document.removeEventListener('visibilitychange', d.onVis);
  window.removeEventListener('focus', d.onVis);
  $('#view-files').removeEventListener('click', d.onFiles);
  $('#view-scm').removeEventListener('click', d.onFiles);
  d.btn.remove(); d.tools.remove(); d.view.remove();
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
  if (!CHATS.on) return;
  const view = CHATS.dom.view;
  const count = $('#chats-count');
  const live = S.terms.filter((t) => !t.exited).length;
  count.textContent = live ? String(live) : '';
  count.hidden = !live;
  if (!CHATS.open) return;
  if (!S.terms.length) {
    const empty = document.createElement('div');
    empty.id = 'chats-empty';
    empty.textContent = S.project ? 'No sessions yet. Start one with + or from the toolbar.' : 'Open a project to start a session.';
    view.replaceChildren(empty);
    return;
  }
  view.replaceChildren(...S.terms.map((t) => {
    const st = SessionStatus.get(t.id);
    const row = document.createElement('div');
    row.className = `chat-row${t === S.activeTerm ? ' active' : ''}${st.state ? ' ' + st.state : ''}${t.exited ? ' exited' : ''}`;
    row.dataset.term = t.id;
    row.dataset.state = st.state || 'none';
    row.setAttribute('role', 'option');
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
      if (e.target.closest('.tab-usage')) return;
      $('#term-area').classList.remove('collapsed');
      activateTerm(t);
    });
    return row;
  }));
}

document.addEventListener('DOMContentLoaded', () => { if (chatsEnabled()) chatsStart(); });
