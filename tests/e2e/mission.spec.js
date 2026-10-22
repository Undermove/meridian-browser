// Mission Control: live agent tree fed by real hook plumbing.
//  - Claude Code: a fake `claude` CLI (tests/fixtures/fake-agents) is started from the Workbench like
//    the real one; it reads the --settings file Meridian generated and fires the real hook script
//    with synthetic Claude Code hook payloads (2 nested subagents, tool calls, a permission prompt,
//    completion). Nothing talks to a model.
//  - Codex: a fake `codex` runs the `-c notify=[…]` program after a turn.
//  - MCP: the real MCP bridge (mcp/meridian-mcp.js) against a local fixture page.
//  - The event channel itself: bad tokens, oversized lines.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { test, expect, launchMeridian, closeMeridian, seedState, ROOT } = require('../fixtures/meridian');

const FAKE_BIN = path.join(ROOT, 'tests', 'fixtures', 'fake-agents');
const SHOTS = process.env.MERIDIAN_MC_SHOTS || null; // set to a folder to keep screenshots

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

const workbenchView = (page) => page.evaluate(() => {
  const wv = [...document.querySelectorAll('webview')].find((w) => { try { return w.getURL().startsWith('meridian://workbench'); } catch { return false; } });
  return wv ? true : false;
});
const inWorkbench = (page, code) => page.evaluate((c) => {
  const wv = [...document.querySelectorAll('webview')].find((w) => { try { return w.getURL().startsWith('meridian://workbench'); } catch { return false; } });
  return wv.executeJavaScript(c);
}, code);
const snap = (page) => page.evaluate(() => mc.snap);

function claudeScript(dir, project) {
  const go = path.join(dir, 'go'), go2 = path.join(dir, 'go2');
  const ev = (event, payload = {}) => ({ event, payload });
  return {
    go, go2,
    claude: [
      ev('SessionStart', { source: 'startup', model: 'claude-opus-5-5' }),
      ev('UserPromptSubmit', { prompt: 'TOP-SECRET-PROMPT please refactor' }),
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 npm test' } }),
      ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: {}, tool_response: { stdout: 'TOP-SECRET-OUTPUT' } }),
      ev('PreToolUse', { tool_name: 'Agent', tool_use_id: 'tu2', tool_input: { description: 'Explore the repo', subagent_type: 'Explore', prompt: 'TOP-SECRET-SUBPROMPT' } }),
      ev('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      ev('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'tu3', tool_input: { file_path: path.join(project, 'README.md') } }),
      ev('PostToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'tu3', tool_input: {} }),
      ev('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Agent', tool_use_id: 'tu4', tool_input: { description: 'Check the tests', subagent_type: 'general-purpose' } }),
      ev('SubagentStart', { agent_id: 'a2', agent_type: 'general-purpose' }),
      ev('PreToolUse', { agent_id: 'a2', agent_type: 'general-purpose', tool_name: 'Grep', tool_use_id: 'tu5', tool_input: { pattern: 'TODO', path: project } }),
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu6', tool_input: { command: 'git push origin main' } }),
      ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash', title: 'Claude Code' }),
      { waitFile: go },
      ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu6', tool_input: {} }),
      ev('PostToolUse', { agent_id: 'a2', agent_type: 'general-purpose', tool_name: 'Grep', tool_use_id: 'tu5', tool_input: {} }),
      ev('SubagentStop', { agent_id: 'a2', agent_type: 'general-purpose', stop_hook_active: false }),
      ev('PostToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Agent', tool_use_id: 'tu4', tool_input: {} }),
      ev('SubagentStop', { agent_id: 'a1', agent_type: 'Explore', stop_hook_active: false }),
      ev('PostToolUse', { tool_name: 'Agent', tool_use_id: 'tu2', tool_input: {} }),
      ev('Stop', { stop_hook_active: false, last_assistant_message: 'TOP-SECRET-ANSWER' }),
      { waitFile: go2 },
      ev('SessionEnd', { reason: 'other' }),
      { exit: 0 },
    ],
    codex: [{ sleep: 300 }, { turn: 1 }, { sleep: 200 }, { turn: 2 }, { waitFile: go2 }, { exit: 0 }],
  };
}

