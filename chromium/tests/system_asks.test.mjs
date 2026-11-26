// Before macOS asks about Meridian for the first time (camera, microphone, recording the screen,
// notifications, location), Meridian's own sheet says what will appear and which button to press,
// once per kind. macOS is never asked here: --meridian-test-system-asks makes every kind "not
// decided yet" and answers a request "allowed" at once, and the sheet's System Settings button
// only writes to a log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const T = 'app.$.tabstrip';
const SA = 'app.$.systemAsk';
const SAR = `${SA}.shadowRoot`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve(body) {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body(req.url)); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

const CAM = `<!doctype html><title>Call</title><script>
window.ask = () => { window.got = 'waiting'; navigator.mediaDevices.getUserMedia({ video: true })
  .then((s) => { window.got = 'camera:' + s.getVideoTracks().length; })
  .catch((e) => { window.got = 'error: ' + e.name; }); };
</script>`;

test('the camera: Meridian’s sheet first, then macOS; once, also after a restart', { skip: process.platform === 'win32' && 'macOS asks these' }, async () => {
  const server = await serve(() => CAM);
  const url = `http://127.0.0.1:${server.address().port}/call`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const log = path.join(profile, '..', `${path.basename(profile)}-asks.log`);
  const args = [`--meridian-test-system-asks=${log}`, '--use-fake-device-for-media-stream'];
  let b = await launch([url], { profile, args });
  try {
    await b.waitFor(`[...${T}.tabs_.values()].some((t) => t.isActive && t.title === 'Call')`, 15000);
    // The site may use the camera (as if the person said Allow to its question).
    await b.eval(`${T}.handler_.setSitePermission(${JSON.stringify(new URL(url).origin)}, 'camera', 'allow')`);
    const page = await b.page(url);
    await page.eval('ask()');
    // Meridian's sheet, and macOS hasn't been asked yet: the page still waits.
    await b.waitFor(`${SA}.open && ${SAR}.getElementById('card').dataset.kind === 'camera'`, 10000);
    assert.match(await b.eval(`${SAR}.getElementById('title').textContent`), /Your Mac will ask about the camera/);
    assert.match(await b.eval(`${SAR}.getElementById('card').textContent`), /Press Allow/);
    // The drawing of macOS's window, its Allow glowing.
    assert.equal(await b.eval(`${SAR}.querySelector('meridian-mac-ask').shadowRoot.querySelector('.press').textContent.trim()`), 'Allow');
    await sleep(600);
    assert.equal(await page.eval('window.got'), 'waiting');
    // Pressed the wrong button? The right pane of System Settings (a log line here).
    assert.equal(await b.eval(`${SAR}.getElementById('settings').textContent.trim()`), 'Open Camera settings');
    await b.click(`${SAR}.getElementById('settings')`);
    await waitForFile(log, /settings camera/);
    await b.click(`${SAR}.getElementById('ok')`);
    await page.waitFor(`window.got === 'camera:1'`, 10000);
    assert.equal(await b.eval(`${SA}.open`), false);
    // Again: macOS has decided, nothing to explain.
    await page.eval('ask()');
    await page.waitFor(`window.got === 'camera:1'`, 10000);
    assert.equal(await b.eval(`${SA}.open`), false);
    page.close();
    await b.quit();

    // After a restart macOS would ask again here (the fake forgets), but the sheet was shown.
    b = await launch([url], { profile, args });
    await b.waitFor(`[...${T}.tabs_.values()].some((t) => t.isActive && t.title === 'Call')`, 15000);
    const again = await b.page(url);
    await again.eval('ask()');
    await again.waitFor(`window.got === 'camera:1'`, 10000);
    assert.equal(await b.eval(`${SA}.open`), false);
    again.close();
  } finally {
    await b.close(); server.close();
    fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(log, { force: true });
  }
});

async function waitForFile(file, re, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (re.test(fs.readFileSync(file, 'utf8'))) return; } catch {}
    await sleep(100);
  }
  throw new Error(`${file} never matched ${re}`);
}

const SHARE = `<!doctype html><title>Meeting</title><script>
window.share = () => { window.shared = 'waiting'; navigator.mediaDevices.getDisplayMedia({ video: true })
  .then((s) => { window.shared = s.getVideoTracks()[0].getSettings().displaySurface; })
  .catch((e) => { window.shared = 'error: ' + e.name; }); };
</script>`;

test('sharing the screen: the sheet says which switch and Quit & Reopen, then the picker', { skip: process.platform === 'win32' && 'macOS asks these' }, async () => {
  const server = await serve((u) => u.startsWith('/slides') ? '<!doctype html><title>Slides deck</title>' : SHARE);
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await launch([`${base}/slides`, `${base}/meet`], { args: ['--meridian-test-system-asks', '--auto-select-tab-capture-source-by-title=Slides deck'] });
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Meeting')`, 15000);
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Meeting').shadowRoot.querySelector('.row')`);
    const page = await b.page(`${base}/meet`);
    await page.waitFor(`document.readyState === 'complete' && typeof share === 'function'`);
    // getDisplayMedia needs a person's click.
    await page.cdp.send('Runtime.evaluate', { expression: 'share()', userGesture: true });
    await b.waitFor(`${SA}.open && ${SAR}.getElementById('card').dataset.kind === 'screen'`, 10000);
    const text = await b.eval(`${SAR}.getElementById('card').textContent.replace(/\\s+/g, ' ')`);
    assert.match(text, /Sharing a tab works right away/);
    assert.match(text, /Quit & Reopen/);
    assert.equal(await b.eval(`${SAR}.querySelectorAll('ol li').length`), 3);
    assert.equal(await b.eval(`${SAR}.querySelector('meridian-mac-ask').shadowRoot.querySelector('.press').textContent.trim()`), 'Quit & Reopen');
    assert.equal(await page.eval('window.shared'), 'waiting');
    await b.click(`${SAR}.getElementById('ok')`);
    // Then the picker, as always (a tab here).
    assert.equal(await page.waitFor(`window.shared !== 'waiting' && window.shared`, 10000), 'browser');
    page.close();
  } finally { await b.close(); server.close(); }
});

