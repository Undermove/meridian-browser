import { test, expect, mutate } from './fixtures.mjs';
import { load as loadAt, inView, press, freeze } from './scene-helpers.mjs';

const load = (open, options) => loadAt(open, '#tdy', options);
const tags = (page) => page.locator('#tdy .tb em').allTextContents();
const tab = (page, i) => page.locator(`#tdy .tb[data-i="${i}"]`);
const archived = (page) => page.locator('#tdy .tb.old');
const START = ['Pinned', 'Just now', 'A moment ago', 'A while ago', 'Archived', 'Archived'];

test('the tabs start pinned, fresh, older and archived', async ({ open }) => {
  const page = await load(open);
  expect(await tags(page)).toEqual(START);
  await expect(tab(page, 0)).toHaveClass(/\bpin\b/);
  await expect(archived(page)).toHaveCount(2);
  // pinned on top of the stack; the archived ones lie on the tray, side by side
  await expect(tab(page, 0)).toHaveAttribute('style', /translate3d\(-10px, -10px, 330px\)/);
  await expect(tab(page, 4)).toHaveAttribute('style', /translate3d\(-88px, -72px, 16px\) rotateZ\(0deg\) scale\(0\.58\)/);
  await expect(tab(page, 5)).toHaveAttribute('style', /translate3d\(96px, -58px, 16px\)/);
});

test('untouched tabs age and drop into the archive, oldest first', async ({ open }) => {
  const page = await load(open);
  // 7 s of life: Figma starts at .6 of it, YouTube at .35, Notion at .1
  await page.clock.runFor(1200);
  expect(await tags(page)).toEqual(['Pinned', 'A moment ago', 'A moment ago', 'A while ago', 'Archived', 'Archived']);
  await page.clock.runFor(1000);
  expect((await tags(page))[3]).toBe('Going…');
  await page.clock.runFor(800);
  await expect(tab(page, 3)).toHaveClass(/\bold\b/);
  expect((await tags(page))[3]).toBe('Archived');
  // it takes the first free place on the tray, under the two already there
  await expect(tab(page, 3)).toHaveAttribute('style', /translate3d\(-88px, -12px, 16px\)/);
  // the two already there keep their places
  await expect(tab(page, 4)).toHaveAttribute('style', /translate3d\(-88px, -72px, 16px\)/);
  await expect(tab(page, 5)).toHaveAttribute('style', /translate3d\(96px, -58px, 16px\)/);
  await page.clock.runFor(4000);
  await expect(archived(page)).toHaveCount(5);
  expect(await tags(page)).toEqual(['Pinned', 'Archived', 'Archived', 'Archived', 'Archived', 'Archived']);
});

test('with nothing left, the tabs come back one at a time, and a click during that still works', async ({ open }) => {
  const page = await load(open);
  // Notion, the freshest, is archived 6.3 s in; 2.6 s later the tabs rise, one every 300 ms
  await page.clock.runFor(6500);
  await expect(archived(page)).toHaveCount(5);
  await page.clock.runFor(2400);
  await expect(archived(page)).toHaveCount(5);
  const counts = [];
  const step = async () => { await page.clock.runFor(120); counts.push(await archived(page).count()); };
  while (counts.at(-1) !== 3) await step();
  // GitHub rises first, then Spotify
  await expect(tab(page, 5)).not.toHaveClass(/\bold\b/);
  await expect(tab(page, 4)).not.toHaveClass(/\bold\b/);
  // used while it waits its turn, Notion comes back now and is not raised again later
  await press(tab(page, 1));
  await expect(archived(page)).toHaveCount(2);
  await expect(tab(page, 1).locator('em')).toHaveText('Just now');
  while (counts.at(-1) !== 0) await step();
  // one at a time: the click took Notion (3 to 2), the clock did the rest
  expect(counts.filter((c, i) => c !== counts[i - 1])).toEqual([5, 4, 3, 2, 1, 0]);
  // a 300 ms gap spans at least two 120 ms ticks
  expect(counts.filter((c) => c === 1).length).toBeGreaterThanOrEqual(2);
  // each comes back aged by its place (i * .12); nothing ages until the last one is back
  expect(await tags(page)).toEqual(['Pinned', 'Just now', 'A moment ago', 'A moment ago', 'A moment ago', 'A while ago']);
  // Notion was used at the click, so it is fresh from then: still under .2 of its life 1.1 s on
  await page.clock.runFor(1100);
  await expect(tab(page, 1).locator('em')).toHaveText('Just now');
});

