import { test, expect, mutate } from './fixtures.mjs';
import { load as loadAt, inView, pointAt, press, freeze, NARROW } from './scene-helpers.mjs';

// A fixed Math.random, so the blocks are thrown the same way on every run.
const SEED = () => {
  let a = 0x9e3779b9;
  Math.random = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const load = (open, options = {}) => loadAt(open, '#pvw', { init: SEED, ...options });

const block = (page, name) => page.locator('#pvw .it', { hasText: name });
const count = (page) => page.locator('#pvn');
const transform = (loc) => loc.evaluate((e) => e.style.transform);
// translate3d(x, y, z) of every block, from its inline transform
const poses = (page) => page.locator('#pvw .it').evaluateAll((els) => els.map((e) => {
  const m = /translate3d\((-?[\d.]+)px, ?(-?[\d.]+)px, ?(-?[\d.]+)px\)/.exec(e.style.transform);
  return { x: +m[1], y: +m[2], z: +m[3], w: e.offsetWidth, h: e.offsetHeight };
}));
// The floor the blocks slide on (the page's X0, X1, Y0, Y1).
const inBox = (p) => p.x >= -214.05 && p.x + p.w <= 222.05 && p.y >= -126.05 && p.y + p.h <= 132.05;

// A point on the scene that is not on a valuable.
async function clickFloor(page) {
  const at = await page.locator('#pvw').evaluate((root) => {
    const b = root.getBoundingClientRect();
    for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
      const x = b.left + b.width * i / 20, y = b.top + b.height * j / 20, h = document.elementFromPoint(x, y);
      if (root.contains(h) && !h.closest('.it, .ad')) return [x, y];
    }
    return null;
  });
  await page.mouse.click(at[0], at[1]);
}

test('with reduced motion no tracker comes by itself', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  await page.clock.runFor(8000);
  await expect(count(page)).toHaveText('0');
  await expect(page.locator('#pvw .ad')).toHaveCount(0);
});

test('a valuable lifts while the pointer is on it', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  const history = block(page, 'History');
  // FLOOR (26) plus the lift (16)
  expect(await transform(history)).toMatch(/, 26px\)/);
  const [x, y] = await pointAt(history);
  await page.mouse.move(x, y);
  expect(await transform(history)).toMatch(/, 42px\)/);
  await page.mouse.move(5, 5);
  expect(await transform(history)).toMatch(/, 26px\)/);
});

test('a click on a valuable sends a pack of five at it; a click elsewhere sends seven at everything', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  const before = await poses(page);
  await press(block(page, 'Passwords'));
  await page.clock.runFor(400);
  // each tracker is named for what it wants: Passwords draw Snoops
  await expect(page.locator('#pvw .ad')).toHaveText(['Snoop', 'Snoop', 'Snoop', 'Snoop', 'Snoop']);
  await page.clock.runFor(800);
  // the click did not also reach the scene behind the block
  await expect(count(page)).toHaveText('5');
  const after = await poses(page);
  expect(after).not.toEqual(before);
  expect(after.every(inBox)).toBe(true);

  await clickFloor(page);
  await page.clock.runFor(1300);
  await expect(count(page)).toHaveText('12');
});

test('a volley still to come when a hold begins never launches', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  // the seven shots are timed 0-420 ms ahead; the paused clock has not run any yet
  await clickFloor(page);
  await page.locator('#pvw').evaluate((e) => e.setAttribute('data-hold', ''));
  await page.clock.runFor(1300);
  await expect(page.locator('#pvw .ad')).toHaveCount(0);
  await expect(count(page)).toHaveText('0');
});

test('red: without the hold check the volley flies during a hold', async ({ open }) => {
  const page = await open(null, { reducedMotion: 'reduce', init: SEED });
  await mutate(page, 'docs/index.html', "    if (root.hasAttribute('data-hold')) return;\n    t = t ||", '    t = t ||');
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await page.goto('docs/index.html');
  await page.locator('#pvw').scrollIntoViewIfNeeded();
  await clickFloor(page);
  await page.locator('#pvw').evaluate((e) => e.setAttribute('data-hold', ''));
  await page.clock.runFor(1300);
  await expect(count(page)).toHaveText('7');
});

test('trackers come every 800 ms while the scene is in view, and stop when it is held or out of view', async ({ open }) => {
  const page = await load(open);
  await page.clock.runFor(4000);
  const n = Number(await count(page).textContent());
  expect(n).toBeGreaterThanOrEqual(3);
  expect(n).toBeLessThanOrEqual(5);

  // held: whatever moves the scene as a whole calls the attacks off
  await page.locator('#pvw').evaluate((e) => e.setAttribute('data-hold', ''));
  await page.clock.runFor(1000);
  const held = await count(page).textContent();
  await page.clock.runFor(4000);
  await expect(count(page)).toHaveText(held);

  await page.locator('#pvw').evaluate((e) => e.removeAttribute('data-hold'));
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.locator('#pvw').evaluate((el) => new Promise((r) =>
    new IntersectionObserver((e, o) => { o.disconnect(); r(e[0].isIntersecting); }).observe(el)))).toBe(false);
  await page.clock.runFor(1000);
  const away = await count(page).textContent();
  await page.clock.runFor(4000);
  await expect(count(page)).toHaveText(away);
});

