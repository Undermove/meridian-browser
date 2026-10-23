/* Meridian — the Chat view: a calm, full-size chat window (like the Claude or ChatGPT apps) in the
 * content area, for people who want to talk to an AI rather than browse with it.
 *
 * It answers with whatever AI the user picked (state.settings.aiProvider): a local agent CLI on their
 * own account where its terms allow it (GitHub Copilot, local models, opt-in agents) or the Claude API key. Conversations live in main
 * (userData/chats.json, src/ai/chats-store.js); private windows keep them in memory only.
 * Each chat has its own AI session ('chat-' + id), so local agents resume their context; a chat
 * reopened after a restart sends its earlier turns once (`history`), since main forgot the session.
 *
 * Model output is rendered with renderMarkdown() from ai.js (escape-first, no images, no raw HTML);
 * links open in a background tab. Loaded after ai.js and shares app.js globals (state, rt, api, …).
 */

const CHAT_SUGGESTIONS = [
  { icon: 'file', label: 'Summarize this page', q: 'Summarize this page.', page: true },
  { icon: 'pencil', label: 'Draft an email', q: 'Help me draft a short, friendly email. Ask me who it’s for and what it should say.' },
  { icon: 'sparkles', label: 'Explain like I’m new to this', q: 'Explain this page simply, like I’m new to the topic.', page: true },
  { icon: 'wand', label: 'Brainstorm ideas', q: 'Help me brainstorm ideas. First ask me what I’m working on.' },
];

const chatUi = {
  el: null,
  open: false,
  list: [],             // summaries, newest first
  cache: new Map(),     // id -> full chat
  current: null,        // the chat on screen (a draft until its first message)
  runs: new Map(),      // sessionId -> { chatId, text, provider, el }
  live: new Set(),      // chat ids main already has a session for (since this window started)
  agents: null,         // last agents list (api.agentsList shape)
  hasKey: false,
  includePage: false,
  showSetup: false,
  setupCard: null,
};

const chatSid = (c) => `chat-${c.id}`;
const chatBusy = (c) => !!c && chatUi.runs.has(chatSid(c));

// ---------------------------------------------------------------- which AI answers
// The list comes from ai.js's listAiAgents() (shared cache).

const chatListAgents = (fresh = false) => (typeof listAiAgents === 'function' ? Promise.resolve(listAiAgents(fresh)) : api.agentsList(fresh)).catch(() => []);

// The picker's choices: installed agents (signed-out ones shown, not choosable) and the API key.
function chatAgentOptions() {
  const opts = (chatUi.agents || []).filter((a) => a.installed && agentAllowed(a)).map((a) => ({
    id: a.id, label: a.label, ready: a.loggedIn !== false, sub: a.loggedIn === false ? 'Not signed in' : (a.account || a.vendor),
  }));
  if (chatUi.hasKey) opts.push({ id: 'api', label: 'Claude API key', ready: true, sub: 'Anthropic API' });
  return opts;
}

// Same rule as ⌘J and Ask (pickAiProvider in ai.js), on the cached list so the picker can draw at once.
function chatProvider() {
  const p = pickAiProvider(chatUi.agents || [], chatUi.hasKey);
  return p.ready ? chatAgentOptions().find((o) => o.id === p.id) || { id: p.id, label: p.label, ready: true } : null;
}

const chatAiReady = () => !!chatProvider();

async function refreshChatAgents(fresh = false) {
  const [agents, hasKey] = await Promise.all([chatListAgents(fresh), api.aiHasKey().catch(() => false)]);
  chatUi.agents = agents || [];
  chatUi.hasKey = !!hasKey;
  if (chatUi.open) { renderChatThread(); updateChatComposer(); }
}

// ---------------------------------------------------------------- storage

// Private windows never save: their chats exist only in this window's memory.
const chatStore = {
  list: () => (EPHEMERAL ? Promise.resolve([]) : api.chatsList().catch(() => [])),
  get: (id) => (EPHEMERAL ? Promise.resolve(null) : api.chatsGet(id).catch(() => null)),
  save: (c) => (EPHEMERAL ? Promise.resolve(true) : api.chatsSave(chatForDisk(c)).catch(() => false)),
  delete: (id) => (EPHEMERAL ? Promise.resolve(true) : api.chatsDelete(id).catch(() => false)),
};

