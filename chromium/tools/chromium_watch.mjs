#!/usr/bin/env node
// Is Meridian behind Chrome? Compares chromium/CHROMIUM_VERSION with Google's Mac releases
// (chromiumdash) and says what to do:
//   patch      a newer build of our branch is out (Chrome ships security fixes this way)
//   milestone  a newer branch is Chrome stable: ours stops getting fixes, move to that one
//   none       up to date
//   node chromium/tools/chromium_watch.mjs   prints {action, version, branch, urgent, title, body}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASH = 'https://chromiumdash.appspot.com/fetch_releases';
// Fixes older than this are urgent: Chrome users have had them for two weeks.
const URGENT_DAYS = 14;

const parse = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// releases: chromiumdash entries ({channel, version, milestone, time}); now: a Date.
export function decide(ours, releases, now = new Date()) {
  const [major, , branch] = parse(ours);
  const days = (t) => Math.floor((now - new Date(t)) / 86400000);
  const stable = releases.filter((r) => r.channel === 'Stable')
      .sort((a, b) => (newer(a.version, b.version) ? -1 : 1))[0];
  // A newer branch is stable: ours is done.
  if (stable && stable.milestone > major) {
    const first = releases.filter((r) => r.channel === 'Stable' && r.milestone === stable.milestone)
        .sort((a, b) => a.time - b.time)[0] || stable;
    const behind = days(first.time);
    return {
      action: 'milestone', version: stable.version, branch: parse(stable.version)[2],
      urgent: behind >= URGENT_DAYS,
      title: `Chrome ${stable.milestone} is stable: move Meridian to branch ${parse(stable.version)[2]}`,
      body: `Meridian is built on Chromium ${ours} (branch ${branch}). Chrome ${stable.version} has been ` +
        `stable for ${behind} day(s), so branch ${branch} no longer gets security fixes.\n\n` +
        `Run \`chromium/update_chromium.sh --branch ${parse(stable.version)[2]}\` (rebases the patches, ` +
        `builds, tests, packages and drafts a release).`,
    };
  }
  // A newer build of our branch (stable or beta).
  const mine = releases.filter((r) => {
    const v = parse(r.version);
    return v[0] === major && v[2] === branch && newer(r.version, ours);
  }).sort((a, b) => (newer(a.version, b.version) ? -1 : 1));
  if (mine.length) {
    const oldest = mine.reduce((a, b) => (a.time < b.time ? a : b));
    const behind = days(oldest.time);
    return {
      action: 'patch', version: mine[0].version, branch, urgent: behind >= URGENT_DAYS,
      title: `Chromium ${mine[0].version} is out: rebuild Meridian`,
      body: `Meridian is built on Chromium ${ours}. Branch ${branch} has newer builds ` +
        `(${mine.map((r) => `${r.version} ${r.channel.toLowerCase()}`).join(', ')}); the first came out ` +
        `${behind} day(s) ago. They usually carry security fixes.\n\n` +
        `Run \`chromium/update_chromium.sh\` (moves to the branch's head, builds, tests, packages and ` +
        `drafts a release).`,
    };
  }
  return { action: 'none', version: ours, branch, urgent: false, title: '', body: '' };
}

async function releases() {
  const out = [];
  for (const channel of ['Stable', 'Beta']) {
    const r = await fetch(`${DASH}?channel=${channel}&platform=Mac&num=20`);
    if (!r.ok) throw new Error(`chromiumdash ${channel}: HTTP ${r.status}`);
    out.push(...(await r.json()));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ours = fs.readFileSync(path.join(HERE, '..', 'CHROMIUM_VERSION'), 'utf8').trim();
  console.log(JSON.stringify(decide(ours, await releases()), null, 2));
}
