import { test, expect, mutate } from './fixtures.mjs';

const FILE = 'site/lab/02-the-window.html';
const URL = FILE;
const DL = 'https://github.com/Undermove/meridian-browser/releases/latest/download/Meridian-';
const BREW = 'brew install --cask undermove/tap/meridian';
const SITE = 'https://meridianbrowser.app/';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  bot: 'Mozilla/5.0 (compatible; SomeBot/1.0)',
};
const DESK = { width: 1280, height: 800 };
const PHONE = { width: 420, height: 860 };

const noUAData = (p) => `
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  Object.defineProperty(Navigator.prototype, 'platform', { get: () => ${JSON.stringify(p)} });`;

// Records copies, shares and window.open calls instead of doing them.
const stubs = ({ clipboard = 'ok', share = 'none' } = {}) => `
  window.__copied = []; window.__shared = []; window.__opened = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => {
    ${clipboard === 'ok' ? 'window.__copied.push(t);' : "throw new Error('denied');"}
  } } });
  ${share === 'none' ? "Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });"
    : `Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
        window.__shared.push(d); ${share === 'ok' ? '' : "throw new Error('AbortError');"}
      } });`}
  window.open = (...a) => { window.__opened.push(a); return null; };`;

// reducedMotion 'reduce' unless a test needs the animated branch: no smooth scrolls or delays.
function load(open, { ua = UA.mac, viewport = DESK, calm = true, hash = '', init = [], clip } = {}) {
  return open(URL + hash, { userAgent: ua, viewport, reducedMotion: calm ? 'reduce' : 'no-preference', init: [stubs(clip), ...[].concat(init)] });
}

const state = (page) => page.evaluate(() => {
  const panes = [...document.querySelectorAll('.pane')];
  return {
    space: +document.documentElement.dataset.space,
    tab: [...document.querySelectorAll('.tab.on')].map((t) => t.hash.slice(1)),
    current: [...document.querySelectorAll('.tab[aria-current]')].map((t) => t.hash.slice(1)),
    path: document.getElementById('url-path').textContent,
    dot: document.querySelector('.spc-dot[aria-current="true"]').dataset.space,
    here: document.querySelector('.spc.here').dataset.space,
    inert: panes.map((p) => p.inert),
    sbInert: [...document.querySelectorAll('.sb-space')].map((p) => p.inert),
    tour: [...document.querySelectorAll('[data-tour].done')].map((l) => l.dataset.tour),
    focus: document.activeElement.closest('.pane') ? 'pane' + document.activeElement.closest('.pane').dataset.space
      : document.activeElement.id || document.activeElement.tagName,
  };
});

// The section is scrolled to: at the top of its pane (desk) or the window (phone), or as far as
// the scroll goes when it is the last one.
const shown = (page, id) => page.evaluate((id) => {
  const s = document.getElementById(id);
  const desk = matchMedia('(min-width: 860px)').matches;
  const box = desk ? s.closest('.pane') : document.scrollingElement;
  const top = s.getBoundingClientRect().top - (desk ? box.getBoundingClientRect().top : 0);
  const atEnd = Math.abs(box.scrollTop - (box.scrollHeight - box.clientHeight)) <= 1;
  return Math.abs(top) <= 1 || (top > 0 && atEnd);
}, id);

// A wheel turn the page has handled: mouse.wheel() can return before the page's listener runs.
// The counter is added after the page's listener, so it counts an event once the page is done with it.
const countWheels = (page) => page.evaluate(() => { window.__wheels = 0; addEventListener('wheel', () => window.__wheels++, { passive: true }); });
async function wheel(page, dx, dy) {
  const n = await page.evaluate(() => window.__wheels);
  await page.mouse.wheel(dx, dy);
  await expect.poll(() => page.evaluate(() => window.__wheels)).toBe(n + 1);
}

