import { test, expect, mutate } from './fixtures.mjs';

const PAGE = 'site/lab/04-spaces.html';
const DL = 'https://github.com/Undermove/meridian-browser/releases/latest/download/Meridian-';
const BREW = 'brew install --cask undermove/tap/meridian';
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 800, height: 900 };
const NAMES = ['Hello', 'Spaces', 'Import', 'Today', 'Split', 'AI', 'Private', 'Download', 'Questions'];

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  ps5: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

// Chromium under Playwright always says "macOS" in userAgentData, so each case sets the platform
// it would really have.
const platform = ({ data, plat = '', touch = 0 }) => `(() => {
  const P = Navigator.prototype;
  Object.defineProperty(P, 'userAgentData', { get: () => ${data ? `({ platform: ${JSON.stringify(data)} })` : 'undefined'} });
  Object.defineProperty(P, 'platform', { get: () => ${JSON.stringify(plat)} });
  Object.defineProperty(P, 'maxTouchPoints', { get: () => ${touch} });
})()`;

const MAC_CTA = ['Download for Mac', 'Free · Apple silicon (M1 and newer)', DL + 'mac-arm64.dmg'];
const WIN_CTA = ['Download for Windows', 'Free · Windows 10 and 11', DL + 'win.exe'];
const CASES = [
  { name: 'a Mac', ua: UA.mac, env: { data: 'macOS', plat: 'MacIntel' }, cta: MAC_CTA, tab: 'mac' },
  { name: 'a Mac known only by its user agent', ua: UA.mac, env: {}, cta: MAC_CTA, tab: 'mac' },
  { name: 'Windows', ua: UA.win, env: { data: 'Windows', plat: 'Win32' }, cta: WIN_CTA, tab: 'win' },
  { name: 'Windows known only by its user agent', ua: UA.win, env: {}, cta: WIN_CTA, tab: 'win' },
  { name: 'Linux', ua: UA.linux, env: { data: 'Linux', plat: 'Linux x86_64' }, cta: ["Linux isn't out yet", 'Meridian is for macOS and Windows', '#install'], tab: 'linux' },
  { name: 'an unknown system', ua: UA.ps5, env: {}, cta: ['Download Meridian', '', '#install'], tab: 'mac' },
  { name: 'an Android phone', ua: UA.android, env: { data: 'Android', plat: 'Linux armv81', touch: 5 }, cta: ['Get it on your computer', 'Free · Meridian is for Mac and Windows', '#install'], tab: 'mac' },
  // iPadOS Safari presents itself as a Mac; only the touch points give it away.
  { name: 'an iPad that says it is a Mac', ua: UA.mac, env: { plat: 'MacIntel', touch: 5 }, cta: ['Get it on your computer', 'Free · Meridian is for Mac and Windows', '#install'], tab: 'mac' },
];

const selectedTab = (page) => page.locator('[role=tab]').evaluateAll((ts) => ts.map((t) => [
  t.dataset.os, t.getAttribute('aria-selected'), t.tabIndex, document.getElementById('p-' + t.dataset.os).hidden,
]));
const tabState = (os) => ['mac', 'win', 'linux'].map((o) => [o, String(o === os), o === os ? 0 : -1, o !== os]);

for (const c of CASES) {
  test(`hero download and the open tab for ${c.name}`, async ({ open }) => {
    const page = await open(PAGE, { userAgent: c.ua, init: platform(c.env), viewport: NARROW });
    const a = page.locator('[data-cta]');
    await expect(a).toHaveAttribute('href', c.cta[2]);
    await expect(a.locator('.cl')).toHaveText(c.cta[0]);
    await expect(a.locator('.cs')).toHaveText(c.cta[1]);
    await expect(a.locator('.ci svg')).toHaveCount(1);
    expect(await selectedTab(page)).toEqual(tabState(c.tab));
  });
}

