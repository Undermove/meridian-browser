import { test, expect, mutate } from './fixtures.mjs';

const FILE = 'site/lab/index.html';
const IDS = ['current', '01-prime-meridian', '02-the-window', '03-moving-day', '04-spaces', '05-command'];
const NAMES = ['Current', 'Prime Meridian', 'The Window', 'Moving Day', 'Spaces', 'Command'];
const SRC = ['../../docs/index.html', ...IDS.slice(1).map((id) => `${id}.html`)];

const concepts = (page) => page.locator('#concepts button');
const sizes = (page) => page.locator('#sizes button');

async function expectConcept(page, i) {
  for (let n = 0; n < IDS.length; n++) await expect(concepts(page).nth(n)).toHaveAttribute('aria-pressed', String(n === i));
  await expect(page.locator('#note strong')).toHaveText(NAMES[i] + '.');
  await expect(page.locator('#open')).toHaveAttribute('href', SRC[i]);
  await expect(page.locator('#view')).toHaveAttribute('src', SRC[i]);
  await expect(page.locator('#missing')).not.toHaveClass(/\bon\b/);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#' + IDS[i]);
}

async function expectSize(page, i, width) {
  for (let n = 0; n < 4; n++) await expect(sizes(page).nth(n)).toHaveAttribute('aria-pressed', String(n === i));
  if (i) await expect(page.locator('#stage')).toHaveClass(/\bsized\b/);
  else await expect(page.locator('#stage')).not.toHaveClass(/\bsized\b/);
  // the width animates for 0.35 s
  await expect.poll(() => page.locator('#frame').evaluate((f) => f.getBoundingClientRect().width)).toBe(width);
}

// Answers the lab's HEAD check for one concept file; the page itself still loads.
async function head(page, file, answer) {
  await page.route((url) => url.pathname === `/site/lab/${file}`, (route) =>
    route.request().method() === 'HEAD' ? answer(route) : route.fallback());
}

test('with no hash the lab opens the live page at full width', async ({ open }) => {
  const page = await open(FILE, { viewport: { width: 1280, height: 800 } });
  await expect(concepts(page)).toHaveText(IDS.map((_, i) => `${i}${NAMES[i]}`));
  await expect(sizes(page)).toHaveText(['Full', '1024', '768', '390']);
  await expectConcept(page, 0);
  await expect(page.locator('#note')).toHaveText('Current. The live page, for comparison. Built from site/pages/index.html.');
  await expectSize(page, 0, 1280);
});

test('a hash opens its concept; an unknown one falls back to the first', async ({ open }) => {
  const page = await open(FILE + '#04-spaces');
  await expectConcept(page, 4);
  const other = await open(FILE + '#nope');
  await expectConcept(other, 0);
});

test('clicking a concept shows it in the frame', async ({ page }) => {
  await page.goto(FILE);
  for (const i of [5, 2, 0]) {
    await concepts(page).nth(i).click();
    await expectConcept(page, i);
  }
});

test('the width buttons size the frame without reloading it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(FILE + '#03-moving-day');
  await expectConcept(page, 3);
  const loads = [];
  page.on('request', (r) => { if (r.url().endsWith('03-moving-day.html')) loads.push(r.method()); });
  for (const [i, w] of [[1, 1024], [2, 768], [3, 390], [0, 1280]]) {
    await sizes(page).nth(i).click();
    await expectSize(page, i, w);
  }
  expect(loads).toEqual([]);
  expect(await page.evaluate(() => location.hash)).toBe('#03-moving-day');
});

