// A newcomer's first hour, on each of the "real computers" of machines.mjs: first run → moving in
// from Arc → "Yes" to the AI → the end of the tour → Boost › Improve with AI → ⌘J Ask → the
// Workbench's Claude tab → Resume → Settings › AI. At every step what Meridian says is checked
// against what is true on that machine (its truth table): no "Connected" a config file doesn't
// back, no "Not signed in" for an account that is, no "found" for a tool that isn't there, the copy
// of Claude Code that is really current, the account the person really uses.
//
//   chromium/tests/run.sh journey                      every machine
//   node --test --test-name-pattern='two-claude' journey.test.mjs
//   MERIDIAN_QG_OUT=<dir>: what each machine showed, as JSON (for the release report)
//
// Assertions that need features not merged yet are `todo` (named after the branch that brings
// them, see PENDING): they run and report, but don't fail the suite. When the branch lands, take
// its name out of PENDING and they count.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';
import { machine, machinesHere, signInClaude, MAC, WIN } from './machines.mjs';

// Features on a branch not merged into chromium-port yet. Remove a line when its PR lands.
const PENDING = {
  perSpaceSubs: 'ai-subs: AI subscriptions by the person’s names (Settings › AI), not merged yet',
  connectWithoutCli: 'ai-subs: Connect writes the config files itself (an editor extension alone connects), not merged yet',
  resumeAcrossAccounts: 'ai-subs: Resume lists the project’s sessions under every Claude account, not merged yet',
};
// Which machines have what (decided before the machines are built: `skip` needs it up front).
const MACHINES_WITH_CLAUDE = new Set(['native-and-old-on-path', 'npm-global', 'claude-code-signed-out', 'two-claude-accounts', 'run-from-disk-image']);
const MACHINES_WITH_SESSIONS_ELSEWHERE = new Set(['two-claude-accounts']);
const MACHINES_WITH_TWO_ACCOUNTS = new Set(['two-claude-accounts']);
const todo = (feature) => (PENDING[feature] ? { todo: PENDING[feature] } : {});

const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const OB = 'app.$.onboarding.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const BE = 'app.$.boostEditor.shadowRoot';
const SC = 'app.$.siteControl.shadowRoot';
const AK = 'app.$.ask.shadowRoot';
const AC = 'app.$.aiConsent.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = `<!doctype html><title>News</title><body><div id=promo style="height:120px;background:#00c">Subscribe now!</div><main><h1>Story</h1><p>Text.</p></main>`;
// The names the tour and Settings may say were found, and which truth backs each.
const TOOL_NAMES = { 'Claude Code': (t) => !!t.claudeCode, 'Claude Desktop': (t) => !!t.desktop, Codex: (t) => !!t.codex || !!t.editor?.extensions.includes('openai.chatgpt'),
  'VS Code': (t) => !!t.editor?.vscode, Copilot: (t) => !!t.editor?.extensions.includes('github.copilot'), Cursor: () => false, OpenCode: () => false, Gemini: () => false };

