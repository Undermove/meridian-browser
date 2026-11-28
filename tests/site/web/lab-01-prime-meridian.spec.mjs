import { test, expect, mutate } from './fixtures.mjs';

const FILE = 'site/lab/01-prime-meridian.html';
const URL = FILE;
const DL = 'https://github.com/Undermove/meridian-browser/releases/latest/download/Meridian-';
const SEND = 'https://meridianbrowser.app/?ref=send';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  bot: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
};

// Browsers without navigator.userAgentData (Firefox, Safari): the page falls back to navigator.platform.
const platform = (p) => `
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  Object.defineProperty(Navigator.prototype, 'platform', { get: () => ${JSON.stringify(p)} });`;

// Records what the page copies or shares instead of touching the real clipboard.
const stubs = ({ clipboard = 'ok', share = 'none' } = {}) => `
  window.__copied = []; window.__shared = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => {
    ${clipboard === 'ok' ? 'window.__copied.push(t);' : "throw new Error('denied');"}
  } } });
  ${share === 'none' ? "Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });"
    : `Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
        window.__shared.push(d); ${share === 'ok' ? '' : "throw new Error('AbortError');"}
      } });`}`;

const touch = 'Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5 });';

async function ctaState(page) {
  return page.evaluate(() => ({
    href: document.querySelector('#cta').getAttribute('href'),
    label: document.querySelector('#cta-label').textContent,
    small: document.querySelector('#cta-small').textContent,
    icon: document.querySelector('#cta-icon').innerHTML.slice(0, 40),
    href2: document.querySelector('#cta2').getAttribute('href'),
    label2: document.querySelector('#cta2 .cta-label').textContent,
    small2: document.querySelector('#cta2 .cta-small').textContent,
    tab: document.querySelector('.tabs button[aria-selected="true"]').dataset.os,
    panels: [...document.querySelectorAll('.panel.on')].map((p) => p.dataset.panel),
    send: !document.querySelector('.mobile-send').hidden,
  }));
}

test.describe('download button per system', () => {
  test('a Mac gets the Mac disk image and the Mac tab', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const s = await ctaState(page);
    expect(s).toMatchObject({
      href: DL + 'mac-arm64.dmg', label: 'Download for Mac', small: 'Free · Apple silicon (M1 and newer)',
      href2: DL + 'mac-arm64.dmg', label2: 'Download for Mac', small2: 'Free · Apple silicon (M1 and newer)',
      tab: 'mac', panels: ['mac'], send: false,
    });
    const macIcon = await page.locator('[data-os="mac"] svg').evaluate((e) => e.outerHTML);
    expect(await page.locator('#cta-icon').innerHTML()).toBe(macIcon);
  });

  test('Windows gets the installer and the Windows tab', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.win, init: stubs() });
    expect(await ctaState(page)).toMatchObject({
      href: DL + 'win.exe', label: 'Download for Windows', small: 'Free · Windows 10 and 11', href2: DL + 'win.exe', tab: 'win', panels: ['win'],
    });
  });

  test('Firefox on Windows (no userAgentData) is found by navigator.platform', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.firefoxWin, init: [platform('Win32'), stubs()] });
    expect(await ctaState(page)).toMatchObject({ href: DL + 'win.exe', tab: 'win' });
  });

  test('Linux is told it is not out yet and sees the Linux tab', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.linux, init: stubs() });
    expect(await ctaState(page)).toMatchObject({
      href: '#install', label: "Linux isn't out yet", small: 'Meridian is for macOS and Windows', tab: 'linux', panels: ['linux'], send: false,
    });
    const linuxIcon = await page.locator('[data-os="linux"] svg').evaluate((e) => e.outerHTML);
    expect(await page.locator('#cta-icon').innerHTML()).toBe(linuxIcon);
  });

  test('an unknown system gets a plain button and the Mac tab', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.bot, init: [platform(''), stubs()] });
    expect(await ctaState(page)).toMatchObject({ href: '#install', label: 'Download Meridian', small: '', tab: 'mac', panels: ['mac'], send: false });
    expect(await page.locator('#cta-icon path').getAttribute('d')).toBe('M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14');
  });

  test('the platform alone is enough, whatever the user agent says', async ({ open }) => {
    for (const [p, os] of [['Win32', 'win'], ['MacIntel', 'mac']]) {
      const page = await open(URL, { userAgent: UA.bot, init: [platform(p), stubs()] });
      expect(await ctaState(page)).toMatchObject({ tab: os, href: DL + (os === 'win' ? 'win.exe' : 'mac-arm64.dmg') });
    }
  });

  test('a Windows laptop with a touch screen is not a phone', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.win, init: [touch, stubs()] });
    expect(await ctaState(page)).toMatchObject({ label: 'Download for Windows', send: false });
  });

  test('opening the page focuses nothing and does not scroll', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    expect(await page.evaluate(() => ({ focus: document.activeElement.tagName, y: scrollY }))).toEqual({ focus: 'BODY', y: 0 });
  });

  test('fails when the Windows link changes (mutation)', async ({ open }) => {
    const page = await open(null, { userAgent: UA.win, init: stubs() });
    await mutate(page, FILE, "DOWNLOAD + 'win.exe'", "DOWNLOAD + 'windows.exe'");
    await page.goto(URL);
    expect((await ctaState(page)).href).not.toBe(DL + 'win.exe');
  });
});