test('a tab used while all are archived starts the 2.6 s wait over once it drops back', async ({ open }) => {
  const page = await load(open);
  await page.clock.runFor(6500);
  await expect(archived(page)).toHaveCount(5);
  await page.clock.runFor(1000);
  await press(tab(page, 2));
  await expect(archived(page)).toHaveCount(4);
  // YouTube drops back 7 s after the click; the tabs rise 2.6 s after that, not at once
  await page.clock.runFor(7100);
  await expect(archived(page)).toHaveCount(5);
  await page.clock.runFor(1500);
  await expect(archived(page)).toHaveCount(5);
  await page.clock.runFor(1500);
  await expect(archived(page)).not.toHaveCount(5);
});

test('a click brings an archived tab back to the top; the pinned tab stays pinned', async ({ open }) => {
  const page = await load(open);
  await press(tab(page, 5));
  await expect(tab(page, 5)).not.toHaveClass(/\bold\b/);
  await expect(tab(page, 5).locator('em')).toHaveText('Just now');
  // second in the stack, right under the pinned tab
  await expect(tab(page, 5)).toHaveAttribute('style', /translate3d\(-3px, -3px, 270px\)/);
  await press(tab(page, 0));
  await expect(tab(page, 0).locator('em')).toHaveText('Pinned');
  await expect(tab(page, 0)).toHaveAttribute('style', /translate3d\(-10px, -10px, 330px\)/);
});

test('a tab brought back and archived again takes the first free place on the tray', async ({ open }) => {
  const page = await load(open);
  // Spotify leaves place 0; Figma (2.8 s), YouTube (4.55 s), Notion (6.3 s) and Spotify (7 s) then drop in
  await press(tab(page, 4));
  await page.clock.runFor(7500);
  await expect(archived(page)).toHaveCount(5);
  await expect(tab(page, 3)).toHaveAttribute('style', /translate3d\(-88px, -72px, 16px\)/);
  await expect(tab(page, 4)).toHaveAttribute('style', /translate3d\(-88px, 48px, 16px\)/);
  const poses = await archived(page).evaluateAll((els) => els.map((e) => e.style.transform));
  expect(new Set(poses).size).toBe(5);
});

test('Enter and Space bring a tab back; other keys do not', async ({ open }) => {
  const page = await load(open);
  await tab(page, 4).focus();
  await page.keyboard.press('a');
  await expect(tab(page, 4)).toHaveClass(/\bold\b/);
  await page.keyboard.press('Enter');
  await expect(tab(page, 4)).not.toHaveClass(/\bold\b/);
  await tab(page, 5).focus();
  await page.keyboard.press(' ');
  await expect(tab(page, 5)).not.toHaveClass(/\bold\b/);
  // Space must not scroll the page
  await expect(page.locator('#tdy')).toBeInViewport({ ratio: 1 });
});

test('held, or with reduced motion, the clock stops; clicks still work', async ({ open }) => {
  const held = await load(open);
  await held.locator('#tdy').evaluate((e) => e.setAttribute('data-hold', ''));
  await held.clock.runFor(10000);
  expect(await tags(held)).toEqual(START);

  const calm = await load(open, { reducedMotion: 'reduce' });
  await calm.clock.runFor(20000);
  expect(await tags(calm)).toEqual(START);
  await press(tab(calm, 4));
  await expect(tab(calm, 4).locator('em')).toHaveText('Just now');
});

test('out of view, the tabs do not age', async ({ open }) => {
  const page = await load(open);
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(() => page.locator('#tdy').evaluate((el) => new Promise((r) =>
    new IntersectionObserver((e, o) => { o.disconnect(); r(e[0].isIntersecting); }).observe(el)))).toBe(false);
  await page.clock.runFor(10000);
  expect(await tags(page)).toEqual(START);
  await inView(page, '#tdy');
  await page.clock.runFor(1200);
  expect((await tags(page))[1]).toBe('A moment ago');
});

test('the tabs age at the default viewport too', async ({ page }) => {
  await page.clock.install();
  await page.goto('docs/index.html');
  await freeze(page);
  await page.evaluate(() => scrollTo(0, document.querySelector('#today').offsetTop + 200));
  // Figma is archived about 2.8 s of clock time after the scene is in view
  for (let i = 0; i < 20 && (await tags(page))[3] !== 'Archived'; i++) await page.clock.runFor(500);
  expect((await tags(page))[3]).toBe('Archived');
});

test('red: a click on an archived tab brings it back', async ({ open }) => {
  const page = await load(open, { before: (p) => mutate(p, 'docs/index.html', 'if (!t.pin) { t.arch = false; t.age = 0; }', 'if (!t.pin) { t.age = 0; }') });
  await press(tab(page, 5));
  await expect(tab(page, 5)).toHaveClass(/\bold\b/);
  await expect(tab(page, 5).locator('em')).not.toHaveText('Just now');
});
