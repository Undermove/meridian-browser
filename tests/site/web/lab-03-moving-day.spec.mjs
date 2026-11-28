import { test, expect, mutate } from './fixtures.mjs';

const PAGE = 'site/lab/03-moving-day.html';
const DL = 'https://github.com/Undermove/meridian-browser/releases/latest/download/Meridian-';
const BREW = 'brew install --cask undermove/tap/meridian';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ps5: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

// What the browser reports besides the user agent. Chromium under Playwright always says
// "macOS" in userAgentData, so each case sets the platform it would really have.
const platform = ({ data, plat = '', touch = 0 }) => `(() => {
  const P = Navigator.prototype;
  Object.defineProperty(P, 'userAgentData', { get: () => ${data ? `({ platform: ${JSON.stringify(data)} })` : 'undefined'} });
  Object.defineProperty(P, 'platform', { get: () => ${JSON.stringify(plat)} });
  Object.defineProperty(P, 'maxTouchPoints', { get: () => ${touch} });
})()`;

const CASES = [
  { name: 'a Mac', ua: UA.mac, env: { data: 'macOS', plat: 'MacIntel' }, cta: ['Download for Mac', 'Free · Apple silicon (M1 and newer)', DL + 'mac-arm64.dmg'], mine: 'mac' },
  { name: 'a Mac known only by its user agent', ua: UA.mac, env: {}, cta: ['Download for Mac', 'Free · Apple silicon (M1 and newer)', DL + 'mac-arm64.dmg'], mine: 'mac' },
  { name: 'Windows', ua: UA.win, env: { data: 'Windows', plat: 'Win32' }, cta: ['Download for Windows', 'Free · Windows 10 and 11', DL + 'win.exe'], mine: 'win' },
  { name: 'Windows known only by its user agent', ua: UA.win, env: {}, cta: ['Download for Windows', 'Free · Windows 10 and 11', DL + 'win.exe'], mine: 'win' },
  { name: 'Linux', ua: UA.linux, env: { data: 'Linux', plat: 'Linux x86_64' }, cta: ["Meridian for Linux isn't out yet", 'For macOS and Windows · Linux comes later', '#keys'], mine: 'linux' },
  { name: 'an unknown system', ua: UA.ps5, env: {}, cta: ['Download Meridian', 'Free · macOS and Windows', '#keys'], mine: null },
  { name: 'an Android phone', ua: UA.android, env: { data: 'Android', plat: 'Linux armv81', touch: 5 }, cta: ['Download Meridian', 'Free · Meridian is for Mac and Windows', '#keys'], mine: null },
  { name: 'an iPhone', ua: UA.iphone, env: { plat: 'iPhone', touch: 5 }, cta: ['Download Meridian', 'Free · Meridian is for Mac and Windows', '#keys'], mine: null },
  // iPadOS Safari presents itself as a Mac; only the touch points give it away.
  { name: 'an iPad that says it is a Mac', ua: UA.mac, env: { plat: 'MacIntel', touch: 5 }, cta: ['Download Meridian', 'Free · Meridian is for Mac and Windows', '#keys'], mine: null },
  // only more than one touch point marks an iPad
  { name: 'a Mac with one touch point', ua: UA.mac, env: { data: 'macOS', plat: 'MacIntel', touch: 1 }, cta: ['Download for Mac', 'Free · Apple silicon (M1 and newer)', DL + 'mac-arm64.dmg'], mine: 'mac' },
];

for (const c of CASES) {
  test(`download links for ${c.name}`, async ({ open }) => {
    const page = await open(PAGE, { userAgent: c.ua, init: platform(c.env) });
    for (const id of ['#cta', '#cta2']) {
      const a = page.locator(id);
      await expect(a).toHaveAttribute('href', c.cta[2]);
      await expect(a.locator('b')).toHaveText(c.cta[0]);
      await expect(a.locator('small')).toHaveText(c.cta[1]);
    }
    const mine = await page.locator('.key.mine').evaluateAll((ks) => ks.map((k) => k.dataset.os));
    expect(mine).toEqual(c.mine ? [c.mine] : []);
  });
}

