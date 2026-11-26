// Copy clean links (Settings > Advanced, on by default): Copy Link in a tab's menu, the address
// bar's controls and ⇧⌘C leave out tracking parameters (utm_*, fbclid, gclid…) and keep the rest and
// the fragment. Off, the link is copied as it is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { launch, SB } from './harness.mjs';

const MAC = process.platform === 'darwin';
const T = 'app.$.tabstrip';

test('Copy Link copies the address without tracking parameters unless that is turned off', { skip: !MAC && 'reads the clipboard with pbpaste' }, async () => {
  const saved = execFileSync('pbpaste');  // the person's clipboard comes back afterwards
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Post</title><h1>post</h1>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dirty = `${base}/post?id=7&utm_source=news&utm_medium=mail&fbclid=abc&gclid=1&mc_eid=x#comments`;
  const clean = `${base}/post?id=7#comments`;
  const b = await launch([dirty, 'data:text/html,<title>Other</title>']);
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const clip = async (want) => { let t = ''; for (let i = 0; i < 40 && t !== want; i++) { await new Promise((r) => setTimeout(r, 100)); t = execFileSync('pbpaste').toString(); } return t; };
  try {
    await b.waitFor(`!!${row('Post')} && !!${row('Other')}`, 15000);
    assert.equal((await b.eval(`${T}.handler_.getSettings()`)).settings.cleanLinks, true, 'on by default');
    // A tab's menu, for a tab in the background.
    execFileSync('pbcopy', { input: 'before' });
    await b.menu(`${row('Post')}.shadowRoot.querySelector('.row')`, 'Copy Link');
    assert.equal(await clip(clean), clean);
    // The address bar's link button on the open tab (what ⇧⌘C runs, shortcuts.test.mjs).
    await b.eval(`${T}.activateTab(${row('Post')}.tab.id)`);
    await b.waitFor(`${row('Post')}.tab.isActive`);
    execFileSync('pbcopy', { input: 'before' });
    await b.eval(`app.shadowRoot.getElementById('copyLinkButton').click()`);
    assert.equal(await clip(clean), clean, 'the link button');
    // Off: as it is.
    await b.eval(`${T}.handler_.getSettings().then(({settings}) => ${T}.handler_.setSettings({...settings, cleanLinks: false}))`);
    await b.waitFor(`${T}.handler_.getSettings().then((r) => !r.settings.cleanLinks)`);
    execFileSync('pbcopy', { input: 'before' });
    await b.menu(`${row('Post')}.shadowRoot.querySelector('.row')`, 'Copy Link');
    assert.equal(await clip(dirty), dirty, 'off: the whole link');
    execFileSync('pbcopy', { input: 'before' });
    await b.eval(`app.shadowRoot.getElementById('copyLinkButton').click()`);
    assert.equal(await clip(dirty), dirty, 'off: the link button too');
    // What the sidebar asks for many links at once.
    assert.equal((await b.eval(`${T}.handler_.copyLinks([${JSON.stringify(dirty)}, 'not a url'])`)).text, `${dirty}\nnot a url`);
    await b.eval(`${T}.handler_.getSettings().then(({settings}) => ${T}.handler_.setSettings({...settings, cleanLinks: true}))`);
    await b.waitFor(`${T}.handler_.getSettings().then((r) => r.settings.cleanLinks)`);
    const many = `${clean}\nhttps://open.spotify.com/track/1`;
    assert.equal((await b.eval(`${T}.handler_.copyLinks([${JSON.stringify(dirty)}, 'https://open.spotify.com/track/1?si=abc'])`)).text, many);
    assert.equal(await clip(many), many, 'Copy Links: one per line');
  } finally {
    await b.close(); server.close();
    execFileSync('pbcopy', { input: saved });
  }
});
