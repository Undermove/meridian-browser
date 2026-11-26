// Part of the isolation guard, macOS: tests run beside the person working at this Mac, so a test
// browser must never take the screen. A window ordered front by a background app still makes
// macOS switch to the Space it is on (the owner saw his screen jump to an empty Desktop while
// little/link_preview ran). tools/space_watch.py reports the active Space, the frontmost app, the
// test browsers' windows that can be seen, and how long ago the person last touched the keyboard,
// mouse or trackpad. A test fails, by name, when during it:
//   - the Space changed with no input from the person in the 2 s before (an app did it);
//   - a test browser became frontmost, or one of its windows could be seen (background mode keeps
//     every test window at alpha 0), whatever the person was doing;
//   - a browser app (Meridian, Arc, Chrome…) was started by macOS from anywhere but the build under
//     test (the owner's backup Meridian was once started that way), by path and pid.
// The person switching Spaces himself (a swipe, ⌃→, ⌘⇥, a click in the Dock: input comes first)
// is his own doing: it is printed, not failed. (26.11: every SPACE GUARD failure of the day was
// such a switch; the owner moves between his Spaces about once a minute.) Not caught: an app
// switching the Space while the person is typing or swiping at that very moment.
//   MERIDIAN_SPACE_GUARD=warn   only print it
//   MERIDIAN_SPACE_GUARD=off    no watcher
//   MERIDIAN_FOREGROUND=1       (tests that need the screen) the guard is off too
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MODE = process.env.MERIDIAN_FOREGROUND ? 'off' : (process.env.MERIDIAN_SPACE_GUARD || 'fail');
const events = [];
let watcher = null;

export function startSpaceWatch() {
  if (process.platform !== 'darwin' || MODE === 'off' || watcher) return;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'space_watch.py');
  // The build under test, and the copy macOS makes of it to run (code_sign_clone): theirs to start.
  const app = (process.env.MERIDIAN_APP || '').split('.app/')[0];
  const build = path.join(process.env.CHROMIUM_DIR || path.join(os.homedir(), 'repos/chromium'), 'src/out');
  watcher = spawn('/usr/bin/python3', ['-I', script, build, app && app + '.app/', path.join(path.dirname(os.tmpdir()), 'X')], { stdio: ['pipe', 'pipe', 'ignore'] });
  watcher.unref();
  watcher.stdin.on('error', () => {});
  watcher.stdout.unref?.();
  readline.createInterface({ input: watcher.stdout }).on('line', (l) => { try { events.push(JSON.parse(l)); } catch {} });
  process.on('exit', () => { try { watcher.kill(); } catch {} });
  for (const pid of pending) watchPid(pid);
}

// A test browser's pid: the watcher looks for its windows on the screen.
const pending = new Set();
export function watchPid(pid) {
  if (!watcher) { pending.add(pid); return; }
  try { watcher.stdin.write(`${pid}\n`); } catch {}
}

// The person's own input this long before a Space switch makes it his.
export const OWN_INPUT_S = 2;

// What changed between `from` and `to` (ms) that a test did: the Space, a test browser in front or
// seen, a browser macOS started.
export function screenTaken(from, to, testPids) {
  if (!watcher || events.length < 1) return [];
  const { taken, own } = classify(events, from, to, testPids);
  owners.push(...own);
  return taken;
}

// The same over a list of the watcher's events (pure; isolation.test.mjs feeds it its own).
export function classify(list, from, to, testPids) {
  const spaces = list.filter((e) => e.space !== undefined);
  // Each switch against the Space just before it (not the one the test began on: after the person
  // moved to another Space, every later change of the frontmost app there would read as a switch).
  let before = [...spaces].reverse().find((e) => e.t <= from) || spaces[0];
  const out = [];
  const own = [];
  for (const e of list.filter((x) => x.t > from && x.t <= to + 300)) {
    if (e.alien) { out.push(`macOS started ${e.alien.exe} (pid ${e.alien.pid}, from launchd: LaunchServices, the Dock or a URL handed to the system) — not the build under test. Tests must never go through LaunchServices; if you opened it yourself, run again`); continue; }
    const at = new Date(e.t).toISOString().slice(11, 23);
    if (e.shown) { if (testPids.has(e.shown)) out.push(`a window of a test browser (pid ${e.shown}, window ${e.window}) could be seen on the screen at ${at}`); continue; }
    if (before && e.space !== before.space) {
      if (typeof e.idle === 'number' && e.idle < OWN_INPUT_S) own.push(`the Space switched (${before.space} → ${e.space}) at ${at}, ${e.idle} s after the person's own input: his switch, not counted`);
      else out.push(`the Space switched (${before.space} → ${e.space}) at ${at} with no input from the person${typeof e.idle === 'number' ? ` (last ${e.idle} s before)` : ''}`);
    }
    if (testPids.has(e.front)) out.push(`a test browser (pid ${e.front}) became the frontmost app at ${at}`);
    before = e;
  }
  return { taken: [...new Set(out)], own };
}

// The person's own Space switches screenTaken() let pass, for the log.
const owners = [];
export const ownSwitches = () => owners.splice(0);

export const SPACE_GUARD_MODE = MODE;
export const spaceEvents = () => events.slice();
// For the guard's own test: what it caught on purpose.
export function forget(pred) { for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) events.splice(i, 1); }
