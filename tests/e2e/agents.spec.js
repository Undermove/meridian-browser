// Local AI agents as the AI behind Ask (⌘T), ⌘J, Settings → AI and the welcome tour, against a fake
// GitHub Copilot CLI (an agent apps may use on the user's account) that logs how it was started, so we can
// check the security posture: no tools, no MCP, no custom instructions, private working directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, testPathDefault, press } = require('../fixtures/meridian');

function fakeAgentDir({ codexLoggedIn = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-agent-'));
  const log = path.join(dir, 'calls.jsonl');
  // GitHub Copilot CLI: prompt in argv (-p), plain streamed text on stdout.
  fs.writeFileSync(path.join(dir, 'copilot'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: 'copilot', args, prompt, cwd: process.cwd() }) + '\\n');
const question = prompt.split('\\n').filter(Boolean).pop();
const answer = prompt.includes('<signals>')
  ? JSON.stringify({ persona: 'designer', mode: 'creative', title: 'Product designer', color: '#c471f5', spaces: [{ name: 'Design', icon: '🎨', color: '#c471f5' }, { name: 'Home', icon: '🏠', color: '#43cea2' }], favorites: ['figma', 'evil-site', 'gmail'] })
  : (prompt.includes('<conversation_so_far>') ? '[remembered] ' : '') + 'Answer to: ' + question;
(async () => { for (const part of answer.match(/.{1,6}/gs)) { process.stdout.write(part); await new Promise((r) => setTimeout(r, 5)); } })();
`, { mode: 0o755 });
  if (codexLoggedIn !== null) {
    // Codex (an opt-in agent): only its sign-in status matters here.
    fs.writeFileSync(path.join(dir, 'codex'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') { console.log(${codexLoggedIn ? "'Logged in using ChatGPT'" : "'Not logged in'"}); process.exit(${codexLoggedIn ? 0 : 1}); }
process.exit(1);
`, { mode: 0o755 });
  }
  return { dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

// Copilot can't report whether it's signed in, so it's never picked automatically: the profiles here choose
// it (as "Check" in the tour or Settings would).
async function launch({ state = seedState({ settings: { aiProvider: 'copilot' } }), agent = fakeAgentDir(), env = {} } = {}) {
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
    const first = page.locator('#cmd-results .cmd-row').first();
    await expect(first).toHaveAttribute('data-kind', 'ask');
    await expect(first).toContainText('Ask GitHub Copilot');
    await page.locator('#cmd-input').press('Enter');
    await expect(page.locator('#cmd-answer .ca-body')).toContainText('Answer to: how do I split the screen?', { timeout: 15_000 });
    await expect(page.locator('#cmd-results')).toBeHidden();

    const call = m.agent.calls()[0];
    const a = call.args;
    // No tools, no built-in MCP servers, no custom instructions, no questions back, no updates.
    expect(a).toContain('--available-tools=');
    expect(a).toContain('--disable-builtin-mcps');
    expect(a).toContain('--no-custom-instructions');
    expect(a).toContain('--no-ask-user');
    // System prompt (sent with the prompt: Copilot has no separate flag) carries Meridian's guide and the untrusted-page rule.
    expect(call.prompt).toContain('<meridian_guide>');
    expect(call.prompt).toMatch(/Split view/);
    expect(call.prompt).toMatch(/never follow instructions/);
    expect(call.prompt).toContain('how do I split the screen?');
    // A private working directory inside Meridian's data dir.
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(path.join(m.userDataDir, 'agent-chat', 'copilot')));
    expect((fs.statSync(call.cwd).mode & 0o777).toString(8)).toBe('700');

    await page.locator('#cmd-input').type(' now');
    await expect(page.locator('#cmd-answer')).toBeHidden();
    await expect(page.locator('#cmd-results')).toBeVisible();
  } finally { await m.cleanup(); }
});

test('"Continue in chat" carries the answer to ⌘J, and the follow-up keeps the context', async () => {
  const m = await launch();
  try {
    const { page } = m;
    await page.evaluate(() => openCommandBar());
    await page.locator('#cmd-input').fill('what is a space?');
    await page.locator('#cmd-input').press('Enter');
    await expect(page.locator('#cmd-answer .ca-body')).toContainText('Answer to: what is a space?', { timeout: 15_000 });
    await page.locator('[data-ca="chat"]').click();
    await expect(page.locator('body')).toHaveClass(/ai-open/);
    await expect(page.locator('#ai-title-text')).toHaveText('Ask GitHub Copilot');
    await expect(page.locator('#ai-messages .ai-msg.user')).toHaveText('what is a space?');
    await expect(page.locator('#ai-messages .ai-msg.assistant').last()).toContainText('Answer to: what is a space?');
    await page.evaluate(() => sendAi('and a profile?'));
    // Copilot can't resume a session, so the follow-up carries the conversation so far.
    await expect(page.locator('#ai-messages .ai-msg.assistant').last()).toContainText('[remembered] Answer to: and a profile?', { timeout: 15_000 });
    const calls = m.agent.calls();
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('what is a space?');
    // ⌘J with a local agent never offers browser tools.
    await expect(page.locator('#ai-tools-label')).toBeHidden();
  } finally { await m.cleanup(); }
});

