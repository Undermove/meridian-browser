// Kinetic mode on the landing page (docs/index.html): on a big screen without reduced motion the page
// pins its sections, glides one window (#win) between them and poses an exploded tab stack per space.
import { test, expect, mutate } from './fixtures.mjs';

const URL = 'docs/index.html';
const BIG = { width: 1280, height: 800 };
const NARROW = { width: 800, height: 800 };
const SHORT = { width: 1280, height: 500 };

// The headline drops in for 1.4 s after the fonts load, and the page ignores layout changes until it
// has landed: a resize before then would be dropped.
async function landed(page) {
  await expect.poll(() => page.evaluate(() => {
    const h = document.querySelector('h1.fit');
    return h.classList.contains('go') && [...h.children].every((l) => !l.style.transform && !l.style.transition);
  }), { timeout: 10000 }).toBe(true);
}

async function load(open, options = {}) {
  const page = await open(URL, { viewport: BIG, ...options });
  await landed(page);
  return page;
}

const kin = (page) => page.evaluate(() => document.documentElement.classList.contains('kin'));

// Puts space i's top at the top of the screen (instant: html.kin scrolls smoothly).
const toSpace = (page, i) => page.evaluate((i) => {
  const s = document.querySelectorAll('.space')[i];
  scrollTo({ top: s.getBoundingClientRect().top + scrollY, behavior: 'instant' });
}, i);

// The first tab of the stack (Linear, the pinned one): its pose and look.
const tab0 = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('#scene .slab em')].find((e) => e.textContent === 'Pinned').parentElement;
  return { transform: el.style.transform, background: el.style.background, pinned: el.lastChild.style.opacity };
});

// Every link below the top bar lies in a space (the footer is in the last one), so the test adds one
// after <main>, at the foot of the page.
async function outsider(page) {
  await page.evaluate(() => {
    const a = Object.assign(document.createElement('a'), { href: '#top', id: 'outsider', textContent: 'outside' });
    document.body.append(a);
  });
  return page.locator('#outsider');
}

const look = (page) => page.evaluate(() => ({
  nav: document.querySelector('.nav').className,
  on: [...document.querySelectorAll('.space')].map((s) => s.classList.contains('on')),
  ins: [...document.querySelectorAll('.space')].map((s) => s.querySelector('.in').style.opacity),
  sky: [...document.querySelectorAll('.sky i')].map((s) => s.style.transform),
  live: [...document.querySelectorAll('.sky i')].map((s) => s.classList.contains('live')),
  win: document.querySelector('#win').style.transform,
  winOpacity: document.querySelector('#win').style.opacity,
  iso: document.querySelector('#scene .iso').style.transform,
}));