test('red: the open tab is checked', async ({ open }) => {
  const page = await open(null, { userAgent: UA.linux, init: platform({ data: 'Linux', plat: 'Linux x86_64' }), viewport: NARROW });
  await mutate(page, PAGE, "showTab(os === 'other' || mobile ? 'mac' : os);", "showTab('mac');");
  await page.goto(PAGE);
  expect(await selectedTab(page)).not.toEqual(tabState('linux'));
});

test('the system tabs switch by click and by arrow keys, and wrap around', async ({ open }) => {
  const page = await open(PAGE, { userAgent: UA.mac, init: platform({ data: 'macOS', plat: 'MacIntel' }), viewport: NARROW });
  await page.locator('#t-win').click();
  expect(await selectedTab(page)).toEqual(tabState('win'));
  await page.keyboard.press('ArrowRight');
  expect(await selectedTab(page)).toEqual(tabState('linux'));
  await expect(page.locator('#t-linux')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  expect(await selectedTab(page)).toEqual(tabState('mac'));
  await page.keyboard.press('ArrowLeft');
  expect(await selectedTab(page)).toEqual(tabState('linux'));
  await page.keyboard.press('Home');
  expect(await selectedTab(page)).toEqual(tabState('linux'));
  await expect(page.locator('#t-linux')).toBeFocused();
});

test('the hero download on a Mac starts the download and then shows the Download space', async ({ open }) => {
  const page = await open(null, { userAgent: UA.mac, init: platform({ data: 'macOS', plat: 'MacIntel' }), viewport: WIDE });
  await page.route(DL + 'mac-arm64.dmg', (r) => r.fulfill({ body: 'dmg', headers: { 'content-disposition': 'attachment; filename=Meridian.dmg' } }));
  await page.goto(PAGE);
  const download = page.waitForEvent('download');
  await page.locator('[data-cta]').click();
  expect((await download).url()).toBe(DL + 'mac-arm64.dmg');
  await expect.poll(() => page.locator('#install').evaluate((s) => Math.round(s.getBoundingClientRect().top))).toBe(0);
});

const clipboard = (ok) => `Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => ({
  writeText: (t) => { window.__copied = t; return ${ok ? 'Promise.resolve()' : "Promise.reject(new DOMException('denied', 'NotAllowedError'))"}; },
}) });`;

test('Copy puts the Homebrew command on the clipboard, then says Copy again', async ({ open }) => {
  const page = await open(PAGE, { init: clipboard(true), viewport: NARROW });
  const copy = page.locator('#copy');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => window.__copied)).toBe(BREW);
  expect(await page.evaluate(() => getSelection().toString())).toBe('');
  await expect(copy).toHaveText('Copy');
});

test('when the clipboard refuses, Copy selects the command instead', async ({ open }) => {
  const page = await open(PAGE, { init: clipboard(false), viewport: NARROW });
  await page.locator('#copy').click();
  await expect(page.locator('#copy')).toHaveText('Copied');
  expect(await page.evaluate(() => getSelection().toString())).toBe(BREW);
});

// Per heading: its width, each line's width and font size, and the height cap that applies.
const fitState = (page) => page.evaluate(() => [...document.querySelectorAll('.fit')].map((h) => ({
  W: h.clientWidth,
  cap: innerWidth > 900 ? innerHeight * (+h.dataset.maxh || 0.52) : Infinity,
  lines: [...h.children].map((l) => [l.getBoundingClientRect().width, parseFloat(l.style.fontSize)]),
})));

test('on a narrow screen every poster line fills its column', async ({ open }) => {
  const page = await open(PAGE, { viewport: NARROW });
  await expect(page.locator('html')).not.toHaveClass(/\bkin\b/);
  const fits = await fitState(page);
  expect(fits).toHaveLength(9);
  // letters get boxes rounded to their own width, so a line can be off by a few px
  for (const h of fits) for (const [w] of h.lines) expect(Math.abs(w - h.W)).toBeLessThan(h.W * 0.01);
});