async function launchWithAgents(extraEnv = {}) {
  const userDataDir = tmp('mer-mc-');
  const project = tmp('mer-mc-proj-');
  fs.writeFileSync(path.join(project, 'README.md'), '# fixture project\n');
  const work = tmp('mer-mc-work-');
  const script = claudeScript(work, project);
  fs.writeFileSync(path.join(work, 'script.json'), JSON.stringify(script));
  const m = await launchMeridian({
    userDataDir, state: seedState({ settings: { agentAccess: 'read' } }),
    env: { MERIDIAN_TEST_KEYCHAIN: '1', MERIDIAN_TEST_PROJECT: project, MERIDIAN_TEST_AGENT_BIN: FAKE_BIN, FAKE_AGENT_SCRIPT: path.join(work, 'script.json'), ...extraEnv },
  });
  return { ...m, userDataDir, project, work, script, cleanup: async () => { await closeMeridian(m.app); for (const d of [userDataDir, project, work]) fs.rmSync(d, { recursive: true, force: true }); } };
}

async function openWorkbenchProject(page) {
  await page.evaluate(() => runCommand('open-workbench'));
  await expect.poll(() => workbenchView(page)).toBe(true);
  await expect.poll(() => inWorkbench(page, 'typeof pickProject === "function" && document.readyState === "complete"').catch(() => false), { timeout: 15_000 }).toBe(true);
  await inWorkbench(page, 'pickProject().then(() => 1)');
  await expect.poll(() => inWorkbench(page, '!!S.project').catch(() => false), { timeout: 15_000 }).toBe(true);
}

