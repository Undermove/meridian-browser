// Windows parity: no Mac-only words where Windows users read. On 26.11 a Windows user moving in
// from Chrome was shown the Mac's Keychain card. Two checks:
//   - the lint (tools/lint_platform_words.mjs) over the shared UI sources: every Mac-only word is
//     behind a Mac check;
//   - the welcome tour (moving in from Arc and from Chrome, the AI question) and every section of
//     Settings, as a person sees them: on Windows the visible text, tooltips and placeholders hold
//     no Keychain, "your Mac", ⌘, Finder, "Applications folder"… On macOS the same walk runs with a
//     Windows user agent, so the UI takes its Windows branches (the C++ still says what the Mac
//     build says, so there it only reports: todo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './harness.mjs';
import { machine } from './machines.mjs';
import { lint, WORDS } from '../tools/lint_platform_words.mjs';

const WIN = process.platform === 'win32';
const ARC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/arc');
const OB = 'app.$.onboarding.shadowRoot';
const ST = 'app.$.settings.shadowRoot';
const step = `app.$.onboarding.open && ${OB}.getElementById('root').dataset.step`;
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36';

// What a person can read in the browser UI right now: visible text, tooltips, placeholders, labels.
const VISIBLE = `(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) out.push(n.textContent.trim());
      for (const a of ['title', 'placeholder', 'aria-label']) if (el.getAttribute?.(a)) out.push(el.getAttribute(a));
    }
  };
  walk(document);
  return [...new Set(out)];
})()`;
const macWords = (texts) => texts.flatMap((t) => WORDS.filter(([re]) => re.test(t)).map(([, w]) => `"${w}" in: ${t.slice(0, 120)}`));

test('lint: every Mac-only word in the shared UI sources is behind a Mac check', (t) => {
  const src = path.join(process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium'), 'src');
  if (!fs.existsSync(path.join(src, 'chrome/browser/resources/webui_browser'))) return t.skip('no Chromium source here');
  const found = lint();
  assert.deepEqual(found.map((f) => `${path.basename(f.file)}:${f.line} ${f.word}`), [],
      'Mac-only words Windows would show (node chromium/tools/lint_platform_words.mjs lists them)');
});

test('Windows: the tour, moving in and Settings show no Mac-only words', { timeout: 180000, ...(WIN ? {} : { todo: 'on macOS with a Windows user agent: the UI’s Windows branches only (the C++ is the Mac build’s); real on Windows' }) }, async () => {
  const m = machine('native-and-old-on-path');
  const arc = path.join(m.root, 'Arc');
  fs.mkdirSync(arc);
  fs.copyFileSync(path.join(ARC, 'StorableSidebar.json'), path.join(arc, 'StorableSidebar.json'));
  const seen = [];
  const look = async (b, where) => { for (const w of macWords(await b.eval(VISIBLE))) seen.push(`${where}: ${w}`); };
  const b = await launch(['about:blank'], { profile: m.profile, env: m.env, args: [...m.args, '--meridian-onboarding', `--meridian-arc-dir=${arc}`,
    '--meridian-arc-safe-storage=test-pass', `--meridian-test-signin-log=${path.join(m.root, 'signins.log')}`, '--meridian-test-ai-consent', '--lang=en-US',
    ...(WIN ? [] : [`--user-agent=${WINDOWS_UA}`])] });
  try {
    await b.waitFor(`${step} === 'hello'`, 20000);
    for (let i = 0; i < 30; i++) {
      const at = await b.eval(step);
      if (!at) break;
      await look(b, `tour › ${at}`);
      if (at === 'done') { await b.click(`${OB}.getElementById('next')`); break; }
      const id = at === 'ai' ? 'aiYes' : at === 'claude' ? 'restartClaude' : at === 'signin' ? 'signInLater' : 'next';
      await b.click(`${OB}.getElementById('${id}')`);
      // Moving in: the card shown before the sign-ins are read (the Mac's keychain card, on a Mac).
      await new Promise((r) => setTimeout(r, 400));
      if (await b.eval(`!!${OB}.querySelector('.confirm')`)) {
        await look(b, `tour › ${at} › before reading sign-ins`);
        await b.click(`${OB}.getElementById('confirmContinue')`);
      }
      await b.waitFor(`(${step}) !== ${JSON.stringify(at)}`, 45000, step);
    }
    await b.waitFor('!app.$.onboarding.open', 15000);
    // Every section of Settings.
    await b.eval('app.$.tabstrip.runCommand(13, 0)');
    await b.waitFor(`app.$.settings.open && !!${ST}.querySelector('[data-id]')`, 15000);
    const sections = await b.eval(`[...${ST}.querySelectorAll('nav [data-id], .nav [data-id], [data-id].nav-item')].map((e) => e.dataset.id)`);
    for (const id of sections.length ? sections : ['general', 'ai']) {
      await b.eval(`${ST}.querySelector('[data-id="${id}"]')?.click()`);
      await new Promise((r) => setTimeout(r, 1200));
      await look(b, `Settings › ${id}`);
    }
  } finally { await b.close(); m.clean(); }
  assert.deepEqual([...new Set(seen)], []);
});