test('on a wide screen poster lines fill their column unless that passes their share of the height', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE });
  await expect(page.locator('html')).toHaveClass(/\bkin\b/);
  const fits = await fitState(page);
  const capped = fits.map((h) => {
    const total = h.lines.reduce((a, [, s]) => a + s * 0.86, 0);
    if (h.lines.every(([w]) => Math.abs(w - h.W) < 2)) {
      expect(total).toBeLessThanOrEqual(h.cap + 0.5);
      return false;
    }
    expect(Math.abs(total - h.cap)).toBeLessThan(0.5);
    return true;
  });
  // at 1280x800 some headings hit their cap and some don't
  expect(capped).toContain(true);
  expect(capped).toContain(false);
});

test('the hero title is split into letters, spaces kept as no-break spaces', async ({ open }) => {
  const page = await open(PAGE, { viewport: NARROW });
  const lines = await page.locator('h1 .l[data-k]').evaluateAll((ls) => ls.map((l) => [...l.children].map((c) => c.className + ':' + c.textContent)));
  expect(lines).toEqual(['The browser', 'loved Arc'].map((t) => [...t].map((ch) => 'c:' + (ch === ' ' ? ' ' : ch))));
});

test('a page shown in a frame with no width leaves its poster type alone', async ({ open }) => {
  const page = await open('site/lab/index.html', { viewport: NARROW });
  await page.evaluate((src) => new Promise((done) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'width:0;height:600px;border:0';
    f.onload = done; f.src = src; document.body.append(f);
  }), '/' + PAGE);
  const frame = page.frameLocator('iframe[src="/' + PAGE + '"]');
  const sizes = await frame.locator('.fit .l').evaluateAll((ls) => ls.map((l) => l.style.fontSize));
  expect(sizes.length).toBeGreaterThan(20);
  expect(sizes.every((s) => s === '')).toBe(true);
});

// The live stack, each act's inline pose.
const poses = (page, mount) => page.locator(mount + ' .act:not(.floor)').evaluateAll((els) => els.map((e) => [
  e.className.replace(' hv', ''), e.style.transform, e.style.opacity, e.style.background, e.textContent, e.querySelector('em')?.style.opacity ?? null,
]));

async function goToSpace(page, i) {
  const top = await page.locator('.space').nth(i).evaluate((s) => s.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), top);
  await expect(page.locator('#dotname')).toHaveText(String(i + 1).padStart(2, '0') + ' ' + NAMES[i]);
}

test('scrolling through the spaces poses the stack, the window, the sky and the dots for each', async ({ open }) => {
  test.setTimeout(90_000);
  const page = await open(PAGE, { viewport: WIDE });
  await expect(page.locator('html')).toHaveClass(/\bkin\b/);
  expect(await page.locator('#win').evaluate((w) => w.parentElement === document.body)).toBe(true);
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  await expect(page.locator('.space').nth(0)).toHaveClass(/\bon\b/);
  await expect(page.locator('.space').nth(1)).not.toHaveClass(/\bon\b/);
  const atLoad = await poses(page, '#scene');
  // tabs are drawn back to front, so Linear, the pinned one, is the last tab
  expect(atLoad[8]).toEqual(['act slab', 'translate3d(-110px, -125px, 150px) rotateZ(0deg) scale(0.85)', '1', 'rgb(255, 255, 255)', 'LinearPinned', '0']);

  const POSE = [[26, 4, 1, 1], [-22, 2, 1, 1], [21, 3, 1, 1], [-22, 4, 1, 1], [22, 3, 1, 1], [-22, 3, 1, 1], [22, 3, 1, 1], [80, -10, .7, 0], [80, -10, .7, 0]];
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await goToSpace(page, i);
    expect(await poses(page, '#scene')).toEqual(await poses(page, `.sc3[data-s="${Math.min(i, 6)}"]`));
    const dots = await page.locator('.dots a').evaluateAll((ds) => ds.map((d) => d.classList.contains('on')));
    expect(dots).toEqual(NAMES.map((_, k) => k === i));
    const sky = await page.locator('.sky i').evaluateAll((s) => s.map((x) => [x.classList.contains('live'), x.style.transform]));
    expect(sky[i]).toEqual([true, 'translate3d(0%, 0px, 0px)']);
    expect(sky.map(([live]) => live)).toEqual(NAMES.map((_, k) => Math.abs(k - i) <= 1));
    await expect(page.locator('.space').nth(i)).toHaveClass(/\bon\b/);
    await expect(page.locator('.space').nth(i).locator('.in')).toHaveCSS('opacity', '1');
    const [x, y, s, o] = POSE[i];
    const win = await page.locator('#win').evaluate((w) => [w.style.transform.match(/-?[\d.]+/g).map(Number), +w.style.opacity]);
    expect(win).toEqual([[3, x * 1280 / 100, y * 800 / 100, 0, s], o]);
  }
  // a small scroll inside the same space keeps everything as it was
  const before = await poses(page, '#scene');
  await page.evaluate(() => scrollBy({ top: 20, behavior: 'instant' }));
  await stillScroll(page);
  await expect(page.locator('#dotname')).toHaveText('09 Questions');
  expect(await poses(page, '#scene')).toEqual(before);
  await goToSpace(page, 0);
  expect(await poses(page, '#scene')).toEqual(atLoad);
});

