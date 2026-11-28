// Opt-in: the real hero shot in a real Meridian, with a temp profile (harness.mjs).
// Run: MERIDIAN_APP=<binary> node --test tests/site/node/site_shot_real.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../site/lab/tools/site_shot.mjs', import.meta.url));
const ICONS = path.dirname(SCRIPT);

test('site_shot.mjs makes the hero picture in a real Meridian', {
  skip: !process.env.MERIDIAN_APP && 'set MERIDIAN_APP=<Meridian binary> to run',
  timeout: 240_000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-shot-'));
  const out = path.join(dir, 'hero.png');
  try {
    // NODE_TEST_CONTEXT would make the child's node:test (via harness.mjs) talk the runner's protocol.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const r = await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, out, ICONS], { env, timeout: 230_000, maxBuffer: 16 << 20 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.equal(r.error, null, `site_shot.mjs failed:\n${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /^tabs \[/m);
    assert.match(r.stdout, /^state /m);
    const png = fs.readFileSync(out);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    console.log(`hero.png ${width}x${height}, ${png.length} bytes`);
    assert.ok(width > 1000 && height > 600, `${width}x${height}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