test.describe('Mission Control', () => {
  test('Claude Code session with nested subagents, waiting prompt and completion', async () => {
    const m = await launchWithAgents();
    try {
      const { page, app } = m;
      await openWorkbenchProject(page);
      await inWorkbench(page, 'launch("claude").then(() => 1)');

      // Settings merge: the fake CLI prints what it found in --settings.
      await expect.poll(() => inWorkbench(page, 'S.terms[0]?.xterm.buffer.active.getLine(0) ? [...Array(40).keys()].map((i) => S.terms[0].xterm.buffer.active.getLine(i)?.translateToString(true) || "").join("") : ""'), { timeout: 15_000 })
        .toMatch(/fake-claude: hooks=.*PreToolUse.*SubagentStart.*guard=true mission=true mcp=true/);

      // The busy tree: session → Explore → Check the tests, the session waiting for permission.
      await expect.poll(async () => (await snap(page)).nodes.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
      await expect.poll(async () => (await snap(page)).nodes.find((n) => !n.parentId)?.status, { timeout: 10_000 }).toBe('waiting');
      const s = await snap(page);
      const root = s.nodes.find((n) => !n.parentId);
      const a1 = s.nodes.find((n) => n.label === 'Explore the repo');
      const a2 = s.nodes.find((n) => n.label === 'Check the tests');
      expect(root).toMatchObject({ source: 'claude', where: 'local', label: 'Claude Code', sublabel: 'claude-opus-5-5', project: path.basename(m.project) });
      expect(a1).toMatchObject({ parentId: root.id, kind: 'subagent', sublabel: 'Explore', status: 'tool', tool: { name: 'Agent' } });
      expect(a2).toMatchObject({ parentId: a1.id, kind: 'subagent', status: 'tool', tool: { name: 'Grep' } });
      expect(a2.tool.summary).toContain('TODO');
      expect(root.toolCalls).toBe(3); // Bash, Agent, Bash
      expect(a1.toolCalls).toBe(2);   // Read, Agent
      expect(root.termId).toBeTruthy();
      // Secrets, prompts and outputs never reach the UI.
      const dump = JSON.stringify(s);
      expect(dump).not.toMatch(/sk-ant-api03|TOP-SECRET/);
      expect(root.log.find((l) => l.name === 'Bash').summary).toMatch(/API_KEY=•••/);
      expect(s.counts).toMatchObject({ waiting: 1 });
      expect(s.counts.working).toBeGreaterThanOrEqual(2);

      // Native notification (recorded in tests) + sidebar badge + Workbench topbar chip.
      const notified = await app.evaluate(() => global.__meridianMission.notified);
      expect(notified.some((n) => /Claude Code · .* is waiting for you/.test(n.title) && /permission/.test(n.body))).toBe(true);
      await expect(page.locator('#mc-indicator .mc-ind-badge')).toHaveText('1');
      await expect(page.locator('#mc-indicator .mc-ind-text')).toHaveText(/\d+ working/);
      await expect.poll(() => inWorkbench(page, 'document.querySelector("#mission-chip .mtext")?.textContent || ""')).toMatch(/1 waiting for you/);

      // The view: open with the shortcut command, three nodes drawn, nesting in the DOM.
      await page.evaluate(() => runCommand('mission-control'));
      await expect(page.locator('#mission-overlay .mc-node')).toHaveCount(3);
      await expect(page.locator(`#mission-overlay .mc-node[data-id="${a1.id}"] .mc-kids .mc-node[data-id="${a2.id}"]`)).toHaveCount(1);
      await expect(page.locator('#mission-overlay .mc-node[data-status="waiting"] > .mc-row .mc-pill-text')).toHaveText(/permission/);
      await expect(page.locator('#mc-detail .mc-d-title')).toHaveText('Claude Code');
      await page.waitForTimeout(700);
      if (SHOTS) {
        // Playwright emulates prefers-color-scheme itself, so switch it there for the dark shot.
        await page.emulateMedia({ colorScheme: 'light' });
        await page.screenshot({ path: path.join(SHOTS, 'mission-light.png') });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.locator(`#mission-overlay .mc-node[data-id="${a2.id}"] > .mc-row`).click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(SHOTS, 'mission-dark.png') });
        await page.emulateMedia({ colorScheme: null });
      }

      // Completion: subagents finish, the session's turn ends.
      fs.writeFileSync(m.script.go, '');
      await expect.poll(async () => (await snap(page)).nodes.filter((n) => n.kind === 'subagent').every((n) => n.status === 'done' && n.endedAt), { timeout: 10_000 }).toBe(true);
      await expect.poll(async () => (await snap(page)).nodes.find((n) => !n.parentId).status).toBe('idle');
      expect((await snap(page)).counts).toMatchObject({ working: 0, waiting: 0 });
      await expect(page.locator('#mc-indicator .mc-ind-badge')).toBeHidden();

      // Click → jump to the agent's terminal in the Workbench.
      await page.locator(`#mission-overlay .mc-node[data-id="${root.id}"] > .mc-row .mc-go`).click({ force: true });
      await expect(page.locator('#mission-overlay')).toHaveCount(0);
      expect(await page.evaluate(() => isWorkbenchTab(activeTab()))).toBe(true);
      expect(await inWorkbench(page, 'S.activeTerm?.id')).toBe(root.termId);

      // Session end + process exit → finished; kept as a history summary without tool inputs.
      fs.writeFileSync(m.script.go2, '');
      await expect.poll(async () => (await snap(page)).nodes.find((n) => n.id === root.id)?.endedAt || null, { timeout: 10_000 }).not.toBeNull();
      await app.evaluate(() => { global.__meridianMission.sweep(true); });
      await expect.poll(async () => (await snap(page)).history.length).toBeGreaterThan(0);
      const h = (await snap(page)).history[0];
      expect(h).toMatchObject({ label: 'Claude Code', source: 'claude', status: 'done', subagents: 2, toolCalls: 6 });
      await expect.poll(() => fs.existsSync(path.join(m.userDataDir, 'mission-history.json'))).toBe(true);
      const file = fs.readFileSync(path.join(m.userDataDir, 'mission-history.json'), 'utf8');
      expect(file).not.toMatch(/summary|npm test|README|TODO|sk-ant/);
      expect(fs.statSync(path.join(m.userDataDir, 'mission-history.json')).mode & 0o777).toBe(0o600);
    } finally { await m.cleanup(); }
  });

  test('Codex session: notify program reports finished turns', async () => {
    const m = await launchWithAgents();
    try {
      const { page } = m;
      await openWorkbenchProject(page);
      await inWorkbench(page, 'launch("codex").then(() => 1)');
      await expect.poll(async () => (await snap(page)).nodes.find((n) => n.source === 'codex')?.turns || 0, { timeout: 15_000 }).toBe(2);
      const node = (await snap(page)).nodes.find((n) => n.source === 'codex');
      expect(node).toMatchObject({ status: 'idle', statusText: 'Turn finished — your move', where: 'local' });
      expect(JSON.stringify(await snap(page))).not.toMatch(/secret input|secret answer/);
      fs.writeFileSync(m.script.go2, '');
      await expect.poll(async () => (await snap(page)).nodes.find((n) => n.source === 'codex')?.endedAt || null, { timeout: 10_000 }).not.toBeNull();
    } finally { await m.cleanup(); }
  });

  test('event channel: private socket, unknown tokens and oversized lines are dropped', async () => {
    const m = await launchWithAgents();
    try {
      const { page, app } = m;
      const reg = await app.evaluate(async () => {
        const r = await global.__meridianMission.registerTerminal({ kind: 'claude', project: 'chan', ownerWcId: 0 });
        return { token: r.token, nodeId: r.nodeId, socket: r.env.MERIDIAN_MISSION_SOCKET };
      });
      if (process.platform !== 'win32') {
        expect(fs.statSync(reg.socket).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(reg.socket)).mode & 0o777).toBe(0o700);
      }
      const sendRaw = (text) => new Promise((resolve) => { const s = net.createConnection(reg.socket, () => s.end(text)); s.on('close', resolve); s.on('error', resolve); });
      await sendRaw(JSON.stringify({ v: 1, token: 'f'.repeat(64), kind: 'claude', event: 'UserPromptSubmit' }) + '\n');
      await sendRaw(JSON.stringify({ v: 1, token: reg.token, kind: 'claude', event: 'PreToolUse', tool: 'Bash', summary: 'x'.repeat(20000) }) + '\n');
      await sendRaw('not json\n');
      await page.waitForTimeout(300);
      let node = (await snap(page)).nodes.find((n) => n.id === reg.nodeId);
      expect(node.status).toBe('starting');
      expect(node.toolCalls).toBe(0);
      // The real hook script, fed a hook payload on stdin, with an HTML-ish label: drawn as text.
      await new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, 'src', 'agents', 'hooks', 'mission-hook.js')], { env: { ...process.env, MERIDIAN_MISSION_SOCKET: reg.socket, MERIDIAN_MISSION_TOKEN: reg.token } });
        p.on('exit', resolve);
        p.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/tmp', tool_name: 'Agent', tool_use_id: 'x1', tool_input: { description: '<img src=x onerror=alert(1)>', subagent_type: 'Explore' } }));
      });
      await expect.poll(async () => (await snap(page)).nodes.some((n) => n.label === '<img src=x onerror=alert(1)>')).toBe(true);
      await page.evaluate(() => runCommand('mission-control'));
      await expect(page.locator('#mission-overlay .mc-label', { hasText: '<img src=x' })).toHaveCount(1);
      expect(await page.locator('#mission-overlay img').count()).toBe(0);
    } finally { await m.cleanup(); }
  });
});

