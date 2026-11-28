// The landing page's download part: OS detection, the CTAs, the OS tabs, sending the link from a
// phone, the copy buttons and the Windows dialog.
import { test, expect, mutate } from './fixtures.mjs';

const PAGE = 'docs/index.html';
const RELEASES = 'https://github.com/Undermove/meridian-browser/releases/latest';
const DMG = `${RELEASES}/download/Meridian-mac-arm64.dmg`;
const EXE = `${RELEASES}/download/Meridian-win.exe`;
const BREW = 'brew install --cask undermove/tap/meridian';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  bot: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
};

// Runs before the page's scripts. Replaces navigator fields and records share, clipboard and
// goatcounter calls in window.__calls. userAgentData and platform are always pinned: with only a
// user agent set, userAgentData follows it but navigator.platform stays the host's (MacIntel).
function stub(o) {
  const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
  const calls = (window.__calls = { share: [], clip: [], gc: [] });
  def('userAgentData', o.uaData);
  def('platform', o.platform);
  def('maxTouchPoints', o.touch || 0);
  const answer = (mode) => (mode === 'resolve' ? Promise.resolve() : Promise.reject(new DOMException('no', 'NotAllowedError')));
  def('share', o.share ? (d) => { calls.share.push(d); return answer(o.share); } : undefined);
  def('clipboard', { writeText: (t) => { calls.clip.push(t); return answer(o.clip || 'resolve'); } });
  if (o.gc === 'record') window.goatcounter = { count: (e) => calls.gc.push(e) };
  if (o.gc === 'throw') window.goatcounter = { count: () => { throw new Error('gc down'); } };
}
const init = (o) => ({ content: `(${stub})(${JSON.stringify(o)})` });

