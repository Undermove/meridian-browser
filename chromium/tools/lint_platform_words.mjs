#!/usr/bin/env node
// Mac-only words in UI that Windows shows too. On 26.11 Windows users saw a macOS Keychain card
// while moving in; this finds such text before a release does.
//
//   node chromium/tools/lint_platform_words.mjs [--chromium <src>] [--json] [--warn]
//
// Looks at the UI shared by every platform:
//   - the browser UI: <src>/chrome/browser/resources/webui_browser/meridian/*.ts
//   - the Workbench: src/renderer/dev/*.{js,html} of this repo
//   - strings in the browser's C++: <src>/chrome/browser/meridian/**/*.cc (not *_mac.*, not tests)
// and flags a Mac-only word (Keychain, "your Mac", "this Mac", ⌘, ⌥, Finder, "Applications folder",
// System Settings, Dock) that isn't behind a Mac check:
//   - TS/JS: `isMac` (or `isWindows`, process.platform, navigator.platform) on the line or in the
//     few lines before it (the condition of the ternary or `if` it is in); ⌘ and ⌥ inside
//     keyText(…)/keyCaps(…), which spell them Ctrl/Alt off the Mac.
//   - C++: inside #if BUILDFLAG(IS_MAC) (or the #else of a !IS_MAC / IS_WIN block).
//   - A line (or the one above) with `platform-ok: <why>`: checked by a person.
// Files that are Mac-only by design (mac_ask*, *_mac.*, keys.ts) are skipped.
// Exit 1 when anything is found (0 with --warn). <src> defaults to $CHROMIUM_DIR/src or
// ~/repos/chromium/src.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SRC = opt('--chromium') || path.join(process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium'), 'src');

export const WORDS = [
  // As a word people read ("the keychain", "Keychain Access"), not a name in code (keychain:, keychainName_).
  [/(?<![\w.$"'=\/-])keychain(?![\w:_"'=-])/i, 'Keychain'],
  [/\byour Mac\b/i, 'your Mac'],
  [/\bthis Mac\b/i, 'this Mac'],
  [/\bon (?:a |the )?Mac\b(?!OS)/i, 'on Mac'],
  [/⌘/, '⌘'],
  [/⌥/, '⌥'],
  [/\bFinder\b/, 'Finder'],
  [/Applications folder|\bto Applications\b|\bin Applications\b|\bfrom Applications\b/i, 'Applications folder'],
  [/System Settings|System Preferences/, 'System Settings'],
  [/\bthe Dock\b|\bin the Dock\b/, 'Dock'],
];
const GUARD = /\bisMac\b|\bwb\.platform\b|\bisWindows\b|\bIS_MAC\b|process\.platform|navigator\.platform|userAgentData|platform-ok|\bmacOnly\b|\bonMac\b/;
const KEY_HELPERS = /\b(keyText|keyCaps|keys|shortcutText|accel)\s*\(/;
const SKIP_FILE = /(^|\/)(mac_ask[^/]*|[^/]*_mac\.[a-z]+|[^/]*\.mm|keys\.ts|[^/]*_unittest\.cc|[^/]*_browsertest\.cc|[^/]*_win\.cc)$/;
const WINDOW = 8;

// Sources BUILD.gn compiles only for the Mac (`if (is_mac) { sources += [ … ] }`).
function macOnlySources() {
  const out = new Set();
  const gn = path.join(SRC, 'chrome/browser/meridian/BUILD.gn');
  if (!fs.existsSync(gn)) return out;
  const text = fs.readFileSync(gn, 'utf8');
  for (const m of text.matchAll(/if \(is_mac\) \{/g)) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        for (const f of text.slice(m.index, i).matchAll(/"([^"]+\.cc)"/g)) out.add(path.join(SRC, 'chrome/browser/meridian', f[1]));
        break;
      }
    }
  }
  return out;
}

// Checked by a person: `path[:line text]  # why` per line in platform_words_allow.txt.
function allowed() {
  const file = path.join(HERE, 'platform_words_allow.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf(':'); return i < 0 ? { file: l, text: '' } : { file: l.slice(0, i), text: l.slice(i + 1) }; });
}

function files() {
  const mac = macOnlySources();
  const out = [];
  const add = (dir, re, deep = false) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && deep) add(p, re, deep);
      else if (e.isFile() && re.test(e.name) && !SKIP_FILE.test(p) && !mac.has(p)) out.push(p);
    }
  };
  add(path.join(SRC, 'chrome/browser/resources/webui_browser/meridian'), /\.ts$/);
  add(path.join(REPO, 'src/renderer/dev'), /\.(js|html)$/);
  add(path.join(SRC, 'chrome/browser/meridian'), /\.cc$/, true);
  return out;
}

