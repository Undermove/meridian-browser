// "Try with Claude" for someone who isn't a developer (a designer with Claude for Mac): the first
// run moves Arc in, connects Claude, explains its restart and its "Allow", then offers the cards;
// the same cards on the home page and from ⌘T. Claude itself is never opened: the test switch
// records the request instead (--meridian-test-claude-log), and Claude's config is a temp file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launch, APP, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const OB = 'app.$.onboarding.shadowRoot';
const HM = 'app.$.home.shadowRoot';
const TC = 'app.$.tryClaude.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
// Words a designer should never meet.
const DEV_WORDS = /Workbench|Mission Control|MCP|server|config|terminal|Connect\b|CLI/;

// A temp "computer": Claude's config folder (Claude for Mac is installed when it's there), no CLIs,
// and the file the test switch writes Claude's links to.
function computer({ claude = true, connected = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-showcase-'));
  const bin = path.join(dir, 'bin');
  const empty = path.join(dir, 'none');
  const claudeDir = path.join(dir, 'Claude');
  for (const d of [bin, empty]) fs.mkdirSync(d);
  const config = path.join(claudeDir, 'claude_desktop_config.json');
  if (claude) {
    fs.mkdirSync(claudeDir);
    fs.writeFileSync(config, JSON.stringify(connected ? { mcpServers: { meridian: { command: 'x', args: ['--mcp-bridge'] } } } : {}));
  }
  const log = path.join(dir, 'claude-links.log');
  const args = [`--meridian-chrome-dir=${empty}`, `--meridian-agents-path=${bin}`,
    `--meridian-claude-desktop-config=${config}`, `--meridian-test-claude-log=${log}`,
    '--meridian-test-persona=designer', '--meridian-test-ai-consent', '--lang=en-US'];
  return {
    dir, config, log, args, empty,
    // The requests Claude was opened with, in order ('' for a plain start).
    requests() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
          .map((l) => (l.startsWith('claude://claude.ai/new?q=') ? decodeURIComponent(l.slice('claude://claude.ai/new?q='.length)) : ''));
    },
    clean() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}

const tabUrls = (b) => b.eval(`[...app.$.tabstrip.tabs_.values()].map((t) => t.pendingUrl || t.url)`);
const cardTitles = (root) => `[...${root}.querySelector('meridian-showcase').shadowRoot.querySelectorAll('.card b')].map((e) => e.textContent.trim())`;
const card = (root, id) => `${root}.querySelector('meridian-showcase').shadowRoot.querySelector('.card[data-id="${id}"]')`;
const TITLES = ['Give this site a new look', 'Find design trends on Pinterest', 'Critique this page like a senior designer', 'Tidy my tabs', 'What else can Meridian do?'];

test('designer first run: Arc first, "We found Claude", its restart and Allow explained, then the cards; a card readies the page and opens Claude with the request', async () => {
  const c = computer();
  const arcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-arc-'));
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arcDir, 'StorableSidebar.json'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch(['about:blank'], { profile, args: ['--meridian-onboarding', `--meridian-arc-dir=${arcDir}`, ...c.args] });
  try {
    await b.waitFor(`${step} === 'hello'`);
    await b.click(`${OB}.getElementById('next')`);
    // Moving in comes first, with the real counts.
    await b.waitFor(`${step} === 'arc'`, 10000);
    assert.deepEqual(await b.eval(`[...${OB}.querySelectorAll('.arc-stats b')].map((e) => e.textContent.trim())`), ['2 spaces', '5 tabs', '3 favorites']);
    assert.equal(await b.eval(`${OB}.getElementById('next').textContent.trim()`), 'Bring everything');
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${step} === 'ai'`, 15000);
    assert.deepEqual((await b.state()).spaces.map((s) => s.name), ['Work', 'Home']);
    const found = await b.eval(`${OB}.querySelector('.step-ai').textContent.replace(/\\s+/g, ' ')`);
    assert.match(found, /We found Claude on your computer/);
    assert.match(found, /Claude Desktop/);
    assert.doesNotMatch(found, DEV_WORDS);
    assert.deepEqual(c.requests(), [], 'nothing opened yet');
    await b.click(`${OB}.getElementById('aiYes')`);

    // Before Claude restarts: what will happen, and what its question looks like.
    await b.waitFor(`${step} === 'claude'`, 15000);
    assert.ok(JSON.parse(fs.readFileSync(c.config, 'utf8')).mcpServers.meridian, 'Claude has Meridian');
    assert.equal((await b.eval(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings)`)).agentAccess, 'ask');
    const explained = await b.eval(`${OB}.querySelector('.claude-step').textContent.replace(/\\s+/g, ' ')`);
    assert.match(explained, /Claude needs a quick restart/);
    assert.match(explained, /asks for permission\. Click Allow/);
    assert.doesNotMatch(explained, DEV_WORDS);
    assert.match(await b.eval(`${OB}.querySelector('meridian-allow-mock').shadowRoot.textContent.replace(/\\s+/g, ' ')`), /Allow Claude to use Meridian\?.*Deny\s*Allow/);
    assert.equal(await b.eval(`${OB}.getElementById('next').hidden`), true, 'one button: Restart Claude');
    await b.click(`${OB}.getElementById('restartClaude')`);

    // The cards.
    await b.waitFor(`${step} === 'try'`, 10000);
    assert.deepEqual(c.requests(), [''], 'Claude started (in the background), no request yet');
    await b.waitFor(`${cardTitles(OB)}.length === 5`);
    assert.deepEqual(await b.eval(cardTitles(OB)), TITLES);
    assert.doesNotMatch(await b.eval(`${OB}.querySelector('.page').textContent`), DEV_WORDS);
    // "Give this site a new look" on an empty tab: a plain page first, then Claude.
    await b.click(card(OB, 'restyle'));
    await b.waitFor(`!app.$.onboarding.open`);
    assert.ok(await until(async () => (await tabUrls(b)).includes('https://info.cern.ch/hypertext/WWW/TheProject.html')), 'the page to restyle is open');
    assert.ok(await until(() => c.requests().length === 2), 'Claude opened with the request');
    const asked = c.requests()[1];
    assert.match(asked, /^In Meridian, give the page in my current tab a fresh new look\./);
    assert.match(asked, /Meridian Boost/);
    assert.match(asked, /say "undo" to put it back/);
    await b.waitFor(`app.$.tryClaude.mode === 'sent'`);
    assert.match(await b.eval(`${TC}.getElementById('sent').textContent.replace(/\\s+/g, ' ')`), /Over to Claude.*Press Enter there, then Allow/);

    // Nothing for developers anywhere a designer looks.
    assert.equal(await b.eval(`app.$.tabstrip.developer`), false);
    assert.equal(await b.eval(`app.$.commandBar.developer`), false);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(arcDir, { recursive: true, force: true }); c.clean(); }
});