test.describe('after the download starts', () => {
  for (const [os, other, reducedMotion] of [['mac', 'win', 'no-preference'], ['mac', 'win', 'reduce'], ['win', 'mac', 'reduce']]) {
    test(`a ${os} click shows the install steps (${reducedMotion})`, async ({ open }) => {
      const page = await open(URL, { userAgent: UA[os], reducedMotion, init: stubs() });
      // The real link would start a download; keep the page here.
      await page.route('**/Meridian-*', (r) => r.fulfill({ status: 204 }));
      await page.evaluate(() => document.querySelector('#cta').addEventListener('click', (e) => e.preventDefault()));
      await page.locator(`[data-os="${other}"]`).click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.locator('#cta').click();
      await expect(page.locator('.panel.on')).toHaveAttribute('data-panel', os);
      await expect.poll(() => page.locator('#install').evaluate((e) => {
        const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0;
      })).toBe(true);
    });
  }
});

test.describe('phones get "send to my computer"', () => {
  test('an Android phone sees the send button and the email link', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.android, init: stubs() });
    const s = await ctaState(page);
    expect(s).toMatchObject({ href: '#', label: 'Send to my computer', small: 'Free · Meridian is for Mac and Windows', send: true, tab: 'mac' });
    expect(s.icon).toContain('svg');
    await expect(page.locator('#send-url')).toHaveValue(SEND);
    await expect(page.locator('#send-email')).toHaveAttribute('href',
      'mailto:?subject=Meridian%20browser&body=' + encodeURIComponent(SEND));
  });

  test('an iPad that says it is a Mac counts as a phone', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: [touch, stubs()] });
    expect(await ctaState(page)).toMatchObject({ label: 'Send to my computer', send: true });
  });

  test('the share sheet gets the link, and the box stays closed', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.android, init: stubs({ share: 'ok' }) });
    await page.locator('#cta').click();
    await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([{ title: 'Meridian', text: 'Meridian browser', url: SEND }]);
    await expect(page.locator('#sendbox')).toBeHidden();
    expect(new globalThis.URL(page.url()).hash).toBe('');
  });

  test('a cancelled share opens the box under the hero button', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.android, init: stubs({ share: 'fail' }) });
    await page.locator('#cta').click();
    await expect(page.locator('#sendbox')).toBeVisible();
    expect(await page.evaluate(() => document.querySelector('.cta-sub').nextElementSibling.id)).toBe('sendbox');
    expect(await page.evaluate(() => window.__shared.length)).toBe(1);
  });

  for (const reducedMotion of ['no-preference', 'reduce']) {
    test(`with no share sheet the box moves next to the button pressed (${reducedMotion})`, async ({ open }) => {
      const page = await open(URL, { userAgent: UA.android, reducedMotion, init: stubs() });
      await page.locator('#cta2').click();
      await expect(page.locator('#sendbox')).toBeVisible();
      expect(await page.evaluate(() => document.querySelector('#cta2').nextElementSibling.id)).toBe('sendbox');
      await page.locator('#send2').click();
      await expect.poll(() => page.evaluate(() => document.querySelector('.mobile-send').nextElementSibling.id)).toBe('sendbox');
      await expect.poll(() => page.locator('#sendbox').evaluate((e) => {
        const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
      })).toBe(true);
    });
  }

  test('Copy puts the link on the clipboard', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.android, init: stubs() });
    await page.locator('#send2').click();
    await page.locator('#send-copy').click();
    await expect(page.locator('#send-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => window.__copied)).toEqual([SEND]);
  });

  test('when the clipboard says no, the link is selected to copy by hand', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.android, init: stubs({ clipboard: 'fail' }) });
    await page.locator('#send2').click();
    await page.locator('#send-copy').click();
    await expect(page.locator('#send-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => {
      const i = document.querySelector('#send-url'); return document.activeElement === i && i.value.slice(i.selectionStart, i.selectionEnd);
    })).toBe(SEND);
  });
});

