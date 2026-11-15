// Whether Meridian's updater on the Mac would take a release: its SHA256SUMS.txt is signed with
// the release key (SHA256SUMS.txt.sig, as update_check.cc checks it) and lists the Mac zip with
// that zip's own checksum. A release whose checksums were replaced or merged without signing
// them again on the Mac would install by hand but never reach anyone through the updater.
//   node chromium/tools/verify_release.mjs SHA256SUMS.txt SHA256SUMS.txt.sig Meridian-<v>-mac-<arch>.zip
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// kReleaseKey in chrome/browser/meridian/update_check.h (the public half).
const KEY = Buffer.from('13cd4136e0510de93833aee40380ab649679d871b85219a21f2df320cf17c5b6', 'hex');

const [sumsFile, sigFile, zipFile] = process.argv.slice(2);
if (!zipFile) {
  console.error('usage: verify_release.mjs SHA256SUMS.txt SHA256SUMS.txt.sig <mac zip>');
  process.exit(2);
}
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };

const sums = fs.readFileSync(sumsFile);
const sig = Buffer.from(fs.readFileSync(sigFile, 'utf8').trim(), 'base64');
const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: KEY.toString('base64url') }, format: 'jwk' });
if (sig.length !== 64 || !crypto.verify(null, sums, key, sig)) {
  fail('SHA256SUMS.txt is not signed with the release key: the Mac updater will refuse it');
}
const name = path.basename(zipFile);
const line = sums.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p.length === 2 && p[1].replace(/^\*/, '') === name);
if (!line) fail(`${name} is not listed in SHA256SUMS.txt: the Mac updater will find nothing to install`);
const hash = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
if (line[0].toLowerCase() !== hash) fail(`${name}'s checksum differs from SHA256SUMS.txt`);
console.log(`✔ the Mac updater takes ${name}: signed checksums, matching zip`);