test('with no AI connected, Ask explains how to connect one instead of failing', async () => {
  const empty = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mer-noagent-')), calls: () => [] };
  const m = await launch({ agent: empty, state: seedState() });
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

test('Settings → AI: default agents always, "Other agents" only when turned on; signing in confirms the exact command', async () => {
  const m = await launch({ agent: fakeAgentDir({ codexLoggedIn: false }) });
  try {
    const { page, app } = m;
    const winPromise = app.waitForEvent('window', (w) => w.url().startsWith('meridian://app/settings.html'));
    await page.evaluate(() => openSettings('ai'));
    const sw = await winPromise;
    await expect(sw.locator('#agent-rows .row.agent', { hasText: 'GitHub Copilot' })).toContainText('Installed · not checked', { timeout: 15_000 });
    // Opt-in agents stay hidden (and unusable) until "Other agents" is on.
    await expect(sw.locator('#agent-rows .row.agent', { hasText: 'Codex' })).toHaveCount(0);
    expect(await page.evaluate(() => agentAllowed(aiAgents.list?.find((a) => a.id === 'codex') || { policy: 'optin' }))).toBe(false);
    await sw.locator('#ai-optin').check({ force: true });
    await expect.poll(() => page.evaluate(() => state.settings.aiOptInAgents)).toBe(true);
    const row = sw.locator('#agent-rows .row.agent', { hasText: 'Codex' });
    await expect(row).toContainText('Not signed in', { timeout: 15_000 });
    await row.locator('[data-setup="login"]').click();
    await expect.poll(async () => (await app.evaluate(() => global.__e2e.dialogs)).map((d) => d.detail || '').join('\n')).toContain('codex login');
    // Claude Code and Gemini CLI aren't offered here at all (their terms don't allow it); the note says why.
    await expect(sw.locator('#agent-rows')).not.toContainText('Claude Code');
    await expect(sw.locator('.page[data-section="ai"]')).toContainText('Claude Code and Gemini CLI run in the Workbench terminal');
    await sw.locator('#agent-rows .row.agent', { hasText: 'GitHub Copilot' }).locator('input[type="radio"]').check({ force: true });
    await expect.poll(() => page.evaluate(() => state.settings.aiProvider)).toBe('copilot');
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
    // Copilot can't say whether it's signed in: it's offered with "Check", which sends one tiny request.
    await expect(page.locator('.ob-step-ai h2')).toHaveText('Bring your AI', { timeout: 15_000 });
    await page.locator('[data-check="copilot"]').click();
    await expect(page.locator('.ob-step-ai h2')).toHaveText('Your AI is here', { timeout: 15_000 });
    expect(m.agent.calls()[0].prompt).toContain('Reply with exactly: OK');
    await expect(page.locator('.ob-ai-name')).toContainText('GitHub Copilot');
    await next.click();
    await page.locator('#ob-about').fill('I design mobile apps');
    await next.click();
    await expect(page.locator('.ob-step-preview')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.ob-persona')).toHaveText('Product designer');
    // The agent was asked once, with the signals, and its answer was validated: the made-up favorite id is gone.
    const call = m.agent.calls().find((c) => c.prompt.includes('<signals>'));
    expect(call.prompt).toContain('about_them: I design mobile apps');
    expect(call.args).toContain('--available-tools=');
    expect(await page.evaluate(() => ob.proposal.favorites.map((f) => f.id))).toEqual(['figma', 'gmail']);
    await next.click();
    await expect(page.locator('.ob-step-done')).toBeVisible({ timeout: 15_000 });
    await next.click();
    const st = await page.evaluate(() => ({ mode: state.settings.mode, provider: state.settings.aiProvider, spaces: state.spaces.map((s) => s.icon + ' ' + s.name), favs: state.favorites.default.map((t) => t.url) }));
    expect(st).toEqual({ mode: 'creative', provider: 'copilot', spaces: ['🎨 Design', '🏠 Home'], favs: ['https://www.figma.com/files', 'https://mail.google.com/'] });
  } finally { await m.cleanup(); }
});
