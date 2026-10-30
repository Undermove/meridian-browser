// The mini player (Arc's): media playing in another tab shows above the sidebar's bottom bar with
// its track, play/pause and next; clicking it goes to the tab, where it steps aside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

// Twelve seconds of a quiet 440 Hz tone, as a WAV file (media under 5 s gets no media session).
function toneWav() {
  const rate = 8000, n = rate * 12;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 2000), 44 + i * 2);
  return buf;
}

const MUSIC = `<!doctype html><title>Radio</title><audio id="a" src="/tone.wav" loop autoplay></audio><script>
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'Song', artist: 'Artist' });
  window.nexts = 0;
  navigator.mediaSession.setActionHandler('nexttrack', () => { window.nexts++; });
</script>`;

test('media in another tab shows a mini player: track, play/pause, next; a click goes to the tab', async () => {
  const wav = toneWav();
  const server = http.createServer((req, res) => {
    if (req.url === '/tone.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/music' ? MUSIC : '<!doctype html><title>Quiet</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const b = await launch([url('/music'), url('/quiet')], { args: ['--autoplay-policy=no-user-gesture-required'] });
  const P = `${SB}.getElementById('player')`;
  const music = async () => {
    const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.url.endsWith('/music'));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    return (expr) => new Promise((res) => { ws.onmessage = (e) => res(JSON.parse(e.data).result?.result?.value); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    // The quiet tab is the active one; the music plays in the other.
    await b.click(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === 'Quiet').shadowRoot.querySelector('.row')`);
    await b.waitFor(`!!${P}`, 15000);
    assert.equal(await b.eval(`${P}.querySelector('.player-title').textContent.trim()`), 'Song');
    assert.equal(await b.eval(`${P}.querySelector('.player-sub').textContent.trim()`), 'Artist');

    const page = await music();
    await b.click(`${SB}.getElementById('playerToggle')`);
    await b.waitFor(`${SB}.getElementById('playerToggle').dataset.action === 'play'`);
    for (let i = 0; i < 30 && !(await page('document.getElementById("a").paused')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page('document.getElementById("a").paused'), true, 'paused');
    await b.click(`${SB}.getElementById('playerToggle')`);
    await b.waitFor(`${SB}.getElementById('playerToggle').dataset.action === 'pause'`);

    await b.click(`${P}.querySelector('[data-action="next"]')`);
    for (let i = 0; i < 30 && !(await page('window.nexts')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await page('window.nexts'), 1, 'next track');

    // A click on it goes to the tab, and the player steps aside there.
    await b.click(`${P}.querySelector('.player-main')`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title === 'Radio'`);
    await b.waitFor(`!${P}`);
  } finally {
    await b.close();
    server.close();
  }
});
