// The Chat view (src/renderer/chat.js) against fake local agent CLIs: no real agent runs, nothing is paid for.
// MERIDIAN_TEST_PATH (dev-only hook in src/dev/env.js) makes the app look for agents in a temp dir only;
// the fakes there print the same stream formats as Qwen Code / Codex and log what they were given.
// Those are opt-in agents ("Other agents" in Settings → AI), so the profiles here turn that on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, launchMeridian, closeMeridian, seedState, flushState, e2eLog, openTabDirect } = require('../fixtures/meridian');
const S = require('../fixtures/state');

const NODE = process.execPath;

function fakeQwen(dir, log) {
  fs.writeFileSync(path.join(dir, 'qwen'), `#!${NODE}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, email: 't@example.com' })); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: 'qwen', args, input }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const said = input.trim().split('\\n').pop();
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  const reply = (input.includes('<conversation_so_far>') ? '(I remember our chat) ' : '') + 'Hi from **Claude**! You said: ' + said + '\\n\\nSee [the docs](https://example.com/docs) ![x](https://evil.example/x.png)';
  const parts = [reply.slice(0, 12), reply.slice(12, 30), reply.slice(30)];
  for (const p of parts) { out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: p } } }); await sleep(said.includes('slow') ? 4000 : 60); }
  out({ type: 'result', subtype: 'success', result: reply, session_id: 's1' });
});
`, { mode: 0o755 });
}

function fakeCodex(dir, log) {
  fs.writeFileSync(path.join(dir, 'codex'), `#!${NODE}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: 'codex', args, input }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hello from Codex' } }));
});
`, { mode: 0o755 });
}

const readLog = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A profile + a bin dir with the given fake agents.
async function setup({ agents = ['qwen'], state, userDataDir } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-chat-'));
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(work, 'agents.log');
  if (agents.includes('qwen')) fakeQwen(bin, log);
  if (agents.includes('codex')) fakeCodex(bin, log);
  const dir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mer-e2e-'));
  const env = { MERIDIAN_TEST_PATH: bin, ANTHROPIC_API_KEY: '' };
  const st = state || seedState();
  st.settings = { aiOptInAgents: true, ...(agents.includes('qwen') ? { aiProvider: 'qwen' } : {}), ...st.settings };
  const m = await launchMeridian({ userDataDir: dir, state: st, env });
  const h = {
    ...m, bin, log, userDataDir: dir, env,
    async relaunch() {
      await flushState(h.page).catch(() => {});
      await closeMeridian(h.app);
      Object.assign(h, await launchMeridian({ userDataDir: dir, keepState: true, env }));
    },
    async cleanup() { await closeMeridian(h.app); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); },
  };
  return h;
}

async function openChatView(page) {
  await page.evaluate(() => runCommand('open-chat'));
  await expect(page.locator('#chat-view')).toBeVisible();
}

async function send(page, text) {
  await expect(page.locator('#chat-stop')).toBeHidden({ timeout: 15_000 }); // the previous answer has finished
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-input').press('Enter');
}

