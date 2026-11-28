// Playwright's global setup and teardown: the web gate's start and verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import teardown from '../web/global-teardown.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// Two temp pages: a.html fully run, b.html never run.
function gate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-'));
  const body = '\nrun();\n';
  fs.writeFileSync(path.join(root, 'a.html'), `<script>${body}</script>\n`);
  // Not the same script as a.html: an entry counts for every page holding its script.
  fs.writeFileSync(path.join(root, 'b.html'), '<script>\nother();\n</script>\n');
  const rawDir = path.join(root, 'raw');
  fs.mkdirSync(rawDir);
  fs.writeFileSync(path.join(rawDir, 'r.json'), JSON.stringify([
    { url: '/a.html', source: body, functions: [{ ranges: [{ startOffset: 0, endOffset: body.length, count: 1 }] }] },
  ]));
  const out = [];
  const opts = { pages: ['a.html', 'b.html'], root, rawDir, exclusionsFile: path.join(root, 'none.json'), log: (l) => out.push(l) };
  return { opts, out };
}

test('teardown: without COVERAGE_ENFORCE a failing page only prints', () => {
  const { opts, out } = gate();
  teardown({}, { env: {}, ...opts });
  assert.equal(out[0], '\nInline script coverage (lines):');
  assert.deepEqual(out.slice(1), ['100.00%      1/1     a.html', '  0.00%      0/1     b.html', '         missed: 2']);
});

test('teardown: COVERAGE_ENFORCE=1 throws and names the failing pages', () => {
  const { opts } = gate();
  assert.throws(() => teardown({}, { env: { COVERAGE_ENFORCE: '1' }, ...opts }), { message: 'coverage below 100% in: b.html' });
});

test('teardown: COVERAGE_ENFORCE=1 passes when every checked page is covered', () => {
  const { opts, out } = gate();
  teardown({}, { env: { COVERAGE_ENFORCE: '1', COVERAGE_ONLY: ',a.html,,zzz,' }, ...opts });
  assert.deepEqual(out.slice(1), ['100.00%      1/1     a.html']);
});

test('teardown: COVERAGE_ENFORCE other than 1 does not throw', () => {
  const { opts } = gate();
  teardown({}, { env: { COVERAGE_ENFORCE: 'true' }, ...opts });
});

// The defaults read the real env and paths, so they run in a child with a temp COVERAGE_DIR.
// The env keeps process.env: node's test coverage of the child depends on it.
function child(code, dir) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, COVERAGE_DIR: dir, COVERAGE_ENFORCE: '1', COVERAGE_ONLY: 'site/lab/index.html' },
  });
}

test('teardown: the defaults read COVERAGE_ENFORCE, COVERAGE_ONLY and COVERAGE_DIR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-'));
  const url = new URL('../web/global-teardown.mjs', import.meta.url).href;
  const r = child(`import t from '${url}'; try { t({}); } catch (e) { console.log('THREW ' + e.message); }`, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\nInline script coverage \(lines\):\n {2}0\.00%\s+0\/\d+\s+site\/lab\/index\.html\n {9}missed: .*\nTHREW coverage below 100% in: site\/lab\/index\.html\n$/);
});

test('setup: wipes $COVERAGE_DIR/raw and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
  fs.mkdirSync(path.join(dir, 'raw', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'raw', 'old.json'), '[]');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  const url = new URL('../web/global-setup.mjs', import.meta.url).href;
  const once = child(`import s from '${url}'; s({});`, dir);
  assert.equal(once.status, 0, once.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'raw')));
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'x');
  const again = child(`import s from '${url}'; s({});`, dir);
  assert.equal(again.status, 0, 'a missing raw dir is fine: ' + again.stderr);
});
