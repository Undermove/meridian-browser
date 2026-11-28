// The landing page's fallbacks (docs/index.html): what the scenes do in layouts and browsers the page
// itself never produces. Each test brings the odd case about with injected CSS, a stubbed browser API or a
// changed piece of markup, and checks what the fallback gives.
//
// CSS keyed on [data-lk] applies only during a crossing: the page marks the parts it picked as visible
// with data-lk, then measures them and makes their copies.
import fs from 'node:fs';
import { test, expect, mutate } from './fixtures.mjs';
import { load as loadNarrow, landed, goTo, state, inFlight, ended, strips, swipeTo } from './scene-helpers.mjs';

const URL = 'docs/index.html';
const BIG = { width: 1280, height: 800 };

test.describe.configure({ timeout: 90000 });

// A wide page (kinetic mode) with `css` in force before the first frame of the scroll connection, which
// reads once which scenes are pinned. `errors` collects uncaught errors.
async function wide(open, { css = '', init = [], before } = {}) {
  const style = `addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(css)} })));`;
  const page = await open(null, { viewport: BIG, init: [style, ...[].concat(init)] });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  if (before) await before(page);
  await page.goto(URL);
  await landed(page);
  return page;
}

// The copies of the parts that have class `cls`: the copy's own inline style and its holder's.
const copies = (page, cls) => page.evaluate((cls) => [...document.querySelectorAll('.lkw > div')]
  .map((h) => [h, h.querySelector('.lk-c')]).filter(([, c]) => c && c.classList.contains(cls))
  .map(([h, c]) => ({ width: c.style.width, background: c.style.background, radius: c.style.borderRadius, holderRadius: h.style.borderRadius, strip: h.style.overflow === 'hidden', holderWidth: parseFloat(h.style.width) })), cls);

// Runs `fn` in the page on every frame from now on; its results pile up in window.__seen.
const record = (page, fn) => page.evaluate(`(() => {
  const f = ${fn};
  window.__seen = [];
  const tick = () => { window.__seen.push(f()); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`);
const seen = (page) => page.evaluate(() => window.__seen);

// The widths of the Download heading's copy (made content-box, with padding) and of its line's (made inline).
async function widths(open, before) {
  const page = await wide(open, { before, css: '#install .say { display: inline !important } #install h2 { box-sizing: content-box !important; padding: 0 10.25px !important }' });
  await goTo(page, 6, .5);
  await inFlight(page);
  const want = await page.evaluate(() => {
    const h = document.querySelector('#install h2'), say = document.querySelector('#install .say');
    return { h2: Math.ceil((parseFloat(getComputedStyle(h).width) + 20.5) * 100) / 100 + 'px', say: say.offsetWidth + 'px' };
  });
  return {
    want, sayWidth: await page.evaluate(() => getComputedStyle(document.querySelector('#install .say')).width),
    h2: (await copies(page, 'fit')).map((c) => c.width), say: (await copies(page, 'say')).map((c) => c.width),
  };
}

// Today down to its tray and pinned tab, the split view to its floor and the Split view switch: one card in
// the hand. Returns how far the card's middle lies from the screen's, once per frame.
async function loneCard(open, before) {
  const page = await wide(open, { before, css: '#tdy .tb:not(.pin), #tdy .tb.pin em, #pl, #pr, #grip, #pk { visibility: hidden !important }' });
  await record(page, () => {
    const h = [...document.querySelectorAll('.lkw > div')].find((e) => e.style.display !== 'none' && e.querySelector('.lk-c.pin, .lk-c.tog'));
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return Math.round(r.left + r.width / 2 - innerWidth / 2);
  });
  await goTo(page, 3, .5);
  await inFlight(page);
  return page;
}

