// The import demo (#imp): one press and Arc's tabs cross to Meridian, Arc shatters, a window opens.
import fs from 'node:fs';
import { test, expect, mutate } from './fixtures.mjs';

const URL = 'docs/index.html';
// these move a fake clock through seconds of animation, and the machine may be busy with other runs
test.describe.configure({ timeout: 120000 });
const HELLO = 'HELLO, MERIDIAN ✦ HELLO, MERIDIAN ✦ ';
// Stops the clock where it is. The page's time runs on while the call travels, so the target can
// already be past on a busy machine: then try again.
async function pause(page) {
  for (let i = 0; ; i++) {
    try { return await page.clock.pauseAt(await page.evaluate(() => Date.now() + 300)); } catch (e) { if (i > 20 || !/past/.test(e.message)) throw e; }
  }
}

// 4 favorites + 9 rows cross, 110 ms apart; the last lands 900 ms after it leaves (index.html `end`).
const END = 13 * 110 + 900;

// Scrolls to where the scene rests: in kinetic mode (wide viewports) a quarter into its section, where no
// flying copy hides its parts. Then stops the clock, so the test moves time itself.
async function rest(page, id) {
  await page.evaluate((id) => { const s = document.querySelector(id).closest('section'); scrollTo(0, s.getBoundingClientRect().top + scrollY + s.offsetHeight / 4); }, id);
  await expect.poll(() => page.evaluate((id) => { const r = document.querySelector(id); return r.querySelectorAll('.lk-hide').length + getComputedStyle(r.closest('.in')).opacity; }, id), { intervals: [50] }).toBe('01');
  await pause(page);
}

async function load(open, options = {}, prepare) {
  const page = await open(null, { viewport: { width: 1280, height: 720 }, ...options });
  if (prepare) await prepare(page);
  await page.clock.install();
  await page.goto(URL);
  await rest(page, '#imp');
  return page;
}

const btn = (page) => page.locator('#imp .btn');

// Where each part of the scene is: which slots left Arc, which landed in Meridian, the root's classes.
const state = (page) => page.evaluate(() => {
  const r = document.querySelector('#imp'), from = r.querySelector('.sb.src'), to = r.querySelector('.sb.arc');
  const slots = (sb) => [...sb.querySelectorAll('.fv4 i, .rw:not(.nt)')];
  return {
    root: r.className,
    btn: r.querySelector('.btn').className,
    label: r.querySelector('.btn textPath').textContent,
    left: slots(from).filter((e) => e.classList.contains('left')).length,
    got: slots(to).filter((e) => e.classList.contains('got') && e.classList.contains('home')).length,
    in2: slots(to).filter((e) => e.classList.contains('in2')).length,
    fromVis: from.style.visibility,
    from: from.className,
    to: to.className,
    shards: r.querySelectorAll('.shard.tri').length,
    flat: r.querySelectorAll('.flat2d').length,
  };
});

// Shards and sparks remove themselves in real time, so they are counted as they are added, with where
// each shard is thrown (its animation's middle frame).
const watch = (page) => page.evaluate(() => {
  window.added = { shard: 0, cf: 0, throws: [] };
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((e) => {
    if (e.classList?.contains('shard')) { added.shard++; added.throws.push(e.getAnimations()[0]?.effect.getKeyframes()[1]?.transform || ''); }
    else if (e.classList?.contains('cf')) added.cf++;
  }))).observe(document.querySelector('#imp .scene'), { childList: true });
});

async function pressAndFinish(page) {
  await btn(page).click();
  await page.clock.runFor(END + 450 + 2500 + 50);
}

