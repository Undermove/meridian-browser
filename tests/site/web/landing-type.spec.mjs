// Poster type: every line of a .fit heading is sized to fill its column, capped in height on wide
// screens.
import { test, expect, mutate } from './fixtures.mjs';
import { landed, goTo, inFlight } from './scene-helpers.mjs';

const PAGE = 'docs/index.html';

// Per heading: its width, the cap, and per line its width and font size.
// .lk-c: copies the scroll connection flies while it runs
const measure = (page) => page.evaluate(() => [...document.querySelectorAll('.fit')].filter((h) => !h.closest('.lk-c')).map((h) => {
  const ls = [...h.children].filter((l) => l.tagName !== 'LK-PT');
  return {
    text: h.textContent.trim().replace(/\s+/g, ' ').slice(0, 20),
    W: h.clientWidth,
    maxh: innerHeight * (+h.dataset.maxh || 0.52),
    lines: ls.map((l) => ({ w: l.getBoundingClientRect().width, size: parseFloat(l.style.fontSize) })),
    m: h.classList.contains('m'),
  };
}));

// Lines come out close to the target, not to the pixel: up to 1.8px off a ~760px column, and lines
// of one heading up to ~0.7% apart, were seen.
const near = (a, b) => Math.abs(a / b - 1) < 0.015;

// Fit runs again on load and when fonts arrive: wait until two reads half a second apart agree.
async function settled(page) {
  let last = '';
  await expect.poll(async () => {
    const now = JSON.stringify(await measure(page));
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [500] }).toBe(true);
  return JSON.parse(last);
}

test('the headline is read as one sentence, its key lines are split into letters', async ({ page }) => {
  await page.goto(PAGE);
  const h1 = page.locator('h1.fit');
  await expect(h1).toHaveAttribute('aria-label', 'Browser for people who loved Arc');
  await expect(h1.locator('> .l')).toHaveCount(3);
  for (const l of await h1.locator('> .l').all()) await expect(l).toHaveAttribute('aria-hidden', 'true');
  // headings without split lines keep their own text for screen readers
  expect(await page.locator('h2.fit[aria-label]').evaluateAll((hs) => hs.filter((h) => !h.closest('.lk-c')).length)).toBe(0);
  const letters = (i) => h1.locator('> .l').nth(i).locator('.c');
  expect(await letters(0).allTextContents()).toEqual([...'Browser']);
  expect(await letters(2).allTextContents()).toEqual([...'loved', ' ', ...'Arc']);
  await expect(letters(1)).toHaveCount(0);
  // fixed letter boxes, in em, so a weight change can't push the neighbours
  for (const w of await page.locator('.c').evaluateAll((cs) => cs.map((c) => c.style.width))) expect(w).toMatch(/^[\d.]+em$/);
});

test('on a narrow screen every line fills its column', async ({ open }) => {
  const page = await open(PAGE, { viewport: { width: 800, height: 900 } });
  const hs = (await settled(page)).filter((h) => h.W);
  expect(hs.length).toBe(9);
  for (const h of hs) {
    expect(h.m, h.text).toBe(false);
    for (const l of h.lines) expect(near(l.w, h.W), `${h.text}: ${l.w} vs ${h.W}`).toBe(true);
  }
});

test('on a wide screen lines fill the column unless the heading would be too tall', async ({ open }) => {
  const page = await open(PAGE, { viewport: { width: 1400, height: 700 } });
  const hs = (await settled(page)).filter((h) => h.W);
  expect(hs.length).toBe(9);
  let capped = 0;
  for (const h of hs) {
    const ratios = h.lines.map((l) => l.w / h.W);
    // every line is scaled by the same factor
    for (const r of ratios) expect(near(r, ratios[0]), `${h.text}: ${ratios}`).toBe(true);
    expect(ratios[0], h.text).toBeLessThan(1.015);
    const height = h.lines.reduce((a, l) => a + l.size * 0.86, 0);
    expect(height, h.text).toBeLessThan(h.maxh + 0.5);
    if (ratios[0] < 0.985) { capped++; expect(height, h.text).toBeCloseTo(h.maxh, 0); }
  }
  expect(capped).toBeGreaterThan(0);
});

test('the lines are fitted again after a resize', async ({ open }) => {
  const page = await open(PAGE, { viewport: { width: 800, height: 900 } });
  const before = (await settled(page))[0];
  await page.setViewportSize({ width: 600, height: 900 });
  await expect.poll(async () => {
    const h = (await measure(page))[0];
    return h.W < before.W && h.lines.every((l) => near(l.w, h.W));
  }).toBe(true);
});

test('at 900px wide, the last width without kinetic mode, lines fill the column uncapped', async ({ open }) => {
  // short, so the wide-screen cap would bite
  const page = await open(PAGE, { viewport: { width: 900, height: 500 } });
  const hs = (await settled(page)).filter((h) => h.W);
  for (const h of hs) for (const l of h.lines) expect(near(l.w, h.W), `${h.text}: ${l.w} vs ${h.W}`).toBe(true);
});

test('a heading fitted while it flies keeps its size', async ({ open }) => {
  const page = await open(PAGE, { viewport: { width: 1280, height: 800 } });
  await landed(page);
  const head = async () => (await measure(page)).find((h) => h.text === 'Download');
  const before = await head();
  // Download's heading is one of crossing 6's parts: it carries the zero-size marks the copies are measured by
  await goTo(page, 6, .5);
  await inFlight(page);
  expect(await page.evaluate(() => document.querySelectorAll('#install h2 > lk-pt').length)).toBeGreaterThan(0);
  // a font arriving now fits every heading again
  await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));
  expect((await head()).lines.map((l) => l.size)).toEqual(before.lines.map((l) => l.size));
});

test('the pointer finds the headline letters after a fit done part-way down the page', async ({ open }) => {
  const page = await open(PAGE, { viewport: { width: 1280, height: 800 } });
  await landed(page);
  await page.evaluate(() => scrollTo({ top: 100, behavior: 'instant' }));
  await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  const c = await page.evaluate(() => { const r = document.querySelector('h1 .c').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(c.x, c.y);
  await expect.poll(() => page.evaluate(() => +document.querySelector('h1 .c').style.fontWeight)).toBe(220);
});

// A page shown inside a hidden frame has no width: the headings are left alone rather than sized
// from 0/0.
const HOST = '__landing_type_host.html';
const host = (page) => page.route('**/' + HOST, (r) => r.fulfill({
  contentType: 'text/html', body: '<!doctype html><iframe style="display:none" src="/docs/index.html"></iframe>',
}));
const hiddenLines = async (page) => {
  const frame = page.frames().find((f) => f.url().endsWith('/docs/index.html'));
  await frame.waitForFunction(() => document.readyState === 'complete');
  return frame.evaluate(() => [...document.querySelectorAll('.fit .l')].map((l) => l.style.fontSize));
};

test('in a hidden frame the headings are not sized', async ({ page }) => {
  await host(page);
  await page.goto(HOST);
  const sizes = await hiddenLines(page);
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s).toBe('');
});

test('the hidden-frame check fails without the zero-width guard', async ({ page }) => {
  await host(page);
  await mutate(page, PAGE, 'if (!W) return;', '');
  await page.goto(HOST);
  expect((await hiddenLines(page)).some((s) => s !== '')).toBe(true);
});
