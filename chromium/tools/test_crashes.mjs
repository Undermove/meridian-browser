#!/usr/bin/env node
// Crashes of Meridian test builds since a time: the macOS crash reports (~/Library/Logs/
// DiagnosticReports/*.ips) of a Meridian process that ran from a build folder (out/Release) or a
// test profile. A test that passed while the browser crashed behind it (a helper, a renderer, the
// MCP bridge) shows up here, not in the test output: after the move to Chromium 159 people met
// crashes the suite never reported.
//
//   node chromium/tools/test_crashes.mjs [--since <ISO time | minutes ago>] [--all]
//
// Only Meridian's own reports are opened. Prints one line per crash (process, exception, the first
// frames of the crashed thread) and exits 1 when there is any. --all: also crashes of an installed
// Meridian (not a test build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const sinceArg = argv[argv.indexOf('--since') + 1];
const since = argv.includes('--since') ? (/^\d+$/.test(sinceArg) ? Date.now() - Number(sinceArg) * 60000 : Date.parse(sinceArg)) : Date.now() - 24 * 3600_000;
const all = argv.includes('--all');
const dirs = [path.join(os.homedir(), 'Library/Logs/DiagnosticReports'), path.join(os.homedir(), 'Library/Logs/DiagnosticReports/Retired')];
if (process.platform !== 'darwin') {
  console.log('Crash reports: macOS only here (on Windows, see %LOCALAPPDATA%\\CrashDumps and the Event Viewer).');
  process.exit(0);
}

const found = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!/^Meridian/.test(name) || !/\.(ips|crash)$/.test(name)) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, 'utf8');
    let header = {};
    try { header = JSON.parse(text.slice(0, text.indexOf('\n'))); } catch {}
    const at = Date.parse((header.timestamp || '').replace(/^(\S+) (\S+) ([+-]\d\d)(\d\d)$/, '$1T$2$3:$4')) || fs.statSync(file).mtimeMs;
    if (at < since) continue;
    // .ips: a JSON header line, then the JSON report.
    let report = {};
    try { report = JSON.parse(text.slice(text.indexOf('\n') + 1)); } catch {}
    const where = report.procPath || (text.match(/"procPath"\s*:\s*"([^"]+)"/) || [])[1] || '';
    // macOS writes a path under the home as /Users/USER/…: a build folder (out/Release) or a copy
    // there; an installed Meridian runs from /Applications.
    const test = /\/out\/[^/]+\/Meridian|\/src\/out\//.test(where) || /^\/Users\/USER\//.test(where) || /meridian-e2e-|meridian-qg-/.test(text);
    if (!test && !all) continue;
    const ex = report.exception ? `${report.exception.type || ''} ${report.exception.signal || ''}`.trim() : (text.match(/Exception Type:\s*(.*)/) || [])[1] || '?';
    const thread = (report.threads || []).find((t) => t.triggered) || {};
    // The first frames past the system's own (pthread_kill, abort…): where it really went wrong.
    const SYSTEM = /^(__pthread_kill|pthread_kill|__abort|abort|abort_report_np|_os_crash|__assert_rtn|raise|malloc_|_malloc|__stack_chk_fail|_sigtramp)/;
    const frames = (thread.frames || []).filter((f) => !SYSTEM.test(f.symbol || '')).slice(0, 4).map((f) => f.symbol || `${report.usedImages?.[f.imageIndex]?.name || '?'}+${f.imageOffset}`).join(' < ');
    found.push(`${new Date(at).toISOString()}  ${report.procName || name.split('-')[0]}  ${ex}  ${frames}  (${name})`);
  }
}
if (!found.length) {
  console.log(`No crashes of Meridian test builds since ${new Date(since).toISOString()}.`);
  process.exit(0);
}
console.log(found.sort().join('\n'));
console.log(`\n${found.length} crash report(s): open each in Console.app, and file it with the test that ran then.`);
process.exit(1);
