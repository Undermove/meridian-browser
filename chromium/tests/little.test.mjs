// Little window: a web link from another app opens in a small window without the sidebar;
// "Open in Meridian" moves it into the main window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, SB } from './harness.mjs';
import { startServer } from './server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What macOS does when a link is clicked in another app: a GetURL Apple event, sent to this test's
// browser by pid (`open -a` picks by bundle id: with the installed Meridian running, it went there).
let opener;
async function openFromOtherApp(b, url) {
  if (!opener) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-open-'));
    process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    opener = path.join(dir, 'open_url');
    await promisify(execFile)('swiftc', ['-O', path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'open_url.swift'), '-o', opener]);
  }
  await promisify(execFile)(opener, [String(b.proc.pid), url]);
}
const todayTitles = `[...${SB}.querySelectorAll('meridian-tab-row')].map((r) => r.tab.title)`;

test('a link from another app opens in a Little window; Open in Meridian moves it to the main window', async () => {
  const site = await startServer();
  const b = await launch([site.url('/p/Main')]);
  try {
    await b.waitFor(`${todayTitles}.includes('Main')`);
    await openFromOtherApp(b, site.url('/p/Little'));
    let little, seen = 'no other window';
    for (let i = 0; i < 100 && !little; i++) {
      await sleep(200);
      const [w] = await b.otherWindows();
      if (w && await w.eval(`app?.hasAttribute('little') && app.shadowRoot.querySelector('#littleBar .host').textContent === '127.0.0.1'`)) {
        little = w;
      } else {
        if (w) seen = await w.eval(`[app?.hasAttribute('little'), app?.shadowRoot.querySelector('#littleBar')?.outerHTML]`).catch((e) => e.message);
        w?.close();
      }
    }
    assert.ok(little, `a Little window opened (last seen: ${JSON.stringify(seen)})`);
    if (process.env.SHOT) await little.screenshot(process.env.SHOT);
    assert.equal(await little.eval(`getComputedStyle(app.shadowRoot.getElementById('sidebar')).display`), 'none');
    assert.equal(await little.eval(`app.$.tabstrip.state_.tabs.length`), 1);
    // The main window didn't get the link.
    assert.deepEqual(await b.eval(todayTitles), ['Main']);

    await little.eval(`app.shadowRoot.getElementById('openInMeridian').click()`);
    await b.waitFor(`${todayTitles}.includes('Little')`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Little')?.tab.isActive`);
    little.close();
    const windowCount = async () => { const ws = await b.otherWindows(); ws.forEach((w) => w.close()); return ws.length; };
    for (let i = 0; i < 50 && await windowCount(); i++) await sleep(200);
    assert.equal(await windowCount(), 0, 'the Little window closed');
  } finally { await b.close(); await site.close(); }
});

test('Air Traffic Control: a matching rule sends the link to the main window instead', async () => {
  const site = await startServer();
  // Settings → Links writes this pref; here it's seeded into a new profile.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({
    meridian: { atc: { fallback: 'little', rules: [{ id: 'r1', pattern: '127.0.0.1/p/work', target: 'main' }] } },
  }));
  const b = await launch([site.url('/p/Main')], { profile });
  try {
    await b.waitFor(`${todayTitles}.includes('Main')`);
    await openFromOtherApp(b, site.url('/p/Work'));
    await b.waitFor(`${todayTitles}.includes('Work')`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Work')?.tab.isActive`);
    const count = async () => { const ws = await b.otherWindows(); ws.forEach((w) => w.close()); return ws.length; };
    assert.equal(await count(), 0, 'no Little window for a matching link');
    // Anything else still goes to the Little window.
    await openFromOtherApp(b, site.url('/p/Elsewhere'));
    for (let i = 0; i < 50 && !(await count()); i++) await sleep(200);
    assert.equal(await count(), 1);
    assert.ok(!(await b.eval(todayTitles)).includes('Elsewhere'));
  } finally { await b.close(); await site.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

// Arc: a Little window opens in the space last used, with that space's logins (its profile), and
// its bar picks another space: the page opens again there. Open in Meridian then lands it in that
// space. A login here was asked for in the work space and opened in the personal one.
test('a Little window opens in the last space with its logins; the bar moves it to another space', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    // The title says which cookie the page sees.
    res.end(req.url === '/home' ? '<title>home</title>'
      : req.url === '/login' ? `<title>login</title><script>document.cookie = 'who=work; max-age=600'</script>`
      : `<title>-</title><script>document.title = 'auth ' + (document.cookie || 'none')</script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const u = (p) => `http://127.0.0.1:${server.address().port}/${p}`;
  const T = 'app.$.tabstrip';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-little-'));
  const b = await launch([u('home')], { profile });
  // A real click in the Little window.
  const click = async (w, expr) => {
    const p = await w.eval(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await w.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
    }
  };
  const waitIn = async (w, expr, what) => {
    let last;
    for (let i = 0; i < 75; i++) { last = await w.eval(expr).catch((e) => e.message); if (last === true) return; await sleep(200); }
    assert.fail(`${what} (last: ${JSON.stringify(last)})`);
  };
  try {
    await b.waitFor(`${todayTitles}.includes('home')`);
    const personal = await b.eval(`${T}.state_.spaces[0].id`);
    const personalName = await b.eval(`${T}.state_.spaces[0].name`);
    const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
    const { spaceId: work } = await b.eval(`${T}.handler_.createSpace('Work', '', '#e08a8a', '#f0b5a8')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(work)}, ${JSON.stringify(profileId)})`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(work)})`);
    await b.waitFor(`${T}.state_.profileId === ${JSON.stringify(profileId)}`);
    // Logged in at work.
    await b.eval(`${T}.openUrl(${JSON.stringify(u('login'))})`);
    await b.waitFor(`${todayTitles}.includes('login')`);

    await openFromOtherApp(b, u('auth'));
    let little;
    for (let i = 0; i < 100 && !little; i++) {
      await sleep(200);
      const [w] = await b.otherWindows();
      if (w && await w.eval(`!!app?.hasAttribute('little') && !!app.shadowRoot.getElementById('littleSpace')`).catch(() => false)) little = w;
      else w?.close();
    }
    assert.ok(little, 'a Little window opened with a space button');
    await waitIn(little, `app.shadowRoot.querySelector('#littleSpace .name')?.textContent.trim() === 'Work'`, 'it names Work');
    await waitIn(little, `${T}.state_.tabs.length === 1 && [...${T}.tabs_.values()][0]?.title === 'auth who=work'`, 'the page sees the work login');
    if (process.env.SHOT) await little.screenshot(process.env.SHOT);

    // The picker: every space, Work checked; pick the personal one.
    await click(little, `app.shadowRoot.getElementById('littleSpace')`);
    await waitIn(little, `app.shadowRoot.querySelectorAll('#littleSpaces .little-space').length === 2`, 'both spaces listed');
    assert.equal(await little.eval(`app.shadowRoot.querySelector('#littleSpaces [aria-checked="true"] .name').textContent.trim()`), 'Work');
    await click(little, `[...app.shadowRoot.querySelectorAll('#littleSpaces .little-space')].find((e) => e.dataset.space === ${JSON.stringify(personal)})`);
    await waitIn(little, `!app.shadowRoot.getElementById('littleSpaces')`, 'the picker closes');
    await waitIn(little, `${T}.state_.littleSpaceId === ${JSON.stringify(personal)} && ${T}.state_.tabs.length === 1 && [...${T}.tabs_.values()][0]?.title === 'auth none'`, 'the page opens again without the work login');
    assert.equal(await little.eval(`app.shadowRoot.querySelector('#littleSpace .name').textContent.trim()`), personalName);

    // Open in Meridian: into the personal space, which the main window now shows.
    await click(little, `app.shadowRoot.getElementById('openInMeridian')`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(personal)}`);
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'auth none'`);
    await b.waitFor(`${todayTitles}.includes('auth none')`);
    little.close();
  } finally { await b.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