test('pressing the button sinks it, and leaving or letting go brings it back up', async ({ open }) => {
  const page = await load(open);
  const b = await btn(page).boundingBox();
  const centre = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(...centre);
  await page.mouse.down();
  await expect(btn(page)).toHaveAttribute('style', /translate3d\(0px, 10px, 64px\) scale\(0\.7\)/);
  await page.mouse.move(5, 5);
  await expect(btn(page)).toHaveAttribute('style', /translate3d\(0px, 10px, 90px\) scale\(0\.7\)/);
  await page.mouse.up();
  await page.mouse.move(...centre);
  await page.mouse.down();
  await expect(btn(page)).toHaveAttribute('style', /, 64px\)/);
  // a real release here would also click
  await btn(page).dispatchEvent('pointerup');
  await expect(btn(page)).toHaveAttribute('style', /, 90px\)/);
  expect(await state(page)).toMatchObject({ btn: 'btn', left: 0, got: 0 });
});

test('one press moves every tab across, shatters Arc and opens the Meridian window', async ({ open }) => {
  const page = await load(open);
  await watch(page);
  await btn(page).click();
  expect(await state(page)).toMatchObject({ btn: 'btn used', label: HELLO, left: 0, got: 0 });
  await expect(page.locator('#imp .btn .key5 path')).toHaveAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
  await expect(btn(page)).toHaveCSS('cursor', 'default');

  // the first tab leaves Arc at 120 ms and lands at 820 ms
  await page.clock.runFor(121);
  expect(await state(page)).toMatchObject({ left: 1, got: 0 });
  await page.clock.runFor(700);
  expect(await state(page)).toMatchObject({ left: 7, got: 1 });

  await page.clock.runFor(END - 821);
  expect(await state(page)).toMatchObject({ left: 13, got: 13, in2: 13, from: 'sb src spent' });
  expect((await state(page)).to).toContain('quiet');
  expect((await state(page)).root).not.toContain('fin');

  // Arc cracks at end + 450 and breaks into 64 triangles 300 ms later
  await page.clock.runFor(450);
  expect(await state(page)).toMatchObject({ root: 'imp fin', fromVis: '' });
  expect(await page.evaluate(() => [added.shard, added.cf])).toEqual([0, 0]);
  await expect(page.locator('#imp .sb.src > svg polyline')).toHaveCount(7);
  await page.clock.runFor(300);
  expect(await state(page)).toMatchObject({ fromVis: 'hidden' });
  // 32 cells cut in two, and a ring + 18 sparks
  expect(await page.evaluate(() => [added.shard, added.cf])).toEqual([64, 19]);

  // Meridian's sidebar flies to the middle, and the move is then written into its style
  await page.clock.runFor(300);
  await expect.poll(() => page.locator('#imp .sb.arc').evaluate((e) => e.style.transform)).toContain('translateX(-322px) scale(0.56)');
  await expect.poll(() => page.locator('#imp .sb.arc').evaluate((e) => e.getAnimations().length)).toBe(0);
  // the shards and sparks remove themselves when their animations end
  await expect.poll(() => page.locator('#imp .shard, #imp .scene > .cf').count(), { timeout: 30000 }).toBe(0);

  // once all has landed, a flat 2D copy is laid over the 3D parts
  expect((await state(page)).flat).toBe(0);
  await page.clock.runFor(2500 - 300 - 300 + 50);
  expect((await state(page)).flat).toBe(1);
});

test('the flat copy replaces the 3D window, without ids, and is redrawn once after a resize', async ({ open }) => {
  const page = await load(open);
  await pressAndFinish(page);
  const flat = page.locator('#imp .flat2d');
  await expect(flat).toHaveCount(1);
  // four parts; the window also gets six layers for its thickness
  await expect(flat.locator('> *')).toHaveCount(10);
  await expect(flat.locator('[id]')).toHaveCount(0);
  for (const sel of ['.fwin', '.sb.arc', '.fpage', '.done-chip.under']) {
    await expect(page.locator(`#imp .scene > ${sel}`)).toHaveCSS('opacity', '0');
  }
  await expect(flat.locator('> .sb.arc')).toHaveCSS('opacity', '1');

  await flat.evaluate((e) => { e.dataset.old = '1'; window.resizes = 0; addEventListener('resize', () => window.resizes++); });
  // one resize: a second one can arrive late and restart the 150 ms wait
  await page.setViewportSize({ width: 1280, height: 700 });
  await expect.poll(() => page.evaluate(() => window.resizes)).toBe(1);
  await page.clock.runFor(149);
  await expect(page.locator('#imp .flat2d[data-old]')).toHaveCount(1);
  await page.clock.runFor(2);
  await expect(flat).toHaveCount(1);
  await expect(page.locator('#imp .flat2d[data-old]')).toHaveCount(0);
  await expect(page.locator('#imp .scene > .sb.arc')).toHaveCSS('opacity', '0');
});