test('red: the stack check fails when a space gets the wrong pose', async ({ open }) => {
  const page = await open(null, { viewport: WIDE });
  await mutate(page, PAGE, 'live.set(Math.min(a, 6));', 'live.set(Math.min(a, 5));');
  await page.goto(PAGE);
  await goToSpace(page, 6);
  expect(await poses(page, '#scene')).not.toEqual(await poses(page, '.sc3[data-s="6"]'));
});

test('leaving and re-entering the kinetic width puts the window back and restores it', async ({ open }) => {
  test.setTimeout(90_000);
  const page = await open(PAGE, { viewport: WIDE });
  await goToSpace(page, 2);
  await goToSpace(page, 0);
  // bend a few letters so the reset has something to undo
  const first = page.locator('h1 .c').first();
  const box = await first.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => first.evaluate((c) => c.style.fontWeight), { timeout: 15_000 }).not.toBe('');

  await page.setViewportSize(NARROW);
  await expect(page.locator('html')).not.toHaveClass(/\bkin\b/);
  const reset = await page.evaluate(() => ({
    home: document.getElementById('win').parentElement === document.querySelector('.space .in'),
    win: document.getElementById('win').style.cssText,
    iso: document.querySelector('#scene .iso').style.transform,
    floor: document.querySelector('#scene .floor').style.transform,
    ins: [...document.querySelectorAll('.space .in')].every((e) => e.style.opacity === ''),
    sky: [...document.querySelectorAll('.sky i')].every((e) => e.style.transform === ''),
    weights: [...document.querySelectorAll('.c')].every((c) => c.style.fontWeight === ''),
  }));
  expect(reset).toEqual({ home: true, win: '', iso: '', floor: '', ins: true, sky: true, weights: true });
  expect(await poses(page, '#scene')).toEqual(await (async () => {
    const fresh = await page.context().newPage();
    await fresh.goto(PAGE);
    const p = await poses(fresh, '#scene');
    await fresh.close();
    return p;
  })());
  // the mouse no longer moves anything
  await page.mouse.move(10, 10);
  await page.mouse.move(400, 400);
  await nextFrames(page);
  expect(await page.locator('#scene .iso').evaluate((e) => e.style.transform)).toBe('');

  await page.setViewportSize(WIDE);
  await expect(page.locator('html')).toHaveClass(/\bkin\b/);
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  expect(await page.locator('#win').evaluate((w) => w.parentElement === document.body)).toBe(true);
  // the spaces below fade out again, as at load
  await expect(page.locator('.space').nth(3).locator('.in')).toHaveCSS('opacity', '0');
  expect(await page.locator('.sky i').nth(3).evaluate((s) => s.style.transform)).toBe('translate3d(104%, 0px, 0px)');
});

