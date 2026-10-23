/* Meridian — Settings → AI (Settings window).
 *
 * Everything AI-related in Settings lives here: the Claude API key, agent access for the ⌘J assistant
 * and MCP clients, which AI answers Ask / ⌘J / Chat, and connecting coding agents (Claude Code, Codex) to
 * Meridian's MCP server (the user runs those agents themselves).
 * Add new AI settings as more groups in render(); they go through the same channel as the rest of
 * Settings (ctx.set for settings in state.json, S.* calls for things main owns, like the key).
 * Loaded after settings.js and uses its helpers (registerSection, group, row, toggle, button, …).
 */

registerSection({
  id: 'ai', label: 'AI', icon: 'sparkles', order: 50,
  async render(el) {
    const s = ctx.settings;
    // Finding the CLIs goes through the login shell and can take seconds: draw the page first, fill them in after.
    const [hasKey, status] = await Promise.all([withTimeout(S.aiHasKey(), false), withTimeout(S.agentStatus(), {})]);
    let clis = {};
    const access = s.agentAccess || 'off';
    const cliRow = (id) => {
      const c = clis[id];
      if (!c) return '';
      return `
        <div class="row cli">
          <div class="cli-ic">${icon('terminal', 16)}</div>
          <div class="row-text">
            <div class="row-label">${esc(c.name)} ${c.path ? '<span class="tag ok-tag">Installed</span>' : '<span class="tag">Not found</span>'}</div>
            <code class="cmd" data-copy="${esc(c.command)}" title="Click to copy">${esc(c.command)}</code>
          </div>
          <div class="row-control">${c.path ? `<button class="btn small primary" data-connect="${id}">Connect…</button>` : `<button class="btn small" data-copy="${esc(c.command)}">Copy</button>`}</div>
        </div>`;
    };
    el.innerHTML = `
      <div class="hero">
        <div class="hero-ic">${icon('sparkles', 22)}</div>
        <div><h1>AI in Meridian</h1><p>Ask Claude about pages with ⌘J, and let coding agents like Claude Code read and drive your browser, within the access you choose.</p></div>
      </div>
      ${group('Your AI', `<div id="agent-rows"><div class="row"><div class="row-text"><div class="row-desc">Looking for AI agents on this computer…</div></div></div></div>`,
        'Ask in the command bar (⌘T), the ⌘J panel and Chat use this AI. Agents answer as text only; they can’t run commands or change files from here. Claude Code and Gemini CLI run in the Workbench terminal (their terms don’t allow apps to power features with a subscription login).')}
      ${group('Claude API key', hasKey
        ? row('API key', `<span class="ok">${icon('check', 14)} Saved</span> ${button('ai-key-remove', 'Remove', 'small')}`, 'Stored encrypted in the system keychain. Pages and the UI never see it.')
        : `<div class="row"><input class="text" id="ai-key" type="password" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">${button('ai-key-save', 'Save', 'primary')}</div>`,
      'Used by the ⌘J assistant. Get a key at console.anthropic.com.')}
      ${group('Agent access', `
        ${AGENT_ACCESS.map(([v, l, d]) => `
          <label class="row radio ${access === v ? 'on' : ''}">
            <input type="radio" name="agent-access" value="${v}" ${access === v ? 'checked' : ''}>
            <div class="row-text"><div class="row-label">${esc(l)}</div><div class="row-desc">${esc(d)}</div></div>
          </label>`).join('')}
        ${row('Allow agents to run JavaScript in pages', toggle('agent-js', !!s.agentAllowJs), 'Powerful: off unless you need it. In “Ask” mode you see and approve the code.')}
      `, `Applies to the ⌘J assistant and every MCP client. ${status.socket ? 'The MCP socket is open.' : 'The MCP socket is closed while access is off.'}`)}
      ${group('Claude features', `
        ${row('Tidy Today', toggle('ai-tidy', s.aiTidy !== false), 'Claude suggests folders and shorter titles for your Today tabs (command bar → “Tidy Today”). You see a preview and choose what to apply.')}
        ${row('Ask Claude from the command bar', toggle('ai-ask-bar', s.aiAskFromBar !== false), 'Type a question in the command bar and pick “Ask Claude” to open it in ⌘J.')}
        ${row('Link previews', toggle('ai-link-preview', s.aiLinkPreview === true), 'Hold ⇧ over a link to see a short summary of the page. Meridian loads the public page in the background without your cookies or logins and sends its text to Claude. Links to this computer or your local network are skipped. Summaries are cached for 30 minutes. Never in private windows.')}
      `, hasKey ? 'These use your Claude API key. Page text and tab titles are sent as untrusted content.' : 'Add a Claude API key above to use these.')}
      ${group('Mission Control', `
        ${row('Notify me when an agent is waiting', toggle('mission-notify', s.missionNotify !== false), 'A notification (or a toast while Meridian is in front) when Claude Code needs your permission or input. Mission Control (⇧⌘M) always shows it.')}
      `, 'Mission Control shows Claude Code and Codex sessions started from the Workbench, MCP clients and ⌘J chats, live. It keeps a short history without tool inputs.')}
      ${group('Coding agents', `<div id="cli-rows"><div class="row"><div class="row-text"><div class="row-desc">Looking for Claude Code and Codex…</div></div></div></div>`,
        'Connect registers Meridian’s MCP server with that CLI. You’ll see the exact command and confirm before it runs. Agents only work while Meridian is running and agent access isn’t Off.')}`;

    drawAgents(el, hasKey);

    S.mcpDetect().catch(() => ({})).then((found) => {
      clis = found || {};
      const box = $('#cli-rows', el);
      if (box) box.innerHTML = cliRow('claude') + cliRow('codex') || '<div class="row"><div class="row-text"><div class="row-desc">Couldn’t look for coding agents.</div></div></div>';
    });

    $('#ai-key-save', el)?.addEventListener('click', async () => {
      const v = $('#ai-key', el).value.trim();
      if (!/^sk-ant-/.test(v)) return toast('That doesn’t look like an Anthropic API key (sk-ant-…)');
      try { await S.aiSetKey(v); toast('API key saved'); showSection('ai'); } catch (err) { toast('Could not save the key: ' + err.message); }
    });
    $('#ai-key-remove', el)?.addEventListener('click', async () => {
      if (!(await confirmBox('Remove your Claude API key?', 'The ⌘J assistant stops working until you add one again.', 'Remove', true))) return;
      await S.aiSetKey(''); toast('API key removed'); showSection('ai');
    });
    $$('input[name="agent-access"]', el).forEach((r) => r.addEventListener('change', async () => {
      if (r.value === 'full' && !(await confirmBox('Give AI agents full control?', 'They can click, type and navigate in your logged-in browser without asking.', 'Allow Full Control', true))) return showSection('ai');
      ctx.set({ agentAccess: r.value });
      $$('.row.radio', el).forEach((x) => x.classList.toggle('on', x.contains(r)));
      toast(`Agent access: ${AGENT_ACCESS.find((x) => x[0] === r.value)[1]}`);
    }));
    $('#agent-js', el).onchange = (e) => ctx.set({ agentAllowJs: e.target.checked });
    $('#ai-tidy', el).onchange = (e) => ctx.set({ aiTidy: e.target.checked });
    $('#ai-ask-bar', el).onchange = (e) => ctx.set({ aiAskFromBar: e.target.checked });
    $('#ai-link-preview', el).onchange = (e) => { ctx.set({ aiLinkPreview: e.target.checked }); if (e.target.checked && !hasKey) toast('Link previews start working once you add a Claude API key'); };
    $('#mission-notify', el).onchange = (e) => ctx.set({ missionNotify: e.target.checked });
    el.addEventListener('click', async (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { await S.copy(copy.dataset.copy); return toast('Command copied — paste it into your terminal'); }
      const c = e.target.closest('[data-connect]');
      if (!c) return;
      c.disabled = true;
      const r = await S.mcpConnect(c.dataset.connect).catch((err) => ({ ok: false, error: err.message }));
      c.disabled = false;
      if (r.cancelled) return;
      if (r.ok) toast(r.already ? 'Already connected' : `Connected. Restart ${clis[c.dataset.connect].name} to pick it up.`, { timeout: 4500 });
      else toast(`Couldn’t connect: ${r.error}`, { timeout: 6000 });
    });
  },
});

// ---------------------------------------------------------------- Your AI (local agents)

const AGENT_MARK = { claude: '#d97757', codex: '#10a37f', gemini: '#4285f4', copilot: '#8957e5', cursor: '#111111', opencode: '#4b5563', qwen: '#615ced', amp: '#f34e3f', goose: '#222222', droid: '#ff6b00', ollama: '#333333', lmstudio: '#4f46e5' };
let agentPoll = null;

async function drawAgents(root, hasKey, fresh = false) {
  const box = $('#agent-rows', root);
  if (!box) return;
  const all = await withTimeout(S.agentsList(fresh), [], 15000);
  if (!box.isConnected) return;
  const optIn = ctx.settings.aiOptInAgents === true;
  const list = all.filter((a) => a.policy === 'default');
  const others = all.filter((a) => a.policy === 'optin');
  const chosen = ctx.settings.aiProvider || '';
  const status = (a) => !a.installed ? '<span class="tag">Not installed</span>'
    : a.loggedIn === false ? '<span class="tag warn-tag">Not signed in</span>'
    : `<span class="tag ok-tag">${a.loggedIn ? 'Ready' : 'Installed'}</span>`;
  const action = (a) => !a.installed
    ? (a.install?.cmd ? `<button class="btn small" data-setup="install" data-id="${a.id}">Install…</button>` : `<a class="btn small" href="${esc(a.docs)}" data-ext="${esc(a.docs)}">How to install</a>`)
    : a.loggedIn === false ? `<button class="btn small primary" data-setup="login" data-id="${a.id}">Sign in…</button>` : '';
  const radio = (id, label, desc, extra = '', disabled = false) => `
    <label class="row radio agent ${chosen === id ? 'on' : ''} ${disabled ? 'dim' : ''}">
      <input type="radio" name="ai-provider" value="${esc(id)}" ${chosen === id ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      ${extra}
      <div class="row-text"><div class="row-label">${label}</div><div class="row-desc">${desc}</div></div>`;
  box.innerHTML = [
    radio('', 'Automatic', 'Your Claude API key if you added one, otherwise the first ready option below.') + '</label>',
    ...list.map((a) => radio(a.id, `${esc(a.label)} ${status(a)}`, `${esc(a.vendor)} · works with ${esc(a.plan)}${a.account ? ` · ${esc(a.account)}` : ''}${!a.installed && a.install?.missing ? ` · needs ${esc(a.install.missing)}` : ''}`,
      `<span class="agent-mark" style="--c:${AGENT_MARK[a.id] || '#888'}">${esc(a.label[0])}</span>`, !a.installed) + `<div class="row-control">${action(a)}</div></label>`),
    radio('api', `Claude API key ${hasKey ? '<span class="tag ok-tag">Ready</span>' : '<span class="tag">No key</span>'}`, 'Pay-as-you-go with your Anthropic API key (below): a question in ⌘T costs a fraction of a cent. The only option that can also act in the browser.',
      `<span class="agent-mark" style="--c:#d97757">${icon('sparkles', 13)}</span>`, !hasKey) + '</label>',
    `<div class="row optin-head"><div class="row-text"><div class="row-label">Other agents</div><div class="row-desc">Codex, Cursor, OpenCode, Qwen Code, Amp, Goose, Droid. They run with your own account in that app, under that provider’s terms — check that they allow use from other apps.</div></div><div class="row-control">${toggle('ai-optin', optIn)}</div></div>`,
    ...(optIn ? others.map((a) => radio(a.id, `${esc(a.label)} ${status(a)}`, `${esc(a.vendor)} · ${esc(a.plan)}${a.account ? ` · ${esc(a.account)}` : ''}`,
      `<span class="agent-mark" style="--c:${AGENT_MARK[a.id] || '#888'}">${esc(a.label[0])}</span>`, !a.installed) + `<div class="row-control">${action(a)}</div></label>`) : []),
  ].join('');
  $('#ai-optin', box).onchange = (e) => {
    ctx.set({ aiOptInAgents: e.target.checked, ...(e.target.checked ? {} : others.some((a) => a.id === chosen) ? { aiProvider: '' } : {}) });
    drawAgents(root, hasKey);
  };
  $$('input[name="ai-provider"]', box).forEach((r) => r.addEventListener('change', () => {
    ctx.set({ aiProvider: r.value });
    $$('.row.radio', box).forEach((x) => x.classList.toggle('on', x.contains(r)));
    toast(r.value ? `${r.closest('.row').querySelector('.row-label').firstChild.textContent.trim()} will answer` : 'Automatic');
  }));
  box.onclick = async (e) => {
    const ext = e.target.closest('[data-ext]');
    if (ext) { e.preventDefault(); S.openUrl(ext.dataset.ext); return; }
    const b = e.target.closest('[data-setup]');
    if (!b) return;
    e.preventDefault();
    const r = await S.agentsSetup(b.dataset.id, b.dataset.setup).catch((err) => ({ ok: false, error: err.message }));
    if (r.cancelled) return;
    if (!r.ok) return toast(r.error || 'Couldn’t start setup', { timeout: 6000 });
    toast(b.dataset.setup === 'install' ? 'Installing in Terminal — this list updates when it’s done' : 'Finish signing in — this list updates when it’s done', { timeout: 5000 });
    // Watch for the change for a few minutes.
    clearInterval(agentPoll);
    const start = Date.now();
    agentPoll = setInterval(() => {
      if (!box.isConnected || Date.now() - start > 5 * 60_000) return clearInterval(agentPoll);
      drawAgents(root, hasKey, true);
    }, 4000);
  };
}