test.describe('tabs and spaces on a desktop', () => {
  test('starts on Welcome in the first space, with the pane focused', async ({ open }) => {
    const page = await load(open);
    expect(await state(page)).toEqual({
      space: 0, tab: ['welcome'], current: ['welcome'], path: '/welcome', dot: '0', here: '0',
      inert: [false, true, true], sbInert: [false, true, true], tour: [], focus: 'pane0',
    });
  });

  test('a sidebar tab opens its section and ticks "pick a tab"', async ({ open }) => {
    const page = await load(open);
    await page.locator('.tab[href="#today"]').click();
    expect(await state(page)).toMatchObject({ space: 0, tab: ['today'], current: ['today'], path: '/today', tour: ['tab'] });
    await expect.poll(() => shown(page, 'today')).toBe(true);
  });

  test('a space dot switches space and ticks "switch space"', async ({ open }) => {
    const page = await load(open);
    await page.locator('.spc-dot[data-space="2"]').click();
    expect(await state(page)).toMatchObject({ space: 2, tab: ['q-free'], path: '/q-free', dot: '2', here: '2', inert: [true, true, false], tour: ['space'] });
  });

  test('a plain in-page link goes to its section without ticking anything', async ({ open }) => {
    const page = await load(open);
    await page.locator('.sub a[href="#download"]').click();
    expect(await state(page)).toMatchObject({ space: 1, tab: ['download'], tour: [] });
    await page.locator('.ghost[href="#download"]').click();
    expect(await state(page)).toMatchObject({ space: 1, tab: ['download'] });
  });

  test('a space card returns to the tab last open in that space', async ({ open }) => {
    const page = await load(open);
    await page.locator('.spc-dot[data-space="1"]').click();
    await page.locator('.tab[href="#homebrew"]').click();
    await page.locator('.spc-dot[data-space="0"]').click();
    await page.locator('.tab[href="#spaces"]').click();
    await page.locator('.spc[data-space="1"]').click();
    expect(await state(page)).toMatchObject({ space: 1, tab: ['homebrew'], path: '/homebrew' });
  });

  test('back, forward and reload walk the tabs in order', async ({ open }) => {
    const page = await load(open);
    await page.locator('#nav-back').click();
    expect((await state(page)).tab).toEqual(['welcome']);
    await page.locator('#nav-fwd').click();
    expect((await state(page)).tab).toEqual(['spaces']);
    await page.locator('.tab[href="#private"]').click();
    await page.locator('#nav-fwd').click();
    expect(await state(page)).toMatchObject({ space: 1, tab: ['download'] });
    await page.locator('#nav-back').click();
    expect(await state(page)).toMatchObject({ space: 0, tab: ['private'] });
    // A small scroll that keeps Private the tab on screen.
    await page.evaluate(() => document.querySelector('.pane').scrollBy(0, -50));
    await page.locator('#nav-reload').click();
    await expect.poll(() => shown(page, 'private')).toBe(true);
  });

  test('scrolling a pane makes the tab on screen the active one', async ({ open }) => {
    const page = await load(open);
    await page.evaluate(() => {
      const pane = document.querySelector('.pane');
      pane.scrollTo(0, document.getElementById('split').offsetTop - pane.clientHeight * 0.3 + 10);
    });
    await expect.poll(async () => (await state(page)).tab).toEqual(['split']);
  });

  test('arrow keys switch space, but not past the ends or with a modifier', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('ArrowLeft');
    expect(await state(page)).toMatchObject({ space: 0, tour: [] });
    await page.keyboard.press('ArrowRight');
    expect(await state(page)).toMatchObject({ space: 1, tab: ['download'], focus: 'pane1', tour: ['space'] });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).space).toBe(2);
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('a');
    expect((await state(page)).space).toBe(2);
    await page.keyboard.press('ArrowLeft');
    expect((await state(page)).space).toBe(1);
  });

  test('fails when the right arrow goes the wrong way (mutation)', async ({ open }) => {
    const page = await open(null, { userAgent: UA.mac, viewport: DESK, reducedMotion: 'reduce', init: stubs() });
    await mutate(page, FILE, "if (e.key === 'ArrowRight') setSpace(space + 1, true);", "if (e.key === 'ArrowRight') setSpace(space - 1, true);");
    await page.goto(URL);
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).space).not.toBe(1);
  });

  test('a sideways trackpad swipe switches space once per gesture', async ({ open }) => {
    const page = await open(null, { userAgent: UA.mac, viewport: DESK, reducedMotion: 'reduce', init: stubs() });
    await page.clock.install();
    await page.goto(URL);
    // Paused, so a slow machine cannot outlast the 900 ms cooldown between wheel events.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await countWheels(page);
    await page.mouse.move(700, 400);
    await wheel(page, 0, 200);
    await wheel(page, 60, 0);
    expect((await state(page)).space).toBe(0);
    await wheel(page, 30, 0);
    expect((await state(page)).space).toBe(1);
    // The same gesture keeps sending deltas: no second switch during the cooldown.
    await wheel(page, 200, 0);
    expect(await state(page)).toMatchObject({ space: 1, tour: ['space'] });
    await page.clock.resume();
    // A sideways scroll over code scrolls the code, not the window.
    await page.locator('.tab[href="#homebrew"]').click();
    const code = page.locator('#homebrew .ln code');
    const box = await code.boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await expect.poll(async () => { await page.mouse.wheel(-200, 0); return (await state(page)).space; }, { timeout: 3000 }).toBe(1);
    await page.mouse.move(700, 100);
    await expect.poll(async () => { await page.mouse.wheel(-200, 0); return (await state(page)).space; }).toBe(0);
  });

  test('back on the first tab and forward on the last do nothing, and throw nothing', async ({ open }) => {
    const page = await load(open);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.locator('#nav-back').click();
    expect((await state(page)).tab).toEqual(['welcome']);
    await page.locator('.spc-dot[data-space="2"]').click();
    await page.locator('.tab[href="#small-print"]').click();
    await page.locator('#nav-fwd').click();
    expect(await state(page)).toMatchObject({ space: 2, tab: ['small-print'] });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    expect(errors).toEqual([]);
  });

  test('an animated tab click lights only that tab, not the ones it scrolls past', async ({ open }) => {
    const page = await load(open, { calm: false });
    await page.evaluate(() => {
      window.__paths = [];
      new MutationObserver(() => window.__paths.push(document.getElementById('url-path').textContent))
        .observe(document.getElementById('url-path'), { childList: true, characterData: true, subtree: true });
    });
    await page.locator('.tab[href="#private"]').click();
    await expect.poll(() => shown(page, 'private')).toBe(true);
    expect([...new Set(await page.evaluate(() => window.__paths))]).toEqual(['/private']);
  });

  test('a sideways swipe interrupted by a vertical scroll starts counting again', async ({ open }) => {
    const page = await load(open);
    await countWheels(page);
    await page.mouse.move(700, 400);
    await wheel(page, 60, 0);
    await wheel(page, 0, 200);
    await wheel(page, 30, 0);
    expect((await state(page)).space).toBe(0);
  });

  test('sliding past a space does not pick its tabs', async ({ open }) => {
    const page = await load(open, { calm: false });
    await page.evaluate(() => {
      window.__paths = [];
      new MutationObserver(() => window.__paths.push(document.getElementById('url-path').textContent))
        .observe(document.getElementById('url-path'), { childList: true, characterData: true, subtree: true });
    });
    // Hold the slide with the middle space in view. This listener runs after the page's Enter
    // handler; getAnimations() flushes style, so the new transition is already there.
    await page.evaluate(() => addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const a = document.querySelector('.track').getAnimations()[0];
      if (a) { a.pause(); a.currentTime = a.effect.getComputedTiming().duration / 2; }
      window.__held = !!a;
    }));
    await page.keyboard.press('Control+k');
    await page.keyboard.type('switch questions');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => window.__held)).toBe(true);
    // An observer like the page's sees the middle space's tab; the page's got the same entry.
    await page.evaluate(() => new Promise((r) => {
      const o = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { o.disconnect(); r(); } }, { rootMargin: '-30% 0px -65% 0px' });
      o.observe(document.getElementById('download'));
    }));
    await page.evaluate(() => document.querySelector('.track').getAnimations().forEach((a) => a.finish()));
    expect([...new Set(await page.evaluate(() => window.__paths))]).toEqual(['/q-free']);
    expect(await state(page)).toMatchObject({ space: 2, tab: ['q-free'] });
  });
});