test('leaving the kinetic width in a space and coming back poses the stack for that space', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE });
  await goToSpace(page, 2);
  await page.setViewportSize(NARROW);
  await expect(page.locator('html')).not.toHaveClass(/\bkin\b/);
  await page.setViewportSize(WIDE);
  await expect(page.locator('html')).toHaveClass(/\bkin\b/);
  const top = await page.locator('.space').nth(2).evaluate((s) => s.getBoundingClientRect().top + scrollY);
  await page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), top);
  await expect(page.locator('#dotname')).toHaveText('03 Import');
  await expect.poll(() => poses(page, '#scene')).toEqual(await poses(page, '.sc3[data-s="2"]'));
});

test('with reduced motion a wide screen stays still', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE, reducedMotion: 'reduce' });
  await expect(page.locator('html')).not.toHaveClass(/\bkin\b/);
  expect(await page.locator('#win').evaluate((w) => w.parentElement.classList.contains('in'))).toBe(true);
});

const nextFrames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const isoTransform = (page) => page.locator('#scene .iso').evaluate((e) => e.style.transform);
// waits until scrollY holds for 10 frames (smooth scrolling is on in kinetic mode)
const stillScroll = (page) => page.evaluate(() => new Promise((done) => {
  let prev = null, same = 0;
  const look = () => { same = scrollY === prev ? same + 1 : 0; prev = scrollY; if (same >= 10) done(); else requestAnimationFrame(look); };
  requestAnimationFrame(look);
}));
// the stack's transform once it stops easing
const stillTransform = (page) => page.evaluate(() => new Promise((done, fail) => {
  const iso = document.querySelector('#scene .iso');
  let prev = null, same = 0, n = 0;
  const look = () => {
    const t = iso.style.transform;
    same = t === prev ? same + 1 : 0; prev = t;
    if (same >= 10) done(t); else if (++n > 900) fail(new Error('the stack never settled')); else requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}));
const depth = (t) => +/scale3d\(1, 1, ([\d.]+)\)/.exec(t)[1];
const turn = (t) => +/rotateZ\((-?[\d.]+)deg\)/.exec(t)[1];

test('the mouse tilts the stack, lifts the tab under it and bends nearby letters', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE });
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  expect(turn(await isoTransform(page))).toBe(-38);

  // heavy near the pointer: the letter under it gets the lightest weight
  const letter = page.locator('h1 .c').nth(2);
  const lb = await letter.boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await expect.poll(() => letter.evaluate((c) => c.style.fontWeight)).toBe('220');

  test.setTimeout(60_000);
  const slab = page.locator('#scene .slab').nth(2);
  // the sections cover the stack, so a lifted tab shows the page's own hit test works
  await expect.poll(async () => {
    const b = await slab.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await nextFrames(page);
    return page.locator('#scene .slab.hv').count();
  }, { timeout: 15_000 }).toBe(1);
  // The pointer tilts the stack and a hovered tab slides aside, so the tab under a resting pointer
  // can change. Rest near a tab, then step to the closest spot that is over one: a few px barely
  // change the tilt.
  let x = 0, y = 0;
  // a hover slide starts a frame after the move, so look for running transitions twice
  const settle = async () => {
    await stillTransform(page);
    for (let k = 0; k < 2; k++) {
      await nextFrames(page);
      await page.evaluate(() => Promise.all(document.querySelector('#scene .iso').getAnimations({ subtree: true }).map((a) => a.finished)));
    }
  };
  await expect.poll(async () => {
    const b = await slab.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await settle();
    const spot = await page.evaluate(([cx, cy]) => {
      const over = (px, py) => document.elementsFromPoint(px, py).some((el) => el.closest('#scene .slab'));
      for (let r = 0; r <= 20; r += 2) for (let dx = -r; dx <= r; dx += 2) for (const dy of [-r, r]) {
        const px = cx + dx, py = cy + dy;
        if ([[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]].every(([ax, ay]) => over(px + ax, py + ay))) return [px, py];
      }
      return null;
    }, [b.x + b.width / 2, b.y + b.height / 2]);
    if (!spot) return false;
    [x, y] = spot;
    await page.mouse.move(x, y);
    await settle();
    return page.evaluate(([px, py]) => document.elementsFromPoint(px, py).some((el) => el.closest('#scene .slab')), [x, y]);
  }, { timeout: 30_000 }).toBe(true);

  const peakDepth = () => page.evaluate(() => new Promise((done) => {
    let max = 0, n = 0;
    const look = () => {
      max = Math.max(max, +/scale3d\(1, 1, ([\d.]+)\)/.exec(document.querySelector('#scene .iso').style.transform)[1]);
      if (++n < 60) requestAnimationFrame(look); else done(max);
    };
    requestAnimationFrame(look);
  }));
  // A hovered tab slides aside, so the tab under a resting pointer can move before a real press lands.
  // Find a point over a tab and press there in the same task, so the page's hit test sees that tab.
  await settle();
  const before = depth(await isoTransform(page));
  const peak = peakDepth();
  const onTab = await page.evaluate(([cx, cy]) => {
    const over = (px, py) => document.elementsFromPoint(px, py).some((el) => el.closest('#scene .slab'));
    for (let r = 0; r <= 40; r += 2) for (let dx = -r; dx <= r; dx += 2) for (const dy of [-r, r]) {
      if (!over(cx + dx, cy + dy)) continue;
      dispatchEvent(new PointerEvent('pointerdown', { clientX: cx + dx, clientY: cy + dy, pointerType: 'mouse' }));
      return true;
    }
    return false;
  }, [x, y]);
  expect(onTab).toBe(true);
  // a press on a tab pops the layers apart (+0.8, fading each frame)
  expect(await peak).toBeGreaterThan(before + 0.3);

  await page.mouse.move(1270, 790);
  await expect(page.locator('#scene .slab.hv')).toHaveCount(0);
  await expect.poll(async () => turn(await isoTransform(page))).toBeGreaterThan(-12);
  // a click off the stack adds no burst
  const settled = await stillTransform(page);
  await page.mouse.down();
  await nextFrames(page);
  await page.mouse.up();
  expect(await isoTransform(page)).toBe(settled);
});

