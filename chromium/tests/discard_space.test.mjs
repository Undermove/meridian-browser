// A tab of a space with its own profile, discarded to free memory (Memory Saver, low memory, or
// chrome://discards): Chromium made the replacement page in the window's profile and its CHECK that
// both are the same crashed the browser. Chromium's field-trial config hides that path today
// (WebContentsDiscard); this runs without it, as a release without that config would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('discarding a tab of a space with its own profile: no crash, the tab comes back', async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title><h1>${req.url}</h1>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const u = (p) => `http://127.0.0.1:${server.address().port}/${p}`;
  const T = 'app.$.tabstrip';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-discard-'));
  // chrome://discards is one of Chromium's debugging pages: on, as chrome://chrome-urls turns them on.
  fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ internal_only_uis_enabled: true }));
  const b = await launch([u('home')], { profile, args: ['--disable-field-trial-config'] });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const personal = await b.eval(`${T}.state_.spaces[0].id`);
    const { profileId } = await b.eval(`${T}.handler_.addProfile('Work')`);
    const { spaceId: work } = await b.eval(`${T}.handler_.createSpace('Work', '', '', '')`);
    await b.eval(`${T}.handler_.setSpaceProfile(${JSON.stringify(work)}, ${JSON.stringify(profileId)})`);
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(work)})`);
    await b.waitFor(`${T}.state_.profileId === ${JSON.stringify(profileId)}`);
    await b.eval(`${T}.openUrl(${JSON.stringify(u('worktab'))})`);
    await b.waitFor(`[...${T}.tabs_.values()].some((t) => t.title === 'worktab')`);
    // Back to the first space: the work tab is in the background.
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(personal)})`);
    await b.waitFor(`${T}.state_.activeSpaceId === ${JSON.stringify(personal)}`);
    // chrome://discards: "Urgent discard" on the work tab's row.
    await b.eval(`${T}.openUrl('chrome://discards')`);
    const d = await b.page('chrome://discards');
    const deep = `((root) => { const all = []; const walk = (r) => { for (const e of r.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(root); return all; })(document)`;
    const clickDiscard = `(() => { const rows = ${deep}.filter((e) => e.tagName === 'TR' && e.textContent.includes('/worktab')); const link = rows.flatMap((r) => [...r.querySelectorAll('*')]).find((e) => /urgent discard/i.test(e.textContent) && !e.children.length); if (!link) return false; link.click(); return true; })()`;
    let clicked = false;
    for (let i = 0; i < 50 && !clicked; i++) { clicked = await d.eval(clickDiscard); if (!clicked) await sleep(200); }
    assert.ok(clicked, 'the work tab has an Urgent discard action');
    await sleep(1500);
    assert.equal(await b.eval('1 + 1'), 2, 'the browser lives');
    d.close();
    // The work tab is still there and loads again when shown.
    await b.eval(`${T}.handler_.activateSpace(${JSON.stringify(work)})`);
    const id = await b.eval(`[...${T}.tabs_.values()].find((t) => t.title === 'worktab')?.id`);
    assert.ok(id, 'the tab stays in the sidebar');
    await b.eval(`${T}.activateTab(${JSON.stringify(id)})`);
    await b.waitFor(`[...${T}.tabs_.values()].find((t) => t.isActive)?.title === 'worktab'`);
  } finally { await b.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