test.describe('Mission Control: MCP clients', () => {
  test('each MCP bridge is a node with its tool calls; a Workbench session’s bridge nests under it', async ({ server }) => {
    const m = await launchWithAgents();
    const clients = [];
    try {
      const { page, app } = m;
      await page.evaluate(() => { state.settings.agentAccess = 'full'; save(); return api.agentConfig({ access: 'full', allowJs: false }); });
      await expect.poll(() => fs.existsSync(path.join(m.userDataDir, 'agent-endpoint.json'))).toBe(true);
      const connect = async (name, env = {}) => {
        const client = new Client({ name, version: '1.0.0' });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp', 'meridian-mcp.js')], env: { ...process.env, MERIDIAN_DATA_DIR: m.userDataDir, ...env }, stderr: 'pipe' }));
        clients.push(client);
        return client;
      };
      const a = await connect('e2e-agent');
      await a.callTool({ name: 'open_tab', arguments: { url: server.url('/p/mission') } });
      await a.callTool({ name: 'read_page', arguments: {} });
      await a.callTool({ name: 'type_text', arguments: { value: 'TOP-SECRET-TYPED', element_index: 0 } }).catch(() => {});
      await expect.poll(async () => (await snap(page)).nodes.find((n) => n.source === 'mcp')?.toolCalls || 0).toBe(3);
      const node = (await snap(page)).nodes.find((n) => n.source === 'mcp');
      expect(node).toMatchObject({ parentId: null, label: 'e2e-agent', where: 'mcp', status: 'idle' });
      expect(node.log.map((l) => l.name)).toEqual(['open_tab', 'read_page', 'type_text']);
      expect(node.log[0].summary).toBe(new URL(server.base).host);
      expect(node.log[2].summary).toMatch(/^16 characters/);
      expect(JSON.stringify(await snap(page))).not.toMatch(/TOP-SECRET-TYPED/);
      expect(node.tabId).toBeTruthy();
      // reveal → that tab
      await page.evaluate((id) => revealMissionNode(id), node.id);
      expect(await page.evaluate(() => tabUrl(activeTab()))).toContain('/p/mission');

      // A bridge started by a Workbench session (it inherits the session's Mission token) nests under it.
      const reg = await app.evaluate(async () => { const r = await global.__meridianMission.registerTerminal({ kind: 'claude', project: 'nest', ownerWcId: 0 }); return { token: r.token, nodeId: r.nodeId }; });
      const b = await connect('claude-code', { MERIDIAN_MISSION_TOKEN: reg.token });
      await b.callTool({ name: 'list_tabs', arguments: {} });
      await expect.poll(async () => (await snap(page)).nodes.find((n) => n.parentId === reg.nodeId)?.label || '').toBe('Meridian browser tools');
    } finally {
      for (const c of clients) await c.close().catch(() => {});
      await m.cleanup();
    }
  });
});
