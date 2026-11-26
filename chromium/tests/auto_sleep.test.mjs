// Auto-sleep: background tabs not used for a while (Settings > General: 30 minutes, 1 or 4
// hours, or Never, the default, as Arc never slept tabs on a timer) fall asleep, all but the few
// used last. Never the open tab, one playing or with something typed, nor a pinned tab marked
// Keep Awake. --meridian-sleep-after-seconds and --meridian-sleep-keep-recent
// make the wait seconds (once Settings turn it on) and the few none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB, itemEl, rowLook } from './harness.mjs';

const TONE = `<!doctype html><title>Tone</title><script>
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
  gain.gain.value = 0.02; osc.connect(gain).connect(ctx.destination); osc.start();
</script>`;
const FORM = '<!doctype html><title>Form</title><form><textarea id="t"></textarea></form>';
const T = 'app.$.tabstrip';
// Settings > General > Put tabs to sleep after: `minutes` (0 = Never), as picked there.
const setSleep = async (b, minutes) => {
  await b.eval(`${T}.handler_.getSettings().then(({settings}) => ${T}.handler_.setSettings({...settings, sleepAfterMinutes: ${minutes}}))`);
  await b.waitFor(`${T}.handler_.getSettings().then((r) => r.settings.sleepAfterMinutes === ${minutes})`);
};

test('background tabs fall asleep on their own; the open, playing, typed-in and kept-awake ones stay', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/tone' ? TONE : req.url === '/form' ? FORM : `<!doctype html><title>${req.url.slice(1)}</title><h1>hi</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const b = await launch([url('/quiet1'), url('/quiet2'), url('/tone'), url('/form'), url('/mail'), url('/open')],
                         { args: ['--autoplay-policy=no-user-gesture-required', '--meridian-sleep-after-seconds=4',
                                  '--meridian-sleep-keep-recent=1'] });
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title === ${JSON.stringify(title)})`;
  const idOf = (title) => b.eval(`${row(title)}.tab.id`);
  const asleep = (title) => `${T}.isAsleep(${row(title)}.tab)`;
  const itemAsleep = (title) => `${T}.isAsleep(${itemEl(title)}.tab_)`;
  try {
    for (const t of ['quiet1', 'quiet2', 'Tone', 'Form', 'mail', 'open']) await b.waitFor(`!!${row(t)}`, 15000);
    // Never unless picked in Settings: nothing sleeps on its own.
    assert.equal((await b.eval(`${T}.handler_.getSettings()`)).settings.sleepAfterMinutes, 0);
    await new Promise((r) => setTimeout(r, 6000));
    for (const t of ['quiet1', 'quiet2']) assert.equal(await b.eval(asleep(t)), false, `${t}: no auto-sleep by default`);
    // Picked: 1 hour (seconds here, by the switch).
    await setSleep(b, 60);
    // "mail" pinned and kept awake from its menu (just used, so not asleep yet).
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('mail'))})`);
    await b.eval(`${T}.handler_.pinTab(${JSON.stringify(await idOf('mail'))}, {container: ${T}.state_.activeSpaceId, parentId: '', index: 0}, '')`);
    await b.waitFor(`!!${itemEl('mail')}`);
    await b.menu(`${itemEl('mail')}.shadowRoot.querySelector('.row')`, 'Keep Awake');
    await b.waitFor(`${itemEl('mail')}.item.keepAwake === true`);
    // Something typed on the form page, by real key presses.
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('Form'))})`);
    const form = await b.page(url('/form'));
    await form.eval(`(document.getElementById('t').focus(), true)`);
    await form.cdp.send('Input.insertText', { text: 'a draft' });
    form.close();
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('open'))})`);
    await b.waitFor(`${row('open')}.tab.isActive`);
    await b.waitFor(`!!${row('Tone')}?.shadowRoot.querySelector('.audio')`, 15000);

    // How the kept-awake pinned tab looks awake, in the background.
    const mailAwake = await b.eval(rowLook(itemEl('mail')));
    // The quiet ones fall asleep by themselves, looking like any background tab (as in Arc).
    await b.waitFor(`${asleep('quiet1')} && ${asleep('quiet2')}`, 20000);
    for (const t of ['quiet1', 'quiet2']) {
      const look = JSON.parse(await b.eval(rowLook(row(t))));
      assert.deepEqual(look.cls, ['row', 'tab'], `${t}: the classes of an awake background row`);
      assert.equal(look.mark, false, `${t}: no sleep mark`);
      assert.equal(look.opacity, '1');
      assert.equal(look.filter, 'none');
    }
    // Some more turns of the timer: the rest stay awake.
    await new Promise((r) => setTimeout(r, 3000));
    for (const t of ['Tone', 'Form', 'open']) assert.equal(await b.eval(asleep(t)), false, `${t} stays awake`);
    assert.equal(await b.eval(itemAsleep('mail')), false, 'the kept-awake pinned tab stays awake');
    // Keep Awake off again: it sleeps too.
    await b.menu(`${itemEl('mail')}.shadowRoot.querySelector('.row')`, 'Keep Awake');
    await b.waitFor(`${itemEl('mail')}.item.keepAwake === false`);
    await b.waitFor(itemAsleep('mail'), 20000);
    assert.equal(await b.eval(rowLook(itemEl('mail'))), mailAwake, 'a sleeping pinned tab looks as it did awake');
    // Opened again, a sleeping tab loads.
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('quiet1'))})`);
    const back = await b.page(url('/quiet1'), 15000);
    assert.equal(await back.eval('document.title'), 'quiet1');
    back.close();
    await b.waitFor(`!${asleep('quiet1')}`, 10000);
    // "Never" turns it off (and the choice is kept).
    await setSleep(b, 0);
  } finally { await b.close(); server.close(); }
});

// A page that saves on the way out, as Discord does with its sign-in: it takes the token out of
// localStorage when it loads and writes it back in beforeunload. Asleep (a discard runs no
// beforeunload) it would be signed out the next time; so neither auto-sleep nor Put to Sleep
// takes it, and a real reload keeps it signed in.
const DISCORD = `<!doctype html><title>Chat</title><script>
  const token = localStorage.getItem('token');
  document.title = token ? 'Chat signed in' : 'Chat signed out';
  localStorage.removeItem('token');
  addEventListener('beforeunload', () => { if (token) localStorage.setItem('token', token); });
