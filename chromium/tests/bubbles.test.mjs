// Chromium's own bubbles in Meridian's window (there is no toolbar or location bar to anchor them):
// permission prompts (asked with or without a click), "download multiple files" and saving a
// password. A test switch lists them and presses their buttons. Camera and location are only
// dismissed here: allowing them would bring up macOS's own prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT = 'PermissionPromptBubbleBaseView';

function site() {
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/file')) {
      res.writeHead(200, { 'content-disposition': `attachment; filename="${req.url.slice(1)}.txt"` });
      res.end('x');
      return;
    }
    if (req.method === 'POST') req.resume();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/done' ? '<title>Signed in</title><h1>Welcome back</h1><p>You are signed in.</p>' :
      `<title>Login</title><form action="/done" method="post"><input name="u" id="u" autocomplete="username">` +
      `<input type="password" name="p" id="p" autocomplete="current-password"><button id="go">Sign in</button></form>`);
  });
  return s;
}

async function open(profile) {
  const s = site();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  // localhost: a secure context, as the permissions need.
  const url = `http://localhost:${s.address().port}/`;
  const b = await launch([url], { profile, args: ['--meridian-test-bubbles', '--use-fake-device-for-media-stream'] });
  await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Login')`);
  const page = await b.page(url);
  // With a click (user activation) or without one, as a site asks on load.
  const run = (code, gesture = true) => page.cdp.send('Runtime.evaluate', { expression: code, userGesture: gesture, awaitPromise: false, returnByValue: true });
  const bubbles = (action = '') => b.eval(`app.$.tabstrip.handler_.testBubbles(${JSON.stringify(action)}).then((r) => r.bubbles)`);
  const waitBubble = async (name) => {
    for (let i = 0; i < 50; i++) { if ((await bubbles()).includes(name)) return; await sleep(100); }
    assert.fail(`no ${name}: ${JSON.stringify(await bubbles())}`);
  };
  return { s, url, b, page, run, bubbles, waitBubble };
}

test('Bubbles: permission prompts show (also without a click) and their answer reaches the page', async () => {
  const { s, b, page, run, bubbles, waitBubble } = await open();
  try {
    // Notifications, allowed.
    await run(`Notification.requestPermission().then((r) => { window.notif = r; })`);
    await waitBubble(PROMPT);
    await bubbles('accept');
    await page.waitFor(`window.notif === 'granted'`);
    // Location asked on load, with no click: still a bubble (Chromium's quiet icon would sit in a
    // location bar Meridian doesn't have). Dismissed.
    await run(`navigator.geolocation.getCurrentPosition(() => {}, () => {})`, false);
    await waitBubble(PROMPT);
    await bubbles('cancel');
    // Camera: dismissed too.
    await run(`navigator.mediaDevices.getUserMedia({ video: true }).catch(() => {})`);
    await waitBubble(PROMPT);
    await bubbles('cancel');
    assert.deepEqual(await bubbles(), []);
  } finally {
    await b.close(); s.closeAllConnections(); s.close();
  }
});

test('Bubbles: a second download from the same page asks first', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-dl-')));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dir, prompt_for_download: false, directory_upgrade: true } }));
  const { s, b, page, run, bubbles, waitBubble } = await open(profile);
  try {
    await run(`(() => { const get = (n) => { const a = document.createElement('a'); a.href = '/' + n; document.body.append(a); a.click(); }; get('file1'); setTimeout(() => get('file2'), 500); })()`);
    await waitBubble(PROMPT);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.txt')), ['file1.txt']);
    await bubbles('accept');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'file2.txt')); i++) await sleep(100);
    assert.ok(fs.existsSync(path.join(dir, 'file2.txt')), 'the second file came after Allow');

    page.close();
  } finally {
    await b.close(); s.closeAllConnections(); s.close();
    for (const d of [profile, dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Bubbles: a submitted password is offered for saving, and Save stores it', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  // No leak check first (it asks Google, which the offer waits for).
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { password_manager_leak_detection: false } }));
  const { s, b, page, run, bubbles, waitBubble } = await open(profile);
  try {
    // Sign in, typing like a person (Chromium offers only what was typed): "Save password?" in
    // the window; Save stores it.
    const type = async (id, text) => {
      await page.eval(`(document.getElementById('${id}').focus(), true)`);
      await page.cdp.send('Input.insertText', { text });
    };
    await type('u', 'dima');
    await type('p', 'correct-horse-7');
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitBubble('PasswordSaveUpdateView');
    await bubbles('accept');
    for (let i = 0; i < 30 && (await bubbles()).length; i++) await sleep(100);
    assert.deepEqual(await bubbles(), []);
    // Saved: the password manager has it for this site.
    await b.eval(`app.$.tabstrip.openUrl('chrome://password-manager/passwords')`);
    const pm = await b.page('chrome://password-manager');
    await pm.waitFor(`(() => { const deep = (root) => [root, ...[...root.querySelectorAll('*')].filter((e) => e.shadowRoot).flatMap((e) => deep(e.shadowRoot))]; return deep(document).some((r) => r.textContent?.includes('localhost')); })()`, 15000);
    pm.close();
    page.close();
  } finally {
    await b.close(); s.closeAllConnections(); s.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
