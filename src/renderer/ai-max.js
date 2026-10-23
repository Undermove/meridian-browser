/* Meridian — Arc Max-style AI features in the main UI (the model calls run in main: src/ai/features.js).
 *
 *  - Tidy Today: Claude proposes folders and shorter titles for the Today tabs; shown as a diff the
 *    user accepts (in parts) or rejects. Nothing changes until Apply.
 *  - Ask from the command bar: type a question and the answer streams inside the command bar.
 *  - Link preview: hold Shift over a link (Settings → AI) → a card with a short summary of the page.
 * Toggles live in Settings → AI. Loaded after app.js / ai.js / panels.js and uses their globals.
 */

// ---------------------------------------------------------------- Ask (command bar)
// Type a question in ⌘T and the answer streams right under it, from whichever AI is connected
// (the Claude API key, GitHub Copilot, a local model, or an opt-in agent). It knows Meridian itself too
// ("how do I split the screen?"). "Continue in chat" carries the conversation over.

const QUESTION_RE = /^(how|what|why|when|where|who|whom|which|whose|can|could|should|would|will|is|are|am|do|does|did|was|were|has|have|explain|tell me|help|compare|summari[sz]e|write|translate|suggest|recommend|как|что|чем|почему|зачем|когда|где|куда|откуда|кто|какой|какая|какое|какие|каким|сколько|можно|можешь|нужно|стоит|есть ли|объясни|расскажи|подскажи|помоги|сравни|напиши|переведи|посоветуй|придумай)\b/i;

function looksLikeQuestion(q) {
  const words = q.split(/\s+/).filter(Boolean).length;
  return /[?？]\s*$/.test(q) || (words >= 2 && QUESTION_RE.test(q)) || words >= 7;
}

function askClaudeResult(raw, isUrl) {
  if (state.settings.aiAskFromBar === false || isUrl || PRIVATE) return null;
  const q = String(raw || '').trim();
  if (q.length < 3) return null;
  const p = ai.provider;
  const label = p?.ready ? `Ask ${p.label}` : 'Ask AI';
  return { kind: 'ask', icon: 'sparkles', title: q, sub: p?.ready ? 'Answer right here' : 'Connect an AI to get answers here', badge: label, first: looksLikeQuestion(q), keepOpen: true, action: () => startInlineAsk(q) };
}

const ask = { sessionId: null, q: '', text: '', provider: null, done: false };

async function startInlineAsk(q) {
  const p = await resolveAiProvider();
  ai.provider = p;
  const box = $('#cmd-answer');
  $('#cmd-results').hidden = true;
  box.hidden = false;
  if (!p.ready) {
    box.innerHTML = `
      <div class="ca-head">${icon('sparkles', 15)}<span>Get answers right here</span></div>
      <div class="ca-body"><p></p></div>
      <div class="ca-foot"><button class="btn accent small" data-ca="connect">Connect an AI…</button><button class="btn small" data-ca="search">Search the web instead</button></div>`;
    $('.ca-body p', box).textContent = p.reason;
    bindAnswerFoot(box, q);
    return;
  }
  if (ask.sessionId && !ask.done) api.aiStop(ask.sessionId);
  Object.assign(ask, { sessionId: 'ask-' + uid(), q, text: '', provider: p, done: false });
  box.innerHTML = `
    <div class="ca-head">${icon('sparkles', 15)}<span></span><div class="grow"></div><span class="ca-status">Thinking…</span></div>
    <div class="ca-body"><span class="ai-typing"></span></div>
    <div class="ca-foot"><button class="btn small" data-ca="chat">${icon('bolt', 13)} Continue in chat</button><button class="btn small" data-ca="copy" disabled>Copy</button><button class="btn small" data-ca="search">Search the web</button><div class="grow"></div><span class="ca-hint">Esc to close</span></div>`;
  $('.ca-head span', box).textContent = p.label;
  bindAnswerFoot(box, q);
  api.aiChat({ sessionId: ask.sessionId, text: q, page: null, provider: p.id, mode: 'ask', useTools: false });
}

function bindAnswerFoot(box, q) {
  box.onclick = async (e) => {
    const a = e.target.closest('[data-ca]')?.dataset.ca;
    if (!a) return;
    if (a === 'connect') { closeCommandBar(); return openSettings('ai'); }
    if (a === 'search') { closeCommandBar(); return openTab(searchUrl(q)); }
    if (a === 'copy') { await navigator.clipboard.writeText(ask.text).catch(() => {}); return toast('Answer copied'); }
    if (a === 'chat') return continueAskInChat();
    const link = e.target.closest('[data-ai-link]');
    if (link) { e.preventDefault(); closeCommandBar(); openTab(link.dataset.aiLink); }
  };
}