// Crossing 0 with the hero's sidebar (it carries the rows as riders) and the spaces scene's sidebars
// squashed to a point. Per frame: riders shown, morph bodies drawn as a point, and what came out blank.
async function squashed(open, before) {
  const page = await wide(open, { before, css: '#asm .sbase[data-lk], #swp .sb[data-lk] { transform: scale(0) !important; transition: none !important; animation: none !important }' });
  await record(page, () => {
    const out = { riders: 0, points: 0, bad: [] };
    for (const e of document.querySelectorAll('.lkw > div')) {
      if (e.style.display === 'none') continue;
      const c = e.querySelector('.lk-c');
      // a transform or corner with NaN or Infinity in it is dropped by the browser and stays ''
      if (c) { if (c.classList.contains('sp')) { out.riders++; if (!e.style.transform) out.bad.push('rider transform'); } continue; }
      // the plain bodies of the morph are 100px squares; the squashed pair's is drawn as a point
      if (e.style.width !== '100px') continue;
      if (/matrix\(0, 0, 0, 0,/.test(e.style.transform)) out.points++;
      if (!e.style.borderRadius) out.bad.push('body corners');
    }
    return out;
  });
  await goTo(page, 0, .5);
  await inFlight(page);
  await expect.poll(async () => (await seen(page)).some((f) => f.points > 0), { timeout: 15000 }).toBe(true);
  return seen(page);
}

// Crossing 0 with no part painted (no colour, no gradient). Per frame: whether a copy is part-way
// through fading into its partner, and how many plain bodies are drawn. Waits for the first.
async function unpainted(open, before) {
  const page = await wide(open, { before, css: '[data-lk] { background: none !important }' });
  await record(page, () => {
    const shown = [...document.querySelectorAll('.lkw > div')].filter((e) => e.style.display !== 'none');
    return {
      changing: shown.some((e) => e.querySelector('.lk-c') && +e.style.opacity > 0 && +e.style.opacity < 1),
      bodies: shown.filter((e) => !e.children.length).length,
    };
  });
  await goTo(page, 0, .5);
  await inFlight(page);
  await expect.poll(async () => (await seen(page)).some((f) => f.changing), { timeout: 15000 }).toBe(true);
  return seen(page);
}

// A browser that calls requestAnimationFrame callbacks without a time. Only the scroll connection's loop
// (named frame) gets none: the hint and the hero use the time they are given.
const NO_TIME = () => {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(cb.name === 'frame' ? () => cb() : cb);
};

test.describe('the flying copies of odd parts', () => {
  test('a chip with no plain colour behind it flies bare', async ({ open }) => {
    // oklch is kept as is (not as rgb), so it does not count as a plain colour; every other ancestor of a
    // row is transparent
    const page = await wide(open, { css: '#imp .sb.src { background-color: oklch(.9 .05 300) !important }' });
    await goTo(page, 2, .5);
    await inFlight(page);
    const rows = await copies(page, 'rw');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.background).toBe('');
    expect(page.errors).toEqual([]);
  });

  test('a chip with small corners gets round ones on its backing', async ({ open }) => {
    const page = await wide(open, { css: '#imp .rw { border-radius: 4px !important }' });
    await goTo(page, 2, .5);
    await inFlight(page);
    const rows = await copies(page, 'rw');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.radius).toBe('16px');
      expect(r.background).toMatch(/^linear-gradient\(/);
    }
  });

  test('a part hidden as its crossing starts is left out, and so is its partner', async ({ open }) => {
    // #asm .pl is the first scene's side of a pair, #swp .pgw the second scene's side of another
    const page = await wide(open, { css: '#asm .pl[data-lk], #swp .pgw[data-lk] { visibility: hidden !important }' });
    await goTo(page, 0, .5);
    await inFlight(page);
    const r = await page.evaluate(() => ({
      pl: document.querySelectorAll('.lkw .lk-c.pl').length,
      pgw: document.querySelectorAll('.lkw .lk-c.pgw').length,
      pg: document.querySelectorAll('.lkw .lk-c.pg').length,
      sbase: document.querySelectorAll('.lkw .lk-c.sbase').length,
      // the measuring marks of the partners that were made and then dropped
      marks: [document.querySelector('#swp .pl'), [...document.querySelectorAll('#asm .pg')].pop()].map((e) => e.querySelectorAll(':scope > lk-pt').length),
    }));
    // the hero's other page still flies (to a spare sidebar), as does its sidebar
    expect(r).toEqual({ pl: 0, pgw: 0, pg: 1, sbase: 1, marks: [0, 0] });
    expect(page.errors).toEqual([]);
  });

  test('a copy gets its part\'s width: the exact one for a content-box part, offsetWidth for an inline one', async ({ open }) => {
    const w = await widths(open);
    // (an inline part has no width of its own)
    expect(w.sayWidth).toBe('auto');
    expect(w.h2).toEqual([w.want.h2]);
    expect(w.say).toEqual([w.want.say]);
  });

  for (const [radius, corner] of [['50%', 'half its shorter side'], ['0px', 'square']]) {
    test(`a part with ${radius} corners cut in two: its pieces' outer corners are ${corner}`, async ({ open }) => {
      const page = await wide(open, { css: `#aipg { border-radius: ${radius} !important }` });
      await goTo(page, 4, .5);
      await inFlight(page);
      // #aipg is 760 x 360: a half is 380 x 360. Where the halves meet the corners square up as they join.
      const r = radius === '0px' ? '0px' : '180px', join = `calc(var(--lkj, 1) * ${r})`;
      expect((await copies(page, 'pp')).filter((c) => c.strip).map((c) => c.holderRadius)).toEqual([`${r} ${join} ${join} ${r}`, `${join} ${r} ${r} ${join}`]);
    });
  }

  // The colour of the copies' sides: the part's surface darkened.
  const sides = (page) => page.evaluate(() => [...document.querySelectorAll('.lkw > div')]
    .filter((e) => !e.children.length && /color-mix/.test(e.style.background)).map((e) => e.style.background));

  test('a floor plate with no --ink gets dark brown sides', async ({ open }) => {
    const page = await wide(open, { css: '#asm .pl { --ink: initial !important }' });
    await goTo(page, 0, .5);
    await inFlight(page);
    expect(await sides(page)).toContain('color-mix(in srgb, rgb(27, 10, 3) 100%, rgb(0, 0, 0) 0%)');
  });

  test('a gradient part with no rgb() colour in it gets black sides', async ({ open }) => {
    const page = await wide(open, { css: '#aipg[data-lk] { background: linear-gradient(oklch(.9 .05 90), oklch(.8 .05 90)) !important }' });
    await goTo(page, 4, .5);
    await inFlight(page);
    // 6 for each of #aipg's two halves
    expect((await sides(page)).filter((b) => b === 'color-mix(in srgb, rgb(0, 0, 0) 62%, rgb(0, 0, 0) 38%)').length).toBe(12);
  });
});