test.describe('kinetic mode on (1280x800)', () => {
  test('the page starts in the first space', async ({ open }) => {
    const page = await load(open);
    expect(await kin(page)).toBe(true);
    const l = await look(page);
    expect(l.nav).toBe('nav s0');
    expect(l.on[0]).toBe(true);
    expect(l.on.slice(1)).not.toContain(true);
    // the sky of the first space and its neighbour are drawn
    expect(l.live.slice(0, 3)).toEqual([true, true, false]);
    // POSE[0]: 22vw left, 40vh down, scale .8
    expect(l.win).toBe('translate3d(-281.6px, 320px, 0px) scale(0.8)');
    expect(await tab0(page)).toEqual({ transform: 'translate3d(-110px, -125px, 150px) rotateZ(0deg) scale(0.85)', background: 'rgb(255, 255, 255)', pinned: '0' });
  });

  test('scrolling to each space makes it current and poses the stack for it', async ({ open }) => {
    const page = await load(open);
    const N = await page.locator('.space').count();
    expect(N).toBe(9);
    const poses = [];
    for (let i = 0; i < N; i++) {
      await toSpace(page, i);
      await expect.poll(async () => (await look(page)).nav).toBe('nav s' + i);
      const l = await look(page);
      expect(l.on[i], `space ${i} on`).toBe(true);
      // its text is fully shown, and the one before has faded out
      expect(l.ins[i]).toBe('1');
      if (i) expect(l.ins[i - 1]).toBe('0');
      // its sky has slid all the way in
      if (i) expect(l.sky[i]).toBe('translate3d(0%, 0px, 0px)');
      expect(l.live.map((v, k) => (v ? k : -1)).filter((k) => k >= 0)).toEqual([i - 1, i, i + 1].filter((k) => k >= 0 && k < N));
      poses.push((await tab0(page)).transform);
      if (i === 3) {
        // Today: the pinned tab is green and wears its "Pinned" tag
        expect(await tab0(page)).toMatchObject({ background: 'rgb(201, 240, 46)', pinned: '1' });
      }
    }
    // spaces 0-6 each have their own pose; Download and Questions keep the last one
    expect(new Set(poses.slice(0, 7)).size).toBe(7);
    expect(poses[7]).toBe(poses[6]);
    expect(poses[8]).toBe(poses[6]);
    // the AI space shows its own extras (the model slabs), and they go again after it
    await toSpace(page, 5);
    await expect.poll(async () => (await look(page)).nav).toBe('nav s5');
    const extra = () => page.evaluate(() => [...document.querySelectorAll('#scene .slab.dk')].map((e) => e.style.opacity));
    expect(await extra(page)).toEqual(['1', '1', '1', '1']);
    await toSpace(page, 6);
    await expect.poll(async () => (await look(page)).nav).toBe('nav s6');
    expect(await extra(page)).toEqual(['0', '0', '0', '0']);
  });

  test('half-way between two spaces the next one takes over at the middle of its wipe', async ({ open }) => {
    const page = await load(open);
    // space 1's top a quarter screen below the bottom edge: p = .25, its sky wipe has begun, not passed half
    const at = (p) => page.evaluate((p) => {
      const s = document.querySelectorAll('.space')[1];
      scrollTo({ top: s.getBoundingClientRect().top + scrollY - innerHeight + p * innerHeight, behavior: 'instant' });
    }, p);
    await at(.25);
    // 104% is the wipe not begun; wait for the frame that draws the new scroll
    const pct = async () => parseFloat(((await look(page)).sky[1].match(/\(([\d.]+)%/) || [0, 104])[1]);
    await expect.poll(pct).toBeLessThan(104);
    expect(await pct()).toBeGreaterThan(50);
    let l = await look(page);
    expect(l.nav).toBe('nav s0');
    await at(.5);
    await expect.poll(async () => (await look(page)).nav).toBe('nav s1');
    l = await look(page);
    // .on comes at p > .62
    expect(l.on[1]).toBe(false);
    await at(.7);
    await expect.poll(async () => (await look(page)).on[1]).toBe(true);
  });

  test('the pointer turns the stack, hovers a tab and thins the headline letters near it', async ({ open }) => {
    const page = await load(open);
    const before = (await look(page)).iso;
    expect(before).toContain('rotateX(58deg) rotateZ(-38deg)');
    // a tab's middle, as the stack is drawn now
    const slab = await page.evaluate(() => {
      for (const el of document.querySelectorAll('#scene .slab')) {
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        const top = document.elementsFromPoint(x, y).map((e) => e.closest('#scene .slab')).find(Boolean);
        if (top === el && +el.style.opacity) return { x, y, i: [...document.querySelectorAll('#scene .slab')].indexOf(el) };
      }
    });
    expect(slab).toBeTruthy();
    await page.mouse.move(slab.x, slab.y);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('#scene .slab.hv').length)).toBe(1);
    await expect.poll(async () => (await look(page)).iso).not.toBe(before);
    // off the stack: the hover goes
    await page.mouse.move(20, 780);
    await expect.poll(() => page.evaluate(() => document.querySelectorAll('#scene .slab.hv').length)).toBe(0);
    // over the headline: the letter under the pointer gets thin
    const c = await page.evaluate(() => { const r = document.querySelector('h1 .c').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(c.x, c.y);
    await expect.poll(() => page.evaluate(() => +document.querySelector('h1 .c').style.fontWeight)).toBe(220);
  });

  test('a press on a tab blows the stack open, and it closes again', async ({ open }) => {
    const page = await load(open);
    const z = async () => parseFloat((await look(page)).iso.match(/scale3d\(1, 1, ([\d.]+)\)/)[1]);
    const slab = await page.evaluate(() => {
      for (const el of document.querySelectorAll('#scene .slab')) {
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (+el.style.opacity && document.elementsFromPoint(x, y).some((e) => e.closest('#scene .slab'))) return { x, y };
      }
    });
    await page.mouse.move(slab.x, slab.y);
    // wait until the pointer's own opening has settled
    let last = -1;
    await expect.poll(async () => { const v = await z(); const same = v === last; last = v; return same; }, { intervals: [250] }).toBe(true);
    const rest = await z();
    // the burst decays in a few frames: the page samples every frame for the peak
    const peak = page.evaluate(() => new Promise((done) => {
      let max = 0, n = 0;
      const tick = () => {
        max = Math.max(max, parseFloat(document.querySelector('#scene .iso').style.transform.match(/scale3d\(1, 1, ([\d.]+)\)/)[1]));
        if (++n < 60) requestAnimationFrame(tick); else done(max);
      };
      requestAnimationFrame(tick);
    }));
    await page.mouse.down();
    expect(await peak).toBeGreaterThan(rest + .5);
    await page.mouse.up();
    await expect.poll(z, { timeout: 10000 }).toBeLessThan(rest + .01);
  });

  test('a press away from the stack does nothing to it', async ({ open }) => {
    const page = await load(open);
    await page.mouse.move(20, 780);
    let last = '';
    await expect.poll(async () => { const v = (await look(page)).iso; const same = v === last; last = v; return same; }, { intervals: [250] }).toBe(true);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect((await look(page)).iso).toBe(last);
  });

  test('touch and pen do not turn the stack', async ({ open }) => {
    const page = await load(open);
    const before = (await look(page)).iso;
    await page.evaluate(() => {
      for (const pointerType of ['touch', 'pen']) dispatchEvent(new PointerEvent('pointermove', { pointerType, clientX: 1200, clientY: 700 }));
    });
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect((await look(page)).iso).toBe(before);
  });

  test('a link reached by keyboard in a faded space is brought to the middle', async ({ open }) => {
    const page = await load(open);
    const link = page.locator('#faq .say a').first();
    // keyboard focus (focus-visible): Tab once, then move focus there. preventScroll, so only the page
    // can bring it into view.
    await page.keyboard.press('Tab');
    await link.evaluate((a) => a.focus({ preventScroll: true }));
    await expect(link).toBeFocused();
    // (the Questions text is sticky: it lands as near the middle as the layout allows)
    const where = () => link.evaluate((a) => { const r = a.getBoundingClientRect(); return { inView: r.top >= 0 && r.bottom <= innerHeight, shown: a.closest('.space').querySelector('.in').style.opacity }; });
    await expect.poll(where, { timeout: 10000 }).toEqual({ inView: true, shown: '1' });
  });

  test('a tab picked with the mouse is not scrolled to', async ({ open }) => {
    const page = await load(open);
    await page.evaluate(() => document.querySelector('#install').scrollIntoView({ behavior: 'instant' }));
    const y = await page.evaluate(() => scrollY);
    await page.locator('#t-win').click();
    await expect(page.locator('#t-win')).toBeFocused();
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect(await page.evaluate(() => scrollY)).toBe(y);
  });

  test('focus outside the spaces does not scroll', async ({ open }) => {
    const page = await load(open);
    await page.keyboard.press('Tab');
    const link = await outsider(page);
    await link.evaluate((a) => a.focus({ preventScroll: true }));
    await expect(link).toBeFocused();
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });
});

test.describe('kinetic mode off', () => {
  for (const [name, options] of [
    ['a narrow window', { viewport: NARROW }],
    ['a short window', { viewport: SHORT }],
    ['reduced motion', { viewport: BIG, reducedMotion: 'reduce' }],
  ]) {
    test(`stays off in ${name}`, async ({ open }) => {
      const page = await load(open, options);
      expect(await kin(page)).toBe(false);
      const l = await look(page);
      expect([l.win, l.winOpacity, l.iso]).toEqual(['', '', '']);
      // scrolling does not move the window or switch the bar's space
      await page.evaluate(() => scrollTo({ top: document.querySelector('#private').offsetTop, behavior: 'instant' }));
      await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
      expect((await look(page)).nav).toBe('nav s0');
      expect((await look(page)).win).toBe('');
    });
  }

  test('reduced motion: the headline is simply shown and no scene copies are made', async ({ open }) => {
    const page = await open(URL, { viewport: BIG, reducedMotion: 'reduce' });
    await expect(page.locator('h1.fit')).toHaveClass(/\bgo\b/);
    expect(await page.evaluate(() => [...document.querySelectorAll('h1.fit > *')].map((l) => l.style.transform))).toEqual(['', '', '']);
    // the connected scenes run only with motion
    expect(await page.locator('.lkw').count()).toBe(0);
  });

  test('the pointer does nothing to the stack', async ({ open }) => {
    const page = await load(open, { viewport: NARROW });
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect((await look(page)).iso).toBe('');
    expect(await page.locator('#scene .slab.hv').count()).toBe(0);
  });

  test('keyboard focus in a space does not scroll', async ({ open }) => {
    const page = await load(open, { viewport: NARROW });
    const y = await page.evaluate(() => scrollY);
    await page.keyboard.press('Tab');
    await page.locator('#faq .say a').first().evaluate((a) => a.focus({ preventScroll: true }));
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect(await page.evaluate(() => scrollY)).toBe(y);
  });
});

test.describe('switching at runtime', () => {
  test('narrowing the window turns kinetic off and clears what it drew; widening turns it back on', async ({ page }) => {
    await page.setViewportSize(BIG);
    await page.goto(URL);
    await landed(page);
    await toSpace(page, 3);
    await expect.poll(async () => (await look(page)).nav).toBe('nav s3');
    // the pointer thins some letters; they must come back to full weight
    await toSpace(page, 0);
    const c = await page.evaluate(() => { const r = document.querySelector('h1 .c').getBoundingClientRect(); return { x: r.left + 2, y: r.top + 2 }; });
    await page.mouse.move(c.x, c.y);
    await expect.poll(() => page.evaluate(() => document.querySelector('h1 .c').style.fontWeight)).not.toBe('');
    await toSpace(page, 3);
    await expect.poll(async () => (await look(page)).nav).toBe('nav s3');

    await page.setViewportSize(NARROW);
    await expect.poll(() => kin(page)).toBe(false);
    const l = await look(page);
    expect([l.win, l.winOpacity, l.iso]).toEqual(['', '', '']);
    expect(l.ins.every((v) => v === '')).toBe(true);
    expect(l.sky.every((v) => v === '')).toBe(true);
    expect(await page.evaluate(() => [...document.querySelectorAll('h1 .c')].every((c) => c.style.fontWeight === ''))).toBe(true);
    // the stack goes back to its first pose
    expect((await tab0(page)).transform).toBe('translate3d(-110px, -125px, 150px) rotateZ(0deg) scale(0.85)');

    await page.setViewportSize(BIG);
    await expect.poll(() => kin(page)).toBe(true);
    // the current space is set again from scratch
    const y = await page.evaluate(() => scrollY);
    await page.evaluate((y) => scrollTo({ top: y + 1, behavior: 'instant' }), y);
    await expect.poll(async () => (await look(page)).win).not.toBe('');
    expect((await look(page)).nav).toMatch(/^nav s\d$/);
  });

  test('turning reduced motion on turns kinetic off without a resize', async ({ page }) => {
    await page.setViewportSize(BIG);
    await page.goto(URL);
    await landed(page);
    expect(await kin(page)).toBe(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => kin(page)).toBe(false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(() => kin(page)).toBe(true);
  });
});

test('without document.fonts the headline still lands and kinetic mode starts', async ({ open }) => {
  const page = await open(URL, { viewport: BIG, init: () => Object.defineProperty(document, 'fonts', { value: undefined }) });
  expect(await page.evaluate(() => document.fonts)).toBeUndefined();
  await landed(page);
  expect(await kin(page)).toBe(true);
});

test.describe('the download tab picked on load', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  test('a phone sees the Mac tab', async ({ open }) => {
    const page = await open(URL, { viewport: BIG, userAgent: IPHONE });
    await expect(page.locator('#t-mac')).toHaveAttribute('aria-selected', 'true');
  });
  test('an unknown system sees the Mac tab', async ({ open }) => {
    const page = await open(URL, {
      viewport: BIG, userAgent: 'Mozilla/5.0 (Plan9) Unknown/1.0',
      init: () => { Object.defineProperty(navigator, 'platform', { get: () => '' }); Object.defineProperty(navigator, 'userAgentData', { get: () => undefined }); },
    });
    await expect(page.locator('#t-mac')).toHaveAttribute('aria-selected', 'true');
  });
  test('Windows sees the Windows tab', async ({ open }) => {
    const page = await open(URL, { viewport: BIG, userAgent: WIN });
    await expect(page.locator('#t-win')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#t-mac')).toHaveAttribute('aria-selected', 'false');
  });
});

// The tests above fail when the code they check changes: each serves a broken copy of the page and
// shows the assertion above would no longer hold.
test.describe('mutations', () => {
  test('a wider kinetic breakpoint would turn kinetic on in a narrow window', async ({ open }) => {
    const page = await open(null, { viewport: NARROW });
    await mutate(page, URL, '(min-width:901px) and (min-height:560px)', '(min-width:701px) and (min-height:560px)');
    await page.goto(URL);
    await landed(page);
    expect(await kin(page)).toBe(true);
  });

  test('without the scroll on focus, a keyboard-focused link stays in its faded space', async ({ open }) => {
    const page = await open(null, { viewport: BIG });
    await mutate(page, URL, "e.target.scrollIntoView({ block: 'center' })", 'void 0');
    await page.goto(URL);
    await landed(page);
    await page.keyboard.press('Tab');
    const link = page.locator('#faq .say a').first();
    await link.evaluate((a) => a.focus({ preventScroll: true }));
    await expect(link).toBeFocused();
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
    expect(await page.evaluate(() => scrollY)).toBe(0);
  });

  test('without the check for a space, a link outside them would be scrolled to', async ({ open }) => {
    const page = await open(null, { viewport: BIG });
    await mutate(page, URL, "if (kin && e.target.closest('.space') && ", 'if (kin && ');
    await page.goto(URL);
    await landed(page);
    await page.keyboard.press('Tab');
    await (await outsider(page)).evaluate((a) => a.focus({ preventScroll: true }));
    await expect.poll(() => page.evaluate(() => scrollY), { timeout: 10000 }).toBeGreaterThan(0);
  });

  test('without the reset, narrowing the window would leave the window posed', async ({ open }) => {
    const page = await open(null, { viewport: BIG });
    await mutate(page, URL, 'win.style.transform = win.style.opacity = live.iso.style.transform', 'live.iso.style.transform');
    await page.goto(URL);
    await landed(page);
    await page.setViewportSize(NARROW);
    await expect.poll(() => kin(page)).toBe(false);
    expect((await look(page)).win).not.toBe('');
  });

  test('without the burst, a press on a tab leaves the stack as it was', async ({ open }) => {
    const page = await open(null, { viewport: BIG });
    await mutate(page, URL, 'burst = .8;', 'burst = 0;');
    await page.goto(URL);
    await landed(page);
    const slab = await page.evaluate(() => {
      for (const el of document.querySelectorAll('#scene .slab')) {
        const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (+el.style.opacity && document.elementsFromPoint(x, y).some((e) => e.closest('#scene .slab'))) return { x, y };
      }
    });
    await page.mouse.move(slab.x, slab.y);
    const z = async () => parseFloat((await look(page)).iso.match(/scale3d\(1, 1, ([\d.]+)\)/)[1]);
    let last = -1;
    await expect.poll(async () => { const v = await z(); const same = v === last; last = v; return same; }, { intervals: [250] }).toBe(true);
    const peak = page.evaluate(() => new Promise((done) => {
      let max = 0, n = 0;
      const tick = () => {
        max = Math.max(max, parseFloat(document.querySelector('#scene .iso').style.transform.match(/scale3d\(1, 1, ([\d.]+)\)/)[1]));
        if (++n < 60) requestAnimationFrame(tick); else done(max);
      };
      requestAnimationFrame(tick);
    }));
    await page.mouse.down();
    expect(await peak).toBeLessThan(last + .5);
  });
});