// Each hit of a pack lands while the block is still in the air; it climbs, but never over the rim.
test('a block hit again in mid-air tops out 26px above the floor', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  await press(block(page, 'Tabs'));
  // off the block, so it is not lifted
  await page.mouse.move(5, 5);
  let top = 0;
  for (let i = 0; i < 60; i++) {
    await page.clock.runFor(25);
    top = Math.max(top, ...(await poses(page)).map((p) => p.z));
  }
  // above one throw's top (26 + 230² / 3000 = 43.6), never over FLOOR (26) plus 26
  expect(top).toBeGreaterThan(46);
  expect(top).toBeLessThanOrEqual(52);
});

// Friction slows a block to a stop: the last move before it rests is a crawl, not a sudden halt.
test('a thrown block slides to a stop', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  await clickFloor(page);
  await page.clock.runFor(1300);
  const step = [];
  let prev = await poses(page);
  for (let i = 0; i < 400; i++) {
    await page.clock.runFor(16);
    const now = await poses(page);
    step.push(Math.max(...now.map((p, k) => Math.hypot(p.x - prev[k].x, p.y - prev[k].y))));
    prev = now;
    if (step.length > 30 && step.slice(-30).every((d) => d === 0)) break;
  }
  const moved = step.filter((d) => d > 0);
  expect(step.slice(-30).every((d) => d === 0)).toBe(true);
  expect(moved.at(-1)).toBeLessThan(0.5);
});

// Trackers coming from the right (Math.random near 1) throw the blocks to the left wall.
test('a block thrown into a wall bounces off it', async ({ open }) => {
  const page = await loadAt(open, '#pvw', { reducedMotion: 'reduce', init: 'Math.random = () => .999' });
  await clickFloor(page);
  const touched = new Set(), away = new Set();
  for (let i = 0; i < 80; i++) {
    await page.clock.runFor(25);
    (await poses(page)).forEach((p, k) => {
      if (p.x <= -214) touched.add(k);
      else if (touched.has(k) && p.x > -212) away.add(k);
    });
  }
  expect(touched.size).toBeGreaterThan(0);
  // without the bounce a block stays pressed on the wall, at -214 exactly
  expect([...away].sort()).toEqual([...touched].sort());
});

test('under fire the blocks stay inside the wall, and come to rest on the floor', async ({ open }) => {
  // many clock steps; slow when the machine is busy
  test.slow();
  const page = await load(open);
  for (const name of ['History', 'Cards', 'Logins', 'Tabs', 'Passwords']) {
    await press(block(page, name));
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(250);
      expect((await poses(page)).every(inBox)).toBe(true);
    }
  }
  await page.locator('#pvw').evaluate((e) => e.setAttribute('data-hold', ''));
  // off the scene, so no block lies lifted under the pointer
  await page.mouse.move(5, 5);
  // wait until a second of clock moves nothing
  let rest = null, prev;
  for (let i = 0; i < 20 && JSON.stringify(rest) !== JSON.stringify(prev); i++) {
    prev = rest;
    await page.clock.runFor(1000);
    rest = await poses(page);
  }
  expect(rest).toEqual(prev);
  expect(rest.map((p) => p.z)).toEqual([26, 26, 26, 26, 26]);
  expect(rest.every(inBox)).toBe(true);
});

// A style put in before the page's script measures the blocks.
const styled = (css) => `(${(c) => {
  const mo = new MutationObserver(() => {
    if (!document.head) return;
    const s = document.createElement('style'); s.textContent = c; document.head.append(s); mo.disconnect();
  });
  mo.observe(document, { childList: true, subtree: true });
}})(${JSON.stringify(css)})`;
const BARE = 'padding:0!important;border:0!important;box-sizing:border-box!important';

// Every block the same size, all on one spot, all thrown the same way (Math.random is a constant), so
// two of them meet exactly centre on centre: the case where the push apart has no side to go by.
for (const [w, h, axis, other] of [[40, 80, 'x', 'y'], [80, 40, 'y', 'x']]) {
  test(`blocks on the very same spot are still pushed apart (${axis})`, async ({ open }) => {
    const css = `#pvw .it{left:-40px!important;top:-40px!important;width:${w}px!important;height:${h}px!important;${BARE}}`;
    const page = await loadAt(open, '#pvw', { reducedMotion: 'reduce', init: ['Math.random = () => .5', styled(css)] });
    const start = await poses(page);
    expect(new Set(start.map((p) => `${p.x},${p.y}`)).size).toBe(1);
    await clickFloor(page);
    await page.clock.runFor(3000);
    const end = await poses(page);
    expect(new Set(end.map((p) => p[axis])).size).toBe(5);
    // pushed apart along the side they overlap least on, so they barely move the other way
    const o = end.map((p) => p[other]);
    expect(Math.max(...o) - Math.min(...o)).toBeLessThan(20);
    expect(end.every(inBox)).toBe(true);
  });
}

