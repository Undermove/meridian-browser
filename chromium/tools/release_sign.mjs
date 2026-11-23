#!/usr/bin/env node
// Signs a checksums file with Meridian's release key (Ed25519) and writes <file>.sig.
//   node chromium/tools/release_sign.mjs <SHA256SUMS file> <update_check.h>
//
// The key lives in the macOS Keychain with no trusted apps, so macOS asks the person every time it
// is read: press Allow, never Always Allow (that would let any program run `security` to get it).
// It is held in memory for this one signature and is never printed or written to a file.
// A missing key is an error: a new one would be refused by every installed Meridian.
// MERIDIAN_RELEASE_KEY: a key file instead (tests only).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const SERVICE = 'Meridian Release Key';
export const ACCOUNT = 'release-ed25519';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readKey() {
  const file = process.env.MERIDIAN_RELEASE_KEY;
  if (file) return fs.readFileSync(file);
  try {
    const stored = execFileSync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    return Buffer.from(stored.toString().trim(), 'base64');
  } catch {
    fail(`Couldn't read "${SERVICE}" from the Keychain (missing, or the request was denied). Nothing was signed.`);
  }
}

const [sums, header] = process.argv.slice(2);
if (!sums || !header) fail('usage: release_sign.mjs <SHA256SUMS file> <update_check.h>');

let key;
try {
  key = crypto.createPrivateKey(readKey());
} catch {
  fail('The stored release key is not a valid key. Nothing was signed.');
}
const pub = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
const built = /kReleaseKey = \{([^}]*)\}/.exec(fs.readFileSync(header, 'utf8'));
const expected = built ? Buffer.from(built[1].match(/0x[0-9a-f]{2}/gi).map((b) => parseInt(b, 16))) : Buffer.alloc(0);
if (!expected.equals(pub)) fail('kReleaseKey in update_check.h is not this key: nothing signed.');

const data = fs.readFileSync(sums);
const signature = crypto.sign(null, data, key);
if (!crypto.verify(null, data, crypto.createPublicKey(key), signature)) fail('The signature did not verify: nothing signed.');
fs.writeFileSync(`${sums}.sig`, signature.toString('base64') + '\n');
console.error(`Signed ${sums}`);