test.describe('on a phone', () => {
  test('all panes stay reachable, and scrolling down switches space', async ({ open }) => {
    const page = await load(open, { viewport: PHONE });
    expect(await state(page)).toMatchObject({ space: 0, inert: [false, false, false], sbInert: [false, false, false], focus: 'BODY' });
    await page.evaluate(() => scrollTo(0, document.getElementById('arc-import').getBoundingClientRect().top + scrollY - innerHeight * 0.3 + 10));
    await expect.poll(async () => (await state(page)).tab).toEqual(['arc-import']);
    expect(await state(page)).toMatchObject({ space: 1, dot: '1' });
    // The arrows only switch space on a desktop.
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).space).toBe(1);
  });

  for (const calm of [true, false]) {
    test(`a tab scrolls the window and the tab strip (${calm ? 'reduced motion' : 'animated'})`, async ({ open }) => {
      const page = await load(open, { viewport: PHONE, calm });
      await page.locator('.tab[href="#private"]').click();
      expect((await state(page)).tab).toEqual(['private']);
      // The section lands under the sticky bar.
      await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('private').getBoundingClientRect().top - document.querySelector('.sb').offsetHeight))).toBe(6);
      await expect.poll(() => page.evaluate(() => {
        const t = document.querySelector('.tab.on'), r = t.parentElement.getBoundingClientRect(), b = t.getBoundingClientRect();
        return b.left >= r.left && b.right <= r.right + 1;
      })).toBe(true);
    });
  }

  test('a space card goes to the first tab of that space', async ({ open }) => {
    const page = await load(open, { viewport: PHONE });
    await page.locator('.tab[href="#spaces"]').click();
    await page.locator('.spc[data-space="2"]').click();
    expect(await state(page)).toMatchObject({ space: 2, tab: ['q-free'], tour: ['tab', 'space'] });
  });

  test('a sideways swipe does not switch space', async ({ open }) => {
    const page = await load(open, { viewport: PHONE });
    await countWheels(page);
    await page.mouse.move(200, 400);
    await wheel(page, 300, 0);
    await wheel(page, 300, 0);
    expect((await state(page)).space).toBe(0);
  });

  test('turning the phone into a desktop window and back', async ({ open }) => {
    const page = await load(open, { viewport: PHONE });
    await page.evaluate(() => scrollTo(0, 400));
    await page.setViewportSize(DESK);
    await expect.poll(async () => (await state(page)).inert).toEqual([false, true, true]);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.setViewportSize(PHONE);
    await expect.poll(async () => (await state(page)).inert).toEqual([false, false, false]);
  });
});