test('changing the hash switches the concept; a hash for the same one does nothing', async ({ page }) => {
  await page.goto(FILE);
  await expectConcept(page, 0);
  await page.evaluate(() => { location.hash = '#05-command'; });
  await expectConcept(page, 5);
  await page.evaluate(() => { location.hash = '#01-prime-meridian'; });
  await expectConcept(page, 1);
  await concepts(page).nth(0).click();
  await expectConcept(page, 0);
  // unknown ids map to the first concept, which is already shown, so the hash is left as typed
  await page.evaluate(() => { location.hash = '#nope'; });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#nope');
  await expect(page.locator('#view')).toHaveAttribute('src', SRC[0]);
  await expect(concepts(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
});

async function keys(page) {
  await page.keyboard.press('ArrowRight');
  await expectConcept(page, 1);
  await page.keyboard.press('ArrowLeft');
  await expectConcept(page, 0);
  await page.keyboard.press('ArrowLeft');
  await expectConcept(page, 5);
  await page.keyboard.press('ArrowRight');
  await expectConcept(page, 0);
}

test('arrows step through the concepts and wrap', async ({ page }) => {
  await page.goto(FILE);
  await expectConcept(page, 0);
  await keys(page);
});

test('the arrow test fails when the step changes', async ({ page }) => {
  await mutate(page, FILE, '(at + 1) % CONCEPTS.length', '(at + 2) % CONCEPTS.length');
  await page.goto(FILE);
  await expectConcept(page, 0);
  await expect(keys(page)).rejects.toThrow();
});

test('digits jump, W cycles the width, other keys and modified keys do nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(FILE);
  await expectConcept(page, 0);
  await page.keyboard.press('3');
  await expectConcept(page, 3);
  await page.keyboard.press('0');
  await expectConcept(page, 0);
  await page.keyboard.press('5');
  await expectConcept(page, 5);
  // any of these that acted would leave a different concept or width
  for (const k of ['6', 'x', 'Meta+ArrowRight', 'Control+ArrowRight', 'Alt+ArrowRight', 'Control+2', 'Meta+w']) await page.keyboard.press(k);
  await expectConcept(page, 5);
  await expectSize(page, 0, 1280);
  await page.keyboard.press('w');
  await expectSize(page, 1, 1024);
  await page.keyboard.press('Shift+W');
  await expectSize(page, 2, 768);
  await page.keyboard.press('w');
  await expectSize(page, 3, 390);
  await page.keyboard.press('w');
  await expectSize(page, 0, 1280);
  await expectConcept(page, 5);
});

test('a concept whose file is missing shows "Not built yet"', async ({ page }) => {
  await head(page, '02-the-window.html', (r) => r.fulfill({ status: 404 }));
  await page.goto(FILE);
  await expectConcept(page, 0);
  await concepts(page).nth(2).click();
  await expect(page.locator('#missing')).toHaveClass(/\bon\b/);
  await expect(page.locator('#missing')).toBeVisible();
  await expect(page.locator('#view')).toHaveAttribute('src', 'about:blank');
  await expect(concepts(page).nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#open')).toHaveAttribute('href', '02-the-window.html');
  await page.keyboard.press('ArrowRight');
  await expectConcept(page, 3);
  await expect(page.locator('#missing')).toBeHidden();
});

test('a concept whose check fails to connect counts as missing', async ({ page }) => {
  await head(page, '01-prime-meridian.html', (r) => r.abort('connectionrefused'));
  await page.goto(FILE + '#01-prime-meridian');
  await expect(page.locator('#missing')).toHaveClass(/\bon\b/);
  await expect(page.locator('#view')).toHaveAttribute('src', 'about:blank');
});

test('on a narrow screen the chosen concept is scrolled into the bar', async ({ open }) => {
  const page = await open(FILE + '#05-command', { viewport: { width: 390, height: 800 } });
  await expectConcept(page, 5);
  const inBar = (i) => page.evaluate((i) => {
    const bar = document.getElementById('concepts').getBoundingClientRect();
    const b = document.querySelectorAll('#concepts button')[i].getBoundingClientRect();
    return b.left >= bar.left - 0.5 && b.right <= bar.right + 0.5;
  }, i);
  // the bar is too narrow for all of them, so the last one starts out of view
  expect(await page.locator('#concepts').evaluate((c) => c.scrollWidth > c.clientWidth)).toBe(true);
  await expect.poll(() => inBar(5)).toBe(true);
  await page.keyboard.press('0');
  await expectConcept(page, 0);
  await expect.poll(() => inBar(0)).toBe(true);
});

test('keys that do nothing do not reload the frame', async ({ page }) => {
  await page.goto(FILE + '#03-moving-day');
  await expectConcept(page, 3);
  const loads = [];
  page.on('request', (r) => { if (r.url().endsWith('03-moving-day.html')) loads.push(r.method()); });
  for (const k of ['x', '6', 'Enter', 'Meta+ArrowRight']) await page.keyboard.press(k);
  // a key that acts, so a stray reload would have been asked for by now
  await page.keyboard.press('w');
  await expect(sizes(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
  expect(loads).toEqual([]);
});