// The ⌘J panel picks up the same session, so the agent keeps the context.
function continueAskInChat() {
  const { sessionId, q, text } = ask;
  if (!sessionId) return;
  ask.handedOff = true;
  closeCommandBar();
  if (ai.busy) api.aiStop(ai.sessionId);
  ai.sessionId = sessionId;
  ai.busy = !ask.done;
  $('#ai-messages').innerHTML = '';
  addMsg('user', esc(q));
  const el = addMsg('assistant', text ? renderMarkdown(text) : '<span class="ai-typing"></span>');
  ai.current = ask.done ? null : { el, text };
  setAiBusy(!ask.done);
  toggleAiPanel(true);
}

function onAskEvent(ev) {
  if (ev.sessionId !== ask.sessionId || ask.handedOff) return;
  const box = $('#cmd-answer');
  const body = $('.ca-body', box);
  if (!body) return;
  if (ev.type === 'text') {
    ask.text += ev.delta;
    body.innerHTML = renderMarkdown(ask.text);
    $('.ca-status', box).textContent = '';
    $('[data-ca="copy"]', box).disabled = false;
  } else if (ev.type === 'error') {
    ask.done = true;
    body.innerHTML = '<p class="ca-error"></p>';
    $('.ca-error', body).textContent = ev.message;
    $('.ca-status', box).textContent = '';
  } else if (ev.type === 'done') {
    ask.done = true;
    $('.ca-status', box).textContent = ev.stopped ? 'Stopped' : '';
    if (!ask.text && !ev.stopped) body.innerHTML = '<p class="muted">No answer.</p>';
  }
}

// Leaving answer mode (typing again, Esc, closing): stop a running answer unless it moved to chat.
function endInlineAsk() {
  const box = $('#cmd-answer');
  if (!box || box.hidden) return;
  if (ask.sessionId && !ask.done && !ask.handedOff) api.aiStop(ask.sessionId);
  if (!ask.handedOff && ask.sessionId) api.aiReset(ask.sessionId);
  ask.sessionId = null; ask.handedOff = false;
  box.hidden = true;
  box.innerHTML = '';
  $('#cmd-results').hidden = false;
}

api.onAiEvent(onAskEvent);

// ---------------------------------------------------------------- Tidy Today

let tidyRun = 0;