test('once all have landed, the slots they left are empty and the travelled parts are put away', async ({ open }) => {
  const page = await load(open);
  await btn(page).click();
  await page.clock.runFor(END + 10);
  expect(await page.evaluate(() => {
    const from = document.querySelector('#imp .sb.src');
    const slots = [...from.querySelectorAll('.fv4 i, .rw:not(.nt)')];
    const parts = [...from.querySelectorAll('.fv4 i svg, .rw:not(.nt) .tb2')];
    return { home: slots.filter((e) => e.classList.contains('home')).length, hidden: parts.filter((e) => e.style.visibility === 'hidden').length };
  })).toEqual({ home: 0, hidden: 13 });
});

test('resizes close together redraw the flat copy once, 150 ms after the last', async ({ open }) => {
  const page = await load(open);
  await pressAndFinish(page);
  const flat = page.locator('#imp .flat2d');
  await flat.evaluate((e) => { e.dataset.old = '1'; });
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await page.clock.runFor(100);
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  // 200 ms after the first: a timer left from it would have redrawn by now
  await page.clock.runFor(100);
  await expect(page.locator('#imp .flat2d[data-old]')).toHaveCount(1);
  await page.clock.runFor(60);
  await expect(page.locator('#imp .flat2d[data-old]')).toHaveCount(0);
  await expect(flat).toHaveCount(1);
});

test('redrawn at the same size, the flat copy lands exactly where it was', async ({ open }) => {
  const page = await load(open);
  await btn(page).click();
  await page.clock.runFor(END + 450 + 2500 - 50);
  // the fake clock jumps, but CSS transitions and el.animate() run on real time: let them end first,
  // so the first copy is measured from the parts at rest, as a visitor's would be
  await expect.poll(() => page.locator('#imp').evaluate((r) => r.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && a.effect.getComputedTiming().endTime !== Infinity).length), { timeout: 30000 }).toBe(0);
  await page.clock.runFor(100);
  const poses = () => page.locator('#imp .flat2d > *').evaluateAll((els) => els.map((e) => e.style.transform));
  const before = await poses();
  expect(before).toHaveLength(10);
  // by now the 3D parts are hidden; measured hidden, a part is drawn flat and lands elsewhere
  await page.evaluate(() => dispatchEvent(new Event('resize')));
  await page.clock.runFor(200);
  expect(await poses()).toEqual(before);
});

test('a resize before the window is finished draws no flat copy', async ({ open }) => {
  const page = await load(open);
  await page.evaluate(() => { window.resizes = 0; addEventListener('resize', () => window.resizes++); });
  await page.setViewportSize({ width: 1280, height: 700 });
  await expect.poll(() => page.evaluate(() => window.resizes)).toBe(1);
  await page.clock.runFor(500);
  await expect(page.locator('#imp .flat2d')).toHaveCount(0);
});

