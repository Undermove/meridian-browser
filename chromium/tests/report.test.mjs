// "Send a report": the sheet from Settings › General, ⌘T and an AI error shows everything the
// report contains before anything leaves (versions, Settings › AI, the agents found with their
// --version, Meridian's recent errors) and never a tab's address, a key or the home folder. Copy
// puts the Markdown on the clipboard, Save writes it (to a test file here), and the GitHub issue
// opens prefilled and short with the whole report on the clipboard. The AI is a stand-in Ollama
// that fails; the only agent is a stand-in `opencode`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const RP = 'app.$.report.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const AK = 'app.$.ask.shadowRoot';
const H = 'app.$.tabstrip.handler_';
const MAC = process.platform === 'darwin';
// Planted where a careless report would pick them up.
const KEY = 'sk-ant-api03-PLANTEDfakeKEY0123456789abcdefXYZ';
const TAB = 'https://example.invalid/private-tab-PLANTED?account=42';
const HOME = os.homedir();

// A stand-in Ollama with a model that always fails, saying too much.
function failingOllama() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `model crashed loading ${path.join(HOME, 'models', 'llama.gguf')} with key ${KEY} for ${TAB}` }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const sheetText = (b) => b.eval(`app.$.report.open ? ${RP}.querySelector('.sheet').textContent.replace(/\\s+/g, ' ') : ''`);
const details = (b) => b.eval(`${RP}.getElementById('details')?.value || ''`);

function assertPrivate(text, what) {
  assert.ok(!text.includes(KEY), `${what}: no key`);
  assert.ok(!text.includes('sk-ant'), `${what}: no key prefix`);
  assert.ok(!text.includes('example.invalid'), `${what}: no tab address`);
  assert.ok(!text.includes('PLANTED'), `${what}: nothing planted`);
  assert.ok(!text.includes(HOME), `${what}: no home folder`);
}

