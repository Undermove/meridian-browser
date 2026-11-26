// Live folders (Arc's): a pinned folder made live from its menu ("Make Live…") shows the first 10
// items of an RSS or Atom feed or a GitHub search as pinned rows, refreshed on a timer (30 minutes;
// seconds here). Local fake feeds only: GitHub's API is a test server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const SHOTS = process.env.MERIDIAN_SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 'app.$.tabstrip.handler_';

test('Make Live… fills a folder from a feed, refreshes it; Atom and GitHub search too; a page that is no feed is refused', async () => {
  let round = 'Story';
  let githubQuery = '';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/rss.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      const items = Array.from({ length: 12 }, (_, i) => `<item><title>${round} ${i + 1}</title><link>/post/${round}-${i + 1}</link></item>`).join('');
      return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>News</title>${items}</channel></rss>`);
    }
    if (u.pathname === '/atom.xml') {
      res.writeHead(200, { 'content-type': 'application/atom+xml' });
      return res.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
        <entry><title>Atom one</title><link rel="alternate" href="http://127.0.0.1:${server.address().port}/a/1"/></entry>
        <entry><title><![CDATA[Atom two]]></title><link href="/a/2"/></entry></feed>`);
    }
    if (u.pathname === '/api/search/issues') {
      githubQuery = u.searchParams.get('q');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ total_count: 2, items: [
        { title: 'Crash on start', html_url: 'https://github.com/o/r/issues/1' },
        { title: 'Tabs vanish', html_url: 'https://github.com/o/r/issues/2' },
      ] }));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Just a page</title><p>no feed here</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const b = await launch([`${origin}/page`], { args: [`--meridian-test-github-api=${origin}/api`, '--meridian-test-live-folder-seconds=3'] });
  const folder = (id) => `${H}.getState().then((r) => { const find = (l) => { for (const i of l) { if (i.id === ${JSON.stringify(id)}) return i; const c = find(i.children); if (c) return c; } return null; }; return find(r.state.spaces.find((s) => s.id === r.state.activeSpaceId).pinned); })`;
  const titles = (id) => b.eval(`${folder(id)}.then((f) => f.children.map((c) => c.title))`);
  const row = (id) => `[...${SB}.querySelectorAll('meridian-item')].find((e) => e.item?.id === ${JSON.stringify(id)})`;
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'Just a page')`, 15000);
    const space = await b.eval(`${H}.getState().then((r) => r.state.activeSpaceId)`);
    const add = (title) => b.eval(`${H}.addFolder({ container: ${JSON.stringify(space)}, parentId: '', index: -1 }, ${JSON.stringify(title)}).then((r) => r.itemId)`);
    const news = await add('News');
    await b.waitFor(`!!${row(news)}`);

    // From the folder's menu, as a person does: the address in place of its name, then Return.
    await b.menu(`${row(news)}.shadowRoot.querySelector('.row.folder')`, 'Make Live…');
    await b.waitFor(`${row(news)}.shadowRoot.querySelector('input.live-url') === ${row(news)}.shadowRoot.activeElement`);
    await b.type(`${origin}/rss.xml`);
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`${folder(news)}.then((f) => f.liveUrl === ${JSON.stringify(origin + '/rss.xml')} && f.children.length === 10)`, 15000);
    assert.deepEqual(await titles(news), Array.from({ length: 10 }, (_, i) => `Story ${i + 1}`));
    assert.equal(await b.eval(`${folder(news)}.then((f) => f.children[0].url)`), `${origin}/post/Story-1`, 'relative links resolve');
    // Pinned-like rows, and the bolt on the folder.
    await b.waitFor(`${row(news)}.shadowRoot.querySelectorAll('.children meridian-item').length === 10`);
    assert.ok(await b.eval(`!!${row(news)}.shadowRoot.querySelector('.row.folder .live')`));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await sleep(400); await b.screenshot(path.join(SHOTS, 'live-folder.png')); }

    // The timer: the feed changes, the folder follows (ids of links kept stay).
    round = 'Fresh';
    await b.waitFor(`${folder(news)}.then((f) => f.children[0].title === 'Fresh 1')`, 20000);

    // Atom, and a GitHub search page (through the API).
    const blog = await add('Blog');
    assert.equal(await b.eval(`${H}.setFolderLive(${JSON.stringify(blog)}, ${JSON.stringify(origin + '/atom.xml')}).then((r) => r.error)`), '');
    assert.deepEqual(await titles(blog), ['Atom one', 'Atom two']);
    const bugs = await add('Bugs');
    assert.equal(await b.eval(`${H}.setFolderLive(${JSON.stringify(bugs)}, 'https://github.com/search?q=repo%3Ao%2Fr+crash&type=issues').then((r) => r.error)`), '');
    assert.deepEqual(await titles(bugs), ['Crash on start', 'Tabs vanish']);
    assert.equal(githubQuery, 'repo:o/r crash is:issue');

    // A page that isn't a feed: refused, the folder stays an ordinary one.
    const plain = await add('Plain');
    assert.match(await b.eval(`${H}.setFolderLive(${JSON.stringify(plain)}, ${JSON.stringify(origin + '/page')}).then((r) => r.error)`), /isn't an RSS or Atom feed/);
    assert.equal(await b.eval(`${folder(plain)}.then((f) => f.liveUrl)`), '');

    // Stop Live Updates: the items stay, nothing changes them any more.
    await b.menu(`${row(news)}.shadowRoot.querySelector('.row.folder')`, 'Stop Live Updates');
    await b.waitFor(`${folder(news)}.then((f) => f.liveUrl === '' && f.children.length === 10)`);
    round = 'Late';
    await sleep(5000);
    assert.equal((await titles(news))[0], 'Fresh 1');
  } finally { await b.close(); server.close(); }
});