// ---- The truth on disk: is Meridian really in this tool's config?
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function claudeState(m) {
  const cfg = m.truth.claudeCode?.account && m.truth.claudeCode.account !== '.claude' ? path.join(m.home, m.truth.claudeCode.account) : null;
  return cfg ? path.join(cfg, '.claude.json') : path.join(m.home, '.claude.json');
}
function meridianIn(m, id) {
  const has = (servers) => servers && servers.meridian;
  switch (id) {
    case 'claude': case 'claude-code': {
      const j = readJson(claudeState(m));
      return !!j && !!(has(j.mcpServers) || Object.values(j.projects || {}).some((p) => has(p.mcpServers)));
    }
    case 'claude-desktop': return !!has(readJson(m.desktopConfig)?.mcpServers);
    case 'codex': {
      const dir = m.truth.codex?.home || path.join(m.home, '.codex');
      try { return /\[mcp_servers\.meridian\]/.test(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')); } catch { return false; }
    }
    case 'vscode': return !!has(readJson(path.join(m.vscodeUser, 'mcp.json'))?.servers);
    case 'copilot': return !!has(readJson(path.join(m.home, '.copilot', 'mcp-config.json'))?.mcpServers);
    default: return null;  // not part of these machines: whatever it says, it says "not installed"
  }
}
const installedHere = (m, id) => ({ claude: !!m.truth.claudeCode, 'claude-code': !!m.truth.claudeCode, 'claude-desktop': !!m.truth.desktop,
  codex: !!m.truth.codex || !!m.truth.editor?.extensions.includes('openai.chatgpt'), vscode: !!m.truth.editor?.vscode,
  copilot: !!m.truth.editor?.extensions.includes('github.copilot') })[id];

async function clickIn(page, expr) {
  const p = await page.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}
const termText = (i) => `(() => { const t = S.terms[${i}]; if (!t) return ''; const b = t.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('\\n'); })()`;

for (const [name, skip] of machinesHere()) {
  describe(`machine ${name}`, { skip }, () => {
    let m, b, server, url, launchArgs, seen = {};
    // A browser that crashed in one step is started again on the same profile, so the steps after
    // it still say what they see (the crash itself fails the step it happened in).
    const ensure = async () => {
      if (b && b.proc.exitCode === null && b.proc.signalCode === null) return;
      (seen.crashes ||= []).push(`browser gone (${b?.proc.exitCode ?? b?.proc.signalCode}) after: ${b?.lastAction || '?'}`);
      try { await b?.close(); } catch {}
      b = await launch([url], { profile: m.profile, env: m.env, args: launchArgs.filter((a) => a !== '--meridian-onboarding') });
      await b.waitFor(`!!app?.$?.tabstrip?.handler_`, 20000);
    };
    const truth = () => m.truth;
    const note = (k, v) => { seen[k] = v; };

    before(async () => {
      m = machine(name);
      const arc = path.join(m.root, 'Arc');
      fs.mkdirSync(arc);
      fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arc, 'StorableSidebar.json'));
      server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      url = `http://127.0.0.1:${server.address().port}/news`;
      launchArgs = [...m.args, '--meridian-onboarding', `--meridian-arc-dir=${arc}`,
        '--meridian-arc-safe-storage=test-pass', `--meridian-test-signin-log=${path.join(m.root, 'signins.log')}`,
        `--meridian-test-claude-log=${path.join(m.root, 'claude-open.log')}`, '--meridian-test-ai-consent', '--meridian-test-keys',
        '--meridian-no-notify', '--lang=en-US'];
      b = await launch([url], { profile: m.profile, env: m.env, args: launchArgs });
    });
    after(async () => {
      if (process.env.MERIDIAN_QG_OUT) {
        fs.mkdirSync(process.env.MERIDIAN_QG_OUT, { recursive: true });
        fs.writeFileSync(path.join(process.env.MERIDIAN_QG_OUT, `journey-${name}.json`), JSON.stringify({ machine: name, about: m.about, seen, runs: m.runs(), refused: m.refused() }, null, 2));
      }
      await b?.close();
      server?.close();
      m?.clean();
    });

    test('first run → moving in from Arc → the AI question names only what is really here', { timeout: 120000 }, async () => {
      await b.waitFor(`${step} === 'hello'`, 20000);
      const steps = [];
      for (let i = 0; i < 40; i++) {
        const at = await b.eval(step);
        if (!at || at === 'done') break;
        steps.push(at);
        if (at === 'arc') {
          await b.click(`${OB}.getElementById('next')`);  // Bring everything
          if (MAC) { await b.waitFor(`!!${OB}.querySelector('.confirm') || (${step}) !== 'arc'`, 15000); if (await b.eval(`!!${OB}.querySelector('.confirm')`)) await b.click(`${OB}.getElementById('confirmContinue')`); }
        } else if (at === 'ai') {
          const said = (await b.eval(`${OB}.querySelector('.step-ai').textContent`)).replace(/\s+/g, ' ');
          note('aiStep', said);
          for (const [tool, here] of Object.entries(TOOL_NAMES)) {
            if (said.includes(tool) && !here(truth())) assert.fail(`the tour says it found ${tool}, which isn't on this computer: "${said}"`);
          }
          for (const tool of ['Claude Code', 'Claude Desktop', 'Codex']) {
            if (TOOL_NAMES[tool](truth()) && tool !== 'Codex' && !said.includes(tool) && !(tool === 'Claude Code' && /\bClaude\b/.test(said))) assert.fail(`${tool} is here but the tour doesn't say so: "${said}"`);
          }
          await b.click(`${OB}.getElementById('aiYes')`);
        } else if (at === 'signin') {
          assert.equal(truth().claudeCode?.signedIn, false, 'a sign-in step for a Claude Code that is signed in');
          // The person signs in in Terminal, as they would.
          await b.click(`${OB}.getElementById('signIn')`);
          for (let k = 0; k < 50 && !fs.existsSync(path.join(m.root, 'signins.log')); k++) await sleep(100);
          note('signInCommand', fs.existsSync(path.join(m.root, 'signins.log')) ? fs.readFileSync(path.join(m.root, 'signins.log'), 'utf8').trim() : '');
          assert.ok(seen.signInCommand.includes(truth().claudeCode.path), `the sign-in runs the copy Meridian uses (${seen.signInCommand})`);
          signInClaude(truth().claudeCode.signInFile);
          truth().claudeCode.signedIn = true;
        } else if (at === 'claude') {
          await b.click(`${OB}.getElementById('restartClaude')`);
        } else {
          await b.click(`${OB}.getElementById('next')`);
        }
        await b.waitFor(`(${step}) !== ${JSON.stringify(at)}`, 45000, step);
      }
      note('steps', steps);
      assert.ok(steps.includes('arc'), `the move from Arc was offered (${steps.join(' → ')})`);
      const names = (await b.state()).spaces.map((s) => s.name);
      note('spaces', names);
      assert.deepEqual([...new Set(names.filter((n) => ['Work', 'Home'].includes(n)))].sort(), ['Home', 'Work'], 'Arc’s spaces came over');
      assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], `two spaces with the same name after moving in and the tour’s setup (${names.join(', ')})`);
      const anyAi = !!(truth().claudeCode || truth().desktop || truth().codex);
      if (anyAi) assert.ok(steps.includes('ai'), `the tour never asked about the AI that is here (${steps.join(' → ')})`);
      if (truth().claudeCode && truth().claudeCode.signedIn === false) assert.ok(steps.includes('signin'), 'signed out: the tour signs it in right there');
    });

    test('the end of the tour is honest: "ok" only where the config file really has Meridian', { timeout: 60000 }, async () => {
      await b.waitFor(`${step} === 'done'`, 30000, step);
      // The checks settle (Claude Code's is asked in the background).
      let checks = [];
      for (let i = 0; i < 40; i++) {
        checks = await b.eval(`[...${OB}.querySelectorAll('.check')].map((c) => ({ id: c.dataset.id, state: c.className.replace('check', '').trim(), text: c.textContent.replace(/\\s+/g, ' ').trim() }))`);
        if (checks.every((c) => !/checking/i.test(c.state + c.text))) break;
        await sleep(250);
      }
      note('doneChecks', checks);
      const done = (await b.eval(`${OB}.querySelector('.step-done')?.textContent || ''`)).replace(/\s+/g, ' ');
      note('doneText', done);
      for (const c of checks) {
        const backed = meridianIn(m, c.id);
        if (c.state === 'ok') {
          assert.ok(backed, `"${c.text}" says ok, but ${c.id}'s config has no Meridian`);
          if (c.id === 'claude-code') assert.ok(truth().claudeCode?.signedIn, `"${c.text}": ok for a Claude Code that isn't signed in`);
        }
        if (c.id === 'claude-desktop') assert.notEqual(c.state, 'ok', `Claude Desktop said connected before it ever started Meridian: "${c.text}"`);
        if (!installedHere(m, c.id)) assert.fail(`the summary talks about ${c.id}, which isn't here: "${c.text}"`);
      }
      if (truth().unstable) {
        // From the disk image: nothing connected to a path that goes away, and said so.
        for (const id of ['claude-code', 'claude-desktop']) assert.equal(meridianIn(m, id), false, `${id} was connected to Meridian on the disk image`);
        assert.match(done + checks.map((c) => c.text).join(' '), /download|disk image|Applications/, 'the end says to move Meridian to Applications');
      } else {
        if (truth().claudeCode) assert.equal(meridianIn(m, 'claude'), true, `Yes connected Claude Code in the account it uses (${claudeState(m)})`);
        if (truth().desktop) assert.equal(meridianIn(m, 'claude-desktop'), true, 'Yes connected Claude Desktop');
        if (truth().codex) assert.equal(meridianIn(m, 'codex'), true, `Yes connected Codex in its CODEX_HOME (${truth().codex.home})`);
      }
      if (truth().desktop?.others.length) {
        assert.deepEqual(Object.keys(readJson(m.desktopConfig).mcpServers).filter((k) => k !== 'meridian').sort(), [...truth().desktop.others].sort(), 'Claude Desktop’s own servers stay');
      }
      if (truth().codex) {
        const plain = path.join(m.home, '.codex');
        if (truth().codex.home !== plain) assert.equal(fs.existsSync(path.join(plain, 'config.toml')), false, 'Codex connected in ~/.codex instead of its CODEX_HOME');
        if (name === 'codex-only') assert.match(fs.readFileSync(path.join(truth().codex.home, 'config.toml'), 'utf8'), /\[mcp_servers\.linear\]/, 'Codex’s own servers stay');
      }
      await b.click(`${OB}.getElementById('next')`);
      await b.waitFor('!app.$.onboarding.open', 15000);
    });

    test('Boost › Improve with AI: offered with what is really here, and it works', { timeout: 60000 }, async () => {
      await ensure();
      const code = truth().claudeCode;
      // The news page is the first tab: show it.
      const tab = await b.eval(`[...app.$.tabstrip.tabs_.values()].find((t) => t.url.startsWith(${JSON.stringify(url)}))?.id`);
      if (tab !== undefined) await b.eval(`app.$.tabstrip.tabStripService_.activateTab(${JSON.stringify(tab)})`);
      await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`, 15000);
      await b.click('app.$.locationIconButton');
      await b.waitFor(`app.$.siteControl.open && !!${SC}.querySelector('#boostRow')`);
      await b.click(`${SC}.querySelector('#boostRow')`);
      await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('improveToggle')`);
      await b.eval(`${BE}.getElementById('improveToggle').click()`);
      await sleep(1500);
      const label = await b.waitFor(`${BE}.getElementById('improve')?.textContent.trim()`, 15000);
      note('improveLabel', label);
      if (!code) {
        assert.doesNotMatch(label, /Improve with Claude Code/, 'Improve offers a Claude Code that isn’t installed');
        return;
      }
      assert.equal(label, 'Improve with Claude Code');
      const before = m.runs().length;
      await b.eval(`${BE}.getElementById('improve').click()`);
      await b.waitFor(`${BE}.getElementById('note')?.textContent.includes('Hid the banner.')`, 30000, `${BE}.getElementById('note')?.textContent`);
      const run = m.runs().slice(before).find((r) => r.call === 'print');
      note('improveRun', run);
      assert.equal(run?.version, code.version, 'Improve ran the current Claude Code, not an older copy on the PATH');
      assert.equal(run?.account, code.account, 'Improve ran as the account the person uses');
      await b.eval(`app.$.boostEditor.open && app.$.boostEditor.close?.()`).catch(() => {});
      await b.key('Escape', 'Escape', 27);
    });

    test('⌘J Ask answers with what is really here, or says how to set it up; never a made-up answer', { timeout: 60000 }, async (t) => {
      await ensure();
      // ⌘J as a person presses it; a browser that dies on it is the failure, and Ask is then
      // still checked from the menu command.
      let crashedOnKey = false;
      if (MAC) {
        await b.shortcut(38, 'j').catch(() => {});
        await sleep(1500);
        if (b.proc.exitCode !== null || b.proc.signalCode !== null) { crashedOnKey = true; await ensure(); }
      }
      if (!MAC || crashedOnKey || !(await b.eval('app.$.ask.open'))) await b.eval('app.$.tabstrip.runCommand(14, 0)');
      t.after(() => { if (crashedOnKey) note('askCrash', 'Meridian crashed on ⌘J'); });
      await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`, 10000);
      const who = await b.eval(`${AK}.getElementById('who')?.textContent.replace(/\\s+/g, ' ').trim() || ''`);
      note('askWho', who);
      const canAnswer = !!truth().claudeCode || (!!truth().codex && MAC);
      if (!canAnswer) {
        const text = await b.eval(`${AK}.textContent.replace(/\\s+/g, ' ')`);
        note('askPanel', text.slice(0, 400));
        assert.doesNotMatch(who, /Claude Code/, 'Ask says Claude Code answers, but it isn’t installed');
        assert.equal(crashedOnKey, false, 'Meridian crashed on ⌘J (an uncaught NSException in the menu action: chromium/tools/test_crashes.mjs)');
        return;
      }
      await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'What is this page?'; ${AK}.getElementById('send').click(); return true; })()`);
      const answer = `[...${AK}.querySelectorAll('.msg.assistant')].pop()?.textContent || ''`;
      for (let i = 0; i < 100; i++) {
        if (await b.eval('app.$.aiConsent.open')) await b.click(`${AC}.getElementById('send')`);
        if (/Answer from/.test(await b.eval(answer))) break;
        await sleep(200);
      }
      const said = await b.eval(answer);
      note('askAnswer', said);
      if (truth().claudeCode) assert.match(said, new RegExp(`Answer from Claude Code ${truth().claudeCode.version.replace(/\./g, '\\.')} \\(${truth().claudeCode.account}\\)`), 'Ask ran the current Claude Code as the person’s account');
      else assert.match(said, /Answer from Codex .* \(\.codex-work\)|Answer from Codex/, 'Ask answered with Codex');
      await b.eval('app.$.ask.toggle()');
      assert.equal(crashedOnKey, false, 'Meridian crashed on ⌘J (an uncaught NSException in the menu action: chromium/tools/test_crashes.mjs)');
    });

    test('Workbench: the Claude Code tab runs the current copy, as the person’s account', { timeout: 60000, skip: WIN && 'the Workbench’s Claude tab on Windows: the Windows session' }, async () => {
      await ensure();
      await b.eval('app.$.tabstrip.runCommand(16, 0)');
      const wb = await b.page('chrome://workbench', 15000);
      try {
        await wb.waitFor(`!document.querySelector('#welcome')?.hidden || !!S.project`, 15000);
        if (!(await wb.eval('!!S.project'))) { await clickIn(wb, `document.querySelector('#open-folder')`); await wb.waitFor('!!S.project'); }
        await wb.waitFor(`[...document.querySelectorAll('#launcher button.launch')].some((x) => x.textContent.includes('Claude Code'))`, 15000);
        const claudeButton = `[...document.querySelectorAll('#launcher button.launch')].find((x) => x.textContent.trim() === 'Claude Code' || (x.textContent.includes('Claude Code') && !x.classList.contains('resume')))`;
        const missing = await wb.eval(`${claudeButton}.classList.contains('missing')`);
        note('workbenchClaudeMissing', missing);
        if (!truth().claudeCode) {
          assert.equal(missing, true, 'the Workbench offers a Claude Code that isn’t installed');
          return;
        }
        assert.equal(missing, false, 'the Workbench says Claude Code isn’t installed');
        await clickIn(wb, claudeButton);
        for (let i = 0; i < 50 && (await wb.eval('S.terms.length')) === 0; i++) { if (await wb.eval(`!!document.querySelector('.modal [data-a="ok"]')`)) await clickIn(wb, `document.querySelector('.modal [data-a="ok"]')`); await sleep(200); }
        await wb.waitFor(`${termText(0)}.includes('Claude Code v')`, 20000);
        const text = await wb.eval(termText(0));
        note('workbenchClaude', text.split('\n').filter(Boolean).slice(0, 4));
        assert.match(text, new RegExp(`Claude Code v${truth().claudeCode.version.replace(/\./g, '\\.')} · account ${truth().claudeCode.account.replace('.', '\\.')}`), 'the Claude tab runs the current copy as the person’s account');
        assert.doesNotMatch(text, /not signed in|refused to run/);
      } finally { wb.close(); }
    });

    test('Workbench › Resume lists the earlier sessions of this project', { timeout: 60000, skip: (WIN && 'the Workbench on Windows: the Windows session') || (!MACHINES_WITH_CLAUDE.has(name) && 'no Claude Code here') }, async () => {
      await ensure();
      const wb = await b.page('chrome://workbench', 15000);
      try {
        const n = await wb.eval('S.terms.length');
        await wb.waitFor(`!!document.querySelector('#launcher .launch.resume, .term-resume-btn')`, 15000);
        await clickIn(wb, `document.querySelector('#launcher .launch.resume, .term-resume-btn')`);
        await wb.waitFor(`S.terms.length > ${n} || /Earlier sessions|Resume/.test(document.querySelector('.modal')?.textContent || '')`, 15000);
        await sleep(1500);
        const listed = (await wb.eval(`S.terms.length > ${n} ? ${termText(n)} : ''`)) + '\n' + (await wb.eval(`document.querySelector('.modal')?.textContent || ''`));
        note('resume', listed.split('\n').filter(Boolean).slice(0, 12));
        for (const t of truth().resume.titles) assert.ok(listed.includes(t), `Resume doesn’t list "${t}" (the account the person uses)`);
        if (!truth().resume.titles.length) assert.match(listed, /No conversations|Resume/);
      } finally { wb.close(); }
    });

    // An old copy first on the PATH: `claude` typed in a plain shell tab is the current one too (its
    // folder goes first on the tab's PATH, again after zsh's startup files and macOS's path_helper).
    // Only on that machine: elsewhere the shell's PATH is the system's, where a real CLI may be.
    test('Workbench › a shell tab: `claude` typed there is the current copy', { timeout: 60000, skip: (WIN && 'the Workbench on Windows: the Windows session') || (name !== 'native-and-old-on-path' && 'one copy of Claude Code here') }, async () => {
      await ensure();
      const wb = await b.page('chrome://workbench', 15000);
      try {
        await wb.waitFor(`!document.querySelector('#welcome')?.hidden || !!S.project`, 15000);
        if (!(await wb.eval('!!S.project'))) { await clickIn(wb, `document.querySelector('#open-folder')`); await wb.waitFor('!!S.project'); }
        const n = await wb.eval('S.terms.length');
        await wb.eval(`launch('shell').then((t) => !!t)`);
        await wb.waitFor(`S.terms.length > ${n}`, 15000);
        const id = await wb.eval(`S.terms[${n}].id`);
        await sleep(1500);
        await wb.eval(`(() => { window.workbench.ptyWrite(${JSON.stringify(id)}, ${JSON.stringify('claude --version\r')}); return true; })()`);
        await wb.waitFor(`${termText(n)}.includes('(Claude Code)')`, 20000, termText(n));
        const text = await wb.eval(termText(n));
        note('workbenchShellClaude', text.split('\n').filter((l) => /Claude Code/.test(l)).slice(0, 2));
        assert.match(text, new RegExp(`${truth().claudeCode.version.replace(/\./g, '\\.')} \\(Claude Code\\)`), '`claude` in a shell tab runs the current copy');
        assert.doesNotMatch(text, /2\.0\.14 \(Claude Code\)/, 'the old copy first on the PATH ran');
      } finally { wb.close(); }
    });

    test('Workbench › Resume also lists the sessions under the person’s other Claude account', { timeout: 30000, skip: (WIN && 'the Windows session') || (!MACHINES_WITH_SESSIONS_ELSEWHERE.has(name) && 'one account here'), ...todo('resumeAcrossAccounts') }, async () => {
      const listed = JSON.stringify(seen.resume || []);
      for (const t of truth().resume.elsewhere) assert.ok(listed.includes(t), `Resume doesn’t list "${t}", a session of this project under the other account`);
    });

    test('Settings › AI: every status matches this computer (no false "Connected", "Not signed in", "Not installed")', { timeout: 60000 }, async () => {
      await ensure();
      await b.eval('app.$.tabstrip.runCommand(13, 0)');
      await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="ai"]')`, 15000);
      await b.eval(`${ST}.querySelector('[data-id="ai"]').click()`);
      await b.waitFor(`!!${ST}.getElementById('aiRows') || !!${ST}.getElementById('ai-claude-code')`, 15000);
      // Statuses settle: "Checking…" is fine while it lasts, never afterwards.
      let rows = {}, connect = {};
      for (let i = 0; i < 60; i++) {
        rows = await b.eval(`Object.fromEntries([...${ST}.querySelectorAll('[id^="ai-"]')].map((r) => [r.id.slice(3), r.textContent.replace(/\\s+/g, ' ').trim()]))`);
        connect = await b.eval(`Object.fromEntries([...${ST}.querySelectorAll('[id^="connect-"]')].filter((r) => r.dataset.state !== undefined).map((r) => [r.id.slice(8), r.dataset.state]))`);
        if (Object.keys(connect).length && !Object.values(rows).some((t) => /Checking/.test(t))) break;
        await sleep(250);
      }
      note('settingsRows', rows);
      note('settingsConnect', connect);
      const code = rows['claude-code'] || '';
      const t = truth().claudeCode;
      // Not here: no row, or one that says so (never Ready, Signed in…).
      if (!t) assert.ok(!code || /Not installed/.test(code), `Claude Code isn’t here: "${code}"`);
      else {
        assert.doesNotMatch(code, /Not installed/, `Claude Code is here: "${code}"`);
        if (t.signedIn) assert.doesNotMatch(code, /Not signed in|Needs sign-in|Update needed/, `Claude Code is signed in: "${code}"`);
        else assert.match(code, /Not signed in|Needs sign-in/);
      }
      if (truth().codex && MAC) assert.doesNotMatch(rows.codex || '', /Not installed|Not signed in/, `Codex is here and signed in: "${rows.codex}"`);
      if (!truth().codex && !truth().editor) assert.match(rows.codex || 'Not installed', /Not installed|macOS only/, `no Codex here: "${rows.codex}"`);
      for (const [id, state] of Object.entries(connect)) {
        const backed = meridianIn(m, id);
        if (/^Connected/.test(state)) assert.ok(backed, `Settings › Connect says ${id} is "${state}", but its config has no Meridian`);
        if (state === 'Not installed' && installedHere(m, id) && id !== 'vscode' && id !== 'copilot') assert.fail(`Settings › Connect says ${id} is not installed, but it is here`);
        if (installedHere(m, id) === false && backed === false && /^Connected/.test(state)) assert.fail(`${id}: Connected without being here`);
      }
      // The copy Meridian runs is the current one; an older one is mentioned, never used.
      if (t) {
        const p = (await b.eval(`${H}.getAiProviders(true)`)).providers.find((x) => x.id === 'claude-code');
        note('provider', { path: p.path, signedIn: p.signedIn, copiesNote: p.copiesNote, needsUpdate: p.needsUpdate });
        assert.equal(p.path, t.path, 'Meridian runs the current copy of Claude Code');
        assert.equal(p.signedIn, 1);
      }
    });

    test('Settings › AI: each Claude subscription by its own name, each signed in as it is', { timeout: 30000, skip: !MACHINES_WITH_TWO_ACCOUNTS.has(name) && 'one account here', ...todo('perSpaceSubs') }, async () => {
      const text = await b.eval(`${ST}.textContent.replace(/\\s+/g, ' ')`);
      note('settingsAccounts', text.match(/Claude[^.]{0,200}/g)?.slice(0, 6));
      assert.match(text, /Claude Personal|Personal Claude/);
      assert.match(text, /~\/\.claude\b/);
      assert.doesNotMatch(text, /\bDefault\b/);
    });

    test('Settings › Connect: an editor extension alone can be connected, by writing its config', { timeout: 30000, skip: name !== 'editor-extension-only' && 'no editor extension here', ...todo('connectWithoutCli') }, async () => {
      const vs = await b.eval(`${ST}.getElementById('connect-vscode')?.dataset.state`);
      note('vscodeConnect', vs);
      assert.notEqual(vs, 'Not installed', 'VS Code (found by its Copilot extension) shows as not installed');
      await b.eval(`${ST}.querySelector('#connect-vscode .btn')?.click()`);
      await b.waitFor(`/^Connected/.test(${ST}.getElementById('connect-vscode')?.dataset.state || '')`, 15000);
      assert.equal(meridianIn(m, 'vscode'), true, 'VS Code’s mcp.json has Meridian');
    });

    test('no stand-in ever saw a path outside the test home', () => {
      assert.deepEqual(m.refused(), []);
    });
  });
}