test('touch does not tilt the stack', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE, hasTouch: true });
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await page.evaluate(() => addEventListener('pointermove', (e) => { window.__moved = e.pointerType; }, { once: true }));
  await touch('touchStart', 900, 600);
  await touch('touchMove', 1200, 700);
  await touch('touchEnd');
  await expect.poll(() => page.evaluate(() => window.__moved)).toBe('touch');
  await nextFrames(page);
  expect(turn(await isoTransform(page))).toBe(-38);
});

// Scrolls until the Download space has faded under Questions while its Copy button is still on
// screen, then reaches Copy with Tab. Chrome scrolls a focused element only when it is off screen,
// so here any move comes from the page. Returns Copy's distance from the middle once scrolling stops.
async function tabToFadedCopy(page) {
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  const y = await page.evaluate(() => document.getElementById('faq').getBoundingClientRect().top + scrollY - innerHeight * 0.66);
  await page.evaluate((top) => scrollTo({ top, behavior: 'instant' }), y);
  await expect(page.locator('#install .in')).toHaveCSS('opacity', '0');
  const copy = page.locator('#copy');
  expect(await copy.evaluate((b) => { const r = b.getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; })).toBe(true);
  await page.locator('#install .brew span').click();
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  await stillScroll(page);
  return copy.evaluate((b) => { const r = b.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - innerHeight / 2); });
}