test('home page and ⌘T: every card readies its scene and opens Claude with its own request', async () => {
  const c = computer({ connected: true });
  const site = await startServer();
  const b = await launch(['chrome://newtab/'], { args: c.args });
  try {
    await b.waitFor(`app.$.home.shown && !!${HM}.getElementById('tryClaude')`, 15000);
    // A designer's home: Try with Claude, no Workbench, no developer card.
    await b.waitFor(`${cardTitles(HM)}.length === 5`);
    assert.deepEqual(await b.eval(cardTitles(HM)), TITLES);
    assert.equal(await b.eval(`!!${HM}.querySelector('.quick-act[data-action="workbench"]')`), false);
    assert.deepEqual(await b.eval(`[...${HM}.querySelectorAll('.cards > .card')].map((x) => x.dataset.card)`), ['everyday', 'designer', 'manager']);
    assert.doesNotMatch(await b.eval(`${HM}.getElementById('scroller').textContent`), DEV_WORDS);

    // Critique, from an empty tab: a page to critique first.
    await b.eval(`${card(HM, 'critique')}.scrollIntoView({ block: 'center' })`);
    await b.click(card(HM, 'critique'));
    assert.ok(await until(async () => (await tabUrls(b)).includes('https://news.ycombinator.com/')), 'a page to critique');
    assert.ok(await until(() => c.requests().length === 1));
    assert.match(c.requests()[0], /critique it like a senior product designer: give me 5 concrete suggestions/);
    assert.match(c.requests()[0], /Don’t change anything on the page\./);

    // On a real site, restyle keeps it: no page opened for it.
    await b.eval(`app.$.tabstrip.openUrl(${JSON.stringify(site.url('/p/Studio'))})`);
    await b.waitFor(`app.$.tabstrip.activeUrl().includes('/p/Studio')`, 10000);
    const before = (await tabUrls(b)).length;
    await b.eval(`app.$.tryClaude.run('restyle', '')`);
    assert.ok(await until(() => c.requests().length === 2));
    assert.match(c.requests()[1], /Meridian Boost/);
    assert.equal((await tabUrls(b)).length, before, 'no new tab');

    // ⌘T: "try" finds Try with Claude… first; Return shows the cards.
    await b.eval(`app.showCommandBar_(false, '')`);
    await b.waitFor(`app.$.commandBar.open`);
    await b.waitFor(`app.$.commandBar.$.address.shadowRoot.querySelector('cr-searchbox-input')`);
    await b.waitFor(`app.$.commandBar.$.address.matches(':focus-within')`);
    await b.type('try');
    await b.key('y', 'KeyY', 89);
    await b.waitFor(`app.$.commandBar.featureRows_.length > 0`);
    assert.equal(await b.eval(`app.$.commandBar.featureRows_[0].name`), 'Try with Claude…');
    assert.ok(!(await b.eval(`app.$.commandBar.featureRows_.map((f) => f.id)`)).some((id) => id === 'workbench' || id === 'mission'));
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!app.$.commandBar.open && app.$.tryClaude.mode === 'sheet'`);
    await b.waitFor(`${cardTitles(TC)}.length === 5`);
    // The moodboard with a topic of one's own.
    await b.eval(`(() => { const i = ${card(TC, 'moodboard')}.querySelector('input'); i.value = 'editorial typography'; i.dispatchEvent(new Event('input')); })()`);
    await b.click(card(TC, 'moodboard'));
    assert.ok(await until(() => c.requests().length === 3));
    assert.match(c.requests()[2], /open Pinterest in a new tab and search for "editorial typography"\. Pick 6/);
    assert.match(c.requests()[2], /pin them all into a new folder called "Moodboard"/);
    assert.equal(await b.eval(`app.$.tryClaude.mode`), 'sent');

    // Tidy and the guide.
    await b.eval(`app.$.tryClaude.showCards()`);
    await b.waitFor(`${cardTitles(TC)}.length === 5`);
    await b.click(card(TC, 'tidy'));
    assert.ok(await until(() => c.requests().length === 4));
    assert.match(c.requests()[3], /change nothing until I say yes/);
    await b.eval(`app.$.tryClaude.showCards()`);
    await b.waitFor(`${cardTitles(TC)}.length === 5`);
    await b.click(card(TC, 'guide'));
    assert.ok(await until(() => c.requests().length === 5));
    assert.match(c.requests()[4], /Use Meridian’s guide to tell me what Meridian can do/);
    assert.match(c.requests()[4], /suggest three things I could try right now/);
  } finally { await b.close(); await site.close(); c.clean(); }
});

test('Claude open since before Meridian was added: the restart is explained first; not connected yet: a card connects it', async () => {
  const c = computer({ connected: false });
  const b = await launch(['chrome://newtab/'], { args: [...c.args, '--meridian-test-claude-needs-restart'] });
  try {
    await b.waitFor(`app.$.home.shown && !!${HM}.getElementById('tryClaude')`, 15000);
    await b.waitFor(`${cardTitles(HM)}.length === 5`);
    await b.eval(`${card(HM, 'guide')}.scrollIntoView({ block: 'center' })`);
    await b.click(card(HM, 'guide'));
    await b.waitFor(`app.$.tryClaude.mode === 'restart'`, 10000);
    assert.ok(JSON.parse(fs.readFileSync(c.config, 'utf8')).mcpServers.meridian, 'connected by the card');
    const said = await b.eval(`${TC}.querySelector('.card').textContent.replace(/\\s+/g, ' ')`);
    assert.match(said, /Claude needs a quick restart/);
    assert.match(said, /Click Allow/);
    assert.doesNotMatch(said, DEV_WORDS);
    assert.deepEqual(c.requests(), [], 'nothing until the person agrees');
    await b.click(`${TC}.getElementById('restartGo')`);
    assert.ok(await until(() => c.requests().length === 1));
    assert.match(c.requests()[0], /Meridian’s guide/);
  } finally { await b.close(); c.clean(); }
});

test('no Claude on this computer: an honest way to get it, and Ask instead, no dead end', async () => {
  const c = computer({ claude: false });
  const b = await launch(['chrome://newtab/'], { args: c.args });
  try {
    await b.waitFor(`app.$.home.shown && !!${HM}.getElementById('tryClaude')`, 15000);
    const S = `${HM}.querySelector('meridian-showcase').shadowRoot`;
    await b.waitFor(`!!${S}.getElementById('getClaude')`);
    assert.match(await b.eval(`${S}.textContent.replace(/\\s+/g, ' ')`), /Get Claude for Mac.*Ask about this page/);
    // ⌘T's Try with Claude… says the same.
    await b.eval(`app.onCommandBarFeature_({ detail: 'try-claude' })`);
    await b.waitFor(`!!${TC}.querySelector('meridian-showcase')?.shadowRoot.getElementById('askInstead')`);
    await b.click(`${TC}.querySelector('meridian-showcase').shadowRoot.getElementById('askInstead')`);
    await b.waitFor(`app.$.ask.hasAttribute('open') && app.$.tryClaude.mode === ''`);
    // A card run anyway (from an old page): the sheet, never a silent nothing.
    await b.eval(`app.$.tryClaude.run('tidy', '')`);
    await b.waitFor(`app.$.tryClaude.mode === 'sheet'`);
    assert.deepEqual(c.requests(), []);
  } finally { await b.close(); c.clean(); }
});

// ---- Claude's side, over the bridge: the guide, and a Moodboard folder of pinned tabs.
function profileWith(meridian) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(dir, 'Default'));
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ meridian }));
  return dir;
}

function bridge(profile) {
  const proc = spawn(APP, ['--mcp-bridge', `--user-data-dir=${profile}`], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let next = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  const request = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = (await request('tools/call', { name, arguments: args })).result;
    const c = r.content[0];
    const parse = (t) => { try { return JSON.parse(t); } catch { return t; } };
    return { error: r.isError ? c.text : null, value: c.type === 'text' && !r.isError ? parse(c.text) : null };
  };
  return { request, call, close: () => proc.kill() };
}

test('meridian_guide answers over the bridge (read-only access is enough); organize_tab pins into a Moodboard folder', async () => {
  const site = await startServer();
  const profile = profileWith({ agent_access: 'read' });
  const b = await launch([site.url('/p/One'), site.url('/p/Two')], { profile });
  let mcp = bridge(profile);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    for (let i = 0; i < 50 && !fs.existsSync(path.join(profile, 'Meridian Agent.json')); i++) await sleep(100);
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude', version: '1' }, capabilities: {} });
    const tools = (await mcp.request('tools/list')).result.tools;
    const def = tools.find((t) => t.name === 'meridian_guide');
    assert.ok(def, 'listed');
    assert.match(def.description, /what the Meridian browser can do/);
    assert.ok(tools.find((t) => t.name === 'organize_tab').inputSchema.properties.folder, 'organize_tab takes a folder');
    const guide = await mcp.call('meridian_guide');
    assert.equal(guide.error, null);
    const text = guide.value.guide;
    for (const line of [/SPACES/, /Ctrl\+1 to Ctrl\+9/, /Cmd\+D pins a tab/, /Little Window/, /Split view: Ctrl\+Shift\+=/, /Peek/, /BOOST/, /Cmd\+T/, /Cmd\+J/, /Import from Arc/, /Workbench \(Shift\+Cmd\+E\)/]) {
      assert.match(text, line);
    }
    // Read-only access can't pin.
    const tabs = (await mcp.call('list_tabs')).value.filter((t) => t.zone === 'today');
    assert.match((await mcp.call('organize_tab', { tab_id: tabs[0].id, action: 'pin', folder: 'Moodboard' })).error || '', /read-only/);
    mcp.close();
    await b.close();

    // Full access: both tabs go into one new Moodboard folder, on top of the space's pinned tabs.
    const prefs = path.join(profile, 'Default', 'Preferences');
    const p = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    p.meridian = { ...(p.meridian || {}), agent_access: 'full' };
    fs.writeFileSync(prefs, JSON.stringify(p));
    const b2 = await launch([site.url('/p/One'), site.url('/p/Two')], { profile });
    try {
      await b2.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 2`);
      mcp = bridge(profile);
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'Claude', version: '1' }, capabilities: {} });
      const today = (await mcp.call('list_tabs')).value.filter((t) => t.zone === 'today');
      for (const t of today.slice(0, 2)) {
        const r = await mcp.call('organize_tab', { tab_id: t.id, action: 'pin', folder: 'Moodboard' });
        assert.equal(r.error, null, r.error);
        assert.equal(r.value.folder, 'Moodboard');
      }
      await b2.waitFor(`(() => { const s = app.$.tabstrip.state_; const sp = s.spaces.find((x) => x.id === s.activeSpaceId); const f = sp.pinned[0]; return f && f.isFolder && f.title === 'Moodboard' && f.children.length === 2; })()`, 10000);
      const pinned = await b2.pinned();
      assert.deepEqual(pinned.filter((r) => r.folder).map((r) => r.title), ['Moodboard'], 'one folder, made once');
    } finally { await b2.close(); }
  } finally { mcp.close(); await b.close(); await site.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