const chatForDisk = (c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages });

function chatSummary(c) { return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length }; }

function rememberChat(c) {
  chatUi.cache.set(c.id, c);
  chatUi.list = [chatSummary(c), ...chatUi.list.filter((x) => x.id !== c.id)].sort((a, b) => b.updatedAt - a.updatedAt);
}

function persistChat(c) {
  rememberChat(c);
  renderChatList();
  return chatStore.save(c);
}

function newDraftChat() {
  return { id: uid(), title: 'New chat', createdAt: now(), updatedAt: now(), messages: [], notices: [] };
}

// "Plan a trip to Tbilisi in May\nwith kids" -> "Plan a trip to Tbilisi in May"
function chatTitle(text) {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) || 'New chat';
  return line.length > 60 ? line.slice(0, 57).replace(/\s+\S*$/, '') + '…' : line;
}

// ---------------------------------------------------------------- open / close

async function openChat() {
  if (MINI) return;
  if (!chatUi.el) initChatView();
  closePanels();
  chatUi.open = true;
  document.body.classList.add('chat-open');
  chatUi.el.hidden = false;
  if (!chatUi.current) chatUi.current = newDraftChat();
  renderChatList();
  renderChatThread();
  updateChatComposer();
  setTimeout(() => $('#chat-input')?.focus(), 30);
  const [list] = await Promise.all([chatStore.list(), refreshChatAgents()]);
  // Chats created in this window but not on disk (private windows) stay in the list.
  const known = new Set(list.map((x) => x.id));
  chatUi.list = [...list, ...chatUi.list.filter((x) => !known.has(x.id) && chatUi.cache.has(x.id))].sort((a, b) => b.updatedAt - a.updatedAt);
  renderChatList();
}

function closeChat({ focus = true } = {}) {
  if (!chatUi.open) return;
  chatUi.open = false;
  document.body.classList.remove('chat-open');
  chatUi.el.hidden = true;
  closeChatAgentMenu();
  if (focus) { const t = activeTab(); if (t) rt.views.get(t.id)?.focus(); }
}

function toggleChat() { return chatUi.open ? closeChat() : openChat(); }

async function showChat(id) {
  closeChatAgentMenu();
  if (!id) chatUi.current = newDraftChat();
  else {
    let c = chatUi.cache.get(id);
    if (!c) {
      const stored = await chatStore.get(id);
      if (!stored) { toast('That chat couldn’t be opened'); return; }
      c = { ...stored, notices: [] };
      chatUi.cache.set(id, c);
    }
    chatUi.current = c;
  }
  chatUi.showSetup = false;
  chatUi.el.classList.remove('side-open');
  renderChatList();
  renderChatThread();
  updateChatComposer();
  $('#chat-input')?.focus();
}

async function deleteChat(id) {
  const s = chatUi.list.find((x) => x.id === id);
  if (!(await confirmBox(`Delete “${s?.title || 'this chat'}”?`, 'Delete'))) return;
  const sid = `chat-${id}`;
  if (chatUi.runs.has(sid)) api.aiStop(sid);
  chatUi.runs.delete(sid);
  api.aiReset(sid);
  chatUi.cache.delete(id);
  chatUi.live.delete(id);
  chatUi.list = chatUi.list.filter((x) => x.id !== id);
  await chatStore.delete(id);
  if (chatUi.current?.id === id) chatUi.current = newDraftChat();
  renderChatList();
  renderChatThread();
  updateChatComposer();
}

// ---------------------------------------------------------------- sending

async function sendChat(text, { page = chatUi.includePage } = {}) {
  text = String(text || '').trim();
  const c = chatUi.current;
  if (!text || !c || chatBusy(c)) return false;
  const provider = chatProvider();
  if (!provider) { chatUi.showSetup = true; renderChatThread(); return false; }
  // Workbench Pro integration: the same "this looks like a secret" check as ⌘J.
  if (window.MeridianSecrets?.find(text).length && !(await confirmSecretSend(text))) return false;
  // A chat main doesn't know yet (reopened after a restart) brings its earlier turns along once.
  const history = !chatUi.live.has(c.id) && c.messages.length ? c.messages.map((m) => ({ role: m.role, text: m.text })) : null;
  if (!c.messages.length) c.title = chatTitle(text);
  c.messages.push({ role: 'user', text, ts: now() });
  c.updatedAt = now();
  const sid = chatSid(c);
  chatUi.runs.set(sid, { chatId: c.id, text: '', provider: provider.id, label: provider.label, el: null });
  chatUi.live.add(c.id);
  chatUi.showSetup = false;
  persistChat(c);
  renderChatThread({ scroll: true });
  updateChatComposer();
  // Private windows never send page text (they never talk to agents about what's open in them).
  const pageCtx = page && !PRIVATE ? await pageForAi(true) : null;
  api.aiChat({ sessionId: sid, text, page: pageCtx, provider: provider.id, mode: 'chat', ...(history ? { history } : {}) });
  return true;
}

