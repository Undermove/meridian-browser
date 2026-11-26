#!/usr/bin/env node
// Improve with AI on a real site, with your real Claude Code: a manual try, never run by CI (it
// spends your Claude plan and needs the internet).
//
//   node chromium/tools/boost_ai_try.mjs <url> [direction] [--app <Meridian binary>] [--out <dir>]
//     [--provider claude-code|api|codex|…] [--wait <seconds>]
//
// It starts the given Meridian (default: the tests' build, $MERIDIAN_APP or out/Release) with a
// fresh temporary profile in the background, opens <url>, waits for you to sign in there if the
// site needs it (--wait), runs Improve with the direction ("" = the AI's own redesign) and prints
// each round as the editor shows it. In --out (default: a new temp folder) it leaves
// before.png, after.png, boost.css and the summary. Your own Meridian, profile and settings are
// not touched; Claude Code runs as you, with its own sign-in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from '../tests/harness.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const [, value] = args.splice(at, 2);
  return value;
};
const app = flag('--app', undefined);
const out = flag('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-boost-try-')));
const provider = flag('--provider', 'claude-code');
const wait = Number(flag('--wait', '0'));
const [url, direction = ''] = args;
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node chromium/tools/boost_ai_try.mjs <https://…> [direction] [--app …] [--out …] [--provider …] [--wait s]');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 'app.$.tabstrip.handler_';

const b = await launch([url], { ...(app ? { app } : {}), args: ['--meridian-test-foreground'] });
try {
  const page = await b.page(url.split('#')[0]);
  await page.waitFor(`document.readyState === 'complete'`, 60000);
  if (wait > 0) {
    console.log(`Sign in or set the page up in the window; Improve starts in ${wait} s…`);
    await sleep(wait * 1000);
  }
  await sleep(1500);
  const shot = async (name) => {
    const { data } = await page.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64'));
  };
  await shot('before.png');
  // The site's boost (a new one), as the editor makes it.
  const { state } = await b.eval(`${H}.getBoost()`);
  if (!state.host) throw new Error('not a website');
  const id = state.boost?.id || (await b.eval(`${H}.setBoost({ id: '', host: ${JSON.stringify(state.host)}, name: 'My Boost', enabled: true, css: '', js: '', zaps: [], hue: 0, font: '', tint: -1, tintStrength: 60, tint2: -1, dark: false, brightness: 100, contrast: 100, saturation: 100, size: 100, textCase: '' })`)).id;
  const started = Date.now();
  const running = b.eval(`${H}.improveBoost(${JSON.stringify(id)}, ${JSON.stringify(direction)}, ${JSON.stringify(provider)})`);
  let last = '', done = null;
  running.then((r) => { done = r; }, (e) => { done = { error: String(e) }; });
  while (!done) {
    const { progress } = await b.eval(`${H}.getImproveProgress()`);
    if (progress && progress !== last) console.log(`${((Date.now() - started) / 1000).toFixed(1)} s  ${progress}`);
    last = progress || last;
    await sleep(300);
  }
  console.log(`${((Date.now() - started) / 1000).toFixed(1)} s  ${done.error ? 'Error: ' + done.error : done.summary}`);
  const boost = (await b.eval(`${H}.getBoost()`)).state.boosts.find((x) => x.id === id);
  fs.writeFileSync(path.join(out, 'boost.css'), boost?.css || '');
  fs.writeFileSync(path.join(out, 'summary.txt'), `${boost?.name || ''}\n${done.error || done.summary}\nzaps: ${(boost?.zaps || []).join(', ')}\n`);
  await sleep(1200);
  await shot('after.png');
  console.log(`Saved before.png, after.png, boost.css and summary.txt in ${out}`);
} finally {
  await b.close();
}
