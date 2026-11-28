// More on the connected scenes (docs/index.html): what the copies look like where they start, and what
// the page is left with when they hand back.
import { test, expect } from './fixtures.mjs';
import { landed, goTo, crossY, inFlight, ended } from './scene-helpers.mjs';

const URL = 'docs/index.html';
const BIG = { viewport: { width: 1280, height: 800 } };
test.describe.configure({ timeout: 90000 });

async function load(open) {
  const page = await open(URL, BIG);
  await landed(page);
  return page;
}

// Every shown holder that clips a strip out of its copy: the holder's width and the copy's.
const cuts = (page) => page.evaluate(() => [...document.querySelectorAll('.lkw > div')]
  .filter((h) => h.style.overflow === 'hidden' && h.querySelector('.lk-c'))
  .map((h) => [parseFloat(h.style.width), parseFloat(h.querySelector('.lk-c').style.width)]));

test('a part paired with one other is flown whole, never as a strip of one', async ({ open }) => {
  const page = await load(open);
  for (let k = 0; k < 7; k++) {
    await goTo(page, k, .5);
    await inFlight(page);
    for (const [holder, copy] of await cuts(page)) expect(holder, `crossing ${k}`).toBeLessThan(copy - 1);
  }
});

// Inline `position` of every element in Download, by index.
const positions = (page) => page.evaluate(() => [...document.querySelectorAll('#install, #install *')].map((e) => e.style.position).join(','));

test('a crossing gives each part back its own inline position', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 6, 0);
  await ended(page);
  const before = await positions(page);
  await goTo(page, 6, .5);
  await inFlight(page);
  // Download's heading has no position of its own: the page makes it relative to measure it
  expect(await page.evaluate(() => document.querySelector('#install h2').style.position)).toBe('relative');
  await goTo(page, 6, 0);
  await ended(page);
  expect(await positions(page)).toBe(before);
});

// Per part of Download with no position of its own: how far its copy lies from it, in px.
const offsets = (page) => page.evaluate(() => Object.fromEntries(['fit', 'say', 'tabs', 'cta', 'brew', 'real'].map((cls) => {
  const el = [...document.querySelectorAll('#install .' + cls)].find((e) => e.offsetWidth && !e.closest('[hidden]'));
  const h = [...document.querySelectorAll('.lkw > div')].find((e) => e.style.display !== 'none' && e.querySelector('.lk-c.' + cls));
  if (!h) return [cls, null];
  const a = h.getBoundingClientRect(), b = el.getBoundingClientRect();
  return [cls, Math.round(Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)))];
})));

test('parts with no position of their own: their copies arrive on them', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 6, .5);
  await inFlight(page);
  await goTo(page, 6, .99);
  // (up to 2px off: .tabs and .brew have a 2px border, and a copy is placed by its part's padding box)
  const want = { fit: 0, say: 0, tabs: 2, cta: 0, brew: 2, real: 0 };
  await expect.poll(async () => Object.entries(await offsets(page)).every(([k, d]) => d !== null && d <= want[k] + 1), { timeout: 15000 }).toBe(true);
});

// After the import the finished window is drawn flat in #imp .flat2d, outside the scene, sides included.
test('after the import, both crossings at the import hide the whole flat window, its sides too', async ({ open }) => {
  const page = await load(open);
  await page.evaluate(() => document.querySelector('#imp').scrollIntoView({ behavior: 'instant' }));
  await page.locator('#imp .btn').click();
  await expect(page.locator('#imp .flat2d')).toHaveCount(1, { timeout: 15000 });
  for (const k of [1, 2]) {
    await goTo(page, k, 0);
    await ended(page);
    await goTo(page, k, .5);
    await inFlight(page);
    const shown = await page.evaluate(() => [...document.querySelectorAll('#imp .flat2d > *')].filter((e) => getComputedStyle(e).opacity !== '0').length);
    expect(shown, `crossing ${k}`).toBe(0);
  }
});