test('open from the command bar, send, streamed answer, copy, links, Esc; persists across relaunch with context', async () => {
  const m = await setup();
  try {
    let { page } = m;
    await page.evaluate(() => openCommandBar('new'));
    await page.locator('#cmd-input').fill('open chat');
    await page.locator('#cmd-results .cmd-row', { hasText: /Open Chat/ }).filter({ hasText: 'Command' }).first().dispatchEvent('mousedown');
    await expect(page.locator('#chat-view')).toBeVisible();
    // Empty state: greeting, four suggestions, who answers.
    await expect(page.locator('.chat-hello')).toHaveText(/Good (morning|afternoon|evening)|Hello/);
    await expect(page.locator('.chat-suggestion')).toHaveCount(4);
    await expect(page.locator('#chat-agent-btn')).toContainText('Qwen Code');
    await expect(page.locator('#chat-input')).toHaveAttribute('placeholder', 'Message Qwen Code…');
    // Shift+Enter is a newline, Enter sends.
    await page.locator('#chat-input').fill('hello there');
    await page.locator('#chat-input').press('Shift+Enter');
    expect(await page.locator('#chat-input').inputValue()).toBe('hello there\n');
    await page.locator('#chat-input').press('Enter');
    await expect(page.locator('.chat-msg.user .chat-bubble')).toHaveText('hello there');
    const answer = page.locator('.chat-msg.assistant').last();
    await expect(answer.locator('.chat-md')).toContainText('You said: hello there', { timeout: 15_000 });
    await expect(answer.locator('.chat-md strong')).toHaveText('Claude');
    await expect(answer.locator('.chat-who')).toContainText('Qwen Code');
    await expect(page.locator('#chat-stop')).toBeHidden();
    // Safe Markdown: no images, ever; links open in a background tab.
    await expect(page.locator('#chat-thread img')).toHaveCount(0);
    await expect(answer.locator('a', { hasText: 'x' })).toHaveCount(0); // ![x](…) is just its alt text
    const tabsBefore = await page.evaluate(() => space().today.length);
    await answer.locator('a', { hasText: 'the docs' }).click();
    await expect.poll(() => page.evaluate(() => space().today.map((t) => t.url))).toContain('https://example.com/docs');
    expect(await page.evaluate(() => space().today.length)).toBe(tabsBefore + 1);
    await expect(page.locator('#chat-view')).toBeVisible(); // background tab: still chatting
    // Copy.
    await answer.locator('[data-copy]').click();
    expect((await e2eLog(m.app)).clip.at(-1)).toContain('You said: hello there');
    // Title from the first message, in the list.
    await expect(page.locator('.chat-item .chat-item-title')).toHaveText(['hello there']);
    await expect(page.locator('.chat-list-group').first()).toHaveText('Today');
    // The agent got the prompt on stdin, with tools off.
    const first = readLog(m.log).at(-1);
    expect(first.bin).toBe('qwen');
    expect(first.input).toContain('hello there');
    expect(first.input).not.toContain('<conversation_so_far>');
    expect(first.args).toEqual(expect.arrayContaining(['--approval-mode', 'plan', '--safe-mode']));
    // Esc returns to browsing.
    await page.locator('#chat-input').press('Escape');
    await expect(page.locator('#chat-view')).toBeHidden();

    // chats.json, private to the user, not in state.json.
    const file = path.join(m.userDataDir, 'chats.json');
    await expect.poll(() => fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.chats[0].title).toBe('hello there');
    expect(saved.chats[0].messages.map((x) => x.role)).toEqual(['user', 'assistant']);
    await flushState(page);
    expect(fs.readFileSync(path.join(m.userDataDir, 'state.json'), 'utf8')).not.toContain('hello there');

    // Relaunch: the chat is still there; the next turn carries the earlier ones (main forgot the session).
    await m.relaunch();
    page = m.page;
    await openChatView(page);
    await expect(page.locator('.chat-item .chat-item-title')).toHaveText(['hello there']);
    await page.locator('.chat-item').first().click();
    await expect(page.locator('.chat-msg.user .chat-bubble')).toHaveText(['hello there']);
    await expect(page.locator('#chat-title')).toHaveText('hello there');
    await send(page, 'and again');
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('(I remember our chat) Hi from Claude! You said: and again', { timeout: 15_000 });
    const second = readLog(m.log).at(-1);
    expect(second.input).toContain('<conversation_so_far>');
    expect(second.input).toContain('User: hello there');
    // Third turn in the same run: no second copy of the history.
    await send(page, 'third');
    await expect(page.locator('.chat-msg.assistant')).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('You said: third');
    expect((readLog(m.log).at(-1).input.match(/<conversation_so_far>/g) || []).length).toBeLessThanOrEqual(1);
    await expect.poll(() => JSON.parse(fs.readFileSync(file, 'utf8')).chats[0].messages.length).toBe(6);
  } finally { await m.cleanup(); }
});

