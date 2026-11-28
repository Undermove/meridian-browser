// The hero drawing: its pieces drop in on load, then the mouse blows the window apart and turns it.
import { test, expect, mutate } from './fixtures.mjs';

const PAGE = 'docs/index.html';
const SIDEBAR = Array.from({ length: 16 }, (_, i) => 's' + i);

// Records every value the style attribute of a piece had before it changed, so the pose the drop
// starts from (set and replaced in the same task) can be checked.
const RECORD = `
  window.__was = [];
  new MutationObserver((ms) => ms.forEach((m) => {
    if (m.target.dataset && m.target.dataset.p === 'a') window.__was.push(m.oldValue);
  })).observe(document, { subtree: true, attributes: true, attributeFilter: ['style'], attributeOldValue: true });
`;

const pose = (page) => page.evaluate(() => {
  const asm = document.getElementById('asm'), scene = asm.querySelector('.scene');
  const p = {};
  for (const el of asm.querySelectorAll('[data-p]')) {
    p[el.dataset.p] = { t: el.style.transform, tr: el.style.transition, delay: el.style.transitionDelay, e: el.style.getPropertyValue('--e') };
  }
  return { p, o: asm.style.getPropertyValue('--o'), scene: scene.style.transform, sceneTr: scene.style.transition };
});
const nums = (s, fn) => s.match(new RegExp(fn + '\\(([^)]*)\\)'))[1].split(',').map(parseFloat);
const turnOf = (scene) => nums(scene, 'rotateZ')[0];

// Moves the mouse to a point of the drawing: (-1,-1) is its top left corner, (1,1) its bottom right.
async function at(page, px, py) {
  const b = await page.locator('#asm').boundingBox();
  await page.mouse.move(b.x + (px + 1) / 2 * b.width, b.y + (py + 1) / 2 * b.height);
  await page.clock.runFor(20); // one frame
}

// Fake timers, stopped before the page loads: only runFor moves them, however slow the machine is.
// The clock runs in real time until pauseAt, which can't go back: 60 s leaves room for a busy machine.
async function frozen(page) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
}

async function load(open, options = {}) {
  const page = await open(null, { init: RECORD, ...options });
  await frozen(page);
  await page.goto(PAGE);
  return page;
}

const REST = { base: [0, 1], a: [14, 1], b: [14, 0.5437], c: [14, 0.5437], ...Object.fromEntries(SIDEBAR.map((k) => [k, [14.6, 0.2752]])) };
const restForm = (k) => `translate3d(0px, 0px, ${REST[k][0]}px) scale(${REST[k][1]})`;
const DROP_AT = { base: 0, a: 0.28, b: 0.54, c: 0.8, ...Object.fromEntries(SIDEBAR.map((k, i) => [k, 1.1 + i * 0.05])) };

