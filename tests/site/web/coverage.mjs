// Coverage of the pages' inline <script>s, from V8's block coverage (page.coverage).
//
// V8 reports, per script, nested byte ranges with an execution count. The innermost range decides a
// byte. A line counts as code when it has a word character inside a script; it is missed when any of
// those characters never ran. So an untaken `else`, `? :` arm or `&&` operand misses its line.
//
//   node tests/site/web/coverage.mjs [--only <file>…]   report from the last run
//   COVERAGE_DIR=<dir>                                  where raw data goes (default coverage/site-web)
//
// tests/site/web/coverage-exclusions.json lists lines allowed to stay missed: { page: [{ code, why }] }.
// `code` is text that must sit on exactly one line of the page, so an exclusion follows its line when
// the page changes. One that matches no line, or whose line is now covered, fails the check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const COVERAGE_DIR = path.resolve(ROOT, process.env.COVERAGE_DIR || 'coverage/site-web');
export const RAW_DIR = path.join(COVERAGE_DIR, 'raw');
const EXCLUSIONS = path.join(ROOT, 'tests/site/web/coverage-exclusions.json');

// The pages whose scripts must be covered.
export const PAGES = [
  'docs/index.html',
  'docs/changelog.html',
  'docs/ru/changelog.html',
  'site/pages/changelog.html',
  'site/lab/index.html',
  'site/lab/01-prime-meridian.html',
  'site/lab/02-the-window.html',
  'site/lab/03-moving-day.html',
  'site/lab/04-spaces.html',
  'site/lab/05-command.html',
];

// Inline scripts of a page: [start, end) offsets of each body in the file.
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (let m; (m = re.exec(html));) {
    if (/\bsrc=|type="application\/ld\+json"/.test(m[1]) || !m[2].trim()) continue;
    const start = m.index + m[0].indexOf('>') + 1;
    out.push([start, start + m[2].length]);
  }
  return out;
}

// One script's V8 functions -> a byte array, 1 where the byte ran.
export function ranByte(source, functions) {
  const ranges = functions.flatMap((f) => f.ranges);
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const counts = new Int32Array(source.length).fill(-1);
  for (const r of ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, source.length));
  return counts.map((c) => (c > 0 ? 1 : 0));
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

const lineOf = (starts, offset) => {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo + 1;
};

export function loadRaw(rawDir = RAW_DIR) {
  if (!fs.existsSync(rawDir)) return [];
  return fs.readdirSync(rawDir).filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')));
}

// Raw entries -> per page: { code: Set<line>, missed: Set<line> }.
export function report(entries = loadRaw(), pages = PAGES, root = ROOT) {
  const result = {};
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const starts = lineStarts(html);
    const ran = new Uint8Array(html.length);
    const scripts = inlineScripts(html);
    for (const e of entries) {
      // An entry belongs to the script whose text it is, on whatever page it ran: the built English and
      // Russian pages share a script. A test that changes the script (fixtures.mjs mutate) matches
      // nothing and does not count; one that changes only the markup still does.
      const s = scripts.find(([a, b]) => b - a === e.source.length && html.slice(a, b) === e.source);
      if (!s) continue;
      const bytes = ranByte(e.source, e.functions);
      for (let i = 0; i < bytes.length; i++) if (bytes[i]) ran[s[0] + i] = 1;
    }
    const code = new Set(), missed = new Set();
    for (const [a, b] of scripts) {
      for (let i = a; i < b; i++) {
        if (!/\w/.test(html[i])) continue;
        const line = lineOf(starts, i);
        code.add(line);
        if (!ran[i]) missed.add(line);
      }
    }
    result[page] = { code, missed };
  }
  return result;
}

export function exclusions(file = EXCLUSIONS) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Lines allowed to stay missed, and the problems with the exclusions themselves.
export function allowed(page, ex, root = ROOT) {
  const lines = fs.readFileSync(path.join(root, page), 'utf8').split('\n');
  const set = new Set(), problems = [];
  for (const { code } of ex[page] || []) {
    const at = lines.flatMap((l, i) => (l.includes(code) ? [i + 1] : []));
    if (at.length === 1) set.add(at[0]);
    else problems.push(`exclusion matches ${at.length} lines: ${JSON.stringify(code)}`);
  }
  return { set, problems };
}

export const ranges = (lines) => {
  const out = [];
  for (const l of [...lines].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && l === last[1] + 1) last[1] = l; else out.push([l, l]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
};

// Prints the table; returns the pages that fall short.
export function check({
  only, pages: all = PAGES, root = ROOT, rawDir = RAW_DIR, exclusionsFile = EXCLUSIONS, log = console.log,
} = {}) {
  const ex = exclusions(exclusionsFile);
  const pages = only?.length ? all.filter((p) => only.some((o) => p.includes(o))) : all;
  const res = report(loadRaw(rawDir), pages, root);
  const failing = [];
  for (const page of pages) {
    const { code, missed } = res[page];
    const { set: ok, problems } = allowed(page, ex, root);
    const bad = [...missed].filter((l) => !ok.has(l));
    for (const l of ok) if (!missed.has(l)) problems.push(`line ${l} is excluded but covered: remove its exclusion`);
    const pct = code.size ? (100 * (code.size - missed.size) / code.size).toFixed(2) : '100.00';
    log(`${pct.padStart(6)}%  ${String(code.size - missed.size).padStart(5)}/${String(code.size).padEnd(5)} ${page}`);
    if (bad.length) log(`         missed: ${ranges(bad).join(', ')}`);
    for (const p of problems) log(`         ${p}`);
    if (bad.length || problems.length) failing.push(page);
  }
  return failing;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--only');
  const only = i > 0 ? process.argv.slice(i + 1) : [];
  const failing = check({ only });
  process.exitCode = failing.length ? 1 : 0;
}