// Opened at the top, every crossing has been seen at rest at its start.
test('from rest at its start, a jump to 70% of a crossing starts from the first scene', async ({ open }) => {
  const page = await load(open);
  const y = await crossY(page, 3, .7);
  await page.evaluate((y) => {
    window.__shown = {};
    const tick = () => {
      for (const h of document.querySelectorAll('.lkw > div')) {
        const c = h.style.display !== 'none' && h.querySelector('.lk-c');
        if (c) for (const k of c.classList) window.__shown[k] = true;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    scrollTo({ top: y, behavior: 'instant' });
  }, y);
  await inFlight(page);
  // Today's tray is the first scene's
  await expect.poll(() => page.evaluate(() => !!window.__shown.tray)).toBe(true);
});

// The next scene can change while it is still far off (it wakes as it comes into view). The copies are
// taken again just before the first part changes face, so they fly as it looks by then.
test('a scene that changes after its crossing starts is flown as it looks by mid-way', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 0, 0);
  await ended(page);
  // one of the spaces scene's two sidebars, marked (its copies carry the mark too)
  await page.evaluate(() => [...document.querySelectorAll('#swp .sb')].filter((e) => getComputedStyle(e).visibility !== 'hidden')[1].setAttribute('data-mark', ''));
  const marked = () => page.evaluate(() => document.querySelectorAll('.lkw [data-mark]').length);
  await goTo(page, 0, .1);
  await inFlight(page);
  expect(await marked()).toBeGreaterThan(0);
  // it goes before any part has changed
  await page.evaluate(() => document.querySelector('#swp [data-mark]').style.setProperty('visibility', 'hidden', 'important'));
  await goTo(page, 0, .6);
  await expect.poll(marked, { timeout: 15000 }).toBe(0);
  await inFlight(page);
});

// The copies are handed back only once each has glided all the way onto its part: handed back short,
// the real part would be seen to hop into place.
test('at the end of a crossing the copies hand back right on their parts', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 6, .5);
  await inFlight(page);
  // Per frame, where the copy of Download's heading is drawn; once the copies are gone, how far the last
  // one drawn lay from the heading.
  const off = page.evaluate(() => new Promise((done) => {
    let last = null;
    const tick = () => {
      const h = [...document.querySelectorAll('.lkw > div')].find((e) => e.style.display !== 'none' && e.querySelector('.lk-c.fit'));
      if (h) last = h.getBoundingClientRect();
      if (!document.querySelector('.lkw').children.length && last) {
        const b = document.querySelector('#install h2').getBoundingClientRect();
        return done(Math.max(Math.abs(last.left - b.left), Math.abs(last.top - b.top), Math.abs(last.width - b.width), Math.abs(last.height - b.height)));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  await goTo(page, 6, 1);
  expect(await off).toBeLessThan(1);
});

// A copy's six side walls are made just before its holder. The spaces scene's floor plate draws its side
// as its face darkened by a filter, so the copy's walls are that darker colour too.
test('a copy\'s sides are its part\'s face darkened the way the real side is', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 0, 0);
  await ended(page);
  const br = await page.evaluate(() => {
    const pl = document.querySelector('#swp .pl');
    pl.setAttribute('data-mark', '');
    return +getComputedStyle(pl, '::after').filter.match(/brightness\(([\d.]+)\)/)[1];
  });
  expect(br).toBeLessThan(1);
  await goTo(page, 0, .5);
  await inFlight(page);
  // its face and its walls, as 0-255 channels (the browser gives the mix as color(srgb …))
  const found = await page.evaluate(() => {
    const rgb = (c) => { const m = c.match(/rgb\(([^)]+)\)/); if (m) return m[1].split(/,\s*/).map(Number); return c.match(/color\(srgb ([^)]+)\)/)[1].split(' ').slice(0, 3).map((v) => v * 255); };
    const h = [...document.querySelectorAll('.lkw > div')].find((e) => e.querySelector('.lk-c[data-mark]'));
    const w = [];
    for (let e = h.previousElementSibling; w.length < 6; e = e.previousElementSibling) w.push(rgb(getComputedStyle(e).backgroundColor));
    return { face: rgb(getComputedStyle(document.querySelector('#swp .pl')).backgroundColor), walls: w };
  });
  for (const w of found.walls) for (let i = 0; i < 3; i++) expect(Math.abs(w[i] - found.face[i] * br)).toBeLessThan(2);
});

