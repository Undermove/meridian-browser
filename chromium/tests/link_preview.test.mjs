// Link previews: Shift over a link shows Claude's summary of the page, loaded without cookies;
// links to this computer are refused; summaries are cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const KEY = 'sk-ant-test-000000000000000000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('link previews: Shift over a link, no cookies, no local addresses, cached', async () => {
  const hits = [];
  const site = http.createServer((req, res) => {
    hits.push({ url: req.url, cookie: req.headers.cookie || '' });
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>Khachapuri Guide</title><meta name="description" content="How to bake it"><p>Cheese, egg, dough.</p>');
    }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=secret; Path=/' });
    res.end(`<title>Links</title><body style="margin:0">
      <a id="a" href="/article" style="position:absolute;left:40px;top:40px;font-size:40px">Article</a>
      <a id="l" href="http://localhost:${site.address().port}/x" style="position:absolute;left:40px;top:200px;font-size:40px">Local</a>`);
  });
  const asked = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      asked.push(json);
      res.writeHead(200, { 'content-type': 'application/json' });
      const title = /title="([^"]*)"/.exec(json.messages?.[0]?.content || '')?.[1] || '';
      res.end(JSON.stringify({ content: [{ type: 'text', text: `A page about ${title}.` }], stop_reason: 'end_turn' }));
    });
  });
  await Promise.all([new Promise((r) => site.listen(0, '127.0.0.1', r)), new Promise((r) => api.listen(0, '127.0.0.1', r))]);
  const port = site.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { ai_link_preview: true } }));
  const b = await launch([`http://127.0.0.1:${port}/`], { profile, args: [`--meridian-ai-base-url=http://127.0.0.1:${api.address().port}`, `--meridian-preview-allow-hosts=127.0.0.1:${port}`] });
  const card = `app.shadowRoot.getElementById('linkPreview')`;
  const bubble = `app.shadowRoot.getElementById('statusBubble')`;
  let ws;
  try {
    assert.equal((await b.eval(`app.$.tabstrip.handler_.setAiKey(${JSON.stringify(KEY)})`)).ok, true);
    let t;
    for (let i = 0; i < 50 && !t; i++) {
      t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.type === 'page' && x.url === `http://127.0.0.1:${port}/`);
      if (!t) await sleep(100);
    }
    ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.onopen = r);
    let id = 0;
    const move = (x, y, shift = false) => ws.send(JSON.stringify({ id: ++id, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, modifiers: shift ? 8 : 0 } }));
    const hover = async (x, y, text) => {
      for (let i = 0; i < 20 && !(await b.eval(`${bubble}.textContent.includes(${JSON.stringify(text)})`)); i++) { move(x + i, y); await sleep(250); }
      await b.waitFor(`${bubble}.textContent.includes(${JSON.stringify(text)})`);
    };

    // Hovering alone: just the status bubble.
    await hover(60, 60, '/article');
    await sleep(500);
    assert.equal(await b.eval(`!!${card}`), false);
    // With Shift: the card, with the page's title and Claude's summary.
    move(62, 62, true);
    await b.waitFor(`${card}?.textContent.includes('A page about Khachapuri Guide.')`);
    assert.match(await b.eval(`${card}.querySelector('.lp-title').textContent`), /Khachapuri Guide/);
    const preview = hits.find((h) => h.url === '/article');
    assert.equal(preview.cookie, '', 'the page was loaded without cookies');
    assert.ok(hits.some((h) => h.url === '/'), 'the tab itself got the cookie first');
    assert.match(asked[asked.length - 1].messages[0].content, /<untrusted_page_content url="http:\/\/127\.0\.0\.1:\d+\/article" title="Khachapuri Guide">\nHow to bake it/);
    assert.equal(asked[asked.length - 1].model, 'claude-haiku-5-5');

    // Off the link: the card goes.
    move(600, 500);
    await b.waitFor(`!${card}`);

    // A link to this computer: refused, nothing fetched.
    await hover(60, 220, 'localhost');
    move(62, 222, true);
    await b.waitFor(`${card}?.querySelector('.lp-error')?.textContent.includes('this computer')`);
    assert.ok(!hits.some((h) => h.url === '/x'));
    move(600, 500);
    await b.waitFor(`!${card}`);

    // The article again: from the cache.
    const before = hits.length + asked.length;
    await hover(60, 60, '/article');
    move(62, 62, true);
    await b.waitFor(`${card}?.textContent.includes('A page about Khachapuri Guide.')`);
    assert.equal(hits.length + asked.length, before);
    // Open: a new tab with the link.
    await b.click(`${card}.querySelector('#linkPreviewOpen')`);
    await b.waitFor(`!${card}`);
  } finally {
    ws?.close();
    await b.close(); site.close(); api.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