test.describe('opening at a tab', () => {
  test('a link to #homebrew opens that tab in its space', async ({ open }) => {
    const page = await load(open, { hash: '#homebrew' });
    // Opening in another space counts as a space switch on the tour.
    expect(await state(page)).toMatchObject({ space: 1, tab: ['homebrew'], path: '/homebrew', tour: ['space'] });
    // The browser's own jump to the hash keeps the 100px scroll-margin-top, unlike a tab click.
    await expect.poll(() => page.evaluate(() => {
      const s = document.getElementById('homebrew');
      return Math.round(s.getBoundingClientRect().top - s.closest('.pane').getBoundingClientRect().top);
    })).toBeLessThanOrEqual(100);
  });

  test('animated, a link to a tab still jumps there at once', async ({ open }) => {
    // Read before load: a smooth scroll would still be near the top of the pane then.
    const atLoad = () => document.addEventListener('DOMContentLoaded', () => {
      const s = document.getElementById('homebrew');
      window.__top = s.getBoundingClientRect().top - s.closest('.pane').getBoundingClientRect().top;
    });
    const page = await load(open, { calm: false, hash: '#homebrew', init: atLoad });
    expect(Math.abs(await page.evaluate(() => window.__top))).toBeLessThanOrEqual(1);
  });

  test('changing the hash moves to that tab; an unknown hash does nothing', async ({ open }) => {
    const page = await load(open);
    await page.evaluate(() => { location.hash = '#q-brew'; });
    await expect.poll(async () => (await state(page)).tab).toEqual(['q-brew']);
    expect((await state(page)).space).toBe(2);
    await page.evaluate(() => { location.hash = '#nowhere'; });
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#nowhere');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    expect((await state(page)).tab).toEqual(['q-brew']);
  });
});

const ctaState = (page) => page.evaluate(() => ({
  hero: document.querySelector('.hero [data-cta]').getAttribute('href'),
  label: document.querySelector('.hero [data-cta-label]').textContent,
  small: document.querySelector('.hero [data-cta-small]').textContent,
  band: document.querySelector('.band [data-cta]').getAttribute('href'),
  fav: document.querySelector('[data-cta-href]').getAttribute('href'),
  os: document.querySelector('.os button[aria-selected="true"]').dataset.os,
  panels: [...document.querySelectorAll('.panel:not([hidden])')].map((p) => p.dataset.panel),
  modk: [...document.querySelectorAll('.modk')].map((k) => k.textContent),
}));

test.describe('download button per system', () => {
  test('Mac', async ({ open }) => {
    const page = await load(open);
    expect(await ctaState(page)).toEqual({
      hero: DL + 'mac-arm64.dmg', label: 'Download for Mac', small: 'Free · Apple silicon (M1 and newer)',
      band: DL + 'mac-arm64.dmg', fav: DL + 'mac-arm64.dmg', os: 'mac', panels: ['mac'], modk: ['⌘K', '⌘K'],
    });
  });

  test('Windows', async ({ open }) => {
    const page = await load(open, { ua: UA.win });
    expect(await ctaState(page)).toMatchObject({ hero: DL + 'win.exe', label: 'Download for Windows', small: 'Free · Windows 10 and 11', os: 'win', panels: ['win'], modk: ['Ctrl K', 'Ctrl K'] });
  });

  test('Windows without userAgentData', async ({ open }) => {
    const page = await load(open, { ua: UA.win, init: noUAData('Win32') });
    expect((await ctaState(page)).hero).toBe(DL + 'win.exe');
  });

  test('Linux keeps the link to the download tab', async ({ open }) => {
    const page = await load(open, { ua: UA.linux });
    expect(await ctaState(page)).toMatchObject({ hero: '#download', label: 'Not on Linux yet', small: 'Meridian is for macOS and Windows', os: 'linux', panels: ['linux'] });
    await page.locator('.hero [data-cta]').click();
    expect(await state(page)).toMatchObject({ space: 1, tab: ['download'] });
  });

  test('on Linux the button does not pull you back to Download later', async ({ open }) => {
    const page = await open(null, { userAgent: UA.linux, viewport: DESK, reducedMotion: 'reduce', init: stubs() });
    await page.clock.install();
    await page.goto(URL);
    await page.locator('.hero [data-cta]').click();
    await page.locator('.tab[href="#homebrew"]').click();
    await page.clock.runFor(2000);
    expect(await state(page)).toMatchObject({ space: 1, tab: ['homebrew'] });
  });

  test('an unknown system', async ({ open }) => {
    const page = await load(open, { ua: UA.bot, init: noUAData('') });
    expect(await ctaState(page)).toMatchObject({ hero: '#download', label: 'Download Meridian', small: '', os: 'mac', panels: ['mac'] });
  });

  for (const calm of [true, false]) {
    test(`after a Mac download starts, the Download tab opens (${calm ? 'reduced motion' : 'animated'})`, async ({ open }) => {
      const page = await load(open, { calm });
      const req = page.waitForRequest(DL + 'mac-arm64.dmg');
      await page.route('**/Meridian-mac-arm64.dmg', (r) => r.fulfill({ status: 204 }));
      await page.locator('.hero [data-cta]').click();
      await req;
      await expect.poll(async () => (await state(page)).tab).toEqual(['download']);
      expect((await state(page)).space).toBe(1);
    });
  }

  test('the system tabs: click, arrows with wrap-round, other keys ignored', async ({ open }) => {
    const page = await load(open, { hash: '#download' });
    const os = async () => (await ctaState(page)).os;
    await page.locator('#os-win').click();
    expect(await ctaState(page)).toMatchObject({ os: 'win', panels: ['win'] });
    await page.keyboard.press('ArrowRight');
    expect(await os()).toBe('linux');
    await page.keyboard.press('ArrowRight');
    expect(await os()).toBe('mac');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('os-mac');
    await page.keyboard.press('ArrowLeft');
    expect(await os()).toBe('linux');
    expect((await state(page)).space).toBe(1);
    await page.keyboard.press('Enter');
    expect(await os()).toBe('linux');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('.os'))).toBe(false);
  });
});