function onChatAiEvent(ev) {
  const run = chatUi.runs.get(ev.sessionId);
  if (!run) return;
  const c = chatUi.cache.get(run.chatId);
  const shown = chatUi.open && chatUi.current?.id === run.chatId;
  if (ev.type === 'text') {
    run.text += ev.delta || '';
    if (shown) scheduleChatStream(run);
  } else if (ev.type === 'notice') {
    c?.notices.push({ at: c.messages.length + 1, text: ev.message });
  } else if (ev.type === 'done' || ev.type === 'error') {
    chatUi.runs.delete(ev.sessionId);
    if (c) {
      const text = run.text.trim();
      if (text) c.messages.push({ role: 'assistant', text, ts: now(), provider: run.provider, ...(ev.stopped ? { stopped: true } : {}) });
      if (ev.type === 'error') c.notices.push({ at: c.messages.length, text: ev.message, error: true });
      else if (ev.stopped && !text) c.notices.push({ at: c.messages.length, text: 'Stopped.' });
      c.updatedAt = now();
      persistChat(c);
    }
    if (ev.type === 'error' && ev.code === 'not-installed') refreshChatAgents(true);
    if (shown) { renderChatThread(); updateChatComposer(); }
    else renderChatList();
  }
}

// Streaming: one Markdown re-render per frame, and follow the bottom only if the reader is there.
function scheduleChatStream(run) {
  if (run.raf) return;
  run.raf = requestAnimationFrame(() => {
    run.raf = 0;
    const el = $(`#chat-thread [data-run="${CSS.escape(chatSidOf(run))}"] .chat-md`);
    if (!el) return;
    const scroller = $('#chat-scroll');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    el.innerHTML = renderMarkdown(run.text) || '<span class="ai-typing"></span>';
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  });
}
const chatSidOf = (run) => `chat-${run.chatId}`;

// ---------------------------------------------------------------- rendering

function chatAgentLabel(id) {
  if (id === 'api') return 'Claude';
  return (chatUi.agents || []).find((a) => a.id === id)?.label || 'Assistant';
}

