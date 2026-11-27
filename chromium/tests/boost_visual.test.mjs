// The Boost editor and its badge in the site controls, pixel for pixel against reference PNGs
// (fixtures/boost_visual/, 2x): the editor with no colour (as the owner's screenshot of Arc), with a
// colour, 125 % and Courier New (as Arc's recording), Code's own page, and the badge's twinkling
// stars at three moments of their round. The references were rendered from the same WebUI code in
// headless Chrome and compared with Arc's frames (S/arc-px/REPORT.md); here the real Meridian must
// draw the same. Set MERIDIAN_SHOT_DIR to keep what it drew and the diffs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { launch, NEEDS_FRAMES } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REF = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/boost_visual');
const SC = 'app.$.siteControl.shadowRoot';
const BE = 'app.$.boostEditor.shadowRoot';
const H = 'app.$.tabstrip.handler_';

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; }
    if (kind === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
      out[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width, height, at: (x, y) => { const i = (y * width + x) * bpp; return [out[i], out[i + 1], out[i + 2]]; } };
}

// Share of pixels (inside `keep`) whose largest channel difference is over 24.
function differ(png, refFile, keep = () => true) {
  const a = decodePng(png), b = decodePng(fs.readFileSync(path.join(REF, refFile)));
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  let n = 0, bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!keep(x, y, w, h)) continue;
    const p = a.at(x, y), q = b.at(x, y);
    n++;
    if (Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2])) > 24) bad++;
  }
  return { share: bad / n, size: [a.width, a.height], ref: [b.width, b.height] };
}

// Away from the card's rounded corners (the window shows there).
const inCard = (x, y, w, h) => x >= 26 && y >= 26 && x < w - 26 && y < h - 26;

const site = () => new Promise((r) => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Plain</title><p>Plain page.</p>'); });
  server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` }));
});

// The element at 2 device pixels per CSS pixel, whatever the screen.
async function shoot(b, expr, name) {
  const r = await b.eval(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: devicePixelRatio }; })()`);
  const { data } = await b.cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 / r.dpr } });
  const png = Buffer.from(data, 'base64');
  if (process.env.MERIDIAN_SHOT_DIR) fs.writeFileSync(path.join(process.env.MERIDIAN_SHOT_DIR, `boost-visual-${name}.png`), png);
  return png;
}

const BOOST = { id: '', host: '127.0.0.1', name: 'My Boost', enabled: true, css: '', js: '', zaps: [], hue: 0, font: '', tint: -1, tintStrength: 60, tint2: -1, dark: false, brightness: 100, contrast: 100, saturation: 100, size: 100, textCase: '' };

test('the Boost editor and its badge look as the references (Arc’s, measured)', { skip: NEEDS_FRAMES }, async () => {
  const s = await site();
  const b = await launch([s.url]);
  try {
    await b.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const page = await b.page(s.url);
    await page.waitFor(`document.readyState === 'complete'`);
    await b.waitFor(`app.shadowRoot.querySelector('#urlPill .host')?.textContent === '127.0.0.1'`);
    const { id } = await b.eval(`${H}.setBoost(${JSON.stringify(BOOST)})`);
    const show = async (change) => {
      await b.eval(`${H}.setBoost(${JSON.stringify({ ...BOOST, id, ...change })})`);
      await b.eval(`app.$.boostEditor.show(${JSON.stringify(id)})`);
      await b.waitFor(`app.$.boostEditor.open && !!${BE}.getElementById('pad')`);
      await sleep(900);  // the card's slide in, the knobs' glide
    };

    // No colour: Arc's greys (the owner's screenshot).
    await show({});
    let d = differ(await shoot(b, `${BE}.getElementById('card')`, 'main'), 'main.png', inCard);
    assert.ok(d.share < 0.015, `no colour: ${(d.share * 100).toFixed(2)} % of the pixels differ (${d.size} vs ${d.ref})`);

    // A colour, 125 % and Courier New (as on Arc's recording).
    await show({ tint: 99, tintStrength: 62, tint2: 258, size: 125, font: 'Courier New' });
    d = differ(await shoot(b, `${BE}.getElementById('card')`, 'colour'), 'colour.png', inCard);
    assert.ok(d.share < 0.015, `colour: ${(d.share * 100).toFixed(2)} %`);

    // Code: its own page, 480 px.
    await b.eval(`${BE}.getElementById('code').click()`);
    await b.waitFor(`${BE}.getElementById('card').getBoundingClientRect().width === 480`, 3000);
    await sleep(500);
    d = differ(await shoot(b, `${BE}.getElementById('card')`, 'code'), 'code.png', inCard);
    assert.ok(d.share < 0.015, `code: ${(d.share * 100).toFixed(2)} %`);
    await b.eval(`app.$.boostEditor.close()`);

    // The badge in the site controls, its stars stopped at three moments of the 1.65 s round.
    await b.eval(`${H}.setBoost(${JSON.stringify({ ...BOOST, id, tint: 340, tint2: 24 })})`);
    await b.click(`app.$.locationIconButton`);
    await b.waitFor(`app.$.siteControl.open && !!${SC}.querySelector('.boost-row.on .boost-ic')`);
    const names = await b.eval(`${SC}.querySelector('.boost-ic').getAnimations({ subtree: true }).map((a) => a.animationName).sort().join()`);
    assert.equal(names, 'star-a,star-b,star-c', 'three stars twinkle');
    for (const t of ['0.433', '0.633', '0.850']) {
      await b.eval(`${SC}.querySelector('.boost-ic').getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = ${Number(t) * 1000}; })`);
      await sleep(100);
      // Inside the circle only (the popover's own background shows round it).
      d = differ(await shoot(b, `${SC}.querySelector('.boost-ic')`, `badge-${t}`), `badge-${t}.png`, (x, y) => (x - 30) ** 2 + (y - 30) ** 2 < 26 ** 2);
      assert.ok(d.share < 0.02, `badge at ${t} s: ${(d.share * 100).toFixed(2)} %`);
    }
    page.close();
  } finally { await b.close(); s.server.close(); }
});