test.describe('phones are offered the link instead', () => {
  test('the share sheet gets the site', async ({ open }) => {
    const page = await load(open, { ua: UA.android, clip: { share: 'ok' } });
    expect(await ctaState(page)).toMatchObject({ hero: '#download', label: 'Send to my computer', small: 'Free · Meridian is for Mac and Windows', os: 'mac' });
    await page.locator('.hero [data-cta]').click();
    await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([{ title: 'Meridian', text: 'Meridian browser', url: SITE }]);
    expect((await state(page)).space).toBe(0);
  });

  test('a cancelled share copies the link instead', async ({ open }) => {
    const page = await load(open, { ua: UA.android, clip: { share: 'fail' } });
    await page.locator('.hero [data-cta]').click();
    await expect(page.locator('#toast')).toHaveText('Link copied. Open it on your computer');
    expect(await page.evaluate(() => window.__copied)).toEqual([SITE]);
  });

  test('with no clipboard either, the link is shown to copy by hand', async ({ open }) => {
    const page = await load(open, { ua: UA.android, clip: { clipboard: 'fail' } });
    await page.locator('.hero [data-cta]').click();
    await expect(page.locator('#toast')).toHaveText('Copy it by hand: ' + SITE);
  });
});

test.describe('copy', () => {
  test('the brew buttons copy the command and show a toast that goes away', async ({ open }) => {
    const page = await load(open);
    await page.locator('.favs [data-copy]').click();
    await expect(page.locator('#toast')).toHaveText('Copied the brew command');
    await expect(page.locator('#toast')).toHaveClass(/\bon\b/);
    await expect(page.locator('#toast')).not.toHaveClass(/\bon\b/);
    await page.locator('.spc-dot[data-space="1"]').click();
    await page.locator('.tab[href="#homebrew"]').click();
    await page.locator('#homebrew [data-copy]').click();
    expect(await page.evaluate(() => window.__copied)).toEqual([BREW, BREW]);
  });
});

const splitState = (page) => page.evaluate(() => ({
  on: document.documentElement.classList.contains('split'),
  inert: document.getElementById('split-pane').inert,
  pressed: document.getElementById('split-btn').getAttribute('aria-pressed'),
  label: document.getElementById('split-label').textContent,
}));

test.describe('split view', () => {
  for (const calm of [true, false]) {
    test(`opens and closes, and keeps the tab in view (${calm ? 'reduced motion' : 'animated'})`, async ({ open }) => {
      const page = await load(open, { calm });
      await page.locator('.tab[href="#split"]').click();
      await page.locator('#split-btn').click();
      expect(await splitState(page)).toEqual({ on: true, inert: false, pressed: 'true', label: 'Close the split' });
      await expect(page.locator('#split-pane')).toBeVisible();
      await expect.poll(() => shown(page, 'split'), { timeout: 4000 }).toBe(true);
      await page.locator('#split-close').click();
      expect(await splitState(page)).toEqual({ on: false, inert: true, pressed: 'false', label: 'Split this window' });
      expect(await page.evaluate(() => document.activeElement.id)).toBe('split-btn');
    });
  }

  test('on a phone it opens without re-scrolling', async ({ open }) => {
    const page = await load(open, { viewport: PHONE });
    await page.locator('.tab[href="#split"]').click();
    const y = await page.evaluate(() => scrollY);
    await page.locator('#split-btn').click();
    expect((await splitState(page)).on).toBe(true);
    expect(await page.evaluate(() => scrollY)).toBe(y);
  });

  test('on a phone it keeps where you scrolled to', async ({ open }) => {
    const page = await load(open, { viewport: PHONE });
    await page.locator('.tab[href="#split"]').click();
    // A little off the section's top, but still on it.
    await page.evaluate(() => scrollBy(0, 40));
    const y = await page.evaluate(() => scrollY);
    await page.locator('#split-btn').click();
    // Past the page's 0 ms timer, which a desktop uses to scroll back.
    await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    expect((await state(page)).tab).toEqual(['split']);
    expect(await page.evaluate(() => scrollY)).toBe(y);
  });

  test('the divider drags, within limits', async ({ open }) => {
    const page = await load(open);
    await page.locator('.tab[href="#split"]').click();
    await page.locator('#split-btn').click();
    const split = () => page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--split')));
    const main = await page.locator('main').boundingBox();
    const drag = async (toX) => {
      const d = await page.locator('#divider').boundingBox();
      await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
      await page.mouse.down();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dragging'))).toBe(true);
      await page.mouse.move(toX, d.y + d.height / 2, { steps: 4 });
      await page.mouse.up();
      expect(await page.evaluate(() => document.documentElement.classList.contains('dragging'))).toBe(false);
    };
    await drag(main.x + main.width / 2);
    expect(await split()).toBeCloseTo(50, 0);
    await drag(main.x + 5);
    expect(await split()).toBe(62);
    await drag(main.x + main.width - 5);
    expect(await split()).toBe(26);
    await page.mouse.move(main.x + main.width / 2, main.y + 100);
    expect(await split()).toBe(26);
    // Hovering the divider after the release, without a button down, moves nothing.
    const d = await page.locator('#divider').boundingBox();
    await page.mouse.move(d.x + 2, d.y + d.height / 2);
    await page.mouse.move(d.x + d.width - 2, d.y + d.height / 2, { steps: 3 });
    expect(await split()).toBe(26);
  });
});

