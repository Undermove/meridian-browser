// The spaces demo (#swp): swipe the sidebar (two-finger wheel or one-finger touch) to change the space.
import { test, expect, mutate } from './fixtures.mjs';

const URL = 'docs/index.html';
// these move a fake clock through seconds of animation, and the machine may be busy with other runs
test.describe.configure({ timeout: 120000 });
// Stops the clock where it is. The page's time runs on while the call travels, so the target can
// already be past on a busy machine: then try again.
async function pause(page) {
  for (let i = 0; ; i++) {
    try { return await page.clock.pauseAt(await page.evaluate(() => Date.now() + 300)); } catch (e) { if (i > 20 || !/past/.test(e.message)) throw e; }
  }
}

// plate colour per space: Work, Life, Side
const PLATE = ['rgb(199, 208, 255)', 'rgb(255, 240, 168)', 'rgb(255, 196, 219)'];
// x of each bar with space `at` in the slot (index.html SLOT and STEP)
const xs = (pos) => [0, 1, 2].map((i) => +(-378 + (i - pos) * 170).toFixed(1));

// Narrow viewport: no kinetic mode. The clock is stopped, so no hint starts unless a test moves time.
async function load(open, options = {}, prepare) {
  const page = await open(null, { viewport: { width: 600, height: 900 }, ...options });
  if (prepare) await prepare(page);
  await page.clock.install();
  await page.goto(URL);
  await pause(page);
  await page.locator('#swp').scrollIntoViewIfNeeded();
  await page.clock.runFor(20);
  return page;
}

// Wide viewport (kinetic mode): scrolled to where the scene rests, a quarter into its section, once no
// flying copy hides its parts. The clock is stopped before the scene comes into view, so no hint has
// started before the test moves time.
async function loadKinetic(open, prepare) {
  const page = await open(null, { viewport: { width: 1280, height: 720 } });
  if (prepare) await prepare(page);
  await page.clock.install();
  await page.goto(URL);
  await pause(page);
  await page.evaluate(() => { const s = document.querySelector('#spaces'); scrollTo(0, s.getBoundingClientRect().top + scrollY + s.offsetHeight / 4); });
  const settled = () => page.evaluate(() => { const r = document.querySelector('#swp'); return r.querySelectorAll('.lk-hide').length + getComputedStyle(r.closest('.in')).opacity; });
  for (let i = 0; (await settled()) !== '01'; i++) {
    if (i > 100) throw new Error('the spaces scene never settled');
    await page.clock.runFor(50);
  }
  return page;
}