// The valuables with nothing to turn into in Download ride inside the box: none is left behind.
test('every valuable in the vault flies, the ones without a partner inside the box', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 6, 0);
  await ended(page);
  const things = await page.evaluate(() => [...document.querySelectorAll('#pvw .it')].filter((e) => e.offsetWidth && getComputedStyle(e).visibility !== 'hidden').length);
  expect(things).toBeGreaterThan(3);
  await goTo(page, 6, .5);
  await inFlight(page);
  expect(await page.evaluate(() => document.querySelectorAll('.lkw .lk-c.it').length)).toBe(things);
});

// Shown copies' boxes on screen, by the class their part has (`cls`) or not.
const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('.lkw > div')]
  .filter((h) => h.style.display !== 'none' && h.querySelector('.lk-c'))
  .map((h) => { const r = h.getBoundingClientRect(); return { cls: [...h.querySelector('.lk-c').classList], x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }));

test('Today into the split view: the tray lies under the hand of cards', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 3, .5);
  await inFlight(page);
  await expect.poll(async () => {
    const all = await boxes(page), tray = all.filter((b) => b.cls.includes('tray') || b.cls.includes('base'));
    if (tray.length !== 1) return false;
    return all.filter((b) => b !== tray[0]).every((b) => b.y < tray[0].y - 100);
  }, { timeout: 15000 }).toBe(true);
});

test('after the import, its page comes to the middle of the screen before it turns into Today', async ({ open }) => {
  const page = await load(open);
  await page.evaluate(() => document.querySelector('#imp').scrollIntoView({ behavior: 'instant' }));
  await page.locator('#imp .btn').click();
  await expect(page.locator('#imp .flat2d')).toHaveCount(1, { timeout: 15000 });
  await goTo(page, 2, 0);
  await ended(page);
  // the scene has come apart, and no part has set off yet
  await goTo(page, 2, .32);
  // the page is held at the middle of the screen (640, 396 at 1280x800), with the rest ringed round it
  await expect.poll(async () => {
    const p = (await boxes(page)).find((b) => b.cls.includes('fpage'));
    return !!p && Math.abs(p.x - 640) < 15 && Math.abs(p.y - 396) < 15;
  }, { timeout: 15000 }).toBe(true);
});

// Where two pieces cut from one part meet, their corners square up (--lkj goes to 0) as they join.
test('the two halves of the AI page square their inner corners as they join', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 4, .5);
  await inFlight(page);
  const joins = () => page.evaluate(() => [...document.querySelectorAll('.lkw > div')]
    .filter((h) => h.style.overflow === 'hidden' && h.querySelector('.lk-c.pp')).map((h) => h.style.getPropertyValue('--lkj')));
  await goTo(page, 4, .985);
  await expect.poll(joins, { timeout: 15000 }).toEqual(['0.000', '0.000']);
});

// After a hard flick the parts glide to their new places; they are never put there in one step.
test('a flick mid-way moves the copies a little per frame, not all at once', async ({ open }) => {
  const page = await load(open);
  await goTo(page, 1, .45);
  await inFlight(page);
  // at rest first (this figure does not move by itself)
  let last = '';
  await expect.poll(async () => {
    const now = await page.evaluate(() => [...document.querySelectorAll('.lkw > div')].map((e) => e.style.transform).join());
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [500], timeout: 15000 }).toBe(true);
  const y = await crossY(page, 1, .75);
  // the largest move of one copy between two frames, over 40 frames from the flick
  const most = await page.evaluate((y) => new Promise((done) => {
    const at = () => new Map([...document.querySelectorAll('.lkw > div')].filter((h) => h.style.display !== 'none' && h.querySelector('.lk-c'))
      .map((h) => { const r = h.getBoundingClientRect(); return [h, [r.left + r.width / 2, r.top + r.height / 2]]; }));
    let last = at(), n = 0, m = 0;
    scrollTo({ top: y, behavior: 'instant' });
    const tick = () => {
      const now = at();
      for (const [h, [x, yy]] of now) { const p = last.get(h); if (p) m = Math.max(m, Math.hypot(x - p[0], yy - p[1])); }
      last = now;
      if (++n < 40) requestAnimationFrame(tick); else done(m);
    };
    requestAnimationFrame(tick);
  }), y);
  // (about 50px a frame at most; put in place in one step, over 300)
  expect(most).toBeLessThan(150);
});