// Five blocks in a row, 40px apart: side by side but not touching, so nothing pushes them together.
test('blocks that do not touch are left apart', async ({ open }) => {
  const css = `#pvw .it{top:-40px!important;width:40px!important;height:40px!important;${BARE}}`
    + [0, 1, 2, 3, 4].map((i) => `#pvw .it:nth-child(${i + 1} of .it){left:${-200 + i * 80}px!important}`).join('');
  const page = await loadAt(open, '#pvw', { reducedMotion: 'reduce', init: [SEED, styled(css)] });
  const gaps = async () => (await poses(page)).map((p) => p.x).sort((a, b) => a - b).map((x, i, xs) => i && xs[i] - xs[i - 1] - 40).slice(1);
  expect(await gaps()).toEqual([40, 40, 40, 40]);
  const start = JSON.stringify(await poses(page));
  await clickFloor(page);
  // the jolt reaches them from 750 ms on; later they do meet, so look at the first frame they move
  await page.clock.runFor(700);
  for (let i = 0; i < 60 && JSON.stringify(await poses(page)) === start; i++) await page.clock.runFor(16);
  expect(JSON.stringify(await poses(page))).not.toBe(start);
  for (const g of await gaps()) expect(g).toBeGreaterThan(30);
});

// A browser that rounds its clock (as privacy modes do) hands a frame the same time as the last one.
test('with a coarse clock the blocks still move', async ({ open }) => {
  const coarse = () => {
    const now = performance.now.bind(performance), raf = requestAnimationFrame.bind(window);
    performance.now = () => Math.floor(now() / 1000) * 1000;
    window.requestAnimationFrame = (cb) => raf(() => cb(performance.now()));
  };
  const page = await open('docs/index.html', { viewport: NARROW, reducedMotion: 'reduce', init: [SEED, coarse] });
  await inView(page, '#pvw');
  const before = await poses(page);
  await press(block(page, 'Cards'));
  await expect.poll(() => poses(page)).not.toEqual(before);
  await expect(count(page)).toHaveText('5');
});

test('trackers come at the default viewport too', async ({ open }) => {
  const page = await open(null, { init: SEED });
  await page.clock.install();
  await page.goto('docs/index.html');
  await freeze(page);
  // kinetic mode pins the section here, at rest (it calls the attacks off while it moves)
  await page.evaluate(() => scrollTo(0, document.querySelector('#private').offsetTop + 300));
  await expect(page.locator('#pvw')).not.toHaveAttribute('data-hold');
  await expect.poll(async () => { await page.clock.runFor(800); return Number(await count(page).textContent()); }).toBeGreaterThan(0);
});

test('a tracker stops dead at the wall and hits it 750 ms after it sets off', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  await press(block(page, 'Tabs'));
  await page.clock.runFor(1);
  // the keyframe at the wall: translate3d(x, y, 46px), on the wall's line |x| = 322 or |y| = 196
  const stop = await page.locator('#pvw .ad').first().evaluate((el) => {
    const m = /translate3d\((-?[\d.]+)px, ?(-?[\d.]+)px/.exec(el.getAnimations()[0].effect.getKeyframes()[2].transform);
    return Math.max(Math.abs(+m[1]) / 322, Math.abs(+m[2]) / 196);
  });
  expect(stop).toBeCloseTo(1, 2);
  await page.clock.runFor(748);
  await expect(count(page)).toHaveText('0');
  await page.clock.runFor(1);
  await expect(count(page)).toHaveText('1');
});

test('trackers come one every 800 ms', async ({ open }) => {
  const page = await load(open);
  await page.clock.runFor(4000);
  const seen = [];
  for (let i = 0; i < 7; i++) {
    const n = Number(await count(page).textContent());
    await page.clock.runFor(800);
    seen.push(Number(await count(page).textContent()) - n);
  }
  expect(seen).toEqual([1, 1, 1, 1, 1, 1, 1]);
});

test('no tracker comes while the tab is hidden', async ({ open }) => {
  const page = await load(open);
  const hide = (on) => page.evaluate((on) => Object.defineProperty(document, 'hidden', { get: () => on, configurable: true }), on);
  await hide(true);
  // trackers already on their way still land
  await page.clock.runFor(1000);
  const n = await count(page).textContent();
  await page.clock.runFor(4000);
  await expect(count(page)).toHaveText(n);
  await hide(false);
  await page.clock.runFor(2000);
  expect(Number(await count(page).textContent())).toBeGreaterThan(Number(n));
});

test('red: the lift is what raises a pointed-at valuable', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce', before: (p) => mutate(p, 'docs/index.html', 't.lift = 16', 't.lift = 0') });
  const history = block(page, 'History');
  const [x, y] = await pointAt(history);
  await page.mouse.move(x, y);
  expect(await transform(history)).not.toMatch(/, 42px\)/);
});
