/* Meridian — AI features in the UI:
 *  1. Agent RPC: the main-process hub asks the UI about tabs/spaces and to open/close/arrange tabs.
 *  2. Agent activity: tabs an agent is working in glow; a bar at the bottom of the sidebar shows what it did, with Stop.
 *  3. The ⌘J assistant panel (Claude, via the main process — the API key never reaches this page).
 * Loaded after app.js and shares its globals (state, rt, space(), locate(), …).
 */

// AGENT_ACCESS (the access levels) is defined in agent-access.js, shared with the Settings window.

// ---------------------------------------------------------------- 1. agent RPC

// Workbench tabs (terminals, local files) are invisible and untouchable for agents.
const agentVisible = (t) => !isWorkbenchTab(t);

function tabInfo(t, sp, zone, folder) {
  return {
    id: t.id, title: titleOf(t), url: tabUrl(t), zone: zone === 'fav' ? 'favorite' : zone,
    ...(folder ? { folder } : {}),
    loaded: rt.views.has(t.id), active: sp.id === state.activeSpaceId && sp.activeTabId === t.id,
    space_id: sp.id, space: sp.name,
  };
}

function allTabs(sp) {
  const out = (state.favorites[sp.profileId] || []).filter(agentVisible).map((t) => tabInfo(t, sp, 'fav'));
  const visit = (nodes, trail) => {
    for (const n of nodes) {
      if (n.type === 'tab') { if (agentVisible(n)) out.push(tabInfo(n, sp, 'pinned', trail.join(' / ') || undefined)); }
      else visit(n.children, [...trail, n.title]);
    }
  };
  visit(sp.pinned, []);
  for (const t of sp.today) if (agentVisible(t)) out.push(tabInfo(t, sp, 'today'));
  return out;
}

function mustLocate(tabId) {
  const l = tabId ? locateAnywhere(tabId) : (space().activeTabId ? locate(space().activeTabId) : null);
  if (!l) throw new Error(tabId ? `no tab with id ${tabId}` : 'no active tab — pass tab_id or open_tab first');
  if (!agentVisible(l.node)) throw new Error(tabId ? `no tab with id ${tabId}` : 'the active tab is not available to agents — pass tab_id');
  return l;
}

function waitWebContentsId(wv, timeout = 15000) {
  return new Promise((resolve, reject) => {
    try { const id = wv.getWebContentsId(); if (id) return resolve(id); } catch {}
    const t = setTimeout(() => reject(new Error('tab did not start loading')), timeout);
    wv.addEventListener('dom-ready', () => { clearTimeout(t); try { resolve(wv.getWebContentsId()); } catch (e) { reject(e); } }, { once: true });
  });
}

function openTabIn(sp, url, { background = true } = {}) {
  if (sp.id === state.activeSpaceId) return openTab(url, { background });
  const tab = { id: uid(), type: 'tab', url, title: hostOf(url), lastActive: now() };
  sp.today.unshift(tab);
  ensureView(tab, sp);
  render(); save();
  return tab;
}

function closeTabIn(sp, id) {
  if (sp.id === state.activeSpaceId) return closeTab(id);
  const l = locate(id, sp);
  if (!l) return;
  if (sp.split?.ids.includes(id)) sp.split = null;
  if (l.zone === 'today') { l.list.splice(l.list.indexOf(l.node), 1); archiveTab(l.node, sp); }
  else l.node.currentUrl = undefined;
  destroyView(id);
  if (sp.activeTabId === id) sp.activeTabId = null;
  render(); save();
}

function ensureSpaceActive(sp) { if (sp.id !== state.activeSpaceId) switchSpace(sp.id); }

