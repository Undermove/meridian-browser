// The hero shot's page server: made-up pages and real brand logos, routed by Host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANDS, OWN, brands, createServer, svg } from '../../../site/lab/tools/site_shot_pages.mjs';

const ICONS = fileURLToPath(new URL('../../../site/lab/tools/', import.meta.url));
let server;
let port;
before(async () => {
  server = createServer(ICONS);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => new Promise((r) => server.close(r)));

// fetch() can't set Host, so this goes over a raw socket.
function get(host, url = '/') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let raw = '';
    s.on('data', (d) => { raw += d; });
    s.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const headers = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      resolve({ status: Number(lines[0].split(' ')[1]), headers, body: rest.join('\r\n\r\n') });
    });
    s.on('error', reject);
    // HTTP/1.0 so the server closes the socket after one reply, and Host can be left out.
    s.end(`GET ${url} HTTP/1.0\r\n${host === null ? '' : `Host: ${host}\r\n`}\r\n`);
  });
}

const HTML = 'text/html; charset=utf-8';
const SVG = 'image/svg+xml';
const title = (body) => body.match(/<title>([^<]*)<\/title>/)[1];
const fill = (body) => body.trimStart().match(/^<svg fill="#([0-9A-F]{6})" /)?.[1] ?? null;

test('brands are the seven sidebar-only sites, in launch order', () => {
  assert.deepEqual(BRANDS, ['linear', 'notion', 'spotify', 'figma', 'github', 'telegram', 'youtube']);
  assert.deepEqual(Object.keys(brands(ICONS)), BRANDS);
});

const EXPECT = {
  linear: ['Linear', '5E6AD2'], notion: ['Notion', '000000'], spotify: ['Spotify', '1ED760'],
  figma: ['Figma', null], github: ['GitHub', '181717'], telegram: ['Telegram', '26A5E4'], youtube: ['YouTube', 'FF0000'],
};
for (const [host, [name, colour]] of Object.entries(EXPECT)) {
  test(`${host}: a titled page and its own logo`, async () => {
    const page = await get(`${host}.example`);
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], HTML);
    assert.equal(title(page.body), name);
    assert.match(page.body, /<link rel="icon" href="\/favicon.svg">/);
    assert.match(page.body, new RegExp(`<h1>${name}</h1>`));

    const icon = await get(`${host}.example:${port}`, '/favicon.svg');
    assert.equal(icon.headers['content-type'], SVG);
    assert.equal(fill(icon.body), colour);
    assert.doesNotMatch(icon.body, /<\?xml/);
    assert.ok(icon.body.trimStart().startsWith('<svg '));
  });
}

test('the xml prolog is dropped and no fill added when none is given', () => {
  const raw = fs.readFileSync(path.join(ICONS, 'gb-figma.svg'), 'utf8');
  assert.match(raw, /^<\?xml/);
  const out = svg(ICONS, 'gb-figma.svg');
  assert.equal(out, raw.replace(/<\?xml[^>]*>/, ''));
  assert.doesNotMatch(out, /<svg fill=/);
});

test('a fill is put on the root <svg> only', () => {
  const raw = fs.readFileSync(path.join(ICONS, 'github.svg'), 'utf8');
  assert.equal(svg(ICONS, 'github.svg', 'ABCDEF'), raw.replace('<svg ', '<svg fill="#ABCDEF" '));
});

for (const [host, name] of [['fieldnotes', 'Field Notes: Slow mornings'], ['coastline', 'Coastline: North by night train'], ['recipes', 'Weekend Recipes']]) {
  test(`${host}: its page and its own favicon`, async () => {
    const page = await get(`${host}.example`);
    assert.equal(page.headers['content-type'], HTML);
    assert.equal(title(page.body), name);
    const icon = await get(`${host}.example`, '/favicon.svg');
    assert.equal(icon.headers['content-type'], SVG);
    assert.equal(icon.body, OWN[host]);
  });
}

test('a favicon url with a query is still the favicon', async () => {
  const icon = await get('coastline.example', '/favicon.svg?v=2');
  assert.equal(icon.headers['content-type'], SVG);
  assert.equal(icon.body, OWN.coastline);
});

test('an unknown host gets Field Notes and its favicon', async () => {
  const page = await get('elsewhere.example');
  assert.equal(page.headers['content-type'], HTML);
  assert.equal(title(page.body), 'Field Notes: Slow mornings');
  const icon = await get('elsewhere.example', '/favicon.svg');
  assert.equal(icon.body, OWN.fieldnotes);
});

test('no Host header at all gets Field Notes', async () => {
  const page = await get(null);
  assert.equal(page.status, 200);
  assert.equal(title(page.body), 'Field Notes: Slow mornings');
});

test('own favicons are distinct rounded squares', () => {
  const colours = Object.values(OWN).map((s) => s.match(/<rect [^>]*fill="(#[0-9A-F]{6})"/)[1]);
  assert.deepEqual(colours, ['#FF5B1F', '#0E8A7A', '#C9F02E']);
});
