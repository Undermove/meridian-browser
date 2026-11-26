// "The person clicks and it installs": Meridian started from Downloads (or from where it was
// unzipped) offers to move itself into Applications, and replaces an older Meridian there (it goes
// to the Trash; the profile is never touched). macOS only. The real Applications folder and Trash
// are never touched: --meridian-test-applications-dir points at a temp "Applications" (its Trash
// is a "Trash" folder next to it), the app that moves is a small stand-in bundle, and the
// question is answered by --meridian-test-install-answer instead of a person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, launch } from './harness.mjs';

const SKIP = process.platform !== 'darwin' && 'macOS only';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real app's bundle id and version: the stand-in is "this Meridian".
function ownInfo() {
  const plist = path.join(APP.split('/Contents/MacOS/')[0], 'Contents', 'Info.plist');
  const read = (key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', plist], { encoding: 'utf8' }).trim();
  return { id: read('CFBundleIdentifier'), version: read('CFBundleShortVersionString') };
}

// A bundle with just an Info.plist and a marker file.
function fakeApp(dir, { id, version, marker }) {
  const app = path.join(dir, 'Meridian.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`);
  fs.writeFileSync(path.join(app, 'Contents', 'marker'), marker);
  return app;
}

function setUp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-install-'));
  const apps = path.join(root, 'Applications');
  const downloads = path.join(root, 'Downloads');
  fs.mkdirSync(apps);
  fs.mkdirSync(downloads);
  const log = path.join(root, 'install.log');
  const own = ownInfo();
  const source = fakeApp(downloads, { ...own, marker: 'new' });
  const args = [`--meridian-test-applications-dir=${apps}`, `--meridian-test-install-source=${source}`, `--meridian-test-install-log=${log}`];
  return { root, apps, downloads, log, own, source, args, read: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}

// Starts Meridian as a person would the first time (no --no-first-run) and waits for it to quit
// by itself: after moving, it hands over to the copy in Applications.
async function runToExit(args) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  // Never the real browsers' folders, should the first run look for them.
  const none = ['arc', 'chrome', 'brave', 'edge', 'vivaldi', 'opera', 'firefox', 'safari'].map((k) => `--meridian-${k}-dir=${path.join(profile, 'none')}`);
  const proc = spawn(APP, [`--user-data-dir=${profile}`, '--use-mock-keychain', '--meridian-test-background', '--no-default-browser-check', ...none, ...args], { stdio: 'ignore' });
  const code = await Promise.race([
    new Promise((r) => proc.once('exit', (c) => r(c))),
    sleep(30000).then(() => 'still running'),
  ]);
  if (code === 'still running') proc.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
  return code;
}

test('from Downloads: one click moves it into Applications, the downloaded copy goes to the Trash', { skip: SKIP }, async () => {
  const t = setUp();
  try {
    assert.equal(await runToExit([...t.args, '--meridian-test-install-answer=yes']), 0, 'quits for the installed copy');
    const log = t.read();
    assert.match(log, /^asked: Move Meridian to Applications\? \| Meridian is running from your Downloads folder\. It moves itself to your Applications folder, opens from there and keeps itself up to date\. \| Move to Applications \| Not Now$/m);
    assert.match(log, new RegExp(`^installed ${t.apps}/Meridian\\.app$`, 'm'));
    assert.match(log, /^relaunch$/m);
    assert.equal(fs.readFileSync(path.join(t.apps, 'Meridian.app', 'Contents', 'marker'), 'utf8'), 'new');
    assert.equal(fs.existsSync(t.source), false, 'moved, not copied');
    assert.equal(fs.readFileSync(path.join(t.root, 'Trash', 'Meridian.app', 'Contents', 'marker'), 'utf8'), 'new');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('an older Meridian in Applications: replaced, the old one in the Trash', { skip: SKIP }, async () => {
  const t = setUp();
  try {
    fakeApp(t.apps, { id: t.own.id, version: '100.0.0.0', marker: 'old' });
    assert.equal(await runToExit([...t.args, '--meridian-test-install-answer=yes']), 0);
    const log = t.read();
    assert.match(log, /^asked: Replace the Meridian in Applications\? \| There’s already a Meridian in your Applications folder\. It goes to the Trash and this one takes its place\. Your tabs, spaces and sign-ins stay as they are\. \| Replace \| Not Now$/m);
    assert.match(log, new RegExp(`^trashed ${t.apps}/Meridian\\.app$`, 'm'));
    assert.equal(fs.readFileSync(path.join(t.apps, 'Meridian.app', 'Contents', 'marker'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(t.root, 'Trash', 'Meridian.app', 'Contents', 'marker'), 'utf8'), 'old');
    // The downloaded copy is in the Trash too, beside it.
    assert.equal(fs.readFileSync(path.join(t.root, 'Trash', 'Meridian 2.app', 'Contents', 'marker'), 'utf8'), 'new');
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('Not Now: Meridian keeps running from where it is, nothing moves', { skip: SKIP }, async () => {
  const t = setUp();
  const b = await launch(['about:blank'], { firstRun: true, args: [...t.args, '--meridian-test-install-answer=no'] });
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!app.$.tabstrip`, 15000);
    const log = t.read();
    assert.match(log, /^asked: Move Meridian to Applications\?/m);
    assert.match(log, /^declined$/m);
    assert.deepEqual(fs.readdirSync(t.apps), []);
    assert.ok(fs.existsSync(t.source));
  } finally { await b.close(); fs.rmSync(t.root, { recursive: true, force: true }); }
});

test('something else called Meridian, or a newer Meridian, in Applications: left alone, no question', { skip: SKIP }, async () => {
  for (const other of [{ id: 'com.example.other', version: '1.0', marker: 'other' }, { id: ownInfo().id, version: '999.0.0.0', marker: 'newer' }]) {
    const t = setUp();
    fakeApp(t.apps, other);
    const b = await launch(['about:blank'], { firstRun: true, args: [...t.args, '--meridian-test-install-answer=yes'] });
    try {
      await b.waitFor(`typeof app !== 'undefined' && !!app.$.tabstrip`, 15000);
      assert.equal(t.read(), '', `no question (${other.marker})`);
      assert.equal(fs.readFileSync(path.join(t.apps, 'Meridian.app', 'Contents', 'marker'), 'utf8'), other.marker);
      assert.ok(fs.existsSync(t.source));
    } finally { await b.close(); fs.rmSync(t.root, { recursive: true, force: true }); }
  }
});