// A page with the given environment. The download links are answered with 204, so a click on one
// leaves the page where it is (the harness would otherwise abort it into an error page).
async function load(open, { ua = UA.mac, viewport, clock, ...env } = {}) {
  const page = await open(null, { userAgent: ua, viewport, init: init({ platform: '', gc: 'record', ...env }) });
  await page.route(`${RELEASES}/download/**`, (r) => r.fulfill({ status: 204 }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.errors = errors;
  // fake timers stopped before load: only runFor moves them, however slow the machine is.
  // The clock runs in real time until pauseAt, which can't go back: 60 s leaves room for a busy machine.
  if (clock) { await page.clock.install({ time: 0 }); await page.clock.pauseAt(60_000); }
  await page.goto(PAGE);
  return page;
}
const gcPaths = (page) => page.evaluate(() => window.__calls.gc.map((e) => e.path));
const cta = (page) => page.locator('[data-cta]').first();
const SEND_ICON = 'M4 12l16-8-6 16-2.5-6.5z';
const ARROW_ICON = 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14';

const CASES = [
  { name: 'Windows by userAgentData', env: { ua: UA.bot, uaData: { platform: 'Windows' } },
    href: EXE, label: 'Download for Windows', sub: 'Free · Windows 10 and 11', icon: ARROW_ICON, tab: 'win' },
  { name: 'Windows by user agent', env: { ua: UA.win },
    href: EXE, label: 'Download for Windows', sub: 'Free · Windows 10 and 11', icon: ARROW_ICON, tab: 'win' },
  { name: 'Mac by navigator.platform', env: { ua: UA.bot, platform: 'MacIntel' },
    href: DMG, label: 'Download for Mac', sub: 'Free · Apple silicon (M1 and newer)', icon: ARROW_ICON, tab: 'mac' },
  { name: 'Mac by user agent, empty userAgentData.platform', env: { ua: UA.mac, uaData: { platform: '' } },
    href: DMG, label: 'Download for Mac', sub: 'Free · Apple silicon (M1 and newer)', icon: ARROW_ICON, tab: 'mac' },
  { name: 'Linux', env: { ua: UA.linux, platform: 'Linux x86_64' },
    href: '#install', label: "Linux isn't out yet", sub: 'Free · Meridian is for macOS and Windows', icon: ARROW_ICON, tab: 'linux' },
  { name: 'an unknown system', env: { ua: UA.bot },
    href: '#install', label: 'Download Meridian', sub: '', icon: ARROW_ICON, tab: 'mac' },
  { name: 'Android', env: { ua: UA.android, platform: 'Linux armv8l' },
    href: '#install', label: 'Send to my computer', sub: 'Free · Meridian is for Mac and Windows', icon: SEND_ICON, tab: 'mac' },
  { name: 'iPhone', env: { ua: UA.iphone, platform: 'iPhone' },
    href: '#install', label: 'Send to my computer', sub: 'Free · Meridian is for Mac and Windows', icon: SEND_ICON, tab: 'mac' },
  { name: 'iPad in desktop mode (Mac with touch)', env: { ua: UA.mac, platform: 'MacIntel', touch: 5 },
    href: '#install', label: 'Send to my computer', sub: 'Free · Meridian is for Mac and Windows', icon: SEND_ICON, tab: 'mac' },
];

for (const c of CASES) {
  test(`detects ${c.name}`, async ({ open }) => {
    const page = await load(open, c.env);
    for (const a of await page.locator('[data-cta]').all()) {
      await expect(a).toHaveAttribute('href', c.href);
      await expect(a.locator('.cl')).toHaveText(c.label);
      await expect(a.locator('.cs')).toHaveText(c.sub);
      await expect(a.locator('.ci svg path').first()).toHaveAttribute('d', c.icon);
    }
    // the bar copies the CTA's href property, which is absolute
    await expect(page.locator('#nav-go')).toHaveAttribute('href', new URL(c.href, page.url()).href);
    await expect(page.locator(`#t-${c.tab}`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator(`#p-${c.tab}`)).toBeVisible();
  });
}

test('the CTA fails the Mac case when the Mac link changes', async ({ open }) => {
  const page = await open(null, { userAgent: UA.mac, init: init({ platform: 'MacIntel' }) });
  await mutate(page, PAGE, "DOWNLOAD + 'mac-arm64.dmg'", "DOWNLOAD + 'mac.dmg'");
  await page.goto(PAGE);
  await expect(cta(page)).not.toHaveAttribute('href', DMG);
});

test('the line under the CTA links to the other systems and to GitHub', async ({ open }) => {
  const page = await load(open);
  const links = page.locator('#cta-sub a');
  await expect(links).toHaveText(['Other systems', 'GitHub']);
  await expect(links.nth(0)).toHaveAttribute('href', '#install');
  await expect(links.nth(1)).toHaveAttribute('href', RELEASES);
});

for (const [os, ua, href] of [['mac', UA.mac, DMG], ['win', UA.win, EXE]]) {
  for (const which of ['[data-cta]', '#nav-go']) {
    test(`${os}: ${which} starts the download, then scrolls to the install steps 400 ms later`, async ({ open }) => {
      const page = await load(open, { ua, clock: true });
      const downloads = [];
      page.on('request', (r) => { if (r.url().startsWith(`${RELEASES}/download/`)) downloads.push(r.url()); });
      await page.locator(which).first().click();
      await expect.poll(() => downloads).toEqual([href]);
      expect(page.url()).toMatch(/\/docs\/index\.html$/);
      await page.clock.runFor(399);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await page.clock.runFor(1);
      await expect.poll(() => page.locator('#install').evaluate((el) => Math.round(el.getBoundingClientRect().top)))
        .toBe(0);
    });
  }
}

test.describe('tabs', () => {
  // [id]: the scroll connection flies id-less copies of the tabs while it runs
  const state = (page) => page.locator('[role=tab][id]').evaluateAll((ts) => ts.map((t) => ({
    os: t.dataset.os, selected: t.getAttribute('aria-selected'), tabIndex: t.tabIndex,
    panelHidden: document.getElementById('p-' + t.dataset.os).hidden,
  })));
  const only = (os) => ['mac', 'win', 'linux'].map((o) => ({
    os: o, selected: String(o === os), tabIndex: o === os ? 0 : -1, panelHidden: o !== os,
  }));

  test('a click selects a tab and shows only its panel', async ({ open }) => {
    const page = await load(open, { platform: 'MacIntel' });
    expect(await state(page)).toEqual(only('mac'));
    await page.locator('#t-win').click();
    expect(await state(page)).toEqual(only('win'));
    await page.locator('#t-linux').click();
    expect(await state(page)).toEqual(only('linux'));
  });

  test('arrow keys move between tabs, wrap around and take focus; other keys do nothing', async ({ open }) => {
    const page = await load(open, { platform: 'MacIntel' });
    await page.locator('#t-mac').focus();
    await page.keyboard.press('ArrowLeft');
    expect(await state(page)).toEqual(only('linux'));
    await expect(page.locator('#t-linux')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    expect(await state(page)).toEqual(only('mac'));
    await expect(page.locator('#t-mac')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    expect(await state(page)).toEqual(only('win'));
    await expect(page.locator('#t-win')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    expect(await state(page)).toEqual(only('win'));
    await expect(page.locator('#t-win')).toBeFocused();
  });

  test('the wrap-around fails when its modulo is dropped', async ({ open }) => {
    const page = await open(null, { userAgent: UA.mac, init: init({ platform: 'MacIntel' }) });
    await mutate(page, PAGE, 'tabs[(i + d + tabs.length) % tabs.length]', 'tabs[i + d]');
    await page.goto(PAGE);
    await page.locator('#t-mac').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#t-linux')).not.toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('download box top (--dlt)', () => {
  // The box sits at max(110, 20% of the height), raised so it fits above the bottom with 24px to
  // spare, never above 84px.
  const read = (page) => page.locator('#install .in').evaluate((box) => ({
    dlt: box.style.getPropertyValue('--dlt'),
    want: Math.round(Math.max(84, Math.min(Math.max(110, innerHeight * 0.2), innerHeight - box.offsetHeight - 24))) + 'px',
  }));

  test('follows the open tab and the window height', async ({ open }) => {
    const page = await load(open, { platform: 'MacIntel', viewport: { width: 1280, height: 1000 } });
    let r = await read(page);
    expect(r.dlt).toBe(r.want);
    const tall = r.dlt;
    await page.setViewportSize({ width: 1280, height: 560 });
    await expect.poll(async () => { const x = await read(page); return x.dlt === x.want && x.dlt !== tall; }).toBe(true);
    await page.locator('#t-win').click();
    r = await read(page);
    expect(r.dlt).toBe(r.want);
    expect(r.dlt).toBe('84px');
  });
});

test.describe('send to my computer (phones)', () => {
  const PHONE = { ua: UA.iphone, platform: 'iPhone', viewport: { width: 390, height: 844 } };
  // An iPad in desktop mode keeps the bar's download button (it is hidden under 480px).
  const IPAD = { ua: UA.mac, platform: 'MacIntel', touch: 5, viewport: { width: 1024, height: 768 } };
  const sendUrl = (page) => page.evaluate(() => location.origin + '/?ref=send');

  test('the share sheet gets the link; the send box stays closed', async ({ open }) => {
    const page = await load(open, { ...PHONE, share: 'resolve' });
    await cta(page).click();
    await expect.poll(() => gcPaths(page)).toEqual(['send-tap', 'send-shared']);
    expect(await page.evaluate(() => window.__calls.share)).toEqual([
      { title: 'Meridian', text: 'Meridian browser', url: await sendUrl(page) },
    ]);
    await expect(page.locator('#sendbox')).toBeHidden();
    expect(page.url()).toMatch(/\/docs\/index\.html$/);
  });

  test('the bar button shares too', async ({ open }) => {
    const page = await load(open, { ...IPAD, share: 'resolve' });
    await page.locator('#nav-go').click();
    await expect.poll(() => gcPaths(page)).toEqual(['send-tap', 'send-shared']);
    await expect(page.locator('#sendbox')).toBeHidden();
    expect(page.url()).toMatch(/\/docs\/index\.html$/);
  });

  for (const [why, share] of [['the share sheet is cancelled', 'reject'], ['there is no share sheet', undefined]]) {
    test(`the send box opens when ${why}`, async ({ open }) => {
      const page = await load(open, { ...PHONE, share });
      await expect(page.locator('#sendbox')).toBeHidden();
      await cta(page).click();
      await expect(page.locator('#sendbox')).toBeVisible();
      await expect(page.locator('#send-note')).toHaveText('Open this link on your Mac or Windows computer:');
      await expect(page.locator('#send-url')).toHaveValue(await sendUrl(page));
      expect(await gcPaths(page)).toEqual(['send-tap', 'send-shown']);
      expect(await page.evaluate(() => window.__calls.share.length)).toBe(share ? 1 : 0);
      expect(page.url()).toMatch(/\/docs\/index\.html$/);
    });
  }

  test('Copy puts the link on the clipboard', async ({ open }) => {
    const page = await load(open, PHONE);
    await cta(page).click();
    await expect(page.locator('#send-copy')).toHaveText('Copy');
    await page.locator('#send-copy').click();
    await expect(page.locator('#send-copy')).toHaveText('Copied!');
    expect(await page.evaluate(() => window.__calls.clip)).toEqual([await sendUrl(page)]);
    expect(await gcPaths(page)).toEqual(['send-tap', 'send-shown', 'send-copied']);
  });

  test('Copy selects the link when the clipboard refuses', async ({ open }) => {
    const page = await load(open, { ...PHONE, clip: 'reject' });
    await cta(page).click();
    const sel = () => page.locator('#send-url').evaluate((i) => [i.selectionStart, i.selectionEnd, i.value.length]);
    const [start0, , len] = await sel();
    expect(start0).toBe(len); // so the check below can fail
    await page.locator('#send-copy').click();
    await expect(page.locator('#send-copy')).toHaveText('Copied!');
    expect(await sel()).toEqual([0, len, len]);
    expect(await gcPaths(page)).toEqual(['send-tap', 'send-shown', 'send-copied']);
  });

  test('Email it to me opens a mail with the link', async ({ open }) => {
    const page = await load(open, PHONE);
    await cta(page).click();
    const mail = page.locator('#send-email');
    await expect(mail).toHaveText('Email it to me');
    await expect(mail).toHaveAttribute('href', 'mailto:?subject=Meridian%20browser&body=' + encodeURIComponent(await sendUrl(page)));
    // cancel the mailto navigation so no mail app is asked; only the count is checked
    await mail.evaluate((a) => a.addEventListener('click', (e) => e.preventDefault()));
    await mail.click();
    expect(await gcPaths(page)).toEqual(['send-tap', 'send-shown', 'send-email']);
  });
});

test.describe('goatcounter', () => {
  const PHONE = { ua: UA.iphone, platform: 'iPhone' };

  test('a missing goatcounter breaks nothing', async ({ open }) => {
    const page = await load(open, { ...PHONE, gc: 'none' });
    expect(await page.evaluate(() => typeof window.goatcounter)).toBe('undefined');
    await cta(page).click();
    await expect(page.locator('#sendbox')).toBeVisible();
    await page.locator('#send-copy').click();
    await expect(page.locator('#send-copy')).toHaveText('Copied!');
    expect(page.errors).toEqual([]);
  });

  // If gc threw, sendToComputer's catch would take a successful share for a failed one.
  test('a throwing goatcounter does not open the send box after a share', async ({ open }) => {
    const page = await load(open, { ...PHONE, gc: 'throw', share: 'resolve' });
    await cta(page).click();
    await expect.poll(() => page.evaluate(() => window.__calls.share.length)).toBe(1);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    await expect(page.locator('#sendbox')).toBeHidden();
    expect(page.errors).toEqual([]);
  });

  // The tap is counted first, so without the try a throwing counter stops the button before it shares.
  test('the same check fails without the try in gc', async ({ open }) => {
    const page = await open(null, { userAgent: UA.iphone, init: init({ platform: 'iPhone', gc: 'throw', share: 'resolve' }) });
    await mutate(page, PAGE, 'const gc = (path) => { try { window.goatcounter && window.goatcounter.count({ path, title: path, event: true }); } catch {} };',
      'const gc = (path) => { window.goatcounter && window.goatcounter.count({ path, title: path, event: true }); };');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(PAGE);
    await cta(page).click();
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__calls.share.length)).toBe(0);
    await expect(page.locator('#sendbox')).toBeHidden();
  });
});

test.describe('Homebrew copy', () => {
  test('copies the command, says Copied! for 1.8 s, then Copy again', async ({ open }) => {
    const page = await load(open, { platform: 'MacIntel', clock: true });
    await page.locator('#copy').click();
    await expect(page.locator('#copy')).toHaveText('Copied!');
    expect(await page.evaluate(() => window.__calls.clip)).toEqual([BREW]);
    await page.clock.runFor(1799);
    await expect(page.locator('#copy')).toHaveText('Copied!');
    await page.clock.runFor(1);
    await expect(page.locator('#copy')).toHaveText('Copy');
  });

  test('selects the command when the clipboard refuses', async ({ open }) => {
    const page = await load(open, { platform: 'MacIntel', clip: 'reject' });
    expect(await page.evaluate(() => getSelection().toString())).toBe('');
    await page.locator('#copy').click();
    await expect(page.locator('#copy')).toHaveText('Copied!');
    expect(await page.evaluate(() => getSelection().toString().trim())).toBe(BREW);
  });
});

test('Windows dialog: Run anyway shows after More info and ticks when pressed', async ({ open }) => {
  const page = await load(open, { ua: UA.win });
  const wd = page.locator('#wd');
  await expect(wd).toBeVisible();
  await expect(wd.locator('.run')).toBeHidden();
  await wd.locator('.mi').click();
  await expect(wd).toHaveClass(/\bmore\b/);
  await expect(wd.locator('.mi')).toBeHidden();
  await expect(wd.locator('dl')).toBeVisible();
  await expect(wd.locator('.run .n')).toHaveText('2');
  await wd.locator('.run').click();
  await expect(wd.locator('.run .n')).toHaveText('✓');
});