test('red: the Windows link is checked', async ({ open }) => {
  const page = await open(null, { userAgent: UA.win, init: platform({ data: 'Windows', plat: 'Win32' }) });
  await mutate(page, PAGE, "DOWNLOAD + 'win.exe'", "DOWNLOAD + 'mac-arm64.dmg'");
  await page.goto(PAGE);
  await expect(page.locator('#cta')).not.toHaveAttribute('href', DL + 'win.exe');
});

const clipboard = (ok) => `Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => ({
  writeText: (t) => { window.__copied = t; return ${ok ? 'Promise.resolve()' : "Promise.reject(new DOMException('denied', 'NotAllowedError'))"}; },
}) });`;

test('Copy puts the Homebrew command on the clipboard, then says Copy again', async ({ open }) => {
  const page = await open(PAGE, { init: clipboard(true) });
  const copy = page.locator('#copy');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => window.__copied)).toBe(BREW);
  expect(await page.evaluate(() => getSelection().toString())).toBe('');
  await expect(copy).toHaveText('Copy');
});

test('when the clipboard refuses, Copy selects the command instead', async ({ open }) => {
  const page = await open(PAGE, { init: clipboard(false) });
  await page.locator('#copy').click();
  await expect(page.locator('#copy')).toHaveText('Copied');
  expect(await page.evaluate(() => getSelection().toString())).toBe(BREW);
});

test('when the clipboard refuses, Copy replaces what was selected with the command', async ({ open }) => {
  const page = await open(PAGE, { init: clipboard(false) });
  await page.locator('h1').evaluate((h) => { const r = document.createRange(); r.selectNodeContents(h); getSelection().addRange(r); });
  expect(await page.evaluate(() => getSelection().toString())).not.toBe('');
  await page.locator('#copy').click();
  await expect(page.locator('#copy')).toHaveText('Copied');
  expect(await page.evaluate(() => getSelection().toString())).toBe(BREW);
});

test('headings set themselves letter by letter, spaces stay plain', async ({ page }) => {
  await page.goto(PAGE);
  const letters = (sel) => page.locator(sel).evaluate((el) => ({
    text: el.textContent,
    nodes: [...el.childNodes].map((n) => n.nodeType === 3 ? [n.textContent] : [n.className, n.textContent, n.style.getPropertyValue('--i'), n.style.getPropertyValue('--d')]),
  }));
  expect(await letters('h1 .l1')).toEqual({
    text: 'Moving',
    nodes: [...'Moving'].map((c, i) => ['ch', c, String(i), '0ms']),
  });
  expect((await letters('h1 .l2')).nodes[0]).toEqual(['ch', 'D', '0', '380ms']);
  expect(await letters('.band .b2 span[data-set]')).toEqual({
    text: 'move ',
    nodes: [...[...'move'].map((c, i) => ['ch', c, String(i), '350ms']), [' ']],
  });
});

test('the closing line stays hidden until it is on screen, then replays its letters', async ({ page }) => {
  await page.goto(PAGE);
  const big = page.locator('.band .big');
  await expect(big).toHaveCSS('visibility', 'hidden');
  const card = page.locator('.card.rv').first();
  await expect(card).not.toHaveClass(/\bin\b/);

  await card.scrollIntoViewIfNeeded();
  await expect(card).toHaveClass(/\bin\b/);

  await big.scrollIntoViewIfNeeded();
  await expect(big).toHaveCSS('visibility', 'visible');
  // the restart sets animation-name to none and back; it ends with no inline override
  expect(await big.locator('.ch').evaluateAll((cs) => cs.every((c) => c.style.animationName === ''))).toBe(true);
  expect(await big.locator('.ch').count()).toBe('Ready to'.replace(' ', '').length + 'move'.length + 'in?'.length);
});

// The closing line's letter animations: true while any still runs.
const bigPlaying = (page) => page.locator('.band .big .ch').evaluateAll((cs) => cs.some((c) => c.getAnimations().some((a) => a.playState === 'running')));