test.describe('install tabs and the brew command', () => {
  test('click and arrow keys move between systems, and wrap round', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const sel = () => page.evaluate(() => ({
      tab: document.querySelector('.tabs button[aria-selected="true"]').dataset.os,
      focus: document.activeElement.dataset.os,
      tabbable: [...document.querySelectorAll('.tabs button')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.os),
      panel: document.querySelector('.panel.on').dataset.panel,
    }));
    await page.locator('[data-os="linux"]').click();
    expect(await sel()).toEqual({ tab: 'linux', focus: 'linux', tabbable: ['linux'], panel: 'linux' });
    await page.keyboard.press('ArrowRight');
    expect(await sel()).toMatchObject({ tab: 'mac', focus: 'mac', panel: 'mac' });
    await page.keyboard.press('ArrowLeft');
    expect(await sel()).toMatchObject({ tab: 'linux', focus: 'linux' });
    await page.keyboard.press('ArrowLeft');
    expect(await sel()).toMatchObject({ tab: 'win', focus: 'win', panel: 'win' });
    await page.keyboard.press('Enter');
    expect(await sel()).toMatchObject({ tab: 'win' });
  });

  test('Copy copies the brew command, then says Copy again', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const btn = page.locator('[data-copy="brew-cmd"]');
    await btn.click();
    await expect(btn).toHaveText('Copied');
    expect(await page.evaluate(() => window.__copied)).toEqual(['brew install --cask undermove/tap/meridian']);
    await expect(btn).toHaveText('Copy');
  });

  test('without clipboard access the command is selected instead', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs({ clipboard: 'fail' }) });
    await page.locator('[data-copy="brew-cmd"]').click();
    await expect(page.locator('[data-copy="brew-cmd"]')).toHaveText('Copied');
    expect(await page.evaluate(() => getSelection().toString())).toBe('brew install --cask undermove/tap/meridian');
  });
});

