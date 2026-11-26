#!/usr/bin/env node
// Keeps the Chromium version people read (the README engine badge) in step with
// chromium/CHROMIUM_VERSION, the one source of truth. update_chromium.sh runs it after a bump;
// CI runs it with --check so a stale mention fails the pull request.
//
//   node chromium/tools/sync_chromium_mentions.mjs          rewrite the mentions
//   node chromium/tools/sync_chromium_mentions.mjs --check  exit 1 if any is out of date
//
// Add a new mention here (file + pattern) rather than hand-editing it after the next bump.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const version = readFileSync(join(root, 'chromium', 'CHROMIUM_VERSION'), 'utf8').trim();
const major = version.split('.')[0];
if (!/^\d+$/.test(major)) {
  console.error(`chromium/CHROMIUM_VERSION does not start with a major version: "${version}"`);
  process.exit(2);
}

const mentions = [
  { file: 'README.md', pattern: /engine-Chromium%20\d+/g, replace: `engine-Chromium%20${major}` },
  { file: 'README.md', pattern: /alt="Chromium \d+"/g, replace: `alt="Chromium ${major}"` },
];

const check = process.argv.includes('--check');
let stale = 0;
const files = new Map();
for (const m of mentions) {
  const path = join(root, m.file);
  const text = files.get(path) ?? readFileSync(path, 'utf8');
  const found = text.match(m.pattern);
  if (!found) {
    console.error(`${m.file}: no match for ${m.pattern}; update the list in this script`);
    process.exit(2);
  }
  const next = text.replace(m.pattern, m.replace);
  if (next !== text) {
    stale++;
    console.log(`${m.file}: ${found[0]} -> ${m.replace}`);
  }
  files.set(path, next);
}

if (check) {
  if (stale) {
    console.error(`Chromium ${major} is in chromium/CHROMIUM_VERSION, but ${stale} mention(s) say otherwise. Run: node chromium/tools/sync_chromium_mentions.mjs`);
    process.exit(1);
  }
  console.log(`All Chromium mentions say ${major}.`);
} else {
  for (const [path, text] of files) writeFileSync(path, text);
}