const AGENT_OPS = {
  list_spaces: () => state.spaces.map((s) => ({
    id: s.id, name: s.name, icon: s.icon || undefined, active: s.id === state.activeSpaceId,
    profile: state.profiles.find((p) => p.id === s.profileId)?.name || s.profileId,
    pinned_tabs: allTabs(s).filter((t) => t.zone === 'pinned').length, today_tabs: s.today.length,
  })),

  list_tabs: ({ space_id }) => {
    const spaces = space_id ? state.spaces.filter((s) => s.id === space_id) : state.spaces;
    if (space_id && !spaces.length) throw new Error('unknown space_id');
    return spaces.flatMap(allTabs);
  },

  search_tabs: ({ query }) => {
    const q = query.toLowerCase();
    const hit = (t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q);
    const open = state.spaces.flatMap(allTabs).filter(hit).slice(0, 50);
    const archived = state.archive.filter((a) => (a.title || '').toLowerCase().includes(q) || a.url.toLowerCase().includes(q))
      .slice(0, 20).map((a) => ({ title: a.title, url: a.url, zone: 'archived', closed_at: new Date(a.closedAt).toISOString() }));
    return { open, archived };
  },

  search_history: ({ query, limit = 20 }) => {
    const q = query.toLowerCase();
    return Object.values(state.history)
      .filter((h) => (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count || b.last - a.last)
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map((h) => ({ title: h.title, url: h.url, visits: h.count, last_visit: new Date(h.last).toISOString() }));
  },

  // A background tab an agent is about to click/type in: rendered (still hidden behind the shown page,
  // never on top) while the action runs. Chromium drops input to a page until it has painted a frame,
  // and a tab that was never shown never paints.
  live: ({ tab_id, on }) => {
    const wv = rt.views.get(String(tab_id));
    if (!wv) return false;
    wv.classList.toggle('agent-live', !!on);
    return true;
  },

  describe: ({ tab_id }) => {
    const l = mustLocate(tab_id);
    return { tabId: l.node.id, title: titleOf(l.node), url: tabUrl(l.node) };
  },

  resolve: async ({ tab_id }) => {
    const l = mustLocate(tab_id);
    const wv = ensureView(l.node, l.space);
    render();
    const wcId = await waitWebContentsId(wv);
    return { tabId: l.node.id, wcId, title: titleOf(l.node), url: tabUrl(l.node) };
  },

  open_tab: async ({ url, space_id, activate: focusTab }) => {
    const sp = space_id ? state.spaces.find((s) => s.id === space_id) : space();
    if (!sp) throw new Error('unknown space_id');
    const target = resolveInput(url);
    if (!/^https?:/i.test(target)) throw new Error('only http(s) URLs can be opened by agents');
    const tab = openTabIn(sp, target, { background: !focusTab });
    tab.agent = true;
    if (focusTab) { ensureSpaceActive(sp); activate(tab.id, { focus: false }); }
    const wcId = await waitWebContentsId(rt.views.get(tab.id));
    return { tabId: tab.id, wcId, url: target };
  },

  navigate: ({ tab_id, url }) => {
    const l = mustLocate(tab_id);
    const target = resolveInput(url);
    if (!/^https?:/i.test(target)) throw new Error('only http(s) URLs can be opened by agents');
    const wv = ensureView(l.node, l.space);
    wv.loadURL(target).catch(() => {});
    return { tabId: l.node.id };
  },

  activate: ({ tab_id }) => {
    const l = mustLocate(tab_id);
    ensureSpaceActive(l.space);
    activate(l.node.id, { focus: false });
    return { tab_id: l.node.id, space: l.space.name };
  },

  close: ({ tab_id }) => {
    const l = mustLocate(tab_id);
    closeTabIn(l.space, l.node.id);
    return { closed: tab_id, archived: l.zone === 'today' };
  },

  organize: ({ tab_id, action, title, space_id }) => {
    const l = mustLocate(tab_id);
    ensureSpaceActive(l.space);
    if (action === 'pin') { if (l.zone !== 'today') return { ok: true, note: 'already pinned' }; moveNode(tab_id, 'pinned', { index: space().pinned.length }); }
    if (action === 'unpin') { if (l.zone === 'today') return { ok: true, note: 'not pinned' }; moveNode(tab_id, 'today', { index: 0 }); }
    if (action === 'favorite') addFavorite(tab_id);
    if (action === 'rename') { if (!title) throw new Error('title is required for rename'); l.node.customTitle = title.slice(0, 200); render(); save(); }
    if (action === 'move_to_space') { if (!state.spaces.some((s) => s.id === space_id)) throw new Error('unknown space_id'); moveToSpace(tab_id, space_id); }
    return { ok: true };
  },

  split: ({ left_tab_id, right_tab_id }) => {
    const a = mustLocate(left_tab_id), b = mustLocate(right_tab_id);
    if (a.space !== b.space) throw new Error('both tabs must be in the same space');
    ensureSpaceActive(a.space);
    a.space.split = { ids: [left_tab_id, right_tab_id], ratio: 0.5 };
    activate(right_tab_id, { focus: false });
    return { ok: true };
  },

  create_space: ({ name, icon }) => {
    const sp = newSpace(name.slice(0, 60), icon ? [...icon].slice(0, 2).join('') : null, SPACE_COLORS[state.spaces.length % SPACE_COLORS.length], space().profileId);
    state.spaces.push(sp);
    render(); save();
    return { space_id: sp.id };
  },
};

function initAgentRpc() {
  api.onAgentRpc(async ({ id, op, input }) => {
    try {
      const fn = AGENT_OPS[op];
      if (!fn) throw new Error(`unknown op ${op}`);
      api.replyAgent({ id, ok: true, result: await fn(input || {}) });
    } catch (err) {
      api.replyAgent({ id, ok: false, error: err.message });
    }
  });
  api.onAgentActivity(onAgentActivity);
}

// ---------------------------------------------------------------- 2. agent activity

const TOOL_VERBS = {
  read_page: 'read', get_interactive_elements: 'looked at', screenshot: 'took a screenshot of', open_tab: 'opened',
  navigate: 'navigated', history_nav: 'navigated', click: 'clicked on', type_text: 'typed on', press_key: 'pressed a key on',
  scroll: 'scrolled', wait_for: 'waited on', activate_tab: 'switched to a tab', organize_tab: 'rearranged a tab',
  run_javascript: 'ran JavaScript on',
};

function onAgentActivity(a) {
  rt.agentLog = [a, ...(rt.agentLog || [])].slice(0, 60);
  if (a.tabId) {
    rt.agentGlow = rt.agentGlow || new Map();
    rt.agentGlow.set(a.tabId, a.ts);
    setTimeout(() => { if (rt.agentGlow.get(a.tabId) === a.ts) { rt.agentGlow.delete(a.tabId); scheduleRender(); } }, 8000);
  }
  renderAgentBar();
  scheduleRender();
}

function renderAgentBar() {
  let bar = $('#agent-bar');
  const last = rt.agentLog?.[0];
  if (!last || state.settings.agentAccess === 'off') { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'agent-bar';
    $('#sidebar').insertBefore(bar, $('.sb-bottom'));
    bar.addEventListener('click', async (e) => {
      if (e.target.closest('[data-act="stop"]')) {
        rt.agentPaused = !rt.agentPaused;
        await api.agentPause(rt.agentPaused);
        toast(rt.agentPaused ? 'Agent paused — it can’t act until you resume' : 'Agent resumed');
        return renderAgentBar();
      }
      const items = (rt.agentLog || []).slice(0, 25).map((x, i) => ({ id: String(i), label: `${new Date(x.ts).toLocaleTimeString()}  ${x.source === 'assistant' ? 'Assistant' : 'Agent'} ${TOOL_VERBS[x.tool] || x.tool} ${x.host || ''}` }));
      const pick = await api.popupMenu(items);
      const entry = pick != null && rt.agentLog[Number(pick)];
      if (entry?.tabId && locateAnywhere(entry.tabId)) { const l = locateAnywhere(entry.tabId); ensureSpaceActive(l.space); activate(entry.tabId); }
    });
  }
  const fresh = Date.now() - last.ts < 8000;
  bar.className = fresh ? 'live' : '';
  bar.innerHTML = `
    <span class="agent-dot"></span>
    <span class="agent-text">${rt.agentPaused ? 'Agent paused' : `${last.source === 'assistant' ? 'Assistant' : 'Agent'} ${esc(TOOL_VERBS[last.tool] || last.tool)} ${esc(last.host || '')}`}</span>
    <button class="agent-stop" data-act="stop">${rt.agentPaused ? 'Resume' : 'Stop'}</button>`;
  clearTimeout(rt.agentBarTimer);
  if (fresh) rt.agentBarTimer = setTimeout(renderAgentBar, 8100);
}

// ---------------------------------------------------------------- 3. assistant panel

const ai = { sessionId: uid(), busy: false, el: null, current: null, includePage: true };

function toggleAiPanel(force) {
  const open = force ?? !document.body.classList.contains('ai-open');
  document.body.classList.toggle('ai-open', open);
  if (open) { refreshAiPanel(); setTimeout(() => $('#ai-input')?.focus(), 50); }
  else { const t = activeTab(); if (t) rt.views.get(t.id)?.focus(); }
}

async function refreshAiPanel() {
  const hasKey = await api.aiHasKey();
  $('#ai-nokey').hidden = hasKey;
  $('#ai-compose').hidden = !hasKey;
  const access = state.settings.agentAccess || 'off';
  const tools = $('#ai-tools');
  tools.disabled = access === 'off';
  tools.checked = access !== 'off' && state.settings.aiUseTools === true;
  $('#ai-tools-label').title = access === 'off' ? 'Turn on agent access in Settings → AI' : `Agent access: ${AGENT_ACCESS.find((x) => x[0] === access)[1]}`;
  const t = activeTab();
  $('#ai-page-chip').textContent = t ? hostOf(tabUrl(t)) : 'no page';
  $('#ai-page-chip').classList.toggle('off', !ai.includePage || !t);
}

async function pageForAi() {
  const t = activeTab();
  if (!t || !ai.includePage) return null;
  const wv = rt.views.get(t.id);
  if (!wv) return null;
  try {
    // Read by the main process in an isolated world — the page can't fake what we send to Claude.
    const r = await api.aiPageText(wv.getWebContentsId());
    return { url: tabUrl(t), title: titleOf(t), text: r ? r.text : '' };
  } catch { return { url: tabUrl(t), title: titleOf(t), text: '' }; }
}

function addMsg(role, html = '') {
  const el = document.createElement('div');
  el.className = `ai-msg ${role}`;
  el.innerHTML = html;
  $('#ai-messages').appendChild(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

// Preset chips (Summarize, …) never get browser tools: one click on a hostile page must not hand it the browser.
async function sendAi(text, { allowTools = true } = {}) {
  text = text.trim();
  if (!text || ai.busy) return;
  // Workbench Pro integration: warn before sending something that looks like an API key or token.
  if (window.MeridianSecrets?.find(text).length && !(await confirmSecretSend(text))) { $('#ai-input').value = text; $('#ai-input').focus(); return; }
  ai.busy = true;
  setAiBusy(true);
  addMsg('user', esc(text));
  ai.current = { el: addMsg('assistant', '<span class="ai-typing"></span>'), text: '' };
  const page = await pageForAi();
  const useTools = allowTools && !$('#ai-tools').disabled && $('#ai-tools').checked;
  api.aiChat({ sessionId: ai.sessionId, text, page, useTools });
}

// Workbench Pro integration: secrets typed into chat end up with the model and in the transcript.
function confirmSecretSend(text) {
  const hits = MeridianSecrets.find(text).map((x) => `${x.kind} (${MeridianSecrets.mask(x.value)})`).join(', ');
  return new Promise((resolve) => {
    showModal(`<h3>Send what looks like a secret?</h3>
      <p class="muted">Your message contains ${esc(hits)}. It would be sent to the model and kept in this chat. Keep keys in the Workbench vault instead — tools and agents get them as environment variables.</p>
      <div class="modal-actions"><button class="btn" data-a="cancel">Edit message</button><button class="btn danger" data-a="ok">Send anyway</button></div>`, (m, close) => {
      m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) { close(); resolve(a === 'ok'); } });
      $('#modal-overlay').addEventListener('dismiss', () => resolve(false), { once: true });
    });
  });
}

