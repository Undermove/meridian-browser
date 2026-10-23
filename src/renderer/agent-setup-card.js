/* Meridian — the "set up an AI" card.
 *
 * Lists the local AI agents Meridian can talk to (Claude Code, Codex, Gemini CLI, …: src/ai/local-agents.js)
 * with Install / Sign in buttons. Setting one up opens a terminal (main confirms the exact command first);
 * the card then re-checks every 3 seconds for up to 3 minutes and calls onReady once an agent is ready.
 *
 * Used by the Chat view; meant to be reused by onboarding and Settings, so it needs nothing from app.js:
 * windows with another preload pass `deps`. Needs icons.js.
 *
 *   const card = renderAgentSetupCard(el, { onReady(list) {}, deps: { list, setup, hasKey, openKeySettings } });
 *   card.destroy();
 */

const AGENT_POLL_MS = 3000;
const AGENT_POLL_MAX = 60; // ~3 minutes

// Usable for chatting: installed, and not known to be signed out (some CLIs can't tell us).
const setupCardReady = (a) => !!a && a.installed && a.loggedIn !== false;

function renderAgentSetupCard(el, { onReady, deps = {}, title = 'Choose an AI to chat with', intro } = {}) {
  const m = window.meridian || {};
  const d = {
    list: (fresh) => m.agentsList(fresh),
    setup: (id, action) => m.agentsSetup(id, action),
    hasKey: () => m.aiHasKey(),
    openKeySettings: () => m.openSettings('ai'),
    ...deps,
  };
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let list = null, waiting = null, polls = 0, timer = null, dead = false, message = '';

  const status = (a) => !a.installed ? ['Not installed', 'off'] : a.loggedIn === false ? ['Sign-in needed', 'warn'] : ['Ready', 'ok'];
  const action = (a) => {
    if (!a.installed) {
      if (!a.install?.cmd) return `<span class="asc-note">${a.install?.missing ? `Needs ${h(a.install.missing)}` : 'Not available here'}</span>`;
      return `<button class="btn small accent" data-setup="${h(a.id)}" data-action="install">Install</button>`;
    }
    if (a.loggedIn === false) return `<button class="btn small accent" data-setup="${h(a.id)}" data-action="login">Sign in</button>`;
    return `<span class="asc-ok">${icon('check', 14)}</span>`;
  };

  function draw() {
    if (dead) return;
    const rows = list === null
      ? '<div class="asc-loading"><span class="ai-typing"></span> Looking for AI apps on this computer…</div>'
      : list.map((a) => {
        const [label, cls] = status(a);
        return `<div class="asc-row" data-agent="${h(a.id)}">
          <span class="asc-avatar">${h((a.label || '?')[0])}</span>
          <div class="asc-text">
            <div class="asc-name">${h(a.label)} <span class="asc-status ${cls}">${waiting === a.id ? 'Waiting…' : label}</span></div>
            <div class="asc-plan">${h(a.vendor)}${a.plan ? ` · uses ${h(a.plan)}` : ''}</div>
          </div>
          <div class="asc-action">${action(a)}</div>
        </div>`;
      }).join('');
    el.innerHTML = `
      <div class="agent-setup-card">
        <div class="asc-head">
          <div class="asc-ic">${icon('sparkles', 20)}</div>
          <div>
            <div class="asc-title">${h(title)}</div>
            <div class="asc-intro">${h(intro || 'Meridian talks to an AI app on this computer, using your own subscription. Pick one and set it up — it takes about a minute.')}</div>
          </div>
        </div>
        <div class="asc-list">${rows}</div>
        ${message ? `<div class="asc-message">${h(message)}</div>` : ''}
        <div class="asc-foot">
          <span>Have a Claude API key?</span> <button class="asc-link" data-act="key">Add it in Settings</button>
          <div class="grow"></div>
          <button class="btn small" data-act="recheck">Check again</button>
        </div>
      </div>`;
  }

  async function refresh(fresh = true) {
    const [next, key] = await Promise.all([d.list(fresh).catch(() => []), d.hasKey().catch(() => false)]);
    if (dead) return;
    const before = waiting && list ? JSON.stringify(list.find((a) => a.id === waiting)) : null;
    list = next || [];
    if (waiting && JSON.stringify(list.find((a) => a.id === waiting)) !== before) { waiting = null; message = ''; stopPolling(); }
    draw();
    if (key || list.some(setupCardReady)) { stopPolling(); onReady?.(list, { hasKey: !!key }); }
  }

  function stopPolling() { clearInterval(timer); timer = null; }
  function poll(id) {
    stopPolling();
    waiting = id; polls = 0;
    timer = setInterval(() => {
      if (++polls > AGENT_POLL_MAX) { stopPolling(); waiting = null; message = 'Still not ready? Finish the steps in the terminal window, then click Check again.'; draw(); return; }
      refresh(true);
    }, AGENT_POLL_MS);
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-setup], [data-act]');
    if (!b || dead) return;
    if (b.dataset.act === 'recheck') { message = ''; return refresh(true); }
    if (b.dataset.act === 'key') return d.openKeySettings();
    b.disabled = true;
    const r = await d.setup(b.dataset.setup, b.dataset.action).catch((err) => ({ ok: false, error: err.message }));
    b.disabled = false;
    if (r?.cancelled) return;
    if (!r?.ok) { message = r?.error || 'Couldn’t start the setup.'; return draw(); }
    message = b.dataset.action === 'install' ? 'Follow the steps in the terminal window. This card updates by itself.' : 'Finish signing in (your browser may open). This card updates by itself.';
    poll(b.dataset.setup);
    draw();
  });

  draw();
  refresh(false);
  return { refresh, destroy() { dead = true; stopPolling(); } };
}