test('Send a report: from Settings, ⌘T and an Ask error; shows versions, AI state and errors, never a tab address or a key; Copy, Save and GitHub', async () => {
  const ollama = await failingOllama();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-report-'));
  const bin = path.join(dir, 'bin');
  const opencodeConfig = path.join(dir, 'opencode');
  fs.mkdirSync(bin);
  fs.mkdirSync(opencodeConfig);
  standIn(bin, 'opencode', `if (process.argv[2] === '--version') { console.log('0.15.2-standin'); } else { process.exit(1); }`);
  const saved = path.join(dir, 'saved-report.md');
  const clipboard = MAC ? execFileSync('pbpaste') : null;  // the person's clipboard comes back afterwards
  const b = await launch([TAB], {
    args: [`--meridian-agents-path=${bin}`, `--meridian-opencode-config=${opencodeConfig}`,
      `--meridian-ollama-url=${ollama.base}`, `--meridian-test-save-report=${saved}`, '--lang=en-US'],
  });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Ollama answers Ask (Settings › AI), and fails.
    await b.waitFor(`${H}.getAiProviders(true).then(({providers}) => providers.some((p) => p.id === 'ollama' && p.installed))`, 15000);
    await b.eval(`${H}.getSettings().then(({settings}) => ${H}.setSettings({...settings, aiProvider: 'ollama', agentAccess: 'ask'}))`);
    await b.waitFor(`${H}.getSettings().then(({settings}) => settings.aiProvider === 'ollama')`);
    await b.eval('app.$.tabstrip.runCommand(14, 0)');
    await b.waitFor(`app.$.ask.open && !!${AK}.getElementById('input')`);
    await b.eval(`(() => { const i = ${AK}.getElementById('input'); i.value = 'what is on this page?'; ${AK}.getElementById('send').click(); })()`);
    await b.waitFor(`!!${AK}.querySelector('.msg.assistant .error .report-link')`, 20000);

    // 1. By the error: the sheet, with that error and everything else in it.
    const shownError = await b.eval(`${AK}.querySelector('.msg.assistant .error').firstChild.textContent.trim()`);
    await b.click(`${AK}.querySelector('.msg.assistant .error .report-link')`);
    await b.waitFor(`app.$.report.open && !!${RP}.getElementById('details')`, 20000);
    let text = await details(b);
    assert.match(text, /## Where it was sent from\n- an error in the Ask panel/);
    assert.ok(text.includes('- The error shown: '), text);
    assert.match(text, /- Version: Meridian \d+\.\d+\.\d+ \(Chromium [\d.]+\)/);
    assert.match(text, new RegExp(`- System: ${MAC ? 'macOS' : process.platform === 'win32' ? 'Windows' : ''}[^\\n]*, (arm64|x86_64|x86|aarch64)`));
    assert.match(text, /- Ask and Chat answer with: Ollama/);
    assert.match(text, /- Agent access: Ask before each action/);
    assert.match(text, /- Ollama \(local\): installed, model llama3\.2/);
    assert.match(text, /- OpenCode: found, version 0\.15\.2-standin/);
    assert.match(text, /## Recent errors/);
    assert.match(text, /ask: Ask panel \(ollama\): /);
    assert.match(text, /provider: Ollama answered HTTP 500: /);
    // What the error said, with what is private taken out.
    assert.ok(text.includes('model crashed loading ~/models/llama.gguf with key [hidden] for [link]'), text);
    assertPrivate(text, 'details');
    assert.ok(shownError.length > 0);
    const sheet = await sheetText(b);
    assert.match(sheet, /What happened\?/);
    assert.match(sheet, /Never included: your tabs or their addresses, page contents, history, cookies, passwords, API keys or tokens, file contents, or your name and email\. Your home folder shows as ~\./);
    assert.match(sheet, /Nothing is sent by itself\./);
    assert.deepEqual(await b.eval(`[...${RP}.querySelectorAll('.actions button')].map((x) => x.textContent.trim())`),
      ['Open an issue on GitHub', 'Save as file…', 'Copy report']);

    // The person's words, with a key pasted by mistake: scrubbed before it leaves, and the box
    // shows what left.
    await b.eval(`(() => { const t = ${RP}.getElementById('happened'); t.value = 'Ollama fails on every question. My key is ${KEY}'; t.dispatchEvent(new Event('input')); })()`);
    await b.click(`${RP}.getElementById('copy')`);
    await b.waitFor(`${RP}.getElementById('done')?.textContent.includes('Copied')`);
    const report = await b.eval('app.$.report.lastReport');
    assert.match(report, /^# Meridian report\n\n## What happened\nOllama fails on every question\. My key is \[hidden\]\n/);
    assert.ok(report.includes('## Settings › AI'));
    assertPrivate(report, 'copied report');
    assert.equal(await b.eval(`${RP}.getElementById('happened').value`), 'Ollama fails on every question. My key is [hidden]');
    if (MAC) assert.equal(execFileSync('pbpaste').toString(), report, 'the Markdown is on the clipboard');

    // An edit in the details is what leaves.
    await b.eval(`(() => { const t = ${RP}.getElementById('details'); t.value = t.value.replace('## Updates', '## Updates (edited)'); t.dispatchEvent(new Event('input')); })()`);
    await b.click(`${RP}.getElementById('save')`);
    await b.waitFor(`${RP}.getElementById('done')?.textContent.includes('Saved')`);
    const file = fs.readFileSync(saved, 'utf8');
    assert.ok(file.includes('## Updates (edited)'));
    assert.ok(file.startsWith('# Meridian report'));
    assertPrivate(file, 'saved file');

    // GitHub: a short, prefilled issue; the whole report on the clipboard.
    const tabsBefore = await b.eval(`${SB}.querySelectorAll('meridian-tab-row').length`);
    await b.click(`${RP}.getElementById('issue')`);
    await b.waitFor(`app.$.report.lastIssueUrl !== ''`);
    const url = await b.eval('app.$.report.lastIssueUrl');
    assert.ok(url.startsWith('https://github.com/Undermove/meridian-browser/issues/new?title='), url);
    assert.ok(url.length <= 2000, `short: ${url.length}`);
    const params = new URL(url).searchParams;
    assert.equal(params.get('title'), 'Ollama fails on every question. My key is [hidden]');
    assert.match(params.get('body'), /\*\*What happened\*\*\nOllama fails/);
    assert.match(params.get('body'), /Meridian \d+\.\d+\.\d+ · /);
    assert.match(params.get('body'), /it’s on your clipboard\. Paste it below\./);
    assert.ok(!params.get('body').includes('## Recent errors'), 'the details stay on the clipboard');
    assertPrivate(url, 'issue address');
    // (GitHub may send someone signed out to its login first, with the issue to come back to.)
    await b.waitFor(`[...app.$.tabstrip.tabs_.values()].some((t) => { const u = t.pendingUrl || t.url; return u.startsWith('https://github.com/Undermove/meridian-browser/issues/new') || u.includes(encodeURIComponent('/Undermove/meridian-browser/issues/new')); })`);
    assert.ok(await b.eval(`${SB}.querySelectorAll('meridian-tab-row').length`) > tabsBefore);
    if (MAC) assert.ok(execFileSync('pbpaste').toString().includes('## Recent errors'), 'the full report is on the clipboard');
    await b.waitFor(`${RP}.getElementById('done')?.textContent.includes('paste it into the issue')`);
    await b.eval('app.$.report.close()');

    // A very long story still makes a short address.
    const long = await b.eval(`import('./meridian/report.js').then((m) => m.issueUrl('x'.repeat(5000) + ' ' + 'y'.repeat(3000), '1.1.0', 'macOS 26.2, arm64'))`);
    assert.ok(long.length <= 2000, `long: ${long.length}`);
    assert.match(decodeURIComponent(new URL(long).searchParams.get('body')), /x…/);

    // 2. Settings › General › Help.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id="general"]')`);
    await b.eval(`${ST}.querySelector('[data-id="general"]').click()`);
    await b.waitFor(`!!${ST}.getElementById('sendReport')`);
    assert.equal(await b.eval(`${ST}.getElementById('sendReport').textContent.trim()`), 'Send a report…');
    await b.eval(`${ST}.getElementById('sendReport').scrollIntoView({ block: 'center' })`);
    await b.click(`${ST}.getElementById('sendReport')`);
    await b.waitFor(`app.$.report.open && !!${RP}.getElementById('details')`, 20000);
    text = await details(b);
    assert.match(text, /## Where it was sent from\n- Settings\n/);
    assert.match(text, /- Version: Meridian /);
    assert.ok(!text.includes('The error shown'));
    assertPrivate(text, 'from Settings');
    await b.key('Escape', 'Escape', 27);
    await b.waitFor('!app.$.report.open');
    await b.eval('app.$.settings.hide()');

    // 3. ⌘T: "report" finds Send a report…; Return opens the sheet.
    await b.eval(`app.showCommandBar_(false, '')`);
    await b.waitFor(`app.$.commandBar.open`);
    await b.waitFor(`app.$.commandBar.$.address.shadowRoot.querySelector('cr-searchbox-input')`);
    await b.waitFor(`app.$.commandBar.$.address.matches(':focus-within')`);
    await b.type('repor');
    await b.key('t', 'KeyT', 84);
    await b.waitFor(`app.$.commandBar.featureRows_.length > 0`);
    assert.equal(await b.eval(`app.$.commandBar.featureRows_[0].name`), 'Send a report…');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!app.$.commandBar.open && app.$.report.open && !!${RP}.getElementById('details')`, 20000);
    assert.match(await details(b), /## Where it was sent from\n- the command bar\n/);
    await b.click(`${RP}.getElementById('close')`);
    await b.waitFor('!app.$.report.open');

    // 4. The command bar's Ask and Chat errors have the link too.
    await b.eval(`app.showCommandBar_(false, '')`);
    await b.waitFor(`app.$.commandBar.open`);
    await b.eval(`app.$.commandBar.askError_ = 'Ollama couldn’t answer.'`);
    await b.waitFor(`!!app.$.commandBar.shadowRoot.querySelector('.error .report-link')`);
    await b.click(`app.$.commandBar.shadowRoot.querySelector('.error .report-link')`);
    await b.waitFor(`!app.$.commandBar.open && app.$.report.open && !!${RP}.getElementById('details')`, 20000);
    assert.match(await details(b), /- an error in the command bar’s Ask\n- The error shown: Ollama couldn’t answer\./);
    await b.eval('app.$.report.close()');
    await b.eval(`app.$.chat.fire('meridian-report', {from: 'chat', error: 'Chat failed'})`);
    await b.waitFor(`app.$.report.open && !!${RP}.getElementById('details')`, 20000);
    assert.match(await details(b), /- an error in Chat\n- The error shown: Chat failed/);
    await b.eval('app.$.report.close()');
  } finally {
    await b.close();
    if (clipboard !== null) execFileSync('pbcopy', { input: clipboard });
    ollama.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