test.describe('pairing parts up', () => {
  test('two spare parts on each side are paired whole, none cut', async ({ open }) => {
    // three sidebars and no page card in the spaces scene: the hero's two pages and two of the sidebars are left
    const page = await wide(open, { css: '#swp .pgw { visibility: hidden !important }' });
    await swipeTo(page, 2);
    // the parts are read as a crossing starts: start this one from rest, after the swipe
    await goTo(page, 0, 0);
    await ended(page);
    await goTo(page, 0, .5);
    await inFlight(page);
    expect(await strips(page, 'pg')).toBe(0);
    expect(await strips(page, 'sb')).toBe(0);
    expect(await page.evaluate(() => [...document.querySelectorAll('#asm .pg, #swp .sb')].map((e) => e.hasAttribute('data-lk')))).toEqual([true, true, true, true, true]);
  });

  test('with the AI page hidden, the split view\'s pages are not paired with it', async ({ open }) => {
    const page = await wide(open, { css: '#aipg { visibility: hidden !important }' });
    await goTo(page, 4, .5);
    await inFlight(page);
    expect(await page.evaluate(() => ['#aipg', '#pl', '#pr'].map((s) => document.querySelector(s).hasAttribute('data-lk')))).toEqual([false, true, true]);
    expect(page.errors).toEqual([]);
  });

  test('a hand of one card holds it in the middle of the screen', async ({ open }) => {
    const page = await loneCard(open);
    await expect.poll(async () => (await seen(page)).pop(), { timeout: 15000 }).toBe(0);
  });
});

test.describe('a scene with nothing to show', () => {
  test('a crossing from a scene with no part showing makes no copies and throws nothing', async ({ open }) => {
    const page = await wide(open, { css: '#swp .scene * { visibility: hidden !important }' });
    await goTo(page, 0, .5);
    await record(page, () => document.querySelectorAll('.lkw .lk-c').length);
    await expect.poll(async () => (await seen(page)).length, { timeout: 15000 }).toBeGreaterThan(30);
    expect(new Set(await seen(page))).toEqual(new Set([0]));
    expect(page.errors).toEqual([]);
  });
});