test('a button reached by keyboard in a faded space is brought to the middle', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE });
  expect(await tabToFadedCopy(page)).toBeLessThan(1);
  expect(+(await page.locator('#install .in').evaluate((e) => e.style.opacity))).toBeGreaterThan(0.9);
});

test('red: without the focus handler the button stays faded', async ({ open }) => {
  const page = await open(null, { viewport: WIDE });
  await mutate(page, PAGE, "e.target.scrollIntoView({ block: 'center' });", ';');
  await page.goto(PAGE);
  expect(await tabToFadedCopy(page)).toBeGreaterThan(50);
  await expect(page.locator('#install .in')).toHaveCSS('opacity', '0');
});

test('the hero download on Windows also shows the Download space', async ({ open }) => {
  const page = await open(null, { userAgent: UA.win, init: platform({ data: 'Windows', plat: 'Win32' }), viewport: WIDE });
  await page.route(DL + 'win.exe', (r) => r.fulfill({ body: 'exe', headers: { 'content-disposition': 'attachment; filename=Meridian.exe' } }));
  await page.goto(PAGE);
  const download = page.waitForEvent('download');
  await page.locator('[data-cta]').click();
  expect((await download).url()).toBe(DL + 'win.exe');
  await expect.poll(() => page.locator('#install').evaluate((s) => Math.round(s.getBoundingClientRect().top))).toBe(0);
});

test('on Linux the hero link goes to the Download space', async ({ open }) => {
  const page = await open(PAGE, { userAgent: UA.linux, init: platform({ data: 'Linux', plat: 'Linux x86_64' }), viewport: WIDE });
  await page.locator('[data-cta]').click();
  await expect.poll(() => page.locator('#install').evaluate((s) => Math.round(s.getBoundingClientRect().top))).toBe(0);
  expect(new URL(page.url()).hash).toBe('#install');
});

test('when the clipboard refuses, Copy replaces what was selected with the command', async ({ open }) => {
  const page = await open(PAGE, { init: clipboard(false), viewport: NARROW });
  await page.locator('h1').evaluate((h) => { const r = document.createRange(); r.selectNodeContents(h); getSelection().addRange(r); });
  expect(await page.evaluate(() => getSelection().toString())).not.toBe('');
  await page.locator('#copy').click();
  await expect(page.locator('#copy')).toHaveText('Copied');
  expect(await page.evaluate(() => getSelection().toString())).toBe(BREW);
});

test('at 900 px wide, just below the kinetic width, poster lines fill their column uncapped', async ({ open }) => {
  const page = await open(PAGE, { viewport: { width: 900, height: 800 } });
  await expect(page.locator('html')).not.toHaveClass(/\bkin\b/);
  const fits = await fitState(page);
  for (const h of fits) for (const [w] of h.lines) expect(Math.abs(w - h.W)).toBeLessThan(h.W * 0.01);
});

// Each letter's fixed box, against the width its glyph takes in the current font.
const letterBoxes = (page) => page.locator('.fit .c').evaluateAll((cs) => cs.map((c) => {
  const fixed = c.getBoundingClientRect().width;
  const w = c.style.width; c.style.width = '';
  const own = c.getBoundingClientRect().width; c.style.width = w;
  return Math.abs(fixed - own);
}));

test('when the font changes, the letters get boxes for the new font', async ({ open }) => {
  const page = await open(PAGE, { viewport: NARROW });
  expect(Math.max(...await letterBoxes(page))).toBeLessThan(0.5);
  // stands in for the web font arriving: the page refits on fonts' loadingdone
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.fit{font-family:monospace!important}');
    document.adoptedStyleSheets = [sheet];
    document.fonts.dispatchEvent(new Event('loadingdone'));
  });
  expect(Math.max(...await letterBoxes(page))).toBeLessThan(0.5);
});

