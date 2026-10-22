/* Meridian — Settings → AI (Settings window).
 *
 * Everything AI-related in Settings lives here: the Claude API key, agent access for the ⌘J assistant
 * and MCP clients, and connecting coding agents (Claude Code, Codex) to Meridian's MCP server.
 * Add new AI settings as more groups in render(); they go through the same channel as the rest of
 * Settings (ctx.set for settings in state.json, S.* calls for things main owns, like the key).
 * Loaded after settings.js and uses its helpers (registerSection, group, row, toggle, button, …).
 */

registerSection({
  id: 'ai', label: 'AI', icon: 'sparkles', order: 50,
  async render(el) {
    const s = ctx.settings;
    const [hasKey, status, clis] = await Promise.all([S.aiHasKey(), S.agentStatus(), S.mcpDetect().catch(() => ({}))]);
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
        ${row('Link previews', toggle('ai-link-preview', s.aiLinkPreview === true), 'Hold ⇧ over a link to see a short summary of the page. Meridian loads the page in the background with that space’s profile (its cookies) and sends its text to Claude. Summaries are cached for 30 minutes. Never in private windows.')}
      `, hasKey ? 'These use your Claude API key. Page text and tab titles are sent as untrusted content.' : 'Add a Claude API key above to use these.')}
      ${group('Mission Control', `
        ${row('Notify me when an agent is waiting', toggle('mission-notify', s.missionNotify !== false), 'A notification (or a toast while Meridian is in front) when Claude Code needs your permission or input. Mission Control (⇧⌘M) always shows it.')}
      `, 'Mission Control shows Claude Code and Codex sessions started from the Workbench, MCP clients and ⌘J chats, live. It keeps a short history without tool inputs.')}
      ${group('Coding agents', `${cliRow('claude')}${cliRow('codex')}`,
        'Connect registers Meridian’s MCP server with that CLI. You’ll see the exact command and confirm before it runs. Agents only work while Meridian is running and agent access isn’t Off.')}`;

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