test('switching the agent: picker lists installed agents, saves aiProvider, the next answer comes from it', async () => {
  const m = await setup({ agents: ['qwen', 'codex'], state: seedState({ settings: { aiProvider: 'qwen' } }) });
  try {
    const { page } = m;
    await openChatView(page);
    await expect(page.locator('#chat-agent-btn')).toContainText('Qwen Code');
    await page.locator('#chat-agent-btn').click();
    await expect(page.locator('#chat-agent-menu .cam-label')).toHaveText(['Codex', 'Qwen Code', 'Set up another AI…']);
    await page.locator('#chat-agent-menu [data-pick="codex"]').click();
    await expect(page.locator('#chat-agent-menu')).toHaveCount(0);
    await expect(page.locator('#chat-agent-btn')).toContainText('Codex');
    expect(await page.evaluate(() => state.settings.aiProvider)).toBe('codex');
    await send(page, 'who are you');
    const answer = page.locator('.chat-msg.assistant').last();
    await expect(answer.locator('.chat-md')).toContainText('Hello from Codex', { timeout: 15_000 });
    await expect(answer.locator('.chat-who')).toContainText('Codex');
    expect(readLog(m.log).at(-1).bin).toBe('codex');
    // Back to Qwen Code mid-chat: it gets the conversation so far (it has no session of its own yet).
    await page.locator('#chat-agent-btn').click();
    await page.locator('#chat-agent-menu [data-pick="qwen"]').click();
    await send(page, 'and you');
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-who')).toContainText('Qwen Code', { timeout: 15_000 });
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('You said: and you', { timeout: 15_000 });
    const last = readLog(m.log).at(-1);
    expect(last.bin).toBe('qwen');
    expect(last.input).toContain('Assistant: Hello from Codex');
  } finally { await m.cleanup(); }
});

test('nothing set up: the setup card offers Install, and the chat unlocks once an agent appears', async () => {
  const m = await setup({ agents: [] });
  try {
    const { page } = m;
    await openChatView(page);
    const card = page.locator('#chat-thread .agent-setup-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('.asc-row[data-agent="cursor"] .asc-status')).toHaveText('Not installed');
    await expect(page.locator('#chat-input')).toBeDisabled();
    await expect(page.locator('#chat-agent-btn')).toContainText('No AI set up');
    // Install asks first (native dialog, answered Cancel by the fixture) and runs nothing.
    await card.locator('[data-setup="cursor"][data-action="install"]').click();
    await expect.poll(async () => (await e2eLog(m.app)).dialogs.map((d) => d.message)).toContain('Install Cursor?');
    // The user installs it in the terminal; the card picks it up.
    fakeQwen(m.bin, m.log);
    await card.locator('[data-act="recheck"]').click();
    // Qwen Code can't report its sign-in, so the card offers a one-request "Check".
    await card.locator('[data-check="qwen"]').click();
    await expect(page.locator('#chat-thread .agent-setup-card')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.chat-suggestion')).toHaveCount(4);
    await expect(page.locator('#chat-input')).toBeEnabled();
    await expect(page.locator('#chat-agent-btn')).toContainText('Qwen Code');
    await send(page, 'works now');
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('You said: works now', { timeout: 15_000 });
  } finally { await m.cleanup(); }
});

test('stop, delete with confirm, new chat, suggestion chips, sidebar button in Creative mode, tab click returns', async ({ server }) => {
  const m = await setup({ state: seedState({ settings: { mode: 'creative' } }) });
  try {
    const { page } = m;
    const tabId = await openTabDirect(page, server.url('/p/alpha'));
    // Creative mode shows a Chat button in the sidebar footer.
    await expect(page.locator('#btn-chat')).toBeVisible();
    await page.locator('#btn-chat').click();
    await expect(page.locator('#chat-view')).toBeVisible();
    // A suggestion that uses the page turns the page on for that message.
    await page.locator('.chat-suggestion', { hasText: 'Summarize this page' }).click();
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('You said: Summarize this page.', { timeout: 15_000 });
    expect(readLog(m.log).at(-1).input).toMatch(/<current_page url="[^"]*\/p\/alpha"/);
    // Stop while streaming.
    await send(page, 'go slow please');
    await expect(page.locator('#chat-stop')).toBeVisible();
    await expect(page.locator('.chat-msg.assistant.streaming .chat-md')).toContainText('Hi from', { timeout: 10_000 });
    await page.locator('#chat-stop').click();
    await expect(page.locator('#chat-send')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-act-note')).toHaveText('Stopped');
    // New chat, then delete the first one (with confirm).
    await page.locator('.chat-new').click();
    await expect(page.locator('.chat-suggestion')).toHaveCount(4);
    await send(page, 'second chat');
    await expect(page.locator('.chat-item')).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('You said: second chat', { timeout: 15_000 });
    const old = page.locator('.chat-item', { hasText: 'Summarize this page.' });
    await old.hover();
    await old.locator('[data-del]').click();
    await page.locator('#modal [data-a="cancel"]').click();
    await expect(page.locator('.chat-item')).toHaveCount(2);
    await old.hover();
    await old.locator('[data-del]').click();
    await page.locator('#modal [data-a="ok"]').click();
    await expect(page.locator('.chat-item .chat-item-title')).toHaveText(['second chat']);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(m.userDataDir, 'chats.json'), 'utf8')).chats.map((c) => c.title)).toEqual(['second chat']);
    // Clicking a tab in the sidebar returns to browsing.
    await page.locator(`#sidebar .row.tab[data-id="${tabId}"]`).click();
    await expect(page.locator('#chat-view')).toBeHidden();
    // Other modes: no sidebar button, but the command still works.
    await page.evaluate(() => applySettingsPatch({ mode: 'everyday' }));
    await expect(page.locator('#btn-chat')).toBeHidden();
  } finally { await m.cleanup(); }
});

