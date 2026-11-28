// The connected scenes on the landing page (docs/index.html): scrolling from one feature to the next
// hands every part of one scene to flying copies (.lkw), which turn into the parts of the next scene.
import { test, expect, mutate } from './fixtures.mjs';
import { landed, crossY, goTo, state, inFlight, ended, morphs, strips, swipeTo } from './scene-helpers.mjs';

const URL = 'docs/index.html';
const BIG = { viewport: { width: 1280, height: 800 } };

async function load(open, opts = BIG) {
  const page = await open(URL, opts);
  await landed(page);
  return page;
}

const paired = (page, sel) => page.evaluate((sel) => document.querySelector(sel).hasAttribute('data-lk'), sel);
const opacity = (page, sel) => page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).opacity, sel);

// The import (#imp): one press sends Arc's tabs over; the scene then finishes (.fin) and is redrawn flat
// (.flat2d).
async function importDone(page) {
  await page.evaluate(() => document.querySelector('#imp').scrollIntoView({ behavior: 'instant' }));
  await page.locator('#imp .btn').click();
  await expect(page.locator('#imp')).toHaveClass(/\bfin\b/, { timeout: 15000 });
  await expect(page.locator('#imp .flat2d')).toHaveCount(1, { timeout: 15000 });
}

// One crossing, played forward and back: copies take over from both scenes, the parts named in `pairs`
// fly, the parts morph, and at each end the real scene is handed back whole.
async function playCrossing(page, k, { pairs = [], during } = {}) {
  await goTo(page, k, 0);
  await ended(page);
  await goTo(page, k, .5);
  await inFlight(page);
  // the real parts are out of sight while their copies fly
  for (const sel of pairs) {
    expect(await paired(page, sel), sel).toBe(true);
    expect(await opacity(page, sel), sel).toBe('0');
  }
  await morphs(page);
  if (during) await during();
  await goTo(page, k, 1);
  await ended(page);
  for (const sel of pairs) expect(await opacity(page, sel), sel).not.toBe('0');
  // back again: the same crossing in reverse ends on the first scene
  await goTo(page, k, .5);
  await inFlight(page);
  await morphs(page);
  await goTo(page, k, 0);
  await ended(page);
  for (const sel of pairs) expect(await opacity(page, sel), sel).not.toBe('0');
}

test.describe('connected scenes at 1280x800', () => {
  test.describe.configure({ timeout: 90000 });

  test('crossing 0: the hero window becomes the spaces window', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 0, { pairs: ['#asm .pl', '#swp .pl', '#asm .sbase', '#swp .pgw'] });
  });

  test('crossing 1: spaces into the import, before the import', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 1, { pairs: ['#swp .pl', '#imp .btn', '#imp .sb.src', '#imp .sb.arc'] });
  });

  test('crossing 1: spaces into the finished import', async ({ open }) => {
    const page = await load(open);
    await importDone(page);
    await playCrossing(page, 1, { pairs: ['#imp .flat2d .fwin', '#imp .flat2d .fpage'] });
  });

  test('crossing 2: the import into Today holds the Today clock', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 2, {
      pairs: ['#imp .btn', '#tdy .tray'],
      during: async () => expect((await state(page)).tdyHold).toBe(true),
    });
    expect((await state(page)).tdyHold).toBe(false);
  });

  test('crossing 2: the finished import circles its page before it becomes Today', async ({ open }) => {
    const page = await load(open);
    await importDone(page);
    await playCrossing(page, 2, { pairs: ['#imp .flat2d .fpage', '#tdy .tray'] });
  });

  test('crossing 3: Today into the split view', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 3, {
      pairs: ['#tdy .tray', '#spl .base', '#pl', '#pr'],
      during: async () => expect((await state(page)).tdyHold).toBe(true),
    });
  });

  test('crossing 4: the split view into the AI window', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 4, { pairs: ['#spl .base', '#aiw .base', '#aipg'] });
  });

  test('crossing 5: the AI window into the vault; trackers are called off', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 5, {
      pairs: ['#aiw .base', '#pvw .base', '#pvw .pp'],
      during: async () => {
        const s = await state(page);
        expect(s.pvwHold).toBe(true);
        expect(await page.locator('#pvw .ad').count()).toBe(0);
      },
    });
    expect((await state(page)).pvwHold).toBe(false);
  });

  test('crossing 6: trackers in the air when it starts are called off', async ({ open }) => {
    const page = await load(open);
    await goTo(page, 6, 0);
    await ended(page);
    // A click on the vault throws a volley of trackers; each flies for at least 750 ms.
    await page.locator('#pvw').dispatchEvent('click');
    await expect.poll(() => page.locator('#pvw .ad').count()).toBeGreaterThan(0);
    await goTo(page, 6, .5);
    await inFlight(page);
    expect((await state(page)).pvwHold).toBe(true);
    expect(await page.locator('#pvw .ad').count()).toBe(0);
  });

  test('crossing 6: the vault into Download, and the band between them fades', async ({ open }) => {
    const page = await load(open);
    await playCrossing(page, 6, {
      pairs: ['#pvw .pp', '#install .real'],
      during: async () => {
        expect((await state(page)).pvwHold).toBe(true);
        await expect.poll(async () => (await state(page)).band, { timeout: 15000 }).toBe('0');
      },
    });
    // at rest the band is left to the stylesheet
    expect((await state(page)).band).toBe('');
  });
});