test('the button works once: a second press or push does nothing', async ({ open }) => {
  const page = await load(open);
  await pressAndFinish(page);
  await watch(page);
  // shards leave on their own in real time, so they are left out of the comparison
  const { shards, ...before } = await state(page);
  await btn(page).dispatchEvent('pointerdown');
  await expect(btn(page)).toHaveAttribute('style', /, 90px\)/);
  await btn(page).dispatchEvent('pointerup');
  await btn(page).dispatchEvent('click');
  await page.clock.runFor(END + 3500);
  const { shards: _, ...now } = await state(page);
  expect(now).toEqual(before);
  expect(await page.evaluate(() => [added.shard, added.cf])).toEqual([0, 0]);
});

test('with reduced motion the press jumps straight to the finished window', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' });
  await btn(page).click();
  expect(await state(page)).toMatchObject({ root: 'imp fin', fromVis: 'hidden', got: 13, in2: 13, left: 0, shards: 0, flat: 0, label: HELLO });
  expect((await state(page)).to).toContain('quiet');
  await expect(page.locator('#imp .sb.arc')).toHaveAttribute('style', /translateX\(-322px\) scale\(0\.56\)/);
  await page.clock.runFor(121);
  expect((await state(page)).flat).toBe(1);
});

// Math.random, scripted only for the jagged net and the triangle choice: one triangle's centre then lands
// exactly on the break point, where its distance from it is 0. Calls are told apart by their line.
// Keys of `net` are the order of the net's calls: P[3][2] x,y = 22,23; P[4][2] = 30,31; P[4][3] = 32,33.
// Quad 14 is row 3, column 2; it is cut into the triangle P[3][2], P[4][3], P[4][2].
const lineOf = (text) => fs.readFileSync(URL, 'utf8').split('\n').findIndex((l) => l.includes(text)) + 1;
const CENTRE = `(() => {
  const NET = ':${lineOf('P[r].push([SX + c * w')}:', CHOICE = ':${lineOf('if (Math.random() < .5) { shard(')}:';
  const real = Math.random.bind(Math), net = new Map([[22, 0.03703703703703705], [23, 0.962962962962963], [30, 0.037037037037033385], [31, 0.962962962962963], [32, 0.03703703703703705], [33, 0.9629629629629629]]);
  let n = 0, q = 0;
  Math.random = () => {
    const s = new Error().stack;
    if (s.includes('index.html' + NET)) return net.has(n) ? net.get(n++) : (n++, 0.5);
    if (s.includes('index.html' + CHOICE)) return q++ === 14 ? 0 : 0.5;
    return real();
  };
})()`;

const centreShard = (page) => page.evaluate(() => {
  const { throws } = added;
  return { n: throws.length, nan: throws.filter((t) => /NaN/.test(t)).length, ok: throws.filter((t) => /^translate3d\(/.test(t)).length };
});

test('a shard whose centre is the break point is still thrown', async ({ open }) => {
  const page = await load(open, { init: CENTRE });
  await watch(page);
  await btn(page).click();
  await page.clock.runFor(END + 450 + 301);
  expect(await centreShard(page)).toEqual({ n: 64, nan: 0, ok: 64 });
});

test('spike: the centre shard check fails without the guard against a zero distance', async ({ open }) => {
  const page = await load(open, { init: CENTRE }, (p) => mutate(p, URL, 'Math.hypot(dx, dy) || 1', 'Math.hypot(dx, dy) || 0'));
  await watch(page);
  await btn(page).click();
  await page.clock.runFor(END + 450 + 301);
  expect(await centreShard(page)).not.toEqual({ n: 64, nan: 0, ok: 64 });
});

test('spike: the sink check fails when the press does not sink the button', async ({ open }) => {
  const page = await load(open, {}, (p) => mutate(p, URL, 'btn.style.transform = sink(26)', 'btn.style.transform = sink(0)'));
  const b = await btn(page).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(btn(page)).not.toHaveAttribute('style', /, 64px\)/);
});

test('spike: the reduced motion check fails when the press skips the finish', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce' }, (p) => mutate(p, URL, "to.classList.add('quiet');\n      to.style.transform", 'to.style.transform'));
  await btn(page).click();
  expect((await state(page)).to).not.toContain('quiet');
});