test.describe('degenerate shapes', () => {
  test('a part squashed flat still has its riders and the morph its corners', async ({ open }) => {
    const frames = await squashed(open);
    expect(frames.some((f) => f.riders > 0)).toBe(true);
    expect(frames.flatMap((f) => f.bad)).toEqual([]);
  });

  test('with no part painted, nothing but the copies is drawn while they change', async ({ open }) => {
    expect((await unpainted(open)).reduce((n, f) => n + f.bodies, 0)).toBe(0);
  });
});

test.describe('measuring the crossings', () => {
  test('frames without a time still play a crossing to its end', async ({ open }) => {
    const page = await wide(open, { init: NO_TIME });
    await goTo(page, 0, .5);
    await inFlight(page);
    await goTo(page, 0, 1);
    await ended(page);
  });

  test('a scene that is not pinned is measured from its section', async ({ open }) => {
    const page = await wide(open, { css: '#spaces > .in { position: relative !important }' });
    for (const [k, r] of [[0, .5], [0, 1], [1, .5], [1, 0], [0, .5], [0, 0]]) {
      await goTo(page, k, r);
      if (r > 0 && r < 1) await inFlight(page); else await ended(page);
    }
    expect(page.errors).toEqual([]);
  });

  test('two sections lying over each other start no crossing', async ({ open }) => {
    // Download drawn two screens up, over the Private scene: crossing 6 has no distance to cover.
    // (0/0 would give NaN, which starts nothing either: this pins that the page stays still and throws nothing.)
    const page = await wide(open, { css: '#install { position: relative; top: -200vh }' });
    const at = await page.evaluate(() => {
      const p = document.querySelector('#private'), H = innerHeight;
      scrollTo({ top: p.getBoundingClientRect().bottom + scrollY - 1.2 * H, behavior: 'instant' });
      return { priv: p.getBoundingClientRect().top / H, install: document.querySelector('#install').getBoundingClientRect().top / H };
    });
    // the Private section is past the top by more than the lead (.12 of a screen), Download further
    expect(at.priv).toBeLessThan(-.12);
    expect(at.install).toBeLessThan(-.12);
    await record(page, () => document.querySelector('.lkw').children.length + document.querySelectorAll('.lk-hide').length);
    await expect.poll(async () => (await seen(page)).length, { timeout: 15000 }).toBeGreaterThan(30);
    expect(new Set(await seen(page))).toEqual(new Set([0]));
    expect(page.errors).toEqual([]);
  });
});

test.describe('where a copy starts', () => {
  // #keys moved out of its pinned scene, into its section or out of every section: its copy lies on it
  // and stays on it as the page scrolls on.
  for (const [where, move] of [['its section', (k) => document.querySelector('#split').append(k)], ['the page', (k) => document.body.append(k)]]) {
    test(`a part outside its scene, in ${where}`, async ({ open }) => {
      // (out of its scene the switch is a plain button, and a copy is placed by its part's padding box)
      const page = await wide(open, { css: '#keys { border: 0 !important }' });
      await page.evaluate(`(${move})(document.querySelector('#keys'))`);
      const off = () => page.evaluate(() => {
        const h = [...document.querySelectorAll('.lkw > div')].find((e) => e.style.display !== 'none' && e.querySelector('.lk-c.tog'));
        if (!h) return null;
        const a = h.getBoundingClientRect(), b = document.querySelector('#keys').getBoundingClientRect();
        return Math.round(Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)));
      });
      await goTo(page, 4, .01);
      await expect.poll(off, { timeout: 15000 }).toBe(0);
      // a little further, before anything moves apart
      await goTo(page, 4, .04);
      await expect.poll(off, { timeout: 15000 }).toBe(0);
    });
  }
});

