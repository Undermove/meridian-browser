#!/usr/bin/env node
// CI: every packaged secret-guard hook under dist/ must match the SHA-256 in src/dev/guard.js byte
// for byte, or Workbench refuses to start Claude Code. A CRLF checkout on Windows broke this once.
//   node scripts/check-guard-hook.js [distDir]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const dist = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
const want = /HOOK_SHA256 = '([0-9a-f]{64})'/.exec(fs.readFileSync(path.join(ROOT, 'src', 'dev', 'guard.js'), 'utf8'))[1];

const found = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.split(path.sep).join('/').endsWith('app.asar.unpacked/src/dev/hooks/secret-guard-hook.js')) found.push(p);
  }
})(dist);

if (!found.length) {
  console.error(`No packaged secret-guard-hook.js under ${dist}`);
  process.exit(1);
}
let bad = 0;
for (const p of found) {
  const sum = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  console.log(`${sum === want ? 'ok ' : 'BAD'} ${sum} ${p}`);
  if (sum !== want) bad++;
}
if (bad) console.error(`Expected ${want} (src/dev/guard.js). Check line endings: .gitattributes keeps LF.`);
process.exit(bad ? 1 : 0);
