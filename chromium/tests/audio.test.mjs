// A tab that plays sound shows a speaker in its row: clicking it mutes the tab (and again unmutes),
// and the tab's menu offers Mute Tab / Unmute Tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

// A page that plays a quiet tone as soon as it loads.
const TONE = `<!doctype html><title>Tone</title><script>
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
  gain.gain.value = 0.02; osc.connect(gain).connect(ctx.destination); osc.start();
</script>`;

test('a playing tab shows a speaker that mutes and unmutes it; its menu offers Mute Tab', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/tone' ? TONE : '<!doctype html><title>Quiet</title>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const b = await launch([url('/tone'), url('/quiet')], { args: ['--autoplay-policy=no-user-gesture-required'] });
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const audio = (title) => `${row(title)}?.shadowRoot.querySelector('.audio')`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    await b.waitFor(`!!${audio('Tone')}`, 15000);
    assert.equal(await b.eval(`!!${audio('Quiet')}`), false, 'a silent tab has no speaker');
    assert.equal(await b.eval(`${audio('Tone')}.title`), 'Mute Tab');

    // The click mutes; it doesn't switch tabs.
    const active = `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.isActive)?.tab.title`;
    await b.click(`${row('Quiet')}.shadowRoot.querySelector('.row')`);
    await b.waitFor(`${active} === 'Quiet'`);
    await b.click(audio('Tone'));
    await b.waitFor(`${audio('Tone')}?.title === 'Unmute Tab'`);
    assert.equal(await b.eval(active), 'Quiet');

    await b.menu(`${row('Tone')}.shadowRoot.querySelector('.row')`, 'Unmute Tab');
    await b.waitFor(`${audio('Tone')}?.title === 'Mute Tab'`);

    // As a favorite, a small speaker in the tile's corner does the same.
    const toneId = await b.eval(`${row('Tone')}.tab.id`);
    await b.eval(`app.$.tabstrip.handler_.pinTab(${JSON.stringify(toneId)}, {container: 'favorites', parentId: '', index: -1}, '')`);
    const badge = `${SB}.querySelector('meridian-fav')?.shadowRoot.querySelector('.fav-audio')`;
    await b.waitFor(`!!${badge}`);
    await b.click(badge);
    await b.waitFor(`${badge}?.title === 'Unmute Tab'`);
    assert.equal(await b.eval(active), 'Quiet');
  } finally {
    await b.close();
    server.close();
  }
});
