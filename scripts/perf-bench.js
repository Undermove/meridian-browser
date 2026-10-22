#!/usr/bin/env node
// Dev-only perf bench: seeds a synthetic Arc-sized profile into a throwaway user-data dir and times
// space switching, tab switching, sidebar updates and state saving inside the real renderer.
//   node scripts/perf-bench.js [userDataDir]
// Never point it at a real profile: the dir is wiped and re-seeded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dir = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-bench-')));
if (fs.existsSync(dir) && fs.readdirSync(dir).length && !fs.existsSync(path.join(dir, '.meridian-bench'))) {
  console.error(`${dir} is not empty and was not made by this bench; refusing to touch it`);
  process.exit(1);
}
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '.meridian-bench'), '');

let n = 0;
const id = () => `t${++n}`;
// .invalid never resolves, so nothing leaves the machine and pages fail fast.
const tab = (i, host) => ({ id: id(), type: 'tab', url: `https://${host}-${i}.invalid/page`, title: `${host} page ${i} with a reasonably long title` });

function bigSpace(name, color, pinnedTabs, folders, todayTabs) {
  const pinned = [];
  const perFolder = Math.floor(pinnedTabs / folders);
  for (let f = 0; f < folders; f++) {
    pinned.push({ id: id(), type: 'folder', title: `Folder ${f + 1}`, collapsed: f % 3 === 2, children: Array.from({ length: perFolder }, (_, i) => tab(f * 100 + i, `p${f}`)) });
  }
  for (let i = folders * perFolder; i < pinnedTabs; i++) pinned.push(tab(i, 'loose'));
  return { id: id(), name, icon: null, color, profileId: 'default', pinned, today: Array.from({ length: todayTabs }, (_, i) => ({ ...tab(i, 'today'), lastActive: Date.now() })), activeTabId: null, split: null };
}

const spaces = [bigSpace('Work', '#8a8fe0', 250, 20, 40), bigSpace('Personal', '#e08a9b', 250, 20, 40), bigSpace('Side', '#7fbf8e', 60, 5, 10)];
const history = {};
for (let i = 0; i < 4000; i++) { const url = `https://hist-${i}.invalid/some/path?q=${i}`; history[url] = { url, title: `History entry ${i}`, count: 1 + (i % 7), last: Date.now() - i * 1000 }; }
const state = {
  version: 1, profiles: [{ id: 'default', name: 'Default' }], spaces, activeSpaceId: spaces[0].id,
  favorites: { default: Array.from({ length: 8 }, (_, i) => tab(i, 'fav')) }, archive: [], history,
  settings: { searchEngine: 'google', archiveAfterHours: 0, adblock: false, sidebarRight: false, sidebarHidden: false, extensions: [], agentAccess: 'off', agentAllowJs: false, aiUseTools: false },
  onboarded: true,
};
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));

// Runs inside the renderer. "sync" = the call plus the style/layout it causes (forced right after);
// the other numbers wait for the next frame, so they include waiting for vsync.
const BENCH = `(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length * 0.95)].toFixed(2); };
  const time = async (fn) => { const t = performance.now(); fn(); await frame(); return performance.now() - t; };
  const ids = state.spaces.map((s) => s.id);
  await frame(); await frame();
  const sw = []; const swSync = [];
  for (let i = 0; i < 20; i++) {
    const target = ids[(i + 1) % 2];
    const t = performance.now(); switchSpace(target, 1); void document.body.offsetHeight; swSync.push(performance.now() - t); await frame(); sw.push(performance.now() - t);
    await new Promise((r) => setTimeout(r, 30));
  }
  if (state.activeSpaceId !== ids[0]) { switchSpace(ids[0]); await frame(); }
  const tabs = visibleTabIds().slice(8, 28);
  const ts = []; const tsSync = [];
  for (const id of tabs) { const t = performance.now(); activate(id, { focus: false }); void document.body.offsetHeight; tsSync.push(performance.now() - t); await frame(); ts.push(performance.now() - t); }
  // Title churn: 40 title updates on background tabs, as page loads produce.
  const churn = await time(() => { for (const id of tabs.slice(0, 40)) { const l = locate(id); l.node.title = 'T ' + Math.random(); navOf(id).loading = !navOf(id).loading; scheduleRender(); } });
  // A routine save, renderer + IPC + main-process write (the old code wrote everything, history included, every time).
  const routine = typeof flushSave === 'function' ? () => flushSave() : () => api.saveState(serialize());
  const st = []; for (let i = 0; i < 10; i++) { const t = performance.now(); await routine(); st.push(performance.now() - t); }
  const full = typeof flushSave === 'function' ? () => { persist.historyDirty = true; persist.faviconsDirty = true; return flushSave({ slow: true }); } : routine;
  const sf = []; for (let i = 0; i < 5; i++) { const t = performance.now(); await full(); sf.push(performance.now() - t); }
  return { spaceSwitch: { first: +sw[0].toFixed(2), firstSync: +swSync[0].toFixed(2), median: med(sw), p95: p95(sw), syncMedian: med(swSync), syncMax: +Math.max(...swSync).toFixed(2) }, tabSwitch: { median: med(ts), p95: p95(ts), syncMedian: med(tsSync), syncMax: +Math.max(...tsSync).toFixed(2) }, titleChurn40: +churn.toFixed(2), saveRoutine: med(st), saveWithHistory: med(sf), rows: document.querySelectorAll('.row').length, webviews: document.querySelectorAll('webview').length };
})()`;

const steps = [{ wait: 2500 }, { js: BENCH, wait: 200, shot: path.join(dir, 'bench.png') }];
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const child = spawn(electron, ['.'], {
  cwd: ROOT,
  env: { ...process.env, MERIDIAN_USER_DATA: dir, MERIDIAN_SHOT: path.join(dir, 'final.png'), MERIDIAN_STEPS: JSON.stringify(steps) },
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', () => {});
const kill = setTimeout(() => child.kill('SIGKILL'), 90_000);
child.on('exit', () => {
  clearTimeout(kill);
  const line = out.split('\n').find((l) => l.startsWith('[eval]'));
  if (!line) { console.error('no result\n' + out); process.exit(1); }
  console.log(JSON.stringify(JSON.parse(line.slice(7)), null, 2));
  console.log('screenshot:', path.join(dir, 'bench.png'));
});