const GUIDE = '**/docs/import-from-arc/index.html';
const peekState = (page) => page.evaluate(() => ({
  open: document.getElementById('peek').classList.contains('open'),
  inert: document.getElementById('peek').inert,
  focus: document.activeElement.getAttribute('aria-label') || document.activeElement.id,
}));

test.describe('peek', () => {
  test('shows the import guide, its links pointing at the live site', async ({ open }) => {
    const page = await load(open);
    await page.locator('.tab[href="#split"]').click();
    await page.locator('#peek-link').click();
    expect(await peekState(page)).toEqual({ open: true, inert: false, focus: 'Close Peek' });
    await expect(page.locator('#peek-doc h1')).toHaveText('Move from Arc in one click');
    const hrefs = await page.locator('#peek-doc [href]').evaluateAll((as) => as.map((a) => a.href));
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs).toContain('https://meridianbrowser.app/arc-shutdown/');
    for (const h of hrefs) expect(h).toMatch(/^https:\/\/meridianbrowser\.app\//);
    await page.locator('.peek .hd [data-peek-close]').click();
    expect(await peekState(page)).toEqual({ open: false, inert: true, focus: 'peek-link' });
  });

  test('copies only the article: no scripts or styles, and images from the guide folder', async ({ open }) => {
    const page = await load(open);
    let fetches = 0;
    await page.route(GUIDE, (r) => { fetches++; r.fulfill({ contentType: 'text/html', body: `<html><head><style>p{}</style></head><body>
      <main><h1>Guide</h1><script>window.__ran = 1</script><style>h1{color:red}</style><link rel="stylesheet" href="x.css">
      <p><a href="../back-up-arc/">Back up</a> <img src="shot.png" alt=""></p></main></body></html>` }); });
    await page.locator('.tab[href="#split"]').click();
    await page.locator('#peek-link').click();
    await expect(page.locator('#peek-doc h1')).toHaveText('Guide');
    expect(await page.locator('#peek-doc script, #peek-doc style, #peek-doc link').count()).toBe(0);
    expect(await page.locator('#peek-doc a').getAttribute('href')).toBe('https://meridianbrowser.app/back-up-arc/');
    expect(await page.locator('#peek-doc img').evaluate((i) => i.src)).toBe('http://127.0.0.1:8010/docs/import-from-arc/shot.png');
    expect(await page.evaluate(() => window.__ran)).toBeUndefined();
    // Esc closes it; opening again shows the same copy without a second fetch.
    await page.keyboard.press('Escape');
    expect((await peekState(page)).open).toBe(false);
    await page.locator('#peek-link').click();
    await expect(page.locator('#peek-doc h1')).toHaveText('Guide');
    await page.locator('.peek .scrim').click({ position: { x: 5, y: 5 } });
    expect((await peekState(page)).open).toBe(false);
    expect(fetches).toBe(1);
  });

  test('fails when links keep their relative paths (mutation)', async ({ open }) => {
    const page = await open(null, { userAgent: UA.mac, viewport: DESK, reducedMotion: 'reduce', init: stubs() });
    await mutate(page, FILE, "'https://meridianbrowser.app/import-from-arc/'", 'src');
    await page.goto(URL);
    await page.locator('.tab[href="#split"]').click();
    await page.locator('#peek-link').click();
    await expect(page.locator('#peek-doc h1')).toHaveText('Move from Arc in one click');
    expect(await page.locator('#peek-doc [href]').evaluateAll((as) => as.map((a) => a.href))).not.toContain('https://meridianbrowser.app/arc-shutdown/');
  });

  for (const fail of ['404', 'abort']) {
    test(`a guide that cannot load (${fail}) says so, and is tried again next time`, async ({ open }) => {
      const page = await load(open);
      let n = 0;
      await page.route(GUIDE, (r) => (n++ === 0 ? (fail === '404' ? r.fulfill({ status: 404, contentType: 'text/html', body: '<main><h1>Not found</h1></main>' }) : r.abort()) : r.continue()));
      await page.locator('.tab[href="#split"]').click();
      await page.locator('#peek-link').click();
      await expect(page.locator('#peek-doc')).toHaveText('The preview could not load here. Use "Open as a tab" above.');
      await page.keyboard.press('Escape');
      await page.locator('#peek-link').click();
      await expect(page.locator('#peek-doc h1')).toHaveText('Move from Arc in one click');
      expect(n).toBe(2);
    });
  }

  for (const mod of ['ControlOrMeta', 'Shift']) {
    test(`a modifier click (${mod}) opens the guide as a real link, not in Peek`, async ({ open }) => {
      const page = await load(open);
      await page.locator('.tab[href="#split"]').click();
      const req = page.context().waitForEvent('request', (r) => r.url() === 'https://meridianbrowser.app/import-from-arc/');
      await page.locator('#peek-link').click({ modifiers: [mod] });
      expect((await peekState(page)).open).toBe(false);
      expect((await req).isNavigationRequest()).toBe(true);
    });
  }
});