test('every kind has its words, its drawing and a way back from the wrong button', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!${SA}`);
    const want = {
      camera: ['Your Mac will ask about the camera', 'Allow', 'Open Camera settings'],
      microphone: ['Your Mac will ask about the microphone', 'Allow', 'Open Microphone settings'],
      location: ['Your Mac will ask about the location', 'Allow', 'Open Location Services settings'],
      notifications: ['Your Mac will ask about notifications', 'Allow', 'Open Notifications settings'],
      screen: ['Sharing your screen takes one switch on your Mac', 'Quit & Reopen', 'Open Screen Recording settings'],
    };
    for (const [kind, [title, press, settings]] of Object.entries(want)) {
      await b.eval(`${SA}.show(${JSON.stringify(kind)})`);
      await b.waitFor(`${SA}.open && ${SAR}.getElementById('card').dataset.kind === ${JSON.stringify(kind)}`);
      assert.equal(await b.eval(`${SAR}.getElementById('title').textContent.trim()`), title);
      assert.equal(await b.eval(`${SAR}.querySelector('meridian-mac-ask').shadowRoot.querySelector('.press').textContent.trim()`), press);
      assert.equal(await b.eval(`${SAR}.getElementById('settings').textContent.trim()`), settings);
      assert.match(await b.eval(`${SAR}.querySelector('.wrong').textContent`), /Pressed (Don’t Allow|Later)\?/);
      await b.click(`${SAR}.getElementById('ok')`);
      await b.waitFor(`!${SA}.open`);
    }
    // Two at once (camera and microphone): one after the other.
    await b.eval(`${SA}.show('camera'), ${SA}.show('microphone')`);
    await b.waitFor(`${SAR}.getElementById('card')?.dataset.kind === 'camera'`);
    await b.click(`${SAR}.getElementById('ok')`);
    await b.waitFor(`${SA}.open && ${SAR}.getElementById('card').dataset.kind === 'microphone'`);
    await b.click(`${SAR}.getElementById('ok')`);
    await b.waitFor(`!${SA}.open`);
  } finally { await b.close(); }
});

// From 0.x (signed by Meridian) to 1.x (Apple's Developer ID) macOS asks about "Meridian Safe Storage"
// before the first window, and at every start until Always Allow. The 0.x app can't be taught to say
// so beforehand, so the first 1.x window says it, once per profile last opened by 0.x.
test('first start of 1.x on a 0.x profile: the keychain question explained, Always Allow; once', { skip: process.platform !== 'darwin' && 'macOS asks this' }, async () => {
  const profileOf = (meridian) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
    fs.mkdirSync(path.join(dir, 'Default'));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ meridian }));
    return dir;
  };
  const old = profileOf({ last_version: '0.6.30', onboarded: true });
  const recent = profileOf({ last_version: '1.0.0', onboarded: true });
  const args = ['--meridian-test-changelog-url='];
  let b;
  try {
    b = await launch(['about:blank'], { profile: old, args });
    await b.waitFor(`${SA}.open && ${SAR}.getElementById('card').dataset.kind === 'safe-storage'`, 10000);
    assert.match(await b.eval(`${SAR}.getElementById('title').textContent`), /Meridian Safe Storage/);
    assert.match(await b.eval(`${SAR}.getElementById('card').textContent`), /Press Always Allow/);
    const mac = `${SAR}.querySelector('meridian-mac-ask').shadowRoot`;
    assert.equal(await b.eval(`${mac}.querySelector('.press').textContent.trim()`), 'Always Allow');
    assert.match(await b.eval(`${mac}.textContent`), /“Meridian Safe Storage”/);
    assert.equal(await b.eval(`!!${SAR}.getElementById('settings')`), false, 'no System Settings pane for this one');
    await b.click(`${SAR}.getElementById('ok')`);
    await b.waitFor(`!${SA}.open`);
    await b.quit();

    // The next start: already said.
    b = await launch([], { profile: old, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await sleep(2500);
    assert.equal(await b.eval(`${SA}.open`), false, 'said once');
    await b.close();

    // A profile 1.x opened before: the same signature, nothing to explain.
    b = await launch(['about:blank'], { profile: recent, args });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await sleep(2500);
    assert.equal(await b.eval(`${SA}.open`), false, 'not after 1.x');
  } finally {
    await b?.close();
    for (const d of [old, recent]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Restart to update says nothing about the keychain: the 0.x app that would show it never had this code', { skip: process.platform === 'win32' && 'macOS asks these' }, async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!app.$.updateSheet`);
    const US = 'app.$.updateSheet';
    await b.eval(`${US}.show({ status: 0, current: '0.6.31', version: '1.0.0', progress: 1, error: '', pageUrl: '', notes: '' })`);
    await b.waitFor(`${US}.open`);
    assert.equal(await b.eval(`!!${US}.shadowRoot.getElementById('safeStorage')`), false);
  } finally { await b.close(); }
});
