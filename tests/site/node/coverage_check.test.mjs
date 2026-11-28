// The web gate itself: check() decides whether `yarn test:web` passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, loadRaw, exclusions, inlineScripts } from '../web/coverage.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = path.join(ROOT, 'tests/site/web/coverage.mjs');

// A page `p.html` with one line per call; `missed` names the calls that never ran.
const BODY = '\na();\nb();\nc();\n';
const PAGE = `<script>${BODY}</script>\n`;
function entry(source, missed = []) {
  const ranges = [{ startOffset: 0, endOffset: source.length, count: 1 }];
  for (const m of missed) {
    const at = source.indexOf(m);
    ranges.push({ startOffset: at, endOffset: at + m.length, count: 0 });
  }
  return { url: '/p.html', source, functions: [{ ranges }] };
}

// A temp root with pages, raw files and an exclusions file; check() reads only these.
function setup({ pages = { 'p.html': PAGE }, raw = [], ex = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'covcheck-'));
  for (const [p, html] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), html);
  }
  const rawDir = path.join(root, 'raw');
  fs.mkdirSync(rawDir);
  raw.forEach((entries, i) => fs.writeFileSync(path.join(rawDir, `s-${i}.json`), JSON.stringify(entries)));
  const exclusionsFile = path.join(root, 'ex.json');
  fs.writeFileSync(exclusionsFile, JSON.stringify(ex));
  const out = [];
  const run = (opts = {}) => {
    const failing = check({ pages: Object.keys(pages), root, rawDir, exclusionsFile, log: (l) => out.push(l), ...opts });
    return { failing, out };
  };
  return { root, rawDir, exclusionsFile, run };
}

test('check: a fully run page passes', () => {
  const { failing, out } = setup({ raw: [[entry(BODY)]] }).run();
  assert.deepEqual(failing, []);
  assert.deepEqual(out, ['100.00%      3/3     p.html']);
});

test('check: missed lines fail and are listed as ranges', () => {
  const { failing, out } = setup({ raw: [[entry(BODY, ['b()', 'c()'])]] }).run();
  assert.deepEqual(failing, ['p.html']);
  assert.deepEqual(out, [' 33.33%      1/3     p.html', '         missed: 3-4']);
});

test('check: no raw data at all misses every line', () => {
  const { failing, out } = setup().run();
  assert.deepEqual(failing, ['p.html']);
  assert.deepEqual(out, ['  0.00%      0/3     p.html', '         missed: 2-4']);
});

test('check: an excluded missed line passes', () => {
  const { failing, out } = setup({ raw: [[entry(BODY, ['c()'])]], ex: { 'p.html': [{ code: 'c()', why: 'x' }] } }).run();
  assert.deepEqual(failing, []);
  assert.deepEqual(out, [' 66.67%      2/3     p.html']);
});

test('check: an excluded line that ran fails', () => {
  const { failing, out } = setup({ raw: [[entry(BODY)]], ex: { 'p.html': [{ code: 'c()', why: 'x' }] } }).run();
  assert.deepEqual(failing, ['p.html']);
  assert.deepEqual(out, ['100.00%      3/3     p.html', '         line 4 is excluded but covered: remove its exclusion']);
});

test('check: an exclusion that matches no line, or two, fails', () => {
  const { failing, out } = setup({ raw: [[entry(BODY)]], ex: { 'p.html': [{ code: 'gone()' }, { code: '();' }] } }).run();
  assert.deepEqual(failing, ['p.html']);
  assert.deepEqual(out, [
    '100.00%      3/3     p.html',
    '         exclusion matches 0 lines: "gone()"',
    '         exclusion matches 3 lines: "();"',
  ]);
});

test('check: a page with no inline code counts as 100%', () => {
  const { failing, out } = setup({ pages: { 'p.html': '<p>text</p><script src="x.js"></script>\n' } }).run();
  assert.deepEqual(failing, []);
  assert.deepEqual(out, ['100.00%      0/0     p.html']);
});

test('check: `only` keeps the pages whose path contains any of its parts', () => {
  const pages = { 'a/p.html': PAGE, 'b/p.html': PAGE, 'c/q.html': PAGE };
  const all = setup({ pages }).run().out;
  assert.equal(all.filter((l) => l.includes('%')).length, 3);
  const { failing, out } = setup({ pages }).run({ only: ['a/', 'q.html'] });
  assert.deepEqual(failing, ['a/p.html', 'c/q.html']);
  assert.deepEqual(out.filter((l) => l.includes('%')).map((l) => l.split(' ').pop()), ['a/p.html', 'c/q.html']);
});

test('check: an empty `only` keeps every page', () => {
  const pages = { 'a/p.html': PAGE, 'b/p.html': PAGE };
  assert.deepEqual(setup({ pages }).run({ only: [] }).failing, ['a/p.html', 'b/p.html']);
});

test('check: raw data from every .json file counts', () => {
  const { failing } = setup({ raw: [[entry(BODY, ['b()'])], [entry(BODY, ['c()'])]] }).run();
  assert.deepEqual(failing, []);
});

test('loadRaw: a missing dir is no data; other files are ignored', () => {
  const { rawDir } = setup({ raw: [[entry(BODY)], [entry(BODY), entry(BODY)]] });
  assert.deepEqual(loadRaw(path.join(rawDir, 'none')), []);
  fs.writeFileSync(path.join(rawDir, 'notes.txt'), 'not json');
  assert.equal(loadRaw(rawDir).length, 3);
});

test('exclusions: a missing file is none', () => {
  const { exclusionsFile, root } = setup({ ex: { 'p.html': [{ code: 'c()' }] } });
  assert.deepEqual(exclusions(exclusionsFile), { 'p.html': [{ code: 'c()' }] });
  assert.deepEqual(exclusions(path.join(root, 'none.json')), {});
});

// The CLI runs on the real pages and exclusions; COVERAGE_DIR points it at temp raw data.
// The env keeps process.env: node's test coverage of the child depends on it.
function cli(args, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covcli-'));
  fs.mkdirSync(path.join(dir, 'raw'));
  if (raw) fs.writeFileSync(path.join(dir, 'raw', 'r.json'), JSON.stringify(raw));
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, COVERAGE_DIR: dir }, encoding: 'utf8' });
}

test('cli: no data fails every page with exit 1', () => {
  const r = cli([]);
  assert.equal(r.status, 1, r.stderr);
  const rows = r.stdout.split('\n').filter((l) => l.includes('%'));
  assert.equal(rows.length, 10);
  assert.ok(rows.every((l) => l.startsWith('  0.00%')), r.stdout);
});

test('cli: --only checks just the named page and exits 0 when it is covered', () => {
  const page = 'site/lab/index.html';
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const raw = inlineScripts(html).map(([a, b]) => entry(html.slice(a, b)));
  const r = cli(['--only', page], raw);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^100\.00%\s+(\d+)\/\1\s+site\/lab\/index\.html\n$/);
});