test.describe('small demos', () => {
  test('with reduced motion the demos play at once, and the buttons flip them', async ({ open }) => {
    const page = await load(open);
    await page.locator('.tab[href="#today"]').click();
    await expect(page.locator('#tidy')).toHaveClass(/\btidied\b/);
    await expect(page.locator('#tidy-btn span')).toHaveText('Bring it back');
    await page.locator('#tidy-btn').click();
    await expect(page.locator('#tidy')).not.toHaveClass(/\btidied\b/);
    await expect(page.locator('#tidy-btn span')).toHaveText('Let 12 hours pass');
    await page.locator('.tab[href="#ai"]').click();
    await expect(page.locator('#ai')).toHaveClass(/\bin\b/);
    await expect(page.locator('#typed')).toHaveText('What does this page say?');
    await page.locator('.spc-dot[data-space="1"]').click();
    await page.locator('.tab[href="#arc-import"]').click();
    await expect(page.locator('#move')).toHaveClass(/\bmoved\b/);
    await page.locator('#move-btn').click();
    await expect(page.locator('#move-btn span')).toHaveText('Import from Arc');
  });

  test('a demo put back stays put when its section comes into view again', async ({ open }) => {
    const page = await load(open);
    await page.locator('.tab[href="#today"]').click();
    await expect(page.locator('#tidy')).toHaveClass(/\btidied\b/);
    await page.locator('#tidy-btn').click();
    await expect(page.locator('#tidy')).not.toHaveClass(/\btidied\b/);
    await page.locator('.tab[href="#welcome"]').click();
    await expect.poll(() => page.locator('#today').evaluate((s) => s.getBoundingClientRect().top > s.closest('.pane').getBoundingClientRect().bottom)).toBe(true);
    // An observer made after the page's gets the same entry after it, so the page has had its
    // turn (and its 0 ms timer) once this one sees Today.
    const seen = page.evaluate(() => new Promise((r) => {
      const o = new IntersectionObserver((es) => { if (es[0].isIntersecting) { o.disconnect(); setTimeout(r, 0); } }, { threshold: 0.18 });
      o.observe(document.getElementById('today'));
    }));
    await page.locator('.tab[href="#today"]').click();
    await seen;
    await expect(page.locator('#tidy')).not.toHaveClass(/\btidied\b/);
  });

  test('animated, the question is typed out and the tidy-up runs after a pause', async ({ open }) => {
    const page = await load(open, { calm: false });
    await page.evaluate(() => {
      window.__typed = []; window.__at = {};
      const el = document.getElementById('typed');
      new MutationObserver(() => window.__typed.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
      const mark = (el, cls) => new MutationObserver(() => { if (el.classList.contains(cls)) window.__at[cls] ??= performance.now(); })
        .observe(el, { attributes: true, attributeFilter: ['class'] });
      mark(document.getElementById('today'), 'in'); mark(document.getElementById('tidy'), 'tidied');
    });
    // The smooth scroll to AI passes Today on the way.
    await page.locator('.tab[href="#ai"]').click();
    await expect.poll(() => page.evaluate(() => window.__typed.at(-1))).toBe('What does this page say?');
    expect((await page.evaluate(() => window.__typed)).slice(0, 3)).toEqual(['', 'W', 'Wh']);
    await expect(page.locator('#tidy')).toHaveClass(/\btidied\b/);
    const at = await page.evaluate(() => window.__at);
    expect(at.tidied - at.in).toBeGreaterThanOrEqual(1390);
  });
});

const cmdState = (page) => page.evaluate(() => {
  const input = document.getElementById('cmd-in');
  return {
    open: document.getElementById('cmd').classList.contains('open'),
    focus: document.activeElement.id,
    rows: [...document.querySelectorAll('#cmd-list li')].map((li) => li.querySelector('.t') ? li.querySelector('.t').textContent : li.textContent),
    sel: [...document.querySelectorAll('#cmd-list li[aria-selected="true"]')].map((li) => li.querySelector('.t').textContent),
    active: input.getAttribute('aria-activedescendant'),
  };
});

test.describe('command bar', () => {
  test('⌘K opens it with every tab and action, ⌘K again closes it', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('Meta+k');
    const s = await cmdState(page);
    expect(s).toMatchObject({ open: true, focus: 'cmd-in', sel: ['Welcome'], active: 'opt-0' });
    expect(s.rows).toHaveLength(16 + 6 + 3);
    expect(s.rows.slice(-3)).toEqual(['Switch to space: Meet Meridian', 'Switch to space: Move in', 'Switch to space: Questions']);
    expect((await state(page)).tour).toEqual(['cmd']);
    await page.keyboard.press('Meta+k');
    expect(await cmdState(page)).toMatchObject({ open: false });
    expect((await state(page)).focus).toBe('pane0');
    // Shift+⌘K is not the shortcut.
    await page.keyboard.press('Meta+Shift+k');
    expect((await cmdState(page)).open).toBe(false);
    await page.keyboard.press('Meta+Alt+k');
    expect((await cmdState(page)).open).toBe(false);
  });

  test('Ctrl+K, the address and the New Tab rows open it; Esc and the backdrop close it', async ({ open }) => {
    const page = await load(open, { ua: UA.win });
    await page.keyboard.press('Control+k');
    expect((await cmdState(page)).open).toBe(true);
    await page.keyboard.press('Escape');
    expect((await cmdState(page)).open).toBe(false);
    await page.locator('#url').click();
    expect((await cmdState(page)).open).toBe(true);
    await page.locator('.cmd .scrim').click({ position: { x: 5, y: 5 } });
    expect(await cmdState(page)).toMatchObject({ open: false, focus: 'url' });
    await page.locator('.sb-space[data-space="0"] .newtab').click();
    expect((await cmdState(page)).open).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    expect((await cmdState(page)).open).toBe(false);
  });

  test('typing filters by every word; arrows move and wrap; Enter opens the tab', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('download');
    expect((await cmdState(page)).rows).toEqual(['Download', 'Download for Mac', 'Download for Windows']);
    await page.keyboard.type(' win');
    expect((await cmdState(page)).rows).toEqual(['Download for Windows']);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ArrowUp');
    expect(await cmdState(page)).toMatchObject({ sel: ['Download for Windows'], active: 'opt-2' });
    await page.keyboard.press('ArrowDown');
    expect((await cmdState(page)).sel).toEqual(['Download']);
    await page.keyboard.press('ArrowDown');
    expect((await cmdState(page)).sel).toEqual(['Download for Mac']);
    await page.keyboard.press('Tab');
    expect((await cmdState(page)).focus).toBe('cmd-in');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    expect(await cmdState(page)).toMatchObject({ open: false });
    expect(await state(page)).toMatchObject({ space: 1, tab: ['download'] });
  });

  test('a query with no match says so, and the keys do nothing', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('zebra');
    expect(await cmdState(page)).toMatchObject({ rows: ['Nothing here by that name.'], active: '' });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await cmdState(page)).toMatchObject({ open: true, rows: ['Nothing here by that name.'] });
    expect((await state(page)).tab).toEqual(['welcome']);
  });

  test('the mouse picks a row by hovering and clicking', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('space');
    const rows = page.locator('#cmd-list li');
    await rows.nth(2).hover();
    expect((await cmdState(page)).sel).toEqual(['Switch to space: Move in']);
    await rows.nth(2).hover({ position: { x: 30, y: 10 } });
    expect((await cmdState(page)).sel).toEqual(['Switch to space: Move in']);
    await rows.nth(3).click();
    expect(await state(page)).toMatchObject({ space: 2, tab: ['q-free'], tour: ['space', 'cmd'] });
  });

  test('a second open request keeps what was typed', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('brew');
    // Focus can leave the bar: click its footer, then Tab to the address and press Enter.
    await page.locator('.cmd .ft').click();
    for (let i = 0; i < 8 && (await page.evaluate(() => document.activeElement.id)) !== 'url'; i++) await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    expect(await page.locator('#cmd-in').inputValue()).toBe('brew');
    expect((await cmdState(page)).open).toBe(true);
  });

  test('actions: downloads, brew, links, split and spaces', async ({ open }) => {
    const page = await load(open);
    await page.route(/Meridian-(mac-arm64\.dmg|win\.exe)$/, (r) => r.fulfill({ status: 204 }));
    const run = async (q) => {
      await page.keyboard.press('Meta+k');
      await page.keyboard.type(q);
      expect((await cmdState(page)).sel).toHaveLength(1);
      await page.keyboard.press('Enter');
    };
    for (const [q, file] of [['download for mac', 'mac-arm64.dmg'], ['download for windows', 'win.exe']]) {
      const req = page.waitForRequest(DL + file);
      await run(q);
      await req;
    }
    await run('copy brew');
    await expect(page.locator('#toast')).toHaveText('Copied the brew command');
    await run('github');
    await run('discord');
    expect(await page.evaluate(() => window.__opened)).toEqual([
      ['https://github.com/Undermove/meridian-browser', '_blank', 'noopener'],
      ['https://discord.gg/kuQRHfG39r', '_blank', 'noopener'],
    ]);
    await run('toggle split');
    expect((await splitState(page)).on).toBe(true);
    await run('switch move');
    expect((await state(page)).space).toBe(1);
    await run('homebrew terminal');
    expect(await page.evaluate(() => window.__copied)).toEqual([BREW, BREW]);
  });

  test('switching space from the sidebar keeps focus in the sidebar', async ({ open }) => {
    const page = await load(open);
    await page.locator('#url').click();
    await page.keyboard.type('switch questions');
    await page.keyboard.press('Enter');
    expect(await state(page)).toMatchObject({ space: 2, focus: 'url' });
  });

  test('while the bar or Peek is open, a sideways swipe does nothing', async ({ open }) => {
    const page = await load(open);
    await countWheels(page);
    await page.mouse.move(700, 400);
    await page.keyboard.press('Meta+k');
    await wheel(page, 300, 0);
    expect((await state(page)).space).toBe(0);
    await page.keyboard.press('Escape');
    await page.locator('.tab[href="#split"]').click();
    await page.locator('#peek-link').click();
    await wheel(page, 300, 0);
    // The arrows are for Peek while it is open.
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).space).toBe(0);
  });
});
