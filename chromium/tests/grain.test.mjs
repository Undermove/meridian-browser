// Arc's grain over the window's colour: as strong at 100% (Windows) as on a
// Retina Mac, on a light window as on a dark one, and gone when turned off.
// Measured on the window's own pixels: the noise is the brightness minus its
// local average (the colour and the gradient), its strength the std-dev of
// that in levels of 0..255, its speck size how alike neighbouring pixels are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { launch, SB } from './harness.mjs';

// 8-bit RGB(A) PNG, not interlaced → { width, height, lum: Float64Array }.
function decodePng(png) {
  let pos = 8, width = 0, height = 0, type = 0;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos), kind = png.toString('latin1', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
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
  const lum = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    lum[i] = 0.2126 * out[i * bpp] + 0.7152 * out[i * bpp + 1] + 0.0722 * out[i * bpp + 2];
  }
  return { width, height, lum };
}

// The grain in a screenshot: { std, corr1 } (corr1 ≈ 0: one-pixel specks; ≈ 0.4: two-pixel).
function grainOf(png) {
  const { width: w, height: h, lum } = decodePng(png);
  const r = 8, k = 2 * r + 1;
  const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const rows = new Float64Array(w * h);  // box blur, rows then columns
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let d = -r; d <= r; d++) s += at(x + d, y); rows[y * w + x] = s / k;
  }
  const n = [];
  for (let y = 10; y < h - 10; y++) {
    const line = [];
    for (let x = 10; x < w - 10; x++) {
      let s = 0; for (let d = -r; d <= r; d++) s += rows[Math.min(h - 1, Math.max(0, y + d)) * w + x];
      line.push(lum[y * w + x] - s / k);
    }
    n.push(line);
  }
  let sum = 0, cnt = 0;
  for (const l of n) for (const v of l) { sum += v; cnt++; }
  const mean = sum / cnt;
  let vv = 0, cx = 0, cy = 0, nx = 0, ny = 0;
  for (let y = 0; y < n.length; y++) for (let x = 0; x < n[y].length; x++) {
    const v = n[y][x] - mean; vv += v * v;
    if (x + 1 < n[y].length) { cx += v * (n[y][x + 1] - mean); nx++; }
    if (y + 1 < n.length) { cy += v * (n[y + 1][x] - mean); ny++; }
  }
  const variance = vv / cnt;
  return { std: Math.sqrt(variance), corr1: variance ? (cx / nx + cy / ny) / 2 / variance : 0 };
}

test('the grain shows the same at 100% and on Retina, light and dark; off is flat', async () => {
  const b = await launch(['about:blank']);
  const shots = process.env.MERIDIAN_GRAIN_SHOTS;  // a folder: the screenshots are kept there
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // On from the start, with the default lilac space: the colour the grain vanished on.
    await b.waitFor(`app.hasAttribute('grain')`);
    // Only the window's colour and its grain: the sidebar and the page out of the way.
    await b.eval(`(() => { const s = document.createElement('style'); s.id = 'grainTest';
      s.textContent = '#sidebar, #main, #edgeHotzone { visibility: hidden !important; }';
      app.shadowRoot.append(s); return true; })()`);
    const measure = async (scheme, dpr) => {
      await b.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await b.cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: dpr, mobile: false });
      await new Promise((r) => setTimeout(r, 400));
      const { data } = await b.cdp.send('Page.captureScreenshot',
          { format: 'png', clip: { x: 40, y: 200, width: 220, height: 220, scale: 1 } });
      const png = Buffer.from(data, 'base64');
      if (shots) fs.writeFileSync(`${shots}/grain-${scheme}-${dpr}x${(await b.eval(`app.hasAttribute('grain')`)) ? '' : '-off'}.png`, png);
      const g = grainOf(png);
      console.log(`# grain ${scheme} ${dpr}x: std ${g.std.toFixed(2)}, corr1 ${g.corr1.toFixed(2)}`);
      return g;
    };
    // Arc on a light window (a Retina screenshot): std ≈ 2.7, corr1 ≈ 0.4.
    for (const dpr of [1, 2]) {
      const light = await measure('light', dpr);
      assert.ok(light.std >= 2 && light.std <= 4.5, `light ${dpr}x: grain std ${light.std.toFixed(2)}, wants 2–4.5 (Arc ≈ 2.7)`);
      const dark = await measure('dark', dpr);
      assert.ok(dark.std >= 3.5 && dark.std <= 7.5, `dark ${dpr}x: grain std ${dark.std.toFixed(2)}, wants 3.5–7.5`);
      // A speck is a CSS pixel: one device pixel at 100%, two on Retina (like Arc's).
      if (dpr === 1) assert.ok(light.corr1 < 0.2, `1x: specks ${light.corr1.toFixed(2)} alike, want one-pixel ones`);
      else assert.ok(light.corr1 > 0.2 && light.corr1 < 0.6, `2x: specks ${light.corr1.toFixed(2)} alike, want two-pixel ones`);
    }
    // Grain off: a flat colour.
    await b.eval(`app.toggleAttribute('grain', false)`);
    for (const dpr of [1, 2]) {
      const off = await measure('light', dpr);
      assert.ok(off.std < 0.8, `off ${dpr}x: std ${off.std.toFixed(2)}, wants flat`);
    }
  } finally {
    await b.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await b.close();
  }
});
