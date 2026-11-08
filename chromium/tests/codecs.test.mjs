// H.264 and AAC play, as on most of the web outside YouTube (a film site's player, a news video):
// the picture and the sound both come through, decoded by macOS (VideoToolbox, AudioToolbox, whose
// licences Apple holds), as in Firefox. Meridian's own FFmpeg has no H.264 or AAC decoder. It played
// none of this before: the build had no H.264 or AAC at all.
//
// The fixtures (fixtures/codecs) are 3 s of a red picture with a 440 Hz tone:
//   h264_aac.mp4       H.264 Main + AAC LC, a plain MP4 (<video src>, FFmpeg's MP4 demuxer)
//   h264_aac_frag.mp4  the same, fragmented, for Media Source (Chromium's MP4 parser, ADTS framing)
//   he_aac.m4a         HE-AAC (AAC with SBR), from afconvert
//   tone.aac           AAC LC as ADTS, a raw .aac file
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, APP } from './harness.mjs';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'codecs');
const TYPES = { '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.html': 'text/html' };

// The page: plays a file into an analyser (muted on the way out) and reports what it heard and saw.
const PAGE = `<!doctype html><title>Codecs</title><body><script>
async function play(src, { mse = '' } = {}) {
  const v = document.createElement(src.endsWith('.mp4') ? 'video' : 'audio');
  document.body.append(v);
  if (mse) {
    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    const sb = ms.addSourceBuffer(mse);
    sb.appendBuffer(await (await fetch(src)).arrayBuffer());
    await new Promise((r) => sb.addEventListener('updateend', r, { once: true }));
    ms.endOfStream();
  } else {
    v.src = src;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 4096;
  const silent = ctx.createGain(); silent.gain.value = 0;
  ctx.createMediaElementSource(v).connect(analyser).connect(silent).connect(ctx.destination);
  const error = new Promise((r) => v.addEventListener('error', () => r(v.error?.message || 'error'), { once: true }));
  const out = await Promise.race([error.then((e) => ({ error: e })), (async () => {
    await v.play();
    await ctx.resume();
    let rms = 0, peak = 0;
    const t = new Float32Array(analyser.fftSize), f = new Float32Array(analyser.frequencyBinCount);
    for (let i = 0; i < 30 && v.currentTime < 2.5; i++) {
      await new Promise((r) => setTimeout(r, 50));
      analyser.getFloatTimeDomainData(t);
      const r = Math.sqrt(t.reduce((s, x) => s + x * x, 0) / t.length);
      if (r > rms) {
        rms = r;
        analyser.getFloatFrequencyData(f);
        peak = Math.round(f.indexOf(Math.max(...f)) * ctx.sampleRate / analyser.fftSize);
      }
    }
    const res = { time: v.currentTime > 0.5, rms: rms > 0.05, hz: Math.abs(peak - 440) < 30 ? 440 : peak };
    if (v.videoWidth) {
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      const g = c.getContext('2d'); g.drawImage(v, 0, 0);
      const [r, gr, b] = g.getImageData(80, 60, 1, 1).data;
      res.size = v.videoWidth + 'x' + v.videoHeight;
      res.red = r > 200 && gr < 60 && b < 60;
    }
    return res;
  })()]);
  v.pause(); ctx.close();
  return out;
}
</script>`;