const sidebars = (page) => page.evaluate(() => [...document.querySelectorAll('#swp .sb')].filter((e) => getComputedStyle(e).visibility !== 'hidden').length);

test.describe('connected scenes: parts with no partner are cut into strips', () => {
  test.describe.configure({ timeout: 90000 });

  test('one sidebar left in the spaces scene is cut in two for Arc and Meridian', async ({ open }) => {
    const page = await load(open);
    await swipeTo(page, 0);
    expect(await sidebars(page)).toBe(1);
    // the parts are read when a crossing starts: start this one after the swipe
    await goTo(page, 1, 0);
    await ended(page);
    await goTo(page, 1, .5);
    await inFlight(page);
    expect(await strips(page, 'sb')).toBe(2);
    await goTo(page, 1, 1);
    await ended(page);
  });

  test('three sidebars in the spaces scene: a hero page is cut in two to meet them', async ({ open }) => {
    const page = await load(open);
    await swipeTo(page, 2);
    expect(await sidebars(page)).toBe(3);
    await goTo(page, 0, 0);
    await ended(page);
    await goTo(page, 0, .5);
    await inFlight(page);
    expect(await strips(page, 'pg')).toBe(2);
    await goTo(page, 0, 0);
    await ended(page);
  });

  test('with two sidebars nothing is cut in crossing 1', async ({ open }) => {
    const page = await load(open);
    expect(await sidebars(page)).toBe(2);
    await goTo(page, 1, .5);
    await inFlight(page);
    expect(await strips(page, 'sb')).toBe(0);
  });
});

test.describe('connected scenes: interruptions', () => {
  test.describe.configure({ timeout: 90000 });

  test('a resize mid-way rebuilds the copies for the new layout', async ({ page }) => {
    await page.setViewportSize(BIG.viewport);
    await page.goto(URL);
    await landed(page);
    await goTo(page, 3, .5);
    await inFlight(page);
    await page.evaluate(() => { window.oldCopy = document.querySelector('.lkw > div'); });
    await page.setViewportSize({ width: 1300, height: 800 });
    await expect.poll(() => page.evaluate(() => !window.oldCopy.isConnected)).toBe(true);
    // still half-way, so a new set takes over
    await inFlight(page);
  });

  test('turning kinetic off mid-way hands the real scenes back at once', async ({ page }) => {
    await page.setViewportSize(BIG.viewport);
    await page.goto(URL);
    await landed(page);
    await goTo(page, 6, .5);
    await inFlight(page);
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(page.locator('html')).not.toHaveClass(/\bkin\b/);
    await ended(page);
    expect((await state(page)).band).toBe('');
    expect((await state(page)).pvwHold).toBe(false);
    await page.setViewportSize(BIG.viewport);
    await expect(page.locator('html')).toHaveClass(/\bkin\b/);
  });

  test('a jump far down the page ends the crossing in flight', async ({ open }) => {
    const page = await load(open);
    await goTo(page, 1, .5);
    await inFlight(page);
    await page.evaluate(() => document.querySelector('#faq').scrollIntoView({ behavior: 'instant' }));
    await ended(page);
  });

  test('just past the end it was handed back at, the crossing does not restart', async ({ open }) => {
    const page = await load(open);
    await goTo(page, 4, .5);
    await inFlight(page);
    await goTo(page, 4, 1);
    await ended(page);
    // .97 is inside the guard band at the far end (the copies wait for < .955)
    await goTo(page, 4, .97);
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))));
    expect((await state(page)).copies).toBe(0);
    await goTo(page, 4, .9);
    await inFlight(page);
    // and the same at the near end
    await goTo(page, 4, 0);
    await ended(page);
    await goTo(page, 4, .03);
    await page.waitForFunction(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))));
    expect((await state(page)).copies).toBe(0);
    await goTo(page, 4, .1);
    await inFlight(page);
  });
});

