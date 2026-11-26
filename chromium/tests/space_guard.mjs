// Part of the isolation guard, macOS: tests run beside the person working at this Mac, so a test
// browser must never take the screen. A window ordered front by a background app still makes
// macOS switch to the Space it is on (the owner saw his screen jump to an empty Desktop while
// little/link_preview ran). tools/space_watch.py reports the active Space and the frontmost app;
// a test during which the Space changed or a test browser became frontmost fails, by name.
// Also: a browser app (Meridian, Arc, Chrome…) that macOS starts during a test from anywhere but
// the build under test (the owner's backup Meridian was once started that way), by path and pid.
//   MERIDIAN_SPACE_GUARD=warn   only print it (when you switch Spaces yourself during a run)
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
}

// What changed between `from` and `to` (ms) that a test did: the Space, or a test browser in front.
export function screenTaken(from, to, testPids) {
  if (!watcher || events.length < 1) return [];
  const spaces = events.filter((e) => !e.alien);
  const before = [...spaces].reverse().find((e) => e.t <= from) || spaces[0];
  const out = [];
  for (const e of events.filter((x) => x.t > from && x.t <= to + 300)) {
    if (e.alien) { out.push(`macOS started ${e.alien.exe} (pid ${e.alien.pid}, from launchd: LaunchServices, the Dock or a URL handed to the system) — not the build under test. Tests must never go through LaunchServices; if you opened it yourself, run again`); continue; }
    if (before && e.space !== before.space) out.push(`the Space switched (${before.space} → ${e.space}) at ${new Date(e.t).toISOString().slice(11, 23)}`);
    if (testPids.has(e.front)) out.push(`a test browser (pid ${e.front}) became the frontmost app at ${new Date(e.t).toISOString().slice(11, 23)}`);
  }
  return [...new Set(out)];
}

export const SPACE_GUARD_MODE = MODE;
export const spaceEvents = () => events.slice();
// For the guard's own test: what it caught on purpose.
export function forget(pred) { for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) events.splice(i, 1); }
