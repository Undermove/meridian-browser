// Arc's automatic picture-in-picture: a video playing with sound floats when its tab is left, and
// comes back into the page when the tab is shown again. No prompt (allowed by default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

test('a playing video goes picture-in-picture when its tab is left, and back when it is shown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-autopip-'));
  fs.copyFileSync(path.join(here, 'fixtures', 'tone.webm'), path.join(dir, 'tone.webm'));
  fs.writeFileSync(path.join(dir, 'video.html'), '<!doctype html><title>Video</title><video id="v" src="tone.webm" autoplay loop width="320"></video>');
  const videoUrl = `file://${dir}/video.html`;
  const b = await launch([videoUrl, 'data:text/html,<title>Quiet</title>'], { args: ['--autoplay-policy=no-user-gesture-required'] });
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})?.shadowRoot.querySelector('.row')`;
  const page = async () => {
    const t = (await (await fetch(`${b.base}/json/list`)).json()).find((x) => x.url === videoUrl);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    return (expr) => new Promise((res) => { const i = ++id; ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === i) res(m.result?.result?.value); }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
  };
  const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    await b.click(row('Video'));
    const v = await page();
    assert.ok(await until(() => v('!document.getElementById("v").paused && document.getElementById("v").currentTime > 1')), 'the video plays');
    await b.click(row('Quiet'));
    assert.ok(await until(() => v('!!document.pictureInPictureElement')), 'picture-in-picture when the tab is left');
    await b.click(row('Video'));
    assert.ok(await until(() => v('!document.pictureInPictureElement')), 'back in the page');
  } finally {
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