test('narrow window: the conversation list collapses into a drawer', async () => {
  const m = await setup();
  try {
    const { page, app } = m;
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === 'meridian://app/index.html'); w.setSize(820, 700); });
    await openChatView(page);
    await expect.poll(() => page.evaluate(() => $('#chat-view').clientWidth)).toBeLessThan(760);
    await expect.poll(() => page.evaluate(() => $('.chat-side').getBoundingClientRect().right)).toBeLessThanOrEqual(await page.evaluate(() => $('#chat-view').getBoundingClientRect().left + 1));
    await page.locator('.chat-head [data-act="side"]').click();
    await expect(page.locator('#chat-view')).toHaveClass(/side-open/);
    await expect.poll(() => page.evaluate(() => Math.round($('.chat-side').getBoundingClientRect().left - $('#chat-view').getBoundingClientRect().left))).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#chat-view')).not.toHaveClass(/side-open/);
    await expect(page.locator('#chat-view')).toBeVisible();
  } finally { await m.cleanup(); }
});

test('private window: chats work but are never saved', async () => {
  const m = await setup();
  try {
    const { page, app } = m;
    const isPrivate = (w) => /^meridian:\/\/app\/index\.html\?private=meridian-private-/.test(w.url());
    const winPromise = app.waitForEvent('window', isPrivate);
    await page.evaluate(() => api.openWindow('private'));
    const pw = await winPromise;
    await pw.waitForFunction(() => typeof state !== 'undefined' && state && document.body.classList.contains('private'));
    await pw.evaluate(() => runCommand('open-chat'));
    await expect(pw.locator('#chat-view')).toBeVisible();
    await expect(pw.locator('#chat-page')).toBeHidden(); // never sends private pages
    await pw.locator('#chat-input').fill('private question');
    await pw.locator('#chat-input').press('Enter');
    await expect(pw.locator('.chat-msg.assistant').last().locator('.chat-md')).toContainText('You said: private question', { timeout: 15_000 });
    await expect(pw.locator('.chat-item .chat-item-title')).toHaveText(['private question']);
    await expect(pw.locator('.chat-list-empty')).toContainText('aren’t saved');
    // Main refuses the store channels from a private window even if asked directly.
    expect(await pw.evaluate(() => api.chatsSave({ id: 'x1', title: 'sneaky', messages: [] }).then(() => 'saved', () => 'refused'))).toBe('refused');
    await pw.waitForTimeout(300);
    expect(fs.existsSync(path.join(m.userDataDir, 'chats.json'))).toBe(false);
    await openChatView(page);
    await expect(page.locator('.chat-item')).toHaveCount(0);
  } finally { await m.cleanup(); }
});