test.describe('reveals and the line', () => {
  test('sections fade in as they scroll into view', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const target = page.locator('#install h2.reveal');
    await expect(target).not.toHaveClass(/\bin\b/);
    await target.scrollIntoViewIfNeeded();
    await expect(target).toHaveClass(/\bin\b/);
  });

  test('the station labels carry their latitude, top to bottom', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const lats = await page.locator('[data-lat]').allTextContents();
    expect(lats.length).toBeGreaterThan(3);
    for (const l of lats) expect(l).toMatch(/^· Lat \d\d°\d\d′[NS]$/);
    expect(lats[0]).toMatch(/N$/);
    expect(lats[lats.length - 1]).toMatch(/S$/);
  });

  test('the lit line follows the scroll, and its head fades at the end', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const scale = () => page.locator('#lit').evaluate((e) => +(/scaleY\(([\d.e-]+)\)/.exec(e.style.transform) || [0, -1])[1]);
    await expect.poll(scale).toBeGreaterThan(0);
    const top = await scale();
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(scale).toBe(1);
    expect(top).toBeLessThan(1);
    await expect.poll(() => page.locator('#head').evaluate((e) => e.style.opacity)).toBe('0');
    await expect(page.locator('#hud-lat')).toHaveText('90°00′S');
    await page.evaluate(() => scrollTo(0, 0));
    await expect.poll(() => page.locator('#head').evaluate((e) => e.style.opacity)).toBe('1');
    await expect(page.locator('#hud-lat')).toHaveText('90°00′N');
  });

  test('the HUD reads the latitude of the scroll, in whole minutes', async ({ open }) => {
    // A page 18,900px tall in a 900px window: 18,000px of scroll, so 100px is one degree.
    const tall = `new MutationObserver((_, o) => { if (document.head) { o.disconnect();
      const s = document.createElement('style'); s.textContent = 'body > * { display: none !important } html, body { margin: 0; padding: 0; height: 18900px }'; document.head.append(s); } })
      .observe(document, { childList: true, subtree: true });`;
    const page = await open(URL, { userAgent: UA.mac, reducedMotion: 'reduce', viewport: { width: 1200, height: 900 }, init: [tall, stubs()] });
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(18000);
    for (const [y, lat] of [[4500, '45°00′N'], [4509, '44°54′N'], [9000, '00°00′N'], [13500, '45°00′S'], [18000, '90°00′S'], [0, '90°00′N']]) {
      await page.evaluate((y) => scrollTo(0, y), y);
      await expect(page.locator('#hud-lat')).toHaveText(lat);
    }
  });

  test('with reduced motion the line jumps instead of easing', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, reducedMotion: 'reduce', init: stubs() });
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight / 2));
    await expect(page.locator('#hud-lat')).not.toHaveText('90°00′N');
    expect(await page.locator('#lit').evaluate((e) => e.style.transform)).toBe('');
  });

  test('a hidden line does not divide by zero', async ({ open }) => {
    // Hide the line before the page script measures it.
    const hide = `new MutationObserver((_, o) => { if (document.head) { o.disconnect();
      const s = document.createElement('style'); s.id = 'hide'; s.textContent = '.spine { display: none }'; document.head.append(s); } })
      .observe(document, { childList: true, subtree: true });`;
    const page = await open(URL, { userAgent: UA.mac, init: [hide, stubs()] });
    for (const l of await page.locator('[data-lat]').allTextContents()) expect(l).toMatch(/^· Lat 90°00′S$/);
    await page.evaluate(() => document.getElementById('hide').remove());
    await expect.poll(() => page.locator('[data-lat]').first().textContent()).not.toBe('· Lat 90°00′S');
  });
});

// The globe: non-blank pixels, and whether two frames differ.
const globe = (page) => page.locator('#globe').evaluate((c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lit = 0, sum = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) { lit++; sum = (sum + d[i] * i) % 1e9; }
  return { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, lit, sum };
});
// Counted in the page's own frames, so a slow machine does not change the answer.
const frames = (page, n) => page.evaluate((n) => new Promise((r) => {
  let i = 0; const f = () => (++i >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f);
}), n);
const turns = async (page) => {
  const a = (await globe(page)).sum;
  await frames(page, 12);
  return (await globe(page)).sum !== a;
};