// Init scripts: scroll to y as soon as the page is parsed (before the first frame of the scroll
// connection), and record from then on the classes of every copy ever shown (window.__shown).
const openedAt = (y) => [`window.__Y = ${y};`, () => {
  window.__shown = {};
  const tick = () => {
    for (const h of document.querySelectorAll('.lkw > div')) {
      const c = h.style.display !== 'none' && h.querySelector('.lk-c');
      if (c) for (const k of c.classList) window.__shown[k] = true;
    }
    requestAnimationFrame(tick);
  };
  addEventListener('DOMContentLoaded', () => { scrollTo({ top: window.__Y, behavior: 'instant' }); requestAnimationFrame(tick); });
}];

// Opened part-way through a crossing (a reload, a link), the page has never seen that crossing at rest:
// it starts from the nearer end. Recorded from the first frame: which scene's copies were ever shown.
test.describe('connected scenes: opened part-way through a crossing', () => {
  test.describe.configure({ timeout: 90000 });
  for (const [r, shows, never] of [[.3, 'tray', 'base'], [.7, 'base', 'tray']]) {
    test(`at ${r * 100}% of Today -> split, only the ${r < .5 ? 'first' : 'second'} scene's parts are shown`, async ({ open }) => {
      const probe = await load(open);
      const y = await crossY(probe, 3, r);
      const page = await open(URL, {
        ...BIG,
        init: openedAt(y),
      });
      await inFlight(page);
      await expect.poll(() => page.evaluate((c) => !!window.__shown[c], shows)).toBe(true);
      expect(await page.evaluate((c) => !!window.__shown[c], never)).toBe(false);
    });
  }
});

// The tests above fail when the code they check changes: each serves a broken copy of the page and
// shows that the assertion above would no longer hold.
test.describe('connected scenes: mutations', () => {
  test.describe.configure({ timeout: 90000 });

  test('if the real parts were not hidden, they would show under their copies', async ({ open }) => {
    const page = await open(null, BIG);
    await mutate(page, URL, "cur.hidden.forEach((e) => e.classList.add('lk-hide'));", '');
    await page.goto(URL);
    await landed(page);
    await goTo(page, 0, .5);
    await expect.poll(async () => (await state(page)).copies).toBeGreaterThan(0);
    expect(await paired(page, '#asm .pl')).toBe(true);
    expect(await opacity(page, '#asm .pl')).not.toBe('0');
  });

  test('if only crossing 2 held the Today clock, crossing 3 would let it run', async ({ open }) => {
    const page = await open(null, BIG);
    await mutate(page, URL, "tdy.toggleAttribute('data-hold', i === 2 || i === 3)", "tdy.toggleAttribute('data-hold', i === 2)");
    await page.goto(URL);
    await landed(page);
    await goTo(page, 3, .5);
    await inFlight(page);
    expect((await state(page)).tdyHold).toBe(false);
  });

  test('if a crossing opened part-way always started from its first end, 70% in would show the first scene', async ({ open }) => {
    const probe = await load(open);
    const y = await crossY(probe, 3, .7);
    const page = await open(null, {
      ...BIG,
      init: openedAt(y),
    });
    await mutate(page, URL, 'shown = rested[k] != null ? rested[k] : real < .5 ? 0 : 1;', 'shown = rested[k] != null ? rested[k] : 0;');
    await page.goto(URL);
    await expect.poll(() => page.evaluate(() => !!window.__shown.tray)).toBe(true);
  });
});