test('the closing line plays its letters when it comes on screen, and only the first time', async ({ page }) => {
  await page.goto(PAGE);
  // hidden letters still animate, so by now they have played out unseen
  await expect.poll(() => bigPlaying(page), { timeout: 10_000 }).toBe(false);
  const big = page.locator('.band .big');
  await big.scrollIntoViewIfNeeded();
  await expect(big).toHaveCSS('visibility', 'visible');
  expect(await bigPlaying(page)).toBe(true);
  await expect.poll(() => bigPlaying(page), { timeout: 10_000 }).toBe(false);
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await expect.poll(() => big.evaluate((b) => b.getBoundingClientRect().top > innerHeight)).toBe(true);
  // an observer with the page's options reports in the same update as the page's own
  const seen = big.evaluate((b) => new Promise((done) => {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); requestAnimationFrame(done); } },
      { threshold: 0.18, rootMargin: '0px 0px -6% 0px' });
    io.observe(b);
  }));
  await big.scrollIntoViewIfNeeded();
  await seen;
  expect(await bigPlaying(page)).toBe(false);
});

test('plates and the packing list come in as they reach the screen', async ({ page }) => {
  await page.goto(PAGE);
  const els = page.locator('[data-plate],[data-inv]');
  expect(await els.count()).toBe(6);
  for (const el of await els.all()) {
    // the hero plate is on screen at load
    if (await el.evaluate((e) => e.getBoundingClientRect().top > innerHeight)) await expect(el).not.toHaveClass(/\bin\b/);
    await el.scrollIntoViewIfNeeded();
    await expect(el).toHaveClass(/\bin\b/);
  }
});

test('red: the closing line check fails when it never shows', async ({ page }) => {
  await mutate(page, PAGE, "big.style.visibility = '';", "big.style.visibility = 'hidden';");
  await page.goto(PAGE);
  const big = page.locator('.band .big');
  await big.scrollIntoViewIfNeeded();
  await page.locator('footer').scrollIntoViewIfNeeded();
  await expect(big).not.toHaveCSS('visibility', 'visible');
});

const ANIM = 'img[data-anim]';
const frozen = (page) => page.locator(ANIM).evaluateAll((imgs) => imgs.map((i) => i.src.slice(0, 22)));

test('with reduced motion, animated screenshots become one still frame and the type is plain', async ({ open }) => {
  const page = await open(PAGE, { reducedMotion: 'reduce' });
  expect(await page.locator(ANIM).evaluateAll((imgs) => imgs.map((i) => i.loading))).toEqual(Array(8).fill('eager'));
  await expect.poll(() => frozen(page)).toEqual(Array(8).fill('data:image/png;base64,'));
  expect(await page.locator('.ch').count()).toBe(0);
  await expect(page.locator('h1 .l1')).toHaveText('Moving');
  await expect(page.locator('.band .big')).toHaveCSS('visibility', 'visible');
});

test('with reduced motion, a screenshot already loaded is frozen at once', async ({ open }) => {
  const page = await open(null, { reducedMotion: 'reduce' });
  // The same page with eager images and a blocking script before ours that answers only once the
  // images are loaded. The inline script is unchanged, so its coverage still counts.
  const fs = await import('node:fs');
  const html = fs.readFileSync(PAGE, 'utf8').replaceAll(' loading="lazy"', '')
    .replace('<script>\n(() => {', '<script src="/__wait.js"></script><script>\n(() => {');
  await page.route((u) => u.pathname === '/' + PAGE, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.route('**/__wait.js', async (r) => {
    await expect.poll(() => page.evaluate((s) => [...document.querySelectorAll(s)].every((i) => i.complete && i.naturalWidth > 0), ANIM)).toBe(true);
    await r.fulfill({ contentType: 'text/javascript', body: 'window.__loadedBefore = true;' });
  });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  expect(await page.evaluate(() => window.__loadedBefore)).toBe(true);
  expect(await frozen(page)).toEqual(Array(8).fill('data:image/png;base64,'));
});

test('with reduced motion, a screenshot that cannot be copied keeps moving', async ({ open }) => {
  const init = `window.__tries = 0;
    HTMLCanvasElement.prototype.toDataURL = function () { window.__tries++; throw new DOMException('tainted', 'SecurityError'); };`;
  const page = await open(PAGE, { reducedMotion: 'reduce', init });
  await expect.poll(() => page.evaluate(() => window.__tries)).toBe(8);
  expect(await page.locator(ANIM).evaluateAll((imgs) => imgs.every((i) => i.src.endsWith('.webp')))).toBe(true);
});