const state = (page) => page.evaluate(() => {
  const r = document.querySelector('#swp'), bars = [...r.querySelectorAll('.sb')], pages = [...r.querySelectorAll('.pc')];
  const card = r.querySelector('.pgw');
  return {
    shown: pages.map((p) => p.style.opacity).join(''),
    plate: r.querySelector('.pl').style.background,
    xs: bars.map((b) => +b.style.transform.match(/translate3d\(([-\d.]+)px/)[1]),
    vis: bars.map((b) => b.style.visibility[0]).join(''),
    snap: bars[0].style.transition,
    clip: pages.map((p) => p.style.clipPath),
    rot: parseFloat(card.style.rotate),
    lift: card.style.translate,
  };
});

// the space in the slot, from what the page shows
async function space(page) {
  const s = await state(page);
  const at = s.shown.indexOf('1');
  expect(s.shown, 'exactly one page shows').toBe(['100', '010', '001'][at]);
  expect(s.plate).toBe(PLATE[at]);
  return at;
}

const wheel = (page, deltaX, deltaY = 0) => page.evaluate(([deltaX, deltaY]) =>
  document.querySelector('#swp').dispatchEvent(new WheelEvent('wheel', { deltaX, deltaY, cancelable: true, bubbles: true })), [deltaX, deltaY]);

const touch = (page, type, x, y, pointerType = 'touch') => page.evaluate(([type, x, y, pointerType]) =>
  document.querySelector('#swp').dispatchEvent(new PointerEvent(type, { pointerType, clientX: x, clientY: y, bubbles: true })), [type, x, y, pointerType]);

// a trackpad sends a swipe as events 16 ms apart
async function swipe(page, deltas) {
  for (const d of deltas) { await wheel(page, d); await page.clock.runFor(16); }
}

test('it starts on Life, with Side waiting hidden under the page', async ({ open }) => {
  const page = await load(open);
  expect(await space(page)).toBe(1);
  expect(await state(page)).toMatchObject({ xs: xs(1), vis: 'vvh', rot: 0 });
});

test('a vertical wheel scrolls the page and leaves the space alone', async ({ open }) => {
  const page = await load(open);
  expect(await wheel(page, 5, 30)).toBe(true);
  await page.clock.runFor(200);
  expect(await space(page)).toBe(1);
  expect((await state(page)).xs).toEqual(xs(1));
});

test('a small horizontal pull follows the fingers, then springs back', async ({ open }) => {
  const page = await load(open);
  // not prevented, the browser would read it as Back
  expect(await wheel(page, 20)).toBe(false);
  await page.clock.runFor(16);
  expect(await state(page)).toMatchObject({ xs: xs(1 + 20 / 230), snap: 'none', rot: 0 });
  await page.clock.runFor(150);
  expect(await state(page)).toMatchObject({ xs: xs(1), snap: 'transform 0.38s cubic-bezier(0.25, 1.45, 0.4, 1)' });
  expect(await space(page)).toBe(1);
});

test('pulls that add up past a fifth of a space move one space', async ({ open }) => {
  const page = await load(open);
  await swipe(page, [20, 20]);
  expect(await space(page)).toBe(1);
  await swipe(page, [20]);
  expect(await space(page)).toBe(2);
  expect(await state(page)).toMatchObject({ xs: xs(2), vis: 'vvv' });
});

test('a flick moves one space even before a fifth is pulled', async ({ open }) => {
  const page = await load(open);
  // 30/230 is past .06 but not past .2: only the flick (more than 26 in one event) commits
  await swipe(page, [-30]);
  expect(await space(page)).toBe(0);
  expect(await state(page)).toMatchObject({ xs: xs(0), vis: 'vhh' });
});

test('the fading tail of a swipe is ignored; a new swipe is not', async ({ open }) => {
  const page = await load(open);
  await swipe(page, [-50]);
  expect(await space(page)).toBe(0);
  // more than 140 ms of quiet: a new swipe
  await page.clock.runFor(200);
  await swipe(page, [50]);
  expect(await space(page)).toBe(1);
  // its tail, each event strong enough to commit on its own, moves nothing
  await swipe(page, [40, 30, 20, 10, 8, 8, 8, 8, 8]);
  expect(await space(page)).toBe(1);
  // after 160 ms, the same way, only well above the quietest tail (8 * 2.5) counts
  await swipe(page, [12]);
  expect((await state(page)).xs).toEqual(xs(1));
  await swipe(page, [25]);
  expect((await state(page)).xs).toEqual(xs(1 + 25 / 230));
  await swipe(page, [25]);
  expect(await space(page)).toBe(2);
});

test('after a swipe, a move the other way starts a new one, but not in the first 160 ms', async ({ open }) => {
  const page = await load(open);
  await swipe(page, [50]);
  expect(await space(page)).toBe(2);
  await swipe(page, [-8]);
  expect((await state(page)).xs).toEqual(xs(2));
  await swipe(page, [10, 10, 10, 10, 10, 10, 10, 10, 10]);
  await swipe(page, [-8]);
  expect((await state(page)).xs).toEqual(xs(2 - 8 / 230));
  await swipe(page, [-50]);
  expect(await space(page)).toBe(1);
});

test('at either end the strip resists, and a hard pull stays put', async ({ open }) => {
  const page = await load(open);
  await swipe(page, [50]);
  expect(await space(page)).toBe(2);
  await page.clock.runFor(200);
  await swipe(page, [20]);
  // pulled 20/230 of a space, it moves only 30% of that
  expect((await state(page)).xs).toEqual(xs(2 + 0.3 * 20 / 230));
  await page.clock.runFor(150);
  expect((await state(page)).xs).toEqual(xs(2));
  await swipe(page, [200]);
  expect(await space(page)).toBe(2);
  expect((await state(page)).xs).toEqual(xs(2));

  await page.clock.runFor(200);
  await swipe(page, [-50]);
  await page.clock.runFor(200);
  await swipe(page, [-50]);
  expect(await space(page)).toBe(0);
  await page.clock.runFor(200);
  await swipe(page, [-20]);
  expect((await state(page)).xs).toEqual(xs(-0.3 * 20 / 230));
});

test('a finger dragged far enough moves one space; a short drag springs back', async ({ open }) => {
  const page = await load(open);
  await touch(page, 'pointerdown', 300, 400);
  await touch(page, 'pointermove', 280, 400);
  await page.clock.runFor(16);
  const short = 20 * 0.857 / (170 * 0.8 * 0.857);
  expect(await state(page)).toMatchObject({ xs: xs(1 + short), snap: 'none' });
  await touch(page, 'pointerup', 280, 400);
  await page.clock.runFor(16);
  expect(await space(page)).toBe(1);
  expect((await state(page)).xs).toEqual(xs(1));

  // dragging right pulls the space on the left in
  await touch(page, 'pointerdown', 300, 400);
  await touch(page, 'pointermove', 360, 400);
  await touch(page, 'pointerup', 360, 400);
  await page.clock.runFor(16);
  expect(await space(page)).toBe(0);
  // already at the first space: a drag past it stays there
  await touch(page, 'pointerdown', 300, 400);
  await touch(page, 'pointermove', 360, 400);
  await touch(page, 'pointercancel', 360, 400);
  await page.clock.runFor(16);
  expect(await space(page)).toBe(0);
  expect((await state(page)).xs).toEqual(xs(0));
});

test('a mouse drag does nothing: only a finger swipes', async ({ open }) => {
  const page = await load(open);
  await touch(page, 'pointerdown', 300, 400, 'mouse');
  await touch(page, 'pointermove', 200, 400, 'mouse');
  await touch(page, 'pointerup', 200, 400, 'mouse');
  await page.clock.runFor(200);
  expect(await space(page)).toBe(1);
  expect((await state(page)).xs).toEqual(xs(1));
});

// Polls in 100 ms steps until the hint has started (it tips the page card).
async function untilPeek(page) {
  for (let i = 0; i < 100; i++) {
    if ((await state(page)).rot !== 0) return;
    await page.clock.runFor(100);
  }
  throw new Error('no hint started');
}

test('in view, the hint tugs the strip toward Side, then toward Work, and lets go', async ({ open }) => {
  const page = await loadKinetic(open);
  await untilPeek(page);
  // held: pulled .46 of a space toward Side, which shows through from the side the strip comes from
  await page.clock.runFor(500);
  let s = await state(page);
  expect(s.xs).toEqual(xs(1.46));
  expect(s).toMatchObject({ shown: '011', clip: ['', '', 'inset(0px 0px 0px 56.8%)'], rot: -1.38, lift: '0px 0px 15.6px', snap: 'none' });
  expect(s.plate).toBe('color-mix(in srgb, rgb(255, 196, 219) 43.2%, rgb(255, 240, 168) 56.8%)');
  // let go: it springs back and Life is shown alone again
  await page.clock.runFor(1300);
  s = await state(page);
  expect(s).toMatchObject({ shown: '010', clip: ['', '', ''], rot: 0, xs: xs(1), plate: PLATE[1] });

  await untilPeek(page);
  await page.clock.runFor(500);
  s = await state(page);
  expect(s.xs).toEqual(xs(0.54));
  expect(s).toMatchObject({ shown: '110', clip: ['inset(0px 56.8% 0px 0px)', '', ''], rot: 1.38 });
  await page.clock.runFor(1300);
  expect(await space(page)).toBe(1);
});

test('a swipe during the hint takes the strip over, and the hint never comes back', async ({ open }) => {
  const page = await loadKinetic(open);
  await untilPeek(page);
  await page.clock.runFor(300);
  // the pull already there plus this one is past a fifth: Side
  await wheel(page, 10);
  await page.clock.runFor(16);
  expect(await space(page)).toBe(2);
  expect(await state(page)).toMatchObject({ xs: xs(2), clip: ['', '', ''], rot: 0 });
  for (let i = 0; i < 40; i++) {
    await page.clock.runFor(250);
    expect((await state(page)).rot).toBe(0);
  }
  expect(await space(page)).toBe(2);
});

test('a finger on the strip stops the hint too, and the strip follows it while held', async ({ open }) => {
  const page = await load(open);
  await touch(page, 'pointerdown', 300, 400);
  await touch(page, 'pointermove', 290, 400);
  // held still for 10 s: no hint pulls the strip from under the finger
  await page.clock.runFor(10000);
  const held = 10 / (170 * 0.8);
  expect(await state(page)).toMatchObject({ xs: xs(1 + held), rot: 0 });
  await touch(page, 'pointerup', 290, 400);
  await page.clock.runFor(10000);
  expect(await state(page)).toMatchObject({ xs: xs(1), rot: 0 });
});

test('out of view there is no hint', async ({ open }) => {
  const page = await load(open);
  await page.evaluate(() => scrollTo(0, 0));
  await page.clock.runFor(10000);
  expect(await state(page)).toMatchObject({ xs: xs(1), rot: 0 });
});

test('with reduced motion there is no hint, and the strip jumps without a spring', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  await page.clock.runFor(10000);
  expect(await state(page)).toMatchObject({ xs: xs(1), rot: 0, snap: 'none' });
  await swipe(page, [50]);
  expect(await space(page)).toBe(2);
  expect((await state(page)).snap).toBe('none');
});

test('spike: the add-up check fails if a commit needs most of a space', async ({ open }) => {
  const page = await load(open, {}, (p) => mutate(p, URL, 'Math.abs(off) > .2 ||', 'Math.abs(off) > .9 ||'));
  await swipe(page, [20, 20, 20]);
  expect(await space(page)).not.toBe(2);
});

test('spike: the hint check fails if a swipe does not stop the hint', async ({ open }) => {
  const page = await loadKinetic(open, (p) => mutate(p, URL, 'const stop = () => { used = true; };', 'const stop = () => {};'));
  await untilPeek(page);
  await page.clock.runFor(300);
  await wheel(page, 10);
  let rotated = false;
  for (let i = 0; i < 40 && !rotated; i++) {
    await page.clock.runFor(250);
    rotated = (await state(page)).rot !== 0;
  }
  expect(rotated).toBe(true);
});
