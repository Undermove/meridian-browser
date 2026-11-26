// "Put to Sleep" in a tab's menu: Chromium discards it to free memory, after Meridian's own check —
// never a tab with something typed, sound or video playing, a share or recording, or an agent at
// work; a toast says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const TONE = `<!doctype html><title>Tone</title><script>
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
  gain.gain.value = 0.02; osc.connect(gain).connect(ctx.destination); osc.start();
</script>`;
const FORM = '<!doctype html><title>Form</title><form><textarea id="t"></textarea></form>';
const T = 'app.$.tabstrip';
const SHOTS = process.env.MERIDIAN_SHOTS || '';

test('Put to Sleep discards a quiet tab and says why it keeps a typed-in, playing or agent tab awake', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/tone' ? TONE : req.url === '/form' ? FORM : `<!doctype html><title>${req.url.slice(1)}</title><h1>hi</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const b = await launch([url('/quiet'), url('/tone'), url('/form'), url('/agent'), url('/open')],
                         { args: ['--autoplay-policy=no-user-gesture-required'] });
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const idOf = (title) => b.eval(`${row(title)}.tab.id`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 5`);
    for (const t of ['quiet', 'Tone', 'Form', 'agent', 'open']) await b.waitFor(`!!${row(t)}`, 15000);
    await b.eval(`(() => { window.__toasts = []; ${T}.addEventListener('meridian-mission-toast', (e) => window.__toasts.push(e.detail.title)); return true; })()`);
    // Something typed on the form page, by real key presses.
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('Form'))})`);
    const form = await b.page(url('/form'));
    await form.eval(`(document.getElementById('t').focus(), true)`);
    await form.cdp.send('Input.insertText', { text: 'a draft' });
    assert.equal(await form.eval(`document.getElementById('t').value`), 'a draft');
    form.close();
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('open'))})`);
    await b.waitFor(`${row('open')}.tab.isActive`);
    await b.waitFor(`!!${row('Tone')}?.shadowRoot.querySelector('.audio')`, 15000);

    const sleep = async (title) => b.eval(`${T}.putToSleep(${JSON.stringify(await idOf(title))})`);
    // The open tab: the menu item is greyed out, and the handler says no.
    assert.equal(await sleep('open'), 'active');
    assert.equal(await sleep('Tone'), 'media');
    assert.equal(await sleep('Form'), 'form');
    // An agent at work in the tab.
    await b.eval(`(${T}.agentTab_ = ${JSON.stringify(await idOf('agent'))}, true)`);
    assert.equal(await sleep('agent'), 'agent');
    await b.eval(`(${T}.agentTab_ = '', true)`);
    // A quiet tab sleeps, from the menu.
    await b.menu(`${row('quiet')}.shadowRoot.querySelector('.row')`, 'Put to Sleep');
    await b.waitFor(`window.__toasts.some((t) => t.startsWith('Put to sleep'))`);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await new Promise((r) => setTimeout(r, 300)); await b.screenshot(path.join(SHOTS, 'sleep-toast.png')); }
    assert.equal(await sleep('quiet'), 'asleep');
    assert.equal(await sleep('agent'), '', 'the agent left: it sleeps');
    const toasts = await b.eval('window.__toasts');
    assert.ok(toasts.includes('Not put to sleep: it is playing sound or video'), toasts.join(' | '));
    assert.ok(toasts.includes('Not put to sleep: something typed on the page would be lost'));
    assert.ok(toasts.includes('Not put to sleep: an agent is working in this tab'));
    // Asleep in the sidebar: a dimmed favicon with a small moon; the others look as before.
    await b.waitFor(`${row('quiet')}.asleep && !!${row('quiet')}.shadowRoot.querySelector('.row.asleep .moon')`, 5000);
    await b.waitFor(`${row('agent')}.asleep`, 5000);
    assert.equal(await b.eval(`${row('Tone')}.asleep || !!${row('Tone')}.shadowRoot.querySelector('.moon')`), false);
    assert.equal(await b.eval(`getComputedStyle(${row('quiet')}.shadowRoot.querySelector('.favicon img')).opacity`), '0.45');
    if (SHOTS) { await new Promise((r) => setTimeout(r, 300)); await b.screenshot(path.join(SHOTS, 'sleep-mark.png')); }
    // Opened again: it loads, and the mark goes.
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('quiet'))})`);
    const back = await b.page(url('/quiet'), 15000);
    assert.equal(await back.eval('document.title'), 'quiet');
    back.close();
    await b.waitFor(`!${row('quiet')}.asleep && !${row('quiet')}.shadowRoot.querySelector('.moon')`, 10000);
    assert.ok(await b.eval(`${row('agent')}.asleep`), 'the other sleeping tab stays asleep');
  } finally { await b.close(); server.close(); }
});
