// The E2E suite on a shared CI Mac: test files that fail are run once more on their own, so a slow
// moment on the runner isn't reported as a bug. What still fails is written to the file given in
// E2E_FAILED, one test per line, and the exit code is 1.
// Usage (from chromium/tests): node ../tools/ci_e2e.mjs [test files or globs…]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TIMEOUT = process.env.E2E_TEST_TIMEOUT || '120000';
const given = process.argv.slice(2).flatMap((a) => a.split(/\s+/)).filter(Boolean);
const wanted = given.length ? given : ['*.test.mjs'];
const files = wanted.flatMap((a) => (a.includes('*') ? fs.globSync(a) : [a])).sort();

function run(list) {
  const r = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=1',
    `--test-timeout=${TIMEOUT}`, '--test-reporter=tap', ...list], { encoding: 'utf8', maxBuffer: 256 << 20 });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return { code: r.status, failed: failuresIn(r.stdout || '') };
}

// Top-level "not ok" results: each test's name and the file it's in.
function failuresIn(tap) {
  const out = [];
  const lines = tap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    let file = /\.test\.mjs$/.test(m[1]) ? path.basename(m[1]) : '';
    for (let j = i + 1; !file && j < lines.length && !/^(not )?ok \d+ - /.test(lines[j]); j++) {
      file = /location: '.*?([^/\\]+\.test\.mjs):\d+/.exec(lines[j])?.[1] || '';
    }
    out.push({ name: m[1], file });
  }
  return out;
}

let { code, failed } = run(files);
if (code !== 0) {
  const again = [...new Set(failed.map((f) => f.file))].filter(Boolean);
  // Nothing to name (the run itself broke): that stays a failure.
  if (again.length && failed.every((f) => f.file)) {
    console.log(`\n# again, on their own: ${again.join(' ')}`);
    ({ code, failed } = run(again));
  }
}
if (process.env.E2E_FAILED) {
  fs.writeFileSync(process.env.E2E_FAILED, failed.map((f) => `${f.file ? `${f.file}: ` : ''}${f.name}`).join('\n') + '\n');
}
process.exit(code === 0 ? 0 : 1);