async function serve() {
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0].slice(1);
    if (!name) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
    const file = path.join(DIR, path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const data = fs.readFileSync(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = +range[1], end = range[2] ? +range[2] : data.length - 1;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${data.length}` });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': data.length });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// The decoders the page's players used, from the Media domain (chrome://media-internals' data).
function decoders(page) {
  const seen = { audio: new Set(), video: new Set() };
  page.cdp.listeners.push((method, params) => {
    if (method !== 'Media.playerPropertiesChanged') return;
    for (const { name, value } of params.properties) {
      if (name === 'kAudioDecoderName') seen.audio.add(value);
      if (name === 'kVideoDecoderName') seen.video.add(value);
      if (name === 'kIsPlatformAudioDecoder' && value === 'true') seen.audio.add('platform');
      if (name === 'kIsPlatformVideoDecoder' && value === 'true') seen.video.add('platform');
    }
  });
  return () => ({ audio: [...seen.audio].sort(), video: [...seen.video].sort() });
}

const ARGS = ['--autoplay-policy=no-user-gesture-required'];

test('H.264 with AAC plays, picture and sound, through macOS decoders: a plain MP4 and Media Source', async () => {
  const site = await serve();
  const b = await launch([site.url], { args: ARGS });
  try {
    const page = await b.page(site.url);
    await page.waitFor(`typeof play === 'function'`);
    await page.cdp.send('Media.enable');
    const used = decoders(page);

    assert.deepEqual(await page.eval(`({
      mp4: document.createElement('video').canPlayType('video/mp4; codecs="avc1.4D401E, mp4a.40.2"'),
      mse: MediaSource.isTypeSupported('video/mp4; codecs="avc1.4D401E, mp4a.40.2"'),
      he: MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.5"') })`),
      { mp4: 'probably', mse: true, he: true }, 'the page is told H.264 and AAC play');

    const want = { time: true, rms: true, hz: 440, size: '160x120', red: true };
    assert.deepEqual(await page.eval(`play('h264_aac.mp4')`), want, 'a plain MP4: the red picture and the tone');
    assert.deepEqual(await page.eval(`play('h264_aac_frag.mp4', { mse: 'video/mp4; codecs="avc1.4D401E, mp4a.40.2"' })`), want,
        'Media Source (how a film site\'s player streams)');

    const d = used();
    assert.ok(d.video.includes('platform'), `the picture was decoded by macOS: ${JSON.stringify(d)}`);
    assert.ok(d.audio.includes('platform'), `the sound was decoded by macOS: ${JSON.stringify(d)}`);
    assert.ok(!d.video.some((n) => /ffmpeg/i.test(n)) && !d.audio.some((n) => /ffmpeg/i.test(n)), `not by FFmpeg: ${JSON.stringify(d)}`);
    page.close();
  } finally { await b.close(); site.close(); }
});

test('HE-AAC and a raw ADTS .aac file play, with their sound', async () => {
  const site = await serve();
  const b = await launch([site.url], { args: ARGS });
  try {
    const page = await b.page(site.url);
    await page.waitFor(`typeof play === 'function'`);
    const want = { time: true, rms: true, hz: 440 };
    assert.deepEqual(await page.eval(`play('he_aac.m4a')`), want, 'HE-AAC');
    assert.deepEqual(await page.eval(`play('tone.aac')`), want, 'ADTS AAC');
    page.close();
  } finally { await b.close(); site.close(); }
});

test('Meridian has no H.264 decoder of its own: with macOS\'s video decoding off, H.264 doesn\'t play', async () => {
  const site = await serve();
  const b = await launch([site.url], { args: [...ARGS, '--disable-accelerated-video-decode'] });
  try {
    const page = await b.page(site.url);
    await page.waitFor(`typeof play === 'function'`);
    const r = await page.eval(`Promise.race([play('h264_aac.mp4'), new Promise((r) => setTimeout(() => r({ stalled: true }), 8000))])`);
    assert.ok(r.error || r.stalled || !r.red, `no picture without macOS: ${JSON.stringify(r)}`);
    page.close();
  } finally { await b.close(); site.close(); }
});

test('the app carries no FFmpeg H.264 or AAC decoder', () => {
  // Messages only FFmpeg's H.264 decoder (h264dec.c, h264_direct.c) and AAC decoder (aacdec.c) print.
  const framework = path.join(path.dirname(path.dirname(APP)), 'Frameworks');
  const bin = fs.readdirSync(framework).filter((f) => f.endsWith('.framework'))
    .map((f) => path.join(framework, f, path.basename(f, '.framework'))).find((p) => fs.existsSync(p) && fs.statSync(p).size > 1e8);
  assert.ok(bin, 'the framework binary');
  const data = fs.readFileSync(bin);
  for (const s of ['decode_slice_header error', 'co located POCs unavailable',
    'Assuming an incorrectly encoded 7.1 channel layout', 'SBR was found before the first channel element']) {
    assert.equal(data.includes(Buffer.from(s)), false, `"${s}" is in the binary`);
  }
  // FFmpeg itself is there (its MP4 demuxer), so the check looks at the right file.
  assert.ok(data.includes(Buffer.from('QuickTime / MOV')), 'FFmpeg\'s MP4 demuxer');
});