async function tidyToday() {
  if (state.settings.aiTidy === false) return toast('Tidy Today is off. Turn it on in Settings → AI.', { action: 'Settings', onClick: () => openSettings('ai'), timeout: 5000 });
  if (!(await api.aiHasKey().catch(() => false))) return toast('Add your Claude API key in Settings → AI to tidy tabs.', { action: 'Settings', onClick: () => openSettings('ai'), timeout: 5000 });
  const sp = space();
  const tabs = sp.today.filter((t) => !isWorkbenchTab(t)).map((t) => ({ id: t.id, title: titleOf(t), url: tabUrl(t) }));
  if (tabs.length < 2) return toast('Tidy needs at least two Today tabs');
  closePanels();
  const run = ++tidyRun;
  const overlay = document.createElement('div');
  overlay.id = 'tidy-overlay';
  overlay.className = 'panel-overlay';
  overlay.innerHTML = `
    <div class="tidy-card" role="dialog" aria-label="Tidy Today">
      <div class="tidy-head"><span class="tidy-title">${icon('wand', 17)} Tidy Today</span><div class="grow"></div><button class="icon-btn small" data-a="close" title="Close (Esc)">${icon('x', 14)}</button></div>
      <div class="tidy-body"><div class="tidy-loading"><span class="tidy-spark">${icon('sparkles', 20)}</span><div>Claude is sorting ${tabs.length} tabs…</div></div></div>
      <div class="tidy-foot"><span class="muted small">Nothing changes until you apply it.</span><div class="grow"></div><button class="btn" data-a="close">Cancel</button><button class="btn accent" data-a="apply" disabled>Apply</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { tidyRun++; overlay.remove(); };
  overlay._cleanup = () => { tidyRun++; };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
  overlay.tabIndex = -1;
  overlay.focus();
  let plan;
  try { plan = await api.aiTidy(tabs); } catch (err) { plan = { error: err.message }; }
  if (run !== tidyRun || !overlay.isConnected) return;
  const body = $('.tidy-body', overlay);
  if (!plan || plan.error) { body.innerHTML = `<div class="panel-empty small">${icon('info', 24)}<div class="pe-title">Couldn’t tidy</div><div class="pe-sub"></div></div>`; $('.pe-sub', body).textContent = plan?.error || 'Something went wrong.'; overlay.addEventListener('click', (e) => { if (e.target.closest('[data-a="close"]')) close(); }); return; }
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const renames = new Map(plan.renames.map((r) => [r.tabId, r.title]));
  if (!plan.folders.length && !plan.renames.length) { body.innerHTML = `<div class="panel-empty small">${icon('check', 24)}<div class="pe-title">Already tidy</div><div class="pe-sub">Claude found nothing worth grouping or renaming.</div></div>`; overlay.addEventListener('click', (e) => { if (e.target.closest('[data-a="close"]')) close(); }); return; }
  body.innerHTML = `<div class="tidy-note">New folders go to <b>Pinned</b> in this space; tabs you don’t group stay in Today. Untick anything you don’t want.</div>`;
  const row = (t, { grouped }) => {
    const r = document.createElement('label');
    r.className = 'tidy-row';
    const nt = renames.get(t.id);
    if (nt) {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.rename = t.id; cb.title = 'Use the shorter title';
      const o = document.createElement('span'); o.className = 'tidy-old'; o.textContent = t.title;
      const a = document.createElement('span'); a.className = 'tidy-arrow'; a.textContent = '→';
      const n = document.createElement('span'); n.className = 'tidy-new'; n.textContent = nt;
      r.append(cb, o, a, n);
      cb.addEventListener('change', () => r.classList.toggle('off', !cb.checked));
    } else {
      const s = document.createElement('span'); s.className = 'tidy-same'; s.textContent = t.title;
      if (grouped) { const pad = document.createElement('span'); pad.style.width = '13px'; pad.style.flex = 'none'; r.append(pad); }
      r.append(s);
    }
    const h = document.createElement('span'); h.className = 'tidy-host'; h.textContent = hostOf(t.url);
    r.append(h);
    return r;
  };
  plan.folders.forEach((f, i) => {
    const g = document.createElement('div');
    g.className = 'tidy-group';
    const head = document.createElement('label');
    head.className = 'tidy-group-head';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.folder = String(i);
    const name = document.createElement('span'); name.textContent = f.name;
    const tag = document.createElement('span'); tag.className = 'tidy-tag'; tag.textContent = `New folder · ${f.tabIds.length} tabs`;
    head.append(cb);
    head.insertAdjacentHTML('beforeend', icon('folder', 15));
    head.append(name, tag);
    cb.addEventListener('change', () => g.classList.toggle('off', !cb.checked));
    g.append(head);
    for (const id of f.tabIds) if (byId.has(id)) g.append(row(byId.get(id), { grouped: true }));
    body.append(g);
  });
  const grouped = new Set(plan.folders.flatMap((f) => f.tabIds));
  const loose = plan.renames.filter((r) => !grouped.has(r.tabId) && byId.has(r.tabId));
  if (loose.length) {
    const g = document.createElement('div');
    g.className = 'tidy-group';
    g.innerHTML = `<div class="tidy-group-head">${icon('pencil', 14)}<span>Shorter titles</span></div>`;
    for (const r of loose) g.append(row(byId.get(r.tabId), { grouped: false }));
    body.append(g);
  }
  const apply = $('[data-a="apply"]', overlay);
  apply.disabled = false;
  apply.focus();
  overlay.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close') close();
    if (a === 'apply') {
      const folders = plan.folders.filter((_f, i) => $(`[data-folder="${i}"]`, overlay)?.checked);
      const titles = plan.renames.filter((r) => $(`[data-rename="${CSS.escape(r.tabId)}"]`, overlay)?.checked);
      close();
      applyTidy(sp.id, folders, titles);
    }
  });
}

function applyTidy(spaceId, folders, renames) {
  const sp = state.spaces.find((s) => s.id === spaceId);
  if (!sp) return;
  if (sp.id !== state.activeSpaceId) switchSpace(sp.id);
  let titles = 0, moved = 0;
  for (const r of renames) {
    const t = sp.today.find((x) => x.id === r.tabId) || null;
    if (t) { t.customTitle = r.title; titles++; }
  }
  folders.forEach((f, fi) => {
    const ids = f.tabIds.filter((id) => sp.today.some((t) => t.id === id));
    if (ids.length < 2) return;
    const folder = { id: uid(), type: 'folder', title: f.name, collapsed: false, children: [] };
    sp.pinned.splice(Math.min(fi, sp.pinned.length), 0, folder);
    ids.forEach((id, i) => { moveNode(id, 'pinned', { parentId: folder.id, index: i }); moved++; });
  });
  render(); save();
  const parts = [folders.length && `${folders.length} folder${folders.length === 1 ? '' : 's'}`, titles && `${titles} shorter title${titles === 1 ? '' : 's'}`].filter(Boolean);
  toast(parts.length ? `Tidied: ${parts.join(', ')}` : 'Nothing applied');
}

// ---------------------------------------------------------------- link preview card

const lp = { url: null, hideTimer: null, over: false };

function onLinkPreview(p) {
  if (!p || typeof p.url !== 'string') return;
  if (p.phase === 'leave') { if (p.url === lp.url) scheduleHideLinkPreview(); return; }
  if (p.phase === 'start') return showLinkPreview(p);
  if (p.url !== lp.url) return;
  const card = $('#link-preview');
  if (!card) return;
  const sum = $('.lp-summary', card);
  if (p.phase === 'result') {
    if (p.title) $('.lp-title', card).textContent = p.title;
    sum.className = 'lp-summary';
    sum.textContent = p.summary || 'No summary.';
  } else if (p.phase === 'error') {
    sum.className = 'lp-summary error';
    sum.textContent = p.message || 'Couldn’t summarize this page.';
  }
}

function showLinkPreview(p) {
  clearTimeout(lp.hideTimer);
  let card = $('#link-preview');
  if (!card) {
    card = document.createElement('div');
    card.id = 'link-preview';
    card.setAttribute('role', 'dialog');
    card.addEventListener('mouseenter', () => { lp.over = true; clearTimeout(lp.hideTimer); });
    card.addEventListener('mouseleave', () => { lp.over = false; scheduleHideLinkPreview(); });
    card.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      const url = lp.url;
      hideLinkPreview();
      if (a === 'peek') openPeek(url);
      if (a === 'tab') { openTab(url, { background: true }); toast('Opened in a background tab'); }
    });
    document.body.appendChild(card);
  }
  lp.url = p.url;
  card.classList.remove('leaving');
  card.innerHTML = `
    <div class="lp-head">${icon('sparkles', 13)}<span class="lp-host"></span></div>
    <div class="lp-title"></div>
    <div class="lp-summary muted"><div class="lp-shimmer"></div><div class="lp-shimmer"></div><div class="lp-shimmer short"></div></div>
    <div class="lp-actions"><button class="btn small accent" data-a="peek">Open in Peek</button><button class="btn small" data-a="tab">New tab</button></div>
    <div class="lp-foot">Summary by Claude · hold ⇧ over a link</div>`;
  $('.lp-host', card).textContent = hostOf(p.url);
  // Bottom-left of the page the link is in (we don't know the pointer position inside the guest).
  const tabId = rt.wcToTab.get(p.fromId);
  const wv = (tabId && rt.views.get(tabId)) || webview();
  const r = wv ? wv.getBoundingClientRect() : $('#content').getBoundingClientRect();
  card.style.left = `${Math.round(r.left + 14)}px`;
  card.style.top = '';
  card.style.bottom = `${Math.round(window.innerHeight - r.bottom + 14)}px`;
}

function scheduleHideLinkPreview() {
  clearTimeout(lp.hideTimer);
  lp.hideTimer = setTimeout(() => { if (!lp.over) hideLinkPreview(); }, 900);
}

function hideLinkPreview() {
  clearTimeout(lp.hideTimer);
  const card = $('#link-preview');
  lp.url = null;
  lp.over = false;
  if (!card) return;
  card.classList.add('leaving');
  setTimeout(() => { if (card.classList.contains('leaving')) card.remove(); }, 160);
}

function initAiMax() {
  if (typeof EPHEMERAL !== 'undefined' && EPHEMERAL) return;
  api.onLinkPreview(onLinkPreview);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#link-preview')) hideLinkPreview(); });
  api.onWebviewEscape(() => { if ($('#link-preview')) hideLinkPreview(); });
}

window.addEventListener('DOMContentLoaded', () => setTimeout(initAiMax, 0));