test.describe('the globe', () => {
  test('is drawn and turns on a wide screen', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    const g = await globe(page);
    expect(g.lit).toBeGreaterThan(1000);
    expect(g.w).toBe(Math.round(g.cssW));
    await expect.poll(() => turns(page)).toBe(true);
  });

  test('stops turning off screen and in a hidden tab, and starts again', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    await page.evaluate(() => scrollTo(0, innerHeight * 3));
    await expect.poll(() => turns(page)).toBe(false);
    await page.evaluate(() => scrollTo(0, 0));
    await expect.poll(() => turns(page)).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => turns(page)).toBe(false);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => turns(page)).toBe(true);
  });

  test('holds still with reduced motion, also when it is switched on later', async ({ open }) => {
    const still = await open(URL, { userAgent: UA.mac, reducedMotion: 'reduce', init: stubs() });
    expect((await globe(still)).lit).toBeGreaterThan(1000);
    expect(await turns(still)).toBe(false);

    const page = await open(URL, { userAgent: UA.mac, init: stubs() });
    await expect.poll(() => turns(page)).toBe(true);
    // Off screen first: while the globe turns in view, the page's 'change' listeners did not run
    // after emulateMedia in this Chromium.
    await page.evaluate(() => scrollTo(0, innerHeight * 3));
    await expect.poll(() => turns(page)).toBe(false);
    // The easing line must have landed too: a step still running would overwrite the reset.
    const lit = () => page.locator('#lit').evaluate((e) => e.style.transform);
    await expect.poll(async () => { const a = await lit(); await frames(page, 3); return a === await lit(); }).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(async () => { await frames(page, 2); return lit(); }).toBe('');
    await page.evaluate(() => scrollTo(0, 0));
    expect(await turns(page)).toBe(false);
    expect((await globe(page)).sum).toBe((await globe(still)).sum);
  });

  test('on a narrow screen it is smaller and dimmer, and resizes with the window', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, reducedMotion: 'reduce', viewport: { width: 600, height: 900 }, init: stubs() });
    const narrow = await globe(page);
    expect(narrow.lit).toBeGreaterThan(500);
    expect(narrow.w).toBe(600);
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(async () => (await globe(page)).w).toBe(1200);
  });

  test('900px wide or less, the globe is higher, smaller, dimmer and has no degree labels', async ({ open }) => {
    const spy = () => {
      window.__cv = { alpha: [], text: 0, glow: null };
      const P = CanvasRenderingContext2D.prototype, a = Object.getOwnPropertyDescriptor(P, 'globalAlpha'), ft = P.fillText;
      // The first arc of a frame is the glow round the globe: centre (cx, cy), radius 1.25 R.
      const cr = P.clearRect, arc = P.arc; let first = false;
      P.clearRect = function (...args) { first = true; return cr.apply(this, args); };
      P.arc = function (x, y, r, ...rest) { if (first) { first = false; window.__cv.glow = { y, r: r / 1.25 }; } return arc.call(this, x, y, r, ...rest); };
      Object.defineProperty(P, 'globalAlpha', { configurable: true, get() { return a.get.call(this); }, set(v) { window.__cv.alpha.push(v); a.set.call(this, v); } });
      P.fillText = function (...args) { window.__cv.text++; return ft.apply(this, args); };
    };
    const draws = async (width) => {
      const page = await open(URL, { userAgent: UA.mac, reducedMotion: 'reduce', viewport: { width, height: 900 }, init: [spy, stubs()] });
      expect((await globe(page)).w).toBe(width);
      return page.evaluate(() => ({ alpha: [...new Set(window.__cv.alpha)].sort(), text: window.__cv.text, glow: window.__cv.glow }));
    };
    // In a 900px tall window: narrow, the centre is at a third of the height and R at 30% of it;
    // wide, the centre is at 52% and R is min(41% of the height, 36% of the width).
    const narrow = await draws(900);
    expect(narrow).toMatchObject({ alpha: [0.62, 1], text: 0 });
    expect(narrow.glow.y).toBeCloseTo(297, 5);
    expect(narrow.glow.r).toBeCloseTo(270, 5);
    const wide = await draws(901);
    expect(wide.alpha).toEqual([1]);
    expect(wide.glow.y).toBeCloseTo(468, 5);
    expect(wide.glow.r).toBeCloseTo(901 * 0.36, 5);
    // Ten labels a frame: 30° to 330° in steps of 30°, without 180°.
    expect(wide.text).toBeGreaterThan(0);
    expect(wide.text % 10).toBe(0);
  });

  test('uses the screen density, capped at 2', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, deviceScaleFactor: 3, viewport: { width: 1000, height: 700 }, init: stubs() });
    const g = await globe(page);
    expect(g.w).toBe(2000);
  });

  test('a browser that reports no density draws at 1x', async ({ open }) => {
    const page = await open(URL, { userAgent: UA.mac, deviceScaleFactor: 2, viewport: { width: 1000, height: 700 },
      init: ['window.devicePixelRatio = 0;', stubs()] });
    const g = await globe(page);
    expect(g.w).toBe(1000);
    expect(g.lit).toBeGreaterThan(1000);
  });

  test('fails when the globe stops turning (mutation)', async ({ open }) => {
    const page = await open(null, { userAgent: UA.mac, init: stubs() });
    await mutate(page, FILE, '(now - t0) / 1000 * 0.05', '(now - t0) / 1000 * 0');
    await page.goto(URL);
    expect(await turns(page)).toBe(false);
  });
});
