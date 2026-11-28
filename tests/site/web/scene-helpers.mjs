// Helpers for the landing page's 3D demo scenes.
import { expect } from './fixtures.mjs';

// Below 901px wide the page has no kinetic mode, so a demo sits still in the flow.
export const NARROW = { width: 800, height: 900 };

// The landing page, with its timers and requestAnimationFrame run only by page.clock, scrolled so
// `sel` is in the middle of the screen. CSS transitions and el.animate() still run on real time.
export async function load(open, sel, { before, ...options } = {}) {
  const page = await open(null, { viewport: NARROW, ...options });
  if (before) await before(page);
  await page.clock.install();
  await page.goto('docs/index.html');
  await freeze(page);
  await inView(page, sel);
  return page;
}

// Stops the installed clock. pauseAt fails on a time already past, which a busy machine can reach
// before the call lands, so aim ahead and try again.
export async function freeze(page) {
  for (let i = 0; ; i++) {
    try { return await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000)); }
    catch (e) { if (i === 4 || !/fast-forward to the past/.test(e.message)) throw e; }
  }
}

// Scrolls `sel` to the middle and resolves once an IntersectionObserver has seen it there. Observers
// report in the order they were made, so the page's own observer has run by then too.
export async function inView(page, sel) {
  const seen = await page.locator(sel).evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    return new Promise((r) => new IntersectionObserver((e, o) => { o.disconnect(); r(e[0].isIntersecting); }).observe(el));
  });
  expect(seen).toBe(true);
}

// The scenes are turned in 3D, so the middle of an element's box can land on something else. The point
// nearest the middle that really hits the element, as a person would aim, once it stops moving.
export async function pointAt(locator) {
  const spot = () => locator.evaluate((el) => {
    const b = el.getBoundingClientRect(), pts = [];
    for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) pts.push([b.left + b.width * i / 20, b.top + b.height * j / 20]);
    const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    pts.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
    const at = pts.find(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    return at ? at.map(Math.round).join(',') : null;
  });
  let last = null, at = null;
  await expect.poll(async () => { [last, at] = [at, await spot()]; return at !== null && at === last; },
    { intervals: [100], timeout: 15000 }).toBe(true);
  return at.split(',').map(Number);
}

export async function press(locator) {
  const [x, y] = await pointAt(locator);
  await locator.page().mouse.click(x, y);
}

// ---- the scroll connection between the scenes (kinetic mode, a wide screen)

export const SCENES = ['#asm .scene', '#swp .scene', '#imp .scene', '#tdy .scene', '#spl .scene', '#aiw .scene', '#pvw .scene', '#install .real'];

// The headline drops in for 1.4 s after the fonts load; the page ignores layout changes until then.
export async function landed(page) {
  await expect(page.locator('html')).toHaveClass(/\bkin\b/);
  await expect.poll(() => page.evaluate(() => {
    const h = document.querySelector('h1.fit');
    return h.classList.contains('go') && [...h.children].every((l) => !l.style.transform && !l.style.transition);
  }), { timeout: 10000 }).toBe(true);
}

// scrollY at which crossing k (scene k to scene k + 1) is at fraction r: the page's own measure of
// "how far between the two pinned places", found by bisection. html.kin scrolls smoothly, so every
// probe jumps with behavior 'instant'.
export async function crossY(page, k, r) {
  return page.evaluate(([SCENES, k, r]) => {
    const pin = (sel) => { for (let p = document.querySelector(sel); p; p = p.parentElement) if (getComputedStyle(p).position === 'sticky' || p.tagName === 'SECTION') return p; };
    const A = pin(SCENES[k]), B = pin(SCENES[k + 1]);
    const real = () => {
      const L = innerHeight * .12, sa = getComputedStyle(A).position === 'sticky', sb = getComputedStyle(B).position === 'sticky';
      const a = A.closest('section').getBoundingClientRect(), b = B.closest('section').getBoundingClientRect();
      const gone = sa ? Math.max(0, L - (a.bottom - innerHeight)) : Math.max(0, -A.getBoundingClientRect().top);
      const left = sb ? Math.max(0, b.top + L) : Math.max(0, B.getBoundingClientRect().top);
      return gone + left > 0 ? gone / (gone + left) : 0;
    };
    const keep = scrollY;
    let lo = 0, hi = document.documentElement.scrollHeight;
    for (let n = 0; n < 40; n++) {
      const m = (lo + hi) / 2;
      scrollTo({ top: m, behavior: 'instant' });
      // (for r = 0: the last place before the crossing begins, not the top of the page)
      if (r <= 0 ? real() <= 0 : real() < r) lo = m; else hi = m;
    }
    scrollTo({ top: keep, behavior: 'instant' });
    return Math.round(r >= 1 ? hi + 2 : r <= 0 ? lo - 2 : (lo + hi) / 2);
  }, [SCENES, k, r]);
}

export const jump = (page, y) => page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), y);
export const goTo = async (page, k, r) => jump(page, await crossY(page, k, r));

// What the scroll connection is doing right now, read from the DOM.
export const state = (page) => page.evaluate(() => {
  const layer = document.querySelector('.lkw');
  const shown = (e) => e.style.display !== 'none';
  return {
    copies: layer.children.length,
    shownCopies: [...layer.children].filter((e) => shown(e) && e.querySelector('.lk-c')).length,
    // a plain body mid-way between two parts' shapes (the morph)
    morphing: [...layer.children].filter((e) => shown(e) && !e.children.length && e.style.background && e.style.background !== 'none').length,
    hidden: document.querySelectorAll('.lk-hide').length,
    paired: document.querySelectorAll('[data-lk]').length,
    tdyHold: document.querySelector('#tdy').hasAttribute('data-hold'),
    pvwHold: document.querySelector('#pvw').hasAttribute('data-hold'),
    band: document.querySelector('.mq.b').style.opacity,
  };
});
export async function inFlight(page) {
  await expect.poll(async () => { const s = await state(page); return s.shownCopies > 0 && s.hidden > 0; }, { timeout: 15000 }).toBe(true);
}
// stop() removes every copy and body and gives the real parts back.
export async function ended(page) {
  await expect.poll(async () => { const s = await state(page); return [s.copies, s.hidden, s.paired]; }, { timeout: 15000 }).toEqual([0, 0, 0]);
}
export async function morphs(page) {
  await expect.poll(async () => (await state(page)).morphing > 0, { timeout: 15000 }).toBe(true);
}

// Copies cut from one part (a strip of it, shown through a holder that clips it), by the part's class.
export const strips = (page, cls) => page.evaluate((cls) => [...document.querySelectorAll('.lkw > div')]
  .filter((h) => h.style.overflow === 'hidden' && h.querySelector('.lk-c')?.classList.contains(cls)).length, cls);

// Swipes the spaces scene (#swp) to space `to` (0-2) with a sideways trackpad swipe.
export async function swipeTo(page, to) {
  const PLATE = ['rgb(199, 208, 255)', 'rgb(255, 240, 168)', 'rgb(255, 196, 219)'];
  await page.evaluate(() => document.querySelector('#swp').scrollIntoView({ behavior: 'instant', block: 'center' }));
  const box = await page.locator('#swp').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(to === 0 ? -80 : 80, 0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#swp .pl')).backgroundColor)).toBe(PLATE[to]);
}
