// The Chrome import reads Chrome's session file on a background thread (MayBlock on the
// ThreadPool). Replaying the session commands used to build SessionWindow/SessionTab objects
// whose constructors minted ids through SessionIdGenerator — a pref write to local state,
// whose write timer then started on a thread with no sequence context, a CHECK and a crash
// (SIGABRT, "requires a sequenced context"). It only showed a minute after launch, when the
// local-state writer's 10 s commit timer was no longer running: a start right at startup joins
// the pending write, which is why the tour tests never saw it and a real person did (the file
// formats here mirror components/sessions/core/session_service_commands.cc).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const H = 'app.$.tabstrip.handler_';
const OB = 'app.$.onboarding.shadowRoot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Chromium v3 SNSS session file: "SNSS", int32 version 3, then commands as
// [uint16 size = 1 + payload][uint8 id][payload]. Command 6's payload is a base::Pickle
// with its own uint32 size header: tab_id, nav_index, url, title, page state, transition.
function writeSession(dir, tabs) {
  const pickled = () => {
    const parts = [];
    let len = 0;
    const push = (b) => { parts.push(b); len += b.length; };
    const int32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); push(b); };
    const str = (s, enc) => {
      int32(enc === 'utf16le' ? [...s].length : Buffer.byteLength(s, 'utf8'));
      push(Buffer.from(s, enc));
      while (len % 4) push(Buffer.alloc(1));
    };
    return { int32, string: (s) => str(s, 'utf8'), string16: (s) => str(s, 'utf16le'),
             buffer: () => Buffer.concat(parts) };
  };
  const WINDOW = 1;
  const commands = [];
  const raw = (id, ...vals) => {
    const b = Buffer.alloc(vals.length * 4);
    vals.forEach((v, i) => b.writeInt32LE(v, i * 4));
    commands.push([id, b]);
  };
  raw(14, WINDOW, 100, 100, 1600, 1000, 1); // SetWindowBounds3, shown normal
  raw(9, WINDOW, 0);                         // SetWindowType, a normal window
  tabs.forEach((t, i) => {
    const tab = i + 1;
    raw(0, WINDOW, tab);                     // SetTabWindow
    raw(2, tab, i);                          // SetTabIndexInWindow
    const p = pickled();
    p.int32(tab); p.int32(0);                // tab id, the navigation's index
    p.string(t.url); p.string16(t.title);
    p.string(''); p.int32(0);                // page state, transition
    const body = p.buffer();
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    commands.push([6, Buffer.concat([head, body])]); // UpdateTabNavigation
    raw(7, tab, 0);                          // SetSelectedNavigationIndex
  });
  raw(8, WINDOW, Math.max(tabs.length - 1, 0)); // SetSelectedTabInWindow
  raw(20, WINDOW);                           // SetActiveWindow
  commands.push([255, Buffer.alloc(0)]);     // the initial-state marker
  const version = Buffer.alloc(4);
  version.writeInt32LE(3, 0);
  const parts = [Buffer.from('SNSS', 'latin1'), version];
  for (const [id, payload] of commands) {
    const head = Buffer.alloc(3);
    head.writeUInt16LE(1 + payload.length, 0);
    head.writeUInt8(id, 2);
    parts.push(head, payload);
  }
  fs.mkdirSync(path.join(dir, 'Default', 'Sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Sessions', 'Session_1'), Buffer.concat(parts));
}

// A Chrome-shaped folder: one profile, bookmarks, and the tabs it had open.
function fakeChrome(tabs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-chrome-thread-'));
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { name: 'Personal' } } } }));
  const b = (name, url) => ({ type: 'url', name, url });
  const f = (name, children) => ({ type: 'folder', name, children });
  fs.writeFileSync(path.join(dir, 'Default', 'Bookmarks'), JSON.stringify({ version: 1, roots: {
    bookmark_bar: f('Bookmarks bar', [b('Mail', 'https://mail.example/'), f('Docs', [b('Spec', 'https://docs.example/spec')])]),
    other: f('Other bookmarks', [b('Recipes', 'https://recipes.example/')]),
    synced: f('Mobile bookmarks', []),
  } }));
  writeSession(dir, tabs);
  return dir;
}

test('reading Chrome\'s session file off the main thread neither crashes nor waits on a sequence', async () => {
  const chrome = fakeChrome([
    { url: 'https://example.com/one', title: 'Example One' },
    { url: 'https://example.com/two', title: 'Example Two' },
  ]);
  const noArc = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-noarc-'));
  // The tour falls back to Chrome only when it finds no Arc: point it at an empty
  // folder, never this machine's real Arc (§7).
  const b = await launch(['about:blank'], { args: [`--meridian-arc-dir=${noArc}`, `--meridian-chrome-dir=${chrome}`] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`, 15000);
    // The local-state writer commits at most 10 s after its first pending write at startup.
    // Once that timer has fired it is idle: the next pref write from a pool worker is what
    // crashed. Waiting for it to go quiet makes the crash deterministic, not lucky.
    await sleep(12000);

    // A preview a minute after launch: the session file is read on a background thread.
    const { preview } = await b.eval(`${H}.getArcPreview('chrome')`);
    assert.deepEqual(
      { s: preview.spaceCount, p: preview.pinnedCount, t: preview.todayCount },
      { s: 1, p: 3, t: 2 });
    assert.equal(preview.spaces[0].name, 'Personal');

    // The same read again through the welcome tour (its fallback when there is no Arc).
    await b.eval(`app.$.onboarding.show('tour')`);
    await b.waitFor(`${OB}.getElementById('root').dataset.step === 'hello'`, 15000);
    await b.click(`${OB}.getElementById('next')`);
    await b.waitFor(`${OB}.getElementById('root').dataset.step === 'arc'`, 15000);
    assert.match(await b.eval(`${OB}.querySelector('h2').textContent`), /Bring everything from Chrome/);
    await b.click(`${OB}.getElementById('next')`); // Bring everything
    await b.waitFor(`app.$.tabstrip.state_.spaces.map((s) => s.name).join() === 'Personal'`, 15000);
    await b.waitFor(`['/one', '/two'].every((p) => [...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.url.endsWith(p)))`, 10000);

    // Alive and well after it all.
    assert.equal(await b.eval(`1 + 1`), 2);
  } finally { await b.close(); fs.rmSync(chrome, { recursive: true, force: true }); fs.rmSync(noArc, { recursive: true, force: true }); }
});