function setAiBusy(busy) {
  $('#ai-send').hidden = busy;
  $('#ai-stop').hidden = !busy;
}

function onAiEvent(ev) {
  if (ev.sessionId !== ai.sessionId) return;
  const cur = ai.current;
  if (ev.type === 'text' && cur) {
    cur.text += ev.delta;
    cur.el.innerHTML = renderMarkdown(cur.text);
    cur.el.scrollIntoView({ block: 'end' });
  } else if (ev.type === 'tool' && cur) {
    const chip = document.createElement('div');
    chip.className = 'ai-tool';
    chip.textContent = `${ev.name.replace(/_/g, ' ')}${ev.input?.url ? ' · ' + hostOf(ev.input.url) : ''}`;
    cur.el.after(chip);
    // Next text block of this turn goes into a fresh bubble below the tool chip.
    ai.current = { el: addMsg('assistant', ''), text: '' };
  } else if (ev.type === 'tool_error') {
    const chip = document.createElement('div');
    chip.className = 'ai-tool error';
    chip.textContent = `${ev.name.replace(/_/g, ' ')} failed: ${ev.message}`;
    (ai.current?.el || $('#ai-messages').lastChild).before(chip);
  } else if (ev.type === 'notice') {
    addMsg('notice', esc(ev.message));
  } else if (ev.type === 'error') {
    if (cur && !cur.text) cur.el.remove();
    addMsg('notice error', esc(ev.message));
    finishAi();
  } else if (ev.type === 'done') {
    if (cur && !cur.text) cur.el.remove();
    if (ev.stopped) addMsg('notice', 'Stopped.');
    finishAi();
  }
}