function chatDayGroup(t) {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function chatRelTime(t) {
  const s = Math.max(0, (now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderChatList() {
  const box = $('#chat-list');
  if (!box) return;
  if (!chatUi.list.length) {
    box.innerHTML = `<div class="chat-list-empty">${EPHEMERAL ? 'Chats in a private window aren’t saved.' : 'Your conversations will show up here.'}</div>`;
    return;
  }
  let group = '';
  const html = [];
  for (const s of chatUi.list) {
    const g = chatDayGroup(s.updatedAt);
    if (g !== group) { html.push(`<div class="chat-list-group">${esc(g)}</div>`); group = g; }
    const busy = chatUi.runs.has(`chat-${s.id}`);
    html.push(`<div class="chat-item ${chatUi.current?.id === s.id ? 'active' : ''}" data-chat="${esc(s.id)}" title="${esc(s.title)} · ${esc(chatRelTime(s.updatedAt))}">
      <span class="chat-item-title">${esc(s.title)}</span>
      ${busy ? '<span class="chat-item-busy"></span>' : `<span class="chat-item-time">${esc(chatRelTime(s.updatedAt))}</span>`}
      <button class="chat-item-del" data-del="${esc(s.id)}" title="Delete chat">${icon('trash', 13)}</button>
    </div>`);
  }
  if (EPHEMERAL) html.push('<div class="chat-list-empty">Chats in a private window aren’t saved.</div>');
  box.innerHTML = html.join('');
}

function renderChatThread({ scroll = false } = {}) {
  const box = $('#chat-thread');
  if (!box) return;
  const c = chatUi.current;
  $('#chat-title').textContent = c && c.messages.length ? c.title : 'New chat';
  chatUi.setupCard?.destroy();
  chatUi.setupCard = null;
  box.classList.remove('is-empty', 'is-setup');

  if (chatUi.agents === null) {
    box.innerHTML = '<div class="chat-loading"><span class="ai-typing"></span></div>';
    return;
  }
  if (!chatAiReady() || chatUi.showSetup) {
    box.classList.add('is-setup');
    box.innerHTML = `<div class="chat-setup">${chatUi.showSetup && chatAiReady() ? '<button class="chat-setup-back" data-act="setup-back">← Back to the chat</button>' : ''}<div id="chat-setup-card"></div></div>`;
    chatUi.setupCard = renderAgentSetupCard($('#chat-setup-card', box), {
      title: chatAiReady() ? 'Set up another AI' : 'Choose an AI to chat with',
      onReady: (list, { hasKey }) => {
        const was = chatAiReady();
        chatUi.agents = list; chatUi.hasKey = hasKey;
        if (!was && chatAiReady()) { chatUi.showSetup = false; renderChatThread(); updateChatComposer(); toast(`${chatProvider().label} is ready`); }
        else updateChatComposer();
      },
    });
    return;
  }
  if (!c.messages.length && !chatBusy(c)) {
    box.classList.add('is-empty');
    box.innerHTML = `
      <div class="chat-empty">
        <div class="chat-hello-mark"><svg width="40" height="40" viewBox="0 7 64 64"><path d="M10 50 A26 26 0 0 1 54 50" fill="none" stroke="var(--space)" stroke-width="7" stroke-linecap="round"/><circle cx="32" cy="50" r="4" fill="var(--space)"/></svg></div>
        <h1 class="chat-hello">${esc(chatGreeting())}</h1>
        <p class="chat-hello-sub">Ask anything — write, plan, explain or summarize. ${esc(chatProvider().label)} answers.</p>
        <div class="chat-suggestions">
          ${CHAT_SUGGESTIONS.map((s, i) => `<button class="chat-suggestion" data-suggest="${i}">${icon(s.icon, 15)}<span>${esc(s.label)}</span></button>`).join('')}
        </div>
      </div>`;
    return;
  }

  const out = [];
  const notices = (at) => (c.notices || []).filter((n) => n.at === at).map((n) => `<div class="chat-notice ${n.error ? 'error' : ''}">${esc(n.text)}</div>`).join('');
  c.messages.forEach((m, i) => {
    out.push(notices(i));
    if (m.role === 'user') out.push(`<div class="chat-msg user"><div class="chat-bubble">${esc(m.text)}</div></div>`);
    else out.push(chatAssistantHtml(m.text, { i, provider: m.provider, stopped: m.stopped }));
  });
  out.push(notices(c.messages.length));
  const run = chatUi.runs.get(chatSid(c));
  if (run) out.push(chatAssistantHtml(run.text, { provider: run.provider, run: chatSid(c) }));
  box.innerHTML = out.join('');
  if (scroll || run || c.messages.length) $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
}

function chatAssistantHtml(text, { i = null, provider, stopped = false, run = null }) {
  return `<div class="chat-msg assistant ${run ? 'streaming' : ''}" ${run ? `data-run="${esc(run)}"` : `data-i="${i}"`}>
    <div class="chat-who"><span class="chat-avatar">${icon('sparkles', 12)}</span>${esc(chatAgentLabel(provider))}</div>
    <div class="chat-md">${renderMarkdown(text) || '<span class="ai-typing"></span>'}</div>
    ${run ? '' : `<div class="chat-actions">
      <button class="chat-act" data-copy="${i}" title="Copy">${icon('copy', 13)}<span>Copy</span></button>
      ${stopped ? '<span class="chat-act-note">Stopped</span>' : ''}
    </div>`}
  </div>`;
}

function chatGreeting() {
  const h = new Date().getHours();
  const name = (state.settings.memberName || '').split(' ')[0];
  const part = h < 5 ? 'Hello' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

function updateChatComposer() {
  if (!chatUi.el) return;
  const c = chatUi.current;
  const busy = chatBusy(c);
  const p = chatProvider();
  const ready = !!p && !chatUi.showSetup;
  $('#chat-composer').classList.toggle('disabled', !ready);
  $('#chat-input').disabled = !ready;
  $('#chat-input').placeholder = p ? `Message ${p.label}…` : 'Set up an AI to start chatting';
  $('#chat-send').hidden = busy;
  $('#chat-stop').hidden = !busy;
  $('#chat-send').disabled = !ready || !$('#chat-input').value.trim();
  $('#chat-agent-btn').innerHTML = `<span class="chat-agent-dot ${p ? 'ok' : ''}"></span><span class="chat-agent-name">${esc(p ? p.label : chatUi.agents === null ? 'Looking…' : 'No AI set up')}</span>${icon('chevronDown', 12)}`;
  const t = activeTab();
  const pageBtn = $('#chat-page');
  const canPage = !!t && !PRIVATE && !isWorkbenchTab(t);
  pageBtn.hidden = !canPage;
  pageBtn.classList.toggle('on', chatUi.includePage && canPage);
  pageBtn.setAttribute('aria-pressed', String(chatUi.includePage && canPage));
  $('#chat-page-host').textContent = t ? hostOf(tabUrl(t)) : '';
  pageBtn.title = chatUi.includePage ? 'The current page’s text is sent with your message — click to stop' : 'Send the current page’s text with your message';
}

// ---------------------------------------------------------------- agent picker

function toggleChatAgentMenu() {
  if ($('#chat-agent-menu')) return closeChatAgentMenu();
  const opts = chatAgentOptions();
  const cur = chatProvider()?.id;
  const menu = document.createElement('div');
  menu.id = 'chat-agent-menu';
  menu.innerHTML = `
    <div class="cam-head">Who answers</div>
    ${opts.map((o) => `<button class="cam-item ${o.id === cur ? 'on' : ''}" data-pick="${esc(o.id)}" ${o.ready ? '' : 'disabled'}>
      <span class="cam-text"><span class="cam-label">${esc(o.label)}</span><span class="cam-sub">${esc(o.sub || '')}</span></span>
      ${o.id === cur ? icon('check', 14) : ''}
    </button>`).join('') || '<div class="cam-empty">No AI set up yet.</div>'}
    <div class="cam-sep"></div>
    <button class="cam-item" data-act="setup"><span class="cam-text"><span class="cam-label">Set up another AI…</span></span></button>`;
  $('.chat-agent').appendChild(menu);
  const away = (e) => { if (!menu.contains(e.target) && !e.target.closest('#chat-agent-btn')) closeChatAgentMenu(); };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
  menu._cleanup = () => document.removeEventListener('mousedown', away, true);
}

function closeChatAgentMenu() {
  const m = $('#chat-agent-menu');
  if (!m) return false;
  m._cleanup?.();
  m.remove();
  return true;
}

function pickChatAgent(id) {
  closeChatAgentMenu();
  applySettingsPatch({ aiProvider: id });
  updateChatComposer();
  renderChatThread();
  $('#chat-input').focus();
}

// ---------------------------------------------------------------- wiring

function chatAutoGrow() {
  const i = $('#chat-input');
  i.style.height = 'auto';
  i.style.height = `${Math.min(i.scrollHeight, 240)}px`;
}

function chatSendFromInput() {
  const i = $('#chat-input');
  const text = i.value;
  if (!text.trim()) return;
  sendChat(text).then((sent) => { if (!sent && !i.value) i.value = text; chatAutoGrow(); updateChatComposer(); });
  i.value = '';
  chatAutoGrow();
}

function initChatView() {
  const el = document.createElement('section');
  el.id = 'chat-view';
  el.hidden = true;
  el.setAttribute('aria-label', 'Chat');
  el.innerHTML = `
    <aside class="chat-side">
      <div class="chat-side-head">
        <span class="chat-side-title">Chats</span>
        <div class="grow"></div>
        <button class="icon-btn small" data-act="new" title="New chat">${icon('pencil', 14)}</button>
      </div>
      <button class="chat-new" data-act="new">${icon('plus', 14)} New chat</button>
      <div id="chat-list"></div>
    </aside>
    <div class="chat-scrim" data-act="side"></div>
    <div class="chat-main">
      <header class="chat-head">
        <button class="icon-btn small" data-act="side" title="Show or hide chats">${icon('sidebar', 15)}</button>
        <span id="chat-title"></span>
        <div class="grow"></div>
        <button class="icon-btn small chat-head-new" data-act="new" title="New chat">${icon('pencil', 14)}</button>
        <button class="icon-btn small" data-act="close" title="Back to browsing (Esc)">${icon('x', 15)}</button>
      </header>
      <div id="chat-scroll"><div id="chat-thread"></div></div>
      <div class="chat-bottom">
        <div id="chat-composer">
          <textarea id="chat-input" rows="1" spellcheck="true"></textarea>
          <div class="chat-composer-row">
            <button class="chat-page" id="chat-page" aria-pressed="false">${icon('file', 13)}<span>Include page</span><span class="chat-page-host" id="chat-page-host"></span></button>
            <div class="grow"></div>
            <div class="chat-agent"><button class="chat-agent-btn" id="chat-agent-btn" title="Choose which AI answers"></button></div>
            <button class="chat-send" id="chat-send" title="Send (↵)">${icon('arrowUp', 16)}</button>
            <button class="chat-stop" id="chat-stop" title="Stop" hidden>${icon('stop', 14)}</button>
          </div>
        </div>
        <div class="chat-disclaimer">AI can make mistakes. Double-check anything important.</div>
      </div>
    </div>`;
  $('#content').appendChild(el);
  chatUi.el = el;

  const input = $('#chat-input', el);
  input.addEventListener('input', () => { chatAutoGrow(); updateChatComposer(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSendFromInput(); }
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('#modal-overlay').hidden) return;
    e.preventDefault();
    e.stopPropagation();
    if (closeChatAgentMenu()) return;
    if (el.classList.contains('side-open')) return el.classList.remove('side-open');
    closeChat();
  });
  $('#chat-send', el).onclick = chatSendFromInput;
  $('#chat-stop', el).onclick = () => { if (chatUi.current) api.aiStop(chatSid(chatUi.current)); };
  $('#chat-page', el).onclick = () => { chatUi.includePage = !chatUi.includePage; updateChatComposer(); input.focus(); };
  $('#chat-agent-btn', el).onclick = toggleChatAgentMenu;

  el.addEventListener('click', (e) => {
    const t = e.target;
    const del = t.closest('[data-del]');
    if (del) { e.stopPropagation(); return deleteChat(del.dataset.del); }
    const item = t.closest('[data-chat]');
    if (item) return showChat(item.dataset.chat);
    const pick = t.closest('[data-pick]');
    if (pick && !pick.disabled) return pickChatAgent(pick.dataset.pick);
    const sug = t.closest('[data-suggest]');
    if (sug) { const s = CHAT_SUGGESTIONS[Number(sug.dataset.suggest)]; return sendChat(s.q, { page: s.page ? true : chatUi.includePage }); }
    const copy = t.closest('[data-copy]');
    if (copy) {
      const m = chatUi.current?.messages[Number(copy.dataset.copy)];
      if (m) { api.copy(m.text); copy.classList.add('done'); copy.querySelector('span').textContent = 'Copied'; setTimeout(() => { copy.classList.remove('done'); copy.querySelector('span').textContent = 'Copy'; }, 1400); }
      return;
    }
    const link = t.closest('[data-ai-link]');
    if (link) { e.preventDefault(); openTab(link.dataset.aiLink, { background: true }); return toast('Opened in a background tab'); }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'new') return showChat(null);
    if (act === 'close') return closeChat();
    if (act === 'setup') { closeChatAgentMenu(); chatUi.showSetup = true; renderChatThread(); return updateChatComposer(); }
    if (act === 'setup-back') { chatUi.showSetup = false; renderChatThread(); return updateChatComposer(); }
    if (act === 'side') {
      // Wide: collapse the list. Narrow: the list slides over the conversation.
      if (el.clientWidth < 760) el.classList.toggle('side-open');
      else el.classList.toggle('side-hidden');
    }
  });

  api.onAiEvent(onChatAiEvent);
}

// The sidebar footer's Chat button: shown in Creative mode (Chat is always in the command bar and on ⌥⌘J).
function renderChatButton() {
  const btn = $('#btn-chat');
  if (!btn) return;
  btn.hidden = MINI || state.settings.mode !== 'creative';
  btn.classList.toggle('open', chatUi.open);
}