// Comments out, string contents in (C-like code; good enough for a lint).
function code(line) {
  const t = line.trim();
  if (/^(\/\/|\*|\/\*|<!--|#(?!if|else|elif|endif))/.test(t)) return '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function lintTs(file, lines) {
  const found = [];
  lines.forEach((line, i) => {
    const text = code(line);
    if (!text) return;
    for (const [re, word] of WORDS) {
      if (!re.test(text)) continue;
      const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join('\n');
      if (GUARD.test(before)) continue;
      if ((word === '⌘' || word === '⌥') && KEY_HELPERS.test(lines.slice(Math.max(0, i - 2), i + 1).join('\n'))) continue;
      found.push({ file, line: i + 1, word, text: line.trim().slice(0, 140) });
    }
  });
  return found;
}

function lintCc(file, lines) {
  const found = [];
  // #if stack: whether each level is Mac-only.
  const stack = [];
  const macOnly = () => stack.some((s) => s.mac);
  lines.forEach((line, i) => {
    const t = line.trim();
    let m;
    if ((m = /^#\s*if(n?def)?\s+(.*)$/.exec(t))) {
      const cond = m[2];
      const mac = /BUILDFLAG\(IS_MAC\)/.test(cond) && !/!\s*BUILDFLAG\(IS_MAC\)|\|\|/.test(cond);
      const notMac = /!\s*BUILDFLAG\(IS_MAC\)|BUILDFLAG\(IS_WIN\)|BUILDFLAG\(IS_LINUX\)|BUILDFLAG\(IS_CHROMEOS\)/.test(cond) && !/\|\|/.test(cond);
      stack.push({ mac, notMac });
      return;
    }
    if (/^#\s*else/.test(t) && stack.length) { const s = stack[stack.length - 1]; stack[stack.length - 1] = { mac: s.notMac, notMac: s.mac }; return; }
    if (/^#\s*elif/.test(t) && stack.length) { stack[stack.length - 1] = { mac: /BUILDFLAG\(IS_MAC\)/.test(t), notMac: false }; return; }
    if (/^#\s*endif/.test(t)) { stack.pop(); return; }
    if (macOnly()) return;
    const text = code(line);
    // Only what is said: string literals.
    const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join(' ');
    if (!strings) return;
    for (const [re, word] of WORDS) {
      if (!re.test(strings)) continue;
      if (/platform-ok/.test(lines.slice(Math.max(0, i - 1), i + 1).join('\n'))) continue;
      // Keychain names in code (the macOS API's, a switch) aren't words shown to a person.
      if (word === 'Keychain' && /mock-keychain|keychain-|_keychain|Keychain(Access|Item|Password)\b/.test(strings) && !/\s/.test(strings.trim())) continue;
      found.push({ file, line: i + 1, word, text: line.trim().slice(0, 140) });
    }
  });
  return found;
}

const rel = (f) => f.startsWith(SRC) ? path.relative(SRC, f) : path.relative(REPO, f);

export function lint() {
  const found = [];
  for (const file of files()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    found.push(...(file.endsWith('.cc') ? lintCc(file, lines) : lintTs(file, lines)));
  }
  const ok = allowed();
  return found.filter((f) => !ok.some((a) => rel(f.file) === a.file && (!a.text || f.text.includes(a.text))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(path.join(SRC, 'chrome/browser/resources/webui_browser'))) {
    console.error(`no Chromium source at ${SRC} (--chromium <src>)`);
    process.exit(2);
  }
  const found = lint();
  if (argv.includes('--json')) console.log(JSON.stringify(found.map((f) => ({ ...f, file: rel(f.file) })), null, 2));
  else {
    for (const f of found) console.log(`${rel(f.file)}:${f.line}: "${f.word}" not behind a Mac check: ${f.text}`);
    console.log(found.length ? `\n${found.length} Mac-only word(s) Windows would show. Guard each with isMac / BUILDFLAG(IS_MAC), use keyText() for shortcuts, or mark a checked line "platform-ok: <why>".` : 'No Mac-only words outside a Mac check.');
  }
  process.exit(found.length && !argv.includes('--warn') ? 1 : 0);
}