</script>`;

test('a page that saves its sign-in on the way out (as Discord) is never put to sleep; it stays signed in', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url.startsWith('/chat') ? DISCORD : `<!doctype html><title>${req.url.slice(1)}</title><h1>hi</h1>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const b = await launch([url('/quiet'), url('/chat'), url('/open')],
                         { args: ['--meridian-sleep-after-seconds=4', '--meridian-sleep-keep-recent=0'] });
  const row = (title) => `[...${SB}.querySelectorAll('meridian-tab-row')].find((r) => r.tab.title.startsWith(${JSON.stringify(title)}))`;
  const idOf = (title) => b.eval(`${row(title)}.tab.id`);
  const asleep = (title) => `${T}.isAsleep(${row(title)}.tab)`;
  try {
    for (const t of ['quiet', 'Chat', 'open']) await b.waitFor(`!!${row(t)}`, 15000);
    // Signed in once: the token is in its storage, and the page reloaded takes it (its
    // beforeunload put it back).
    const chat = await b.page(url('/chat'));
    await chat.eval(`(localStorage.setItem('token', 'tok-1'), true)`);
    await chat.eval('location.reload()').catch(() => {});
    chat.close();
    await b.waitFor(`${row('Chat')}.tab.title === 'Chat signed in'`, 15000);
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('open'))})`);
    await b.waitFor(`${row('open')}.tab.isActive`);

    // Auto-sleep on (seconds here); the plain page falls asleep, the chat doesn't, turn after turn.
    await setSleep(b, 30);
    await b.waitFor(asleep('quiet'), 20000);
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(await b.eval(asleep('Chat')), false, 'the chat stays awake');
    // Put to Sleep says why not.
    assert.equal(await b.eval(`${T}.putToSleep(${JSON.stringify(await idOf('Chat'))})`), 'unload');
    assert.equal(await b.eval(asleep('Chat')), false);

    // Opened again, and reloaded: still signed in.
    await b.eval(`${T}.activateTab(${JSON.stringify(await idOf('Chat'))})`);
    const again = await b.page(url('/chat'));
    await again.eval('location.reload()').catch(() => {});
    again.close();
    await new Promise((r) => setTimeout(r, 1000));
    await b.waitFor(`${row('Chat')}.tab.title === 'Chat signed in'`, 15000);
  } finally { await b.close(); server.close(); }
});

// Profiles from before Never was the default: the old default (1 hour, saved with Settings even
// unchanged) becomes Never, once; a time picked by hand stays.
test('auto-sleep: the old 1 hour default becomes Never; 4 hours picked by hand stays', async () => {
  for (const [kept, expected] of [[60, 0], [240, 240]]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
    fs.mkdirSync(path.join(profile, 'Default'));
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'),
                     JSON.stringify({ meridian: { sleep_after_minutes: kept } }));
    try {
      const b = await launch([], { profile });
      try {
        await b.waitFor(`!!${T}.handler_`);
        assert.equal((await b.eval(`${T}.handler_.getSettings()`)).settings.sleepAfterMinutes, expected, `${kept} → ${expected}`);
        // Picked by hand after that (1 hour), it is kept across a restart.
        if (kept === 60) await setSleep(b, 60);
        await b.quit();
      } finally { await b.close(); }
      if (kept === 60) {
        const again = await launch([], { profile });
        try {
          await again.waitFor(`!!${T}.handler_`);
          assert.equal((await again.eval(`${T}.handler_.getSettings()`)).settings.sleepAfterMinutes, 60, 'picked 1 hour stays');
        } finally { await again.close(); }
      }
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  }
});