test('the pieces start above the page and drop in one after another', async ({ open }) => {
  const page = await load(open);
  expect(await page.evaluate(() => window.__was.some((s) => s.includes('translate3d(0px, 0px, 2400px)')))).toBe(true);
  const s = await pose(page);
  for (const [k, v] of Object.entries(s.p)) {
    expect(v.t, k).toBe(restForm(k));
    expect(v.tr, k).toMatch(/^transform 0\.85s linear\(/);
    expect(parseFloat(v.delay), k).toBeCloseTo(DROP_AT[k], 5);
  }
  expect(s.p.b.e).toBe('0.000');
  expect(s.o).toBe('0.000');
  expect(s.sceneTr).toBe('none');
  expect(s.scene).toBe('scale(0.9) rotateX(22deg) rotateZ(8deg)');
});

test('the mouse does nothing until the drop is over (2.8 s)', async ({ open }) => {
  const page = await load(open);
  const before = await pose(page);
  await at(page, 0, 0);
  await at(page, 0.01, 0);
  expect(await pose(page)).toEqual(before);
  await page.clock.runFor(2800);
  await at(page, 0, 0);
  expect((await pose(page)).p.a.t).not.toBe(before.p.a.t);
});

test('the mouse starts to count at 2.8 s, not before', async ({ open }) => {
  const page = await load(open);
  const before = await pose(page);
  // at() runs the clock 20 ms itself
  await page.clock.runFor(2760);
  await at(page, 0, 0);
  expect(await pose(page)).toEqual(before);
  await page.clock.runFor(30);
  await at(page, 0.01, 0);
  expect((await pose(page)).o).toBe('1.000');
});

test('in the middle the window is blown apart; off to one side it turns', async ({ open }) => {
  const page = await load(open);
  await page.clock.runFor(2800);
  await at(page, 0, 0);
  let s = await pose(page);
  expect(s.o).toBe('1.000');
  expect(s.sceneTr).toBe('transform 0.16s ease-out');
  expect(turnOf(s.scene)).toBeCloseTo(8, 0);
  expect(s.p.base.t).toBe('none');
  expect(s.p.a.t).toMatch(/^translate3d\(-70px, 10px, 40px\) scale\(1\) translate\(/);
  expect(s.p.a.t).toContain('rotateZ(-7deg)');
  expect(s.p.b.t).toMatch(/^translate3d\(-16px, 22px, 184px\) scale\(0\.5437\)/);
  expect(s.p.c.t).toMatch(/^translate3d\(76px, -22px, 264px\) scale\(0\.5437\)/);
  // the open pages tell their insides how far apart they are
  expect(s.p.b.e).toBe('0.500');
  expect(s.p.c.e).toBe('0.500');
  // sidebar parts: spread top to bottom, lifted off the plate, each tipped its own way
  const side = SIDEBAR.map((k) => nums(s.p[k].t, 'translate3d'));
  expect(side.map(([, y]) => y)).toEqual(SIDEBAR.map((_, i) => (i - 7.5) * 17));
  for (const [, , z] of side) expect(z).toBeGreaterThan(14.6);
  expect(new Set(SIDEBAR.map((k) => s.p[k].t.match(/rotateZ\([^)]*\)/)[0])).size).toBe(16);
  for (const k of SIDEBAR) expect(s.p[k].tr).toBe('transform 0.16s ease-out');
  // odd parts fly right of the -40px drift, even ones left of it
  side.forEach(([x], i) => expect(x > -40, SIDEBAR[i]).toBe(i % 2 === 1));

  // right of the middle: less apart, turned to the right
  await at(page, 0.5, 0);
  s = await pose(page);
  expect(turnOf(s.scene)).toBeCloseTo(14, 0);
  expect(parseFloat(s.p.b.e)).toBeCloseTo(0.5 * 0.5 / 0.7, 2);

  // just inside the bottom edge, as far right: it hardly turns (8 + 0.5 * 0.05 / 0.25 * 12)
  await at(page, 0.5, 0.95);
  s = await pose(page);
  expect(turnOf(s.scene)).toBeCloseTo(9.2, 0);

  // near a corner, still over the drawing: assembled
  await at(page, 0.95, 0.95);
  s = await pose(page);
  for (const [k, v] of Object.entries(s.p)) expect(v.t, k).toBe(restForm(k));
  expect(s.o).toBe('0.000');
  expect(s.sceneTr).toBe('transform 0.16s ease-out');
});

test('leaving the drawing or the window puts it back together', async ({ open }) => {
  const page = await load(open);
  await page.clock.runFor(2800);
  for (const leave of [
    async () => { const b = await page.locator('#asm').boundingBox(); await page.mouse.move(b.x - 30, b.y + b.height / 2); },
    async () => page.mouse.move(-20, -20), // fires pointerleave on the document
  ]) {
    await at(page, 0, 0);
    expect((await pose(page)).o).toBe('1.000');
    await leave();
    await page.clock.runFor(20);
    const s = await pose(page);
    for (const [k, v] of Object.entries(s.p)) expect(v.t, k).toBe(restForm(k));
    expect(s.o).toBe('0.000');
    expect(s.sceneTr).toBe('transform 0.5s cubic-bezier(0.2, 0.8, 0.3, 1)');
    expect(s.scene).toBe('scale(0.9) rotateX(22deg) rotateZ(8deg)');
  }
});

test('touch and pen moves are ignored', async ({ open }) => {
  const page = await load(open);
  await page.clock.runFor(2800);
  const before = await pose(page);
  const b = await page.locator('#asm').boundingBox();
  await page.evaluate(([x, y]) => dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: x, clientY: y })),
    [b.x + b.width / 2, b.y + b.height / 2]);
  await page.clock.runFor(20);
  expect(await pose(page)).toEqual(before);
});

test('the blow-apart check fails if the middle no longer opens the window', async ({ open }) => {
  const page = await open(null);
  await mutate(page, PAGE, 'const e = over ? .5 * clamp', 'const e = over ? 0 * clamp');
  await frozen(page);
  await page.goto(PAGE);
  await page.clock.runFor(2800);
  await at(page, 0, 0);
  expect((await pose(page)).o).not.toBe('1.000');
});

test('with reduced motion nothing moves: no drop, no pointer tracking', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  const markup = await page.evaluate(() => [...document.querySelectorAll('#asm [data-p]')].map((el) => el.getAttribute('style')));
  const s = await pose(page);
  for (const [k, v] of Object.entries(s.p)) {
    expect(v.t, k).toBe(k === 'base' ? 'none' : restForm(k));
    expect(v.tr, k).toBe('');
  }
  expect(await page.evaluate(() => window.__was)).toEqual([]);
  await page.clock.runFor(3000);
  await at(page, 0, 0);
  await at(page, 0.01, 0);
  expect(await page.evaluate(() => [...document.querySelectorAll('#asm [data-p]')].map((el) => el.getAttribute('style')))).toEqual(markup);
  await expect(page.locator('h1.fit')).toHaveClass(/\bgo\b/);
});