function finishAi() {
  ai.busy = false;
  ai.current = null;
  setAiBusy(false);
  $('#ai-input').focus();
}

function newAiChat() {
  api.aiReset(ai.sessionId);
  ai.sessionId = uid();
  ai.busy = false;
  setAiBusy(false);
  $('#ai-messages').innerHTML = '';
}

// Tiny, escape-first markdown: paragraphs, headings, lists, **bold**, *italic*, `code`, ```blocks```, [links](url).
function renderMarkdown(src) {
  const blocks = [];
  let s = esc(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_m, _l, code) => { blocks.push(code); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-ai-link="$2">$1</a>');
  const out = [];
  let list = null;
  for (const line of s.split('\n')) {
    const li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) out.push(`<h4>${inline(h[2])}</h4>`);
    else if (/^\u0000\d+\u0000$/.test(line.trim())) out.push(line.trim());
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i) => `<pre><code>${blocks[i]}</code></pre>`);
}

function initAiPanel() {
  const panel = document.createElement('aside');
  panel.id = 'ai-panel';
  panel.innerHTML = `
    <div class="ai-head">
      <span class="ai-title">${icon('bolt', 14)} Ask Claude</span>
      <div class="grow"></div>
      <button class="icon-btn small" id="ai-new" title="New chat">${icon('plus', 14)}</button>
      <button class="icon-btn small" id="ai-close" title="Close (⌘J)">${icon('x', 14)}</button>
    </div>
    <div id="ai-messages"></div>
    <div id="ai-nokey" hidden>
      <p>Add your Anthropic API key to chat with Claude about pages and let it work in your browser.</p>
      <button class="btn accent" id="ai-open-settings">Open AI settings</button>
    </div>
    <div id="ai-compose">
      <div class="ai-chips">
        <button class="ai-chip" data-q="Summarize this page.">Summarize</button>
        <button class="ai-chip" data-q="What are the key points? Short list.">Key points</button>
        <button class="ai-chip" data-q="Explain this page simply, like I'm new to the topic.">Explain</button>
      </div>
      <div class="ai-input-wrap">
        <textarea id="ai-input" rows="2" placeholder="Ask about this page or tell Claude what to do…"></textarea>
        <div class="ai-input-row">
          <button class="ai-ctx" id="ai-page-chip" title="Include the current page as context"></button>
          <label class="ai-ctx-tools" id="ai-tools-label"><input type="checkbox" id="ai-tools"> use browser</label>
          <div class="grow"></div>
          <button class="btn accent small" id="ai-send">Send ↵</button>
          <button class="btn small" id="ai-stop" hidden>Stop</button>
        </div>
      </div>
    </div>`;
  $('#app').appendChild(panel);

  $('#ai-close').onclick = () => toggleAiPanel(false);
  $('#ai-new').onclick = newAiChat;
  $('#ai-open-settings').onclick = () => openSettings('ai');
  $('#ai-send').onclick = () => { const i = $('#ai-input'); sendAi(i.value); i.value = ''; };
  $('#ai-stop').onclick = () => api.aiStop(ai.sessionId);
  $('#ai-page-chip').onclick = () => { ai.includePage = !ai.includePage; refreshAiPanel(); };
  $('#ai-tools').onchange = (e) => { state.settings.aiUseTools = e.target.checked; save(); };
  panel.querySelectorAll('.ai-chip').forEach((b) => b.onclick = () => sendAi(b.dataset.q, { allowTools: false }));
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAi(e.target.value); e.target.value = ''; }
    if (e.key === 'Escape') toggleAiPanel(false);
  });
  $('#ai-messages').addEventListener('click', (e) => {
    const a = e.target.closest('[data-ai-link]');
    if (a) { e.preventDefault(); openTab(a.dataset.aiLink, { background: true }); toast('Opened in a background tab'); }
  });
  api.onAiEvent(onAiEvent);
}

// Settings → AI lives in the Settings window: see settings-ai.js.

function initAi() {
  initAgentRpc();
  initAiPanel();
  api.agentConfig({ access: state.settings.agentAccess || 'off', allowJs: !!state.settings.agentAllowJs });
}