test('after a scroll the letter under the pointer still bends the most', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE });
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  await page.evaluate(() => scrollTo({ top: 150, behavior: 'instant' }));
  await stillScroll(page);
  await expect(page.locator('#dotname')).toHaveText('01 Hello');
  // a refit while scrolled, as when the web font arrives
  await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));
  const letter = page.locator('h1 .c').nth(2);
  const lb = await letter.boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2);
  await expect.poll(() => letter.evaluate((c) => c.style.fontWeight)).toBe('220');
});

test('each still stack shows only its own extras', async ({ open }) => {
  const page = await open(PAGE, { viewport: NARROW });
  // the shield is an icon with no text
  const EXTRA = { 5: ['Local modelFree', 'GitHub Copilot', 'Claude API key', 'Summarise this page'], 6: ['Ads', 'Trackers', ''] };
  for (const s of [1, 2, 3, 4, 5, 6]) {
    const shown = await page.locator(`.sc3[data-s="${s}"] .act`).evaluateAll((els) =>
      els.filter((e) => /^act (slab dk|slab no|shd)/.test(e.className) && e.style.opacity === '1').map((e) => e.textContent));
    expect(shown, 'space ' + s).toEqual(EXTRA[s] || []);
  }
});

test('in Today the pinned tab is lime and the last two tabs are blue', async ({ open }) => {
  const page = await open(PAGE, { viewport: NARROW });
  const bg = (s) => page.locator(`.sc3[data-s="${s}"] .act.slab:not(.dk):not(.no)`).evaluateAll((els) =>
    Object.fromEntries(els.map((e) => [e.textContent.replace('Pinned', ''), e.style.background])));
  const W = 'rgb(255, 255, 255)', LIME = 'rgb(201, 240, 46)', BLUE = 'rgb(169, 180, 255)';
  expect(await bg(3)).toEqual({ Linear: LIME, Notion: W, YouTube: W, Figma: W, Spotify: BLUE, GitHub: BLUE });
  expect(await bg(2)).toEqual({ Linear: W, Notion: W, YouTube: W, Figma: W, Spotify: W, GitHub: W });
});

test('a mouse click on a button in a space does not scroll the page', async ({ open }) => {
  const page = await open(PAGE, { viewport: WIDE, init: clipboard(true) });
  await goToSpace(page, 7);
  await stillScroll(page);
  const y = await page.evaluate(() => scrollY);
  const copy = page.locator('#copy');
  // off the middle, so a centring scroll would show
  expect(await copy.evaluate((b) => { const r = b.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - innerHeight / 2); })).toBeGreaterThan(50);
  await copy.click();
  await expect(copy).toBeFocused();
  await stillScroll(page);
  expect(await page.evaluate(() => scrollY)).toBe(y);
});

test('on a narrow screen a button reached by keyboard is left where it is', async ({ open }) => {
  const page = await open(PAGE, { viewport: NARROW });
  const copy = page.locator('#copy');
  // Copy near the bottom of the screen, but on it
  await copy.evaluate((b) => scrollTo({ top: b.getBoundingClientRect().top + scrollY - innerHeight + 120, behavior: 'instant' }));
  await stillScroll(page);
  const y = await page.evaluate(() => scrollY);
  await page.locator('#install .brew span').click();
  await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  await stillScroll(page);
  expect(await page.evaluate(() => scrollY)).toBe(y);
});

test('other keys on a focused tab that is not open change nothing', async ({ open }) => {
  const page = await open(PAGE, { userAgent: UA.mac, init: platform({ data: 'macOS', plat: 'MacIntel' }), viewport: NARROW });
  // On Windows and Linux, pressing a tab and sliding off it focuses it without a click. Chromium on
  // macOS doesn't focus buttons on press, so the test focuses it directly.
  await page.locator('#t-win').focus();
  await expect(page.locator('#t-win')).toBeFocused();
  expect(await selectedTab(page)).toEqual(tabState('mac'));
  await page.keyboard.press('Home');
  expect(await selectedTab(page)).toEqual(tabState('mac'));
});