test.describe('the spaces hint without its .in wrapper', () => {
  const FROM = '<section class="space s1 feat flip" id="spaces">\n    <div class="in">';
  const NO_IN = '<section class="space s1 feat flip" id="spaces">\n    <div class="in-x">';
  const rot = (page) => page.evaluate(() => parseFloat(document.querySelector('#swp .pgw').style.rotate));
  // the hint tips the page card; true once it has
  async function hinted(page, ms) {
    for (let t = 0; t < ms; t += 100) {
      if (await rot(page) !== 0) return true;
      await page.clock.runFor(100);
    }
    return false;
  }
  const narrow = { viewport: { width: 600, height: 900 } };

  test('it follows #swp\'s own opacity: at 1 it tugs', async ({ open }) => {
    const page = await loadNarrow(open, '#swp', { ...narrow, before: (p) => mutate(p, URL, FROM, NO_IN) });
    expect(await page.evaluate(() => document.querySelector('#swp').closest('.in'))).toBe(null);
    expect(await hinted(page, 10000)).toBe(true);
  });

  test('it follows #swp\'s own opacity: faded, it waits', async ({ open }) => {
    const page = await loadNarrow(open, '#swp', { ...narrow, before: (p) => mutate(p, URL, FROM, NO_IN) });
    await page.addStyleTag({ content: '#swp { opacity: .5 }' });
    expect(await hinted(page, 10000)).toBe(false);
  });

  test('with the wrapper, #swp\'s own opacity does not count', async ({ open }) => {
    const page = await loadNarrow(open, '#swp', narrow);
    await page.addStyleTag({ content: '#swp { opacity: .5 }' });
    expect(await hinted(page, 10000)).toBe(true);
  });
});

// The tests above fail when the fallback they check is taken out: each serves a copy of the page without
// it and shows that the assertion would no longer hold. (A changed script counts for no coverage.)
test.describe('fallbacks: mutations', () => {
  const without = (from, to) => (page) => mutate(page, URL, from, to);

  test('without its zero-area guard, a squashed part\'s riders lose their transform', async ({ open }) => {
    const frames = await squashed(open, without('det = H[2] * H[5] - H[3] * H[4] || 1,', 'det = H[2] * H[5] - H[3] * H[4],'));
    expect(frames.flatMap((f) => f.bad)).toContain('rider transform');
  });

  test('without its zero-length guard, a squashed pair\'s morph loses its corners', async ({ open }) => {
    const frames = await squashed(open, without('lu = Math.hypot(S[2], S[3]) || 1, lv = Math.hypot(S[4], S[5]) || 1;', 'lu = Math.hypot(S[2], S[3]), lv = Math.hypot(S[4], S[5]);'));
    expect(frames.flatMap((f) => f.bad)).toContain('body corners');
  });

  test('without the wall check, bodies with no colour are drawn', async ({ open }) => {
    const frames = await unpainted(open, without("if (!wa && !wb) { e.style.display = 'none'; return; } ", ''));
    expect(frames.reduce((n, f) => n + f.bodies, 0)).toBeGreaterThan(0);
  });

  test('without the offsetWidth fallback, an inline part\'s copy gets no width', async ({ open }) => {
    const w = await widths(open, without(": w) + 'px'; clone.style.height", ": exact) + 'px'; clone.style.height"));
    expect(w.say).not.toEqual([w.want.say]);
  });

  test('without the one-card case, the lone card is never put in the middle', async ({ open }) => {
    const page = await loneCard(open, without('x.wc > 1 ? x.wi / (x.wc - 1) - .5 : 0', 'x.wi / (x.wc - 1) - .5'));
    await expect.poll(async () => (await seen(page)).length, { timeout: 15000 }).toBeGreaterThan(120);
    expect((await seen(page)).filter((v) => v === 0)).toEqual([]);
  });

  test('without the time fallback, frames with no time never finish a crossing', async ({ open }) => {
    const page = await wide(open, { init: NO_TIME, before: without('const dt = Math.min(.05, ((now || performance.now()) - then) / 1000);', 'const dt = Math.min(.05, (now - then) / 1000);') });
    await goTo(page, 0, .5);
    await expect.poll(async () => (await state(page)).copies, { timeout: 15000 }).toBeGreaterThan(0);
    await goTo(page, 0, 1);
    await record(page, () => document.querySelector('.lkw').children.length);
    await expect.poll(async () => (await seen(page)).length, { timeout: 15000 }).toBeGreaterThan(180);
    expect((await seen(page)).filter((n) => n === 0)).toEqual([]);
  });

  test('without the .in fallback, the hint\'s check throws', async ({ open }) => {
    const FROM = '<section class="space s1 feat flip" id="spaces">\n    <div class="in">';
    const body = fs.readFileSync(URL, 'utf8').replace(FROM, FROM.replace('"in"', '"in-x"')).replace("root.closest('.in') || root", "root.closest('.in')");
    const page = await loadNarrow(open, '#swp', { viewport: { width: 600, height: 900 }, before: (p) => p.route((u) => u.pathname === '/' + URL, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body })) });
    await expect(page.clock.runFor(10000)).rejects.toThrow(/getComputedStyle/);
  });
});
