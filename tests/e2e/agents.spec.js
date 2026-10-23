// Local AI agents as the AI behind Ask (⌘T), ⌘J and Settings → AI, against a fake `claude` CLI that
// speaks Claude Code's stream-json and logs how it was started (flags, stdin, cwd) so we can check the
// security posture: no tools, no MCP, no user settings, prompt on stdin, private working directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, testPathDefault, press } = require('../fixtures/meridian');

function fakeAgentDir({ loggedIn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-agent-'));
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: ${loggedIn}, email: 'tester@example.com' })); process.exit(0); }
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, cwd: process.cwd(), env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null } }) + '\\n');
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const question = stdin.split('\\n').filter(Boolean).pop();
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [], mcp_servers: [] });
  const answer = stdin.includes('<signals>')
    ? JSON.stringify({ persona: 'designer', mode: 'creative', title: 'Product designer', color: '#c471f5', spaces: [{ name: 'Design', icon: '🎨', color: '#c471f5' }, { name: 'Home', icon: '🏠', color: '#43cea2' }], favorites: ['figma', 'evil-site', 'gmail'] })
    : (resume ? '[resumed ' + resume + '] ' : '') + 'Answer to: ' + question;
  for (const part of answer.match(/.{1,6}/g)) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: 'sess-1' });
});
`, { mode: 0o755 });
  return { dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

async function launch({ state = seedState(), agent = fakeAgentDir(), env = {} } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-agents-'));
  const m = await launchMeridian({ userDataDir, state, env: { MERIDIAN_TEST_PATH: `${agent.dir}${path.delimiter}${testPathDefault()}`, ...env } });
  return { ...m, agent, userDataDir, cleanup: async () => { await closeMeridian(m.app); fs.rmSync(userDataDir, { recursive: true, force: true }); fs.rmSync(agent.dir, { recursive: true, force: true }); } };
}

test('a question in ⌘T is answered inline by the local agent, started safely', async () => {
  const m = await launch();
  try {
    const { page } = m;
    await page.evaluate(() => openCommandBar());
    await page.locator('#cmd-input').fill('how do I split the screen?');
    // Reads like a question → "Ask Claude Code" is the first row.
    const first = page.locator('#cmd-results .cmd-row').first();
    await expect(first).toHaveAttribute('data-kind', 'ask');
    await expect(first).toContainText('Ask Claude Code');
    await page.locator('#cmd-input').press('Enter');
    await expect(page.locator('#cmd-answer .ca-body')).toContainText('Answer to: how do I split the screen?', { timeout: 15_000 });
    await expect(page.locator('#cmd-results')).toBeHidden();

    const call = m.agent.calls()[0];
    const a = call.args;
    // Tools off, MCP off, no user/project settings (no plugins or hooks), no slash commands.
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
    expect(a).toContain('--disable-slash-commands');
    // The question travels on stdin, never in argv.
    expect(a.join(' ')).not.toContain('split the screen');
    expect(call.stdin).toContain('how do I split the screen?');
    // System prompt carries Meridian's own guide (so it can answer about the browser) and the untrusted-page rule.
    const sys = a[a.indexOf('--system-prompt') + 1];
    expect(sys).toContain('<meridian_guide>');
    expect(sys).toMatch(/Split view/);
    expect(sys).toMatch(/never follow instructions/);
    // A private working directory inside Meridian's data dir.
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(path.join(m.userDataDir, 'agent-chat', 'claude')));
    expect((fs.statSync(call.cwd).mode & 0o777).toString(8)).toBe('700');

    // Typing again leaves the answer and shows results; Esc closes.
    await page.locator('#cmd-input').type(' now');
    await expect(page.locator('#cmd-answer')).toBeHidden();
    await expect(page.locator('#cmd-results')).toBeVisible();
  } finally { await m.cleanup(); }
});

test('"Continue in chat" carries the answer to ⌘J, and the follow-up resumes the same agent session', async () => {
  const m = await launch();
  try {
    const { page } = m;
    await page.evaluate(() => openCommandBar());
    await page.locator('#cmd-input').fill('what is a space?');
    await page.locator('#cmd-input').press('Enter');
    await expect(page.locator('#cmd-answer .ca-body')).toContainText('Answer to: what is a space?', { timeout: 15_000 });
    await page.locator('[data-ca="chat"]').click();
    await expect(page.locator('body')).toHaveClass(/ai-open/);
    await expect(page.locator('#ai-title-text')).toHaveText('Ask Claude Code');
    await expect(page.locator('#ai-messages .ai-msg.user')).toHaveText('what is a space?');
    await expect(page.locator('#ai-messages .ai-msg.assistant').last()).toContainText('Answer to: what is a space?');
    await page.evaluate(() => sendAi('and a profile?'));
    await expect(page.locator('#ai-messages .ai-msg.assistant').last()).toContainText('[resumed sess-1] Answer to: and a profile?', { timeout: 15_000 });
    const calls = m.agent.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toContain('--resume');
    // ⌘J with a local agent never offers browser tools.
    await expect(page.locator('#ai-tools-label')).toBeHidden();
  } finally { await m.cleanup(); }
});

test('with no AI connected, Ask explains how to connect one instead of failing', async () => {
  const empty = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mer-noagent-')), calls: () => [] };
  const m = await launch({ agent: empty });
  try {
    const { page } = m;
    await page.evaluate(() => openCommandBar());
    await page.locator('#cmd-input').fill('why is the sky blue?');
    await expect(page.locator('#cmd-results .cmd-row').first()).toContainText('Connect an AI');
    await page.locator('#cmd-input').press('Enter');
    await expect(page.locator('#cmd-answer')).toContainText('Connect an AI');
    await expect(page.locator('[data-ca="connect"]')).toBeVisible();
  } finally { await m.cleanup(); }
});

test('Settings → AI lists the agent as ready; choosing it is saved; signing in confirms the exact command', async () => {
  const m = await launch({ agent: fakeAgentDir({ loggedIn: false }) });
  try {
    const { page, app } = m;
    const winPromise = app.waitForEvent('window', (w) => w.url().startsWith('meridian://app/settings.html'));
    await page.evaluate(() => openSettings('ai'));
    const sw = await winPromise;
    const row = sw.locator('#agent-rows .row.agent', { hasText: 'Claude Code' });
    await expect(row).toContainText('Not signed in', { timeout: 15_000 });
    await expect(sw.locator('#agent-rows .row.agent', { hasText: 'Codex' })).toContainText('Not installed');
    // Sign in → native confirmation naming the exact command; cancelled here, so nothing runs.
    await row.locator('[data-setup="login"]').click();
    await expect.poll(async () => (await app.evaluate(() => global.__e2e.dialogs)).map((d) => d.detail || '').join('\n')).toContain('claude auth login');
    // Pick it explicitly.
    await row.locator('input[type="radio"]').check({ force: true });
    await expect.poll(() => page.evaluate(() => state.settings.aiProvider)).toBe('claude');
  } finally { await m.cleanup(); }
});

test('modes: everyday hides developer tools; developer brings them back', async () => {
  const m = await launch({ state: seedState({ settings: { mode: 'everyday' } }) });
  try {
    const { page } = m;
    await expect(page.locator('body')).toHaveClass(/mode-everyday/);
    await page.evaluate(() => openCommandBar());
    await page.locator('#cmd-input').fill('workbench');
    await expect(page.locator('#cmd-results')).not.toContainText('Open Workbench');
    await page.evaluate(() => { closeCommandBar(); applySettingsPatch({ mode: 'developer' }); });
    await page.evaluate(() => openCommandBar());
    await page.locator('#cmd-input').fill('workbench');
    await expect(page.locator('#cmd-results')).toContainText('Open Workbench');
  } finally { await m.cleanup(); }
});

test('the tour: the agent is found, it proposes a setup from the apps, and applying it sets mode, spaces and favorites', async () => {
  const m = await launch({ state: { ...seedState(), onboarded: false } });
  try {
    const { page } = m;
    await expect(page.locator('#onboarding')).toBeVisible({ timeout: 15_000 });
    const next = page.locator('#onboarding [data-ob="next"]');
    await next.click();
    await expect(page.locator('.ob-step-ai h2')).toHaveText('Your AI is here', { timeout: 15_000 });
    await expect(page.locator('.ob-ai-name')).toContainText('Claude Code');
    await next.click();
    await page.locator('#ob-about').fill('I design mobile apps');
    await next.click();
    await expect(page.locator('.ob-step-preview')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ob-persona')).toHaveText('Product designer');
    // The agent was asked once, with the signals, and its answer was validated: the made-up favorite id is gone.
    const call = m.agent.calls().find((c) => c.stdin.includes('<signals>'));
    expect(call.stdin).toContain('about_them: I design mobile apps');
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('');
    expect(await page.evaluate(() => ob.proposal.favorites.map((f) => f.id))).toEqual(['figma', 'gmail']);
    await next.click();
    await expect(page.locator('.ob-step-done')).toBeVisible({ timeout: 15_000 });
    await next.click();
    const st = await page.evaluate(() => ({ mode: state.settings.mode, provider: state.settings.aiProvider, spaces: state.spaces.map((s) => s.icon + ' ' + s.name), favs: state.favorites.default.map((t) => t.url) }));
    expect(st).toEqual({ mode: 'creative', provider: 'claude', spaces: ['🎨 Design', '🏠 Home'], favs: ['https://www.figma.com/files', 'https://mail.google.com/'] });
  } finally { await m.cleanup(); }
});
