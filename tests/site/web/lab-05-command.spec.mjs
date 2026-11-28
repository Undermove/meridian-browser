import { test, expect, mutate } from './fixtures.mjs';

const FILE = 'site/lab/05-command.html';
const DL = 'https://github.com/Undermove/meridian-browser/releases/latest/download/Meridian-';
const MAC_DMG = DL + 'mac-arm64.dmg';
const WIN_EXE = DL + 'win.exe';
const BREW = 'brew install --cask undermove/tap/meridian';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  odd: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

// Init scripts (strings, so they can take arguments).
const call = (fn, arg) => `(${fn})(${JSON.stringify(arg ?? null)})`;
// Chromium fills userAgentData from the UA; dropping it makes the page fall back to navigator.platform.
const platform = (p) => call((p) => {
  Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  Object.defineProperty(Navigator.prototype, 'platform', { get: () => p });
}, p);
const touchPoints = (n) => call((n) => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => n }), n);
const clipboard = (ok) => call((ok) => {
  window.__clip = [];
  Object.defineProperty(navigator.clipboard, 'writeText', {
    value: async (t) => { if (!ok) throw new Error('denied'); window.__clip.push(t); },
  });
  window.__exec = [];
  const exec = document.execCommand.bind(document);
  document.execCommand = (cmd) => { window.__exec.push([cmd, String(getSelection()) || document.activeElement.value]); return exec(cmd); };
}, ok);
const share = (ok) => call((ok) => {
  window.__share = [];
  navigator.share = async (d) => { window.__share.push(d.url); if (!ok) throw new Error('AbortError'); };
}, ok);
const RANDOM_ZERO = 'Math.random = () => 0;';
// Catches dots drawn at non-finite coordinates, and records the colour of the dot at __watch.
const SPY = call(() => {
  window.__bad = 0;
  window.__at = [];
  const fill = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
    if (![x, y, w, h].every(Number.isFinite)) window.__bad++;
    if (window.__watch && x + w / 2 === window.__watch[0] && y + h / 2 === window.__watch[1]) window.__at.push(this.fillStyle);
    return fill.call(this, x, y, w, h);
  };
});

// install() alone lets fake time flow with real time; pausing makes every step explicit. The pause
// must lie ahead of the flowing clock, so it is far ahead of the install time.
async function pauseClock(page) {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1e6);
}

const gridPrint = (page) => page.evaluate(() => {
  const c = document.querySelector('#grid');
  const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < px.length; i += 7) h = (h * 31 + px[i]) | 0;
  return h;
});

async function load(open, { ua = UA.mac, init = [], clock = false, ...options } = {}) {
  const page = await open(null, { userAgent: ua, viewport: { width: 1280, height: 800 }, init, ...options });
  if (clock) await pauseClock(page);
  await page.goto(FILE);
  return page;
}

async function until(page, fn, arg, step = 8, max = 60000) {
  for (let t = 0; t <= max; t += step) {
    if (await page.evaluate(fn, arg)) return;
    await page.clock.runFor(step);
  }
  throw new Error('until: never true: ' + fn);
}

const ghost = (page) => page.locator('#ghost b');
const rows = (page) => page.locator('#list .row');
const titles = (page) => page.locator('#list .row .tt').allTextContents();
const selected = (page) => page.locator('#list .row.sel .tt');
const panelOn = (page) => page.locator('#body .panel.on');

const OS_CASES = [
  { name: 'Mac', ua: UA.mac, href: MAC_DMG, label: 'Download for Mac', small: 'Free · Apple silicon (M1 and newer)', tab: 'mac' },
  { name: 'Windows', ua: UA.win, href: WIN_EXE, label: 'Download for Windows', small: 'Free · Windows 10 and 11', tab: 'win' },
  { name: 'Linux', ua: UA.linux, href: '#install', label: 'Download Meridian', small: "Meridian for Linux isn't out yet", tab: 'linux' },
  { name: 'Android', ua: UA.android, href: '#install', label: 'Send to my computer', small: 'Free · Meridian is for Mac and Windows', tab: 'mac' },
  { name: 'an iPad that says Mac', ua: UA.mac, init: [touchPoints(5)], href: '#install', label: 'Send to my computer', small: 'Free · Meridian is for Mac and Windows', tab: 'mac' },
  { name: 'an unknown system', ua: UA.odd, init: [platform('')], href: '#install', label: 'Download Meridian', small: '', tab: 'mac' },
  { name: 'Windows by navigator.platform only', ua: UA.odd, init: [platform('Win32')], href: WIN_EXE, label: 'Download for Windows', small: 'Free · Windows 10 and 11', tab: 'win' },
];

async function expectOs(page, c) {
  for (const a of await page.locator('[data-cta]').all()) {
    await expect(a).toHaveAttribute('href', c.href);
    await expect(a.locator('[data-cta-label]')).toHaveText(c.label);
  }
  for (const s of await page.locator('[data-cta-small]').all()) await expect(s).toHaveText(c.small);
  await expect(page.locator(`#tab-${c.tab}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ospanel:not([hidden])')).toHaveAttribute('id', 'os-' + c.tab);
}

for (const c of OS_CASES) {
  test(`${c.name}: the CTAs and the install tab match the system`, async ({ open }) => {
    const page = await load(open, { ua: c.ua, init: c.init });
    await expect(page.locator('[data-cta]')).toHaveCount(3);
    await expectOs(page, c);
  });
}

test('the Mac CTA test fails when the Mac link changes', async ({ open }) => {
  const page = await open(null, { userAgent: UA.mac });
  await mutate(page, FILE, "DL + 'mac-arm64.dmg'", "DL + 'mac.dmg'");
  await page.goto(FILE);
  await expect(expectOs(page, { ...OS_CASES[0] }).then(() => 'passed', () => 'failed')).resolves.toBe('failed');
});

test('a phone shares the page link instead of downloading', async ({ open }) => {
  const page = await load(open, { ua: UA.iphone, init: [share(true), clipboard(true)] });
  const cta = page.locator('.end [data-cta]');
  await cta.click();
  await expect.poll(() => page.evaluate(() => window.__share)).toEqual(['https://meridianbrowser.app/?ref=send']);
  expect(page.url()).not.toContain('#install');
  await expect(cta).toHaveText('Send to my computer');
  expect(await page.evaluate(() => window.__clip)).toEqual([]);
});

test('a phone whose share sheet is cancelled copies the link', async ({ open }) => {
  const page = await load(open, { ua: UA.iphone, init: [share(false), clipboard(true)] });
  await page.locator('.end [data-cta]').click();
  await expect(page.locator('[data-cta-label]').first()).toHaveText('Link copied');
  for (const l of await page.locator('[data-cta-label]').all()) await expect(l).toHaveText('Link copied');
  expect(await page.evaluate(() => window.__clip)).toEqual(['https://meridianbrowser.app/?ref=send']);
});

test('install tabs show one panel at a time', async ({ open }) => {
  const page = await load(open);
  for (const os of ['win', 'linux', 'mac']) {
    await page.locator(`#tab-${os}`).click();
    for (const o of ['mac', 'win', 'linux']) {
      await expect(page.locator(`#tab-${o}`)).toHaveAttribute('aria-selected', String(o === os));
      if (o === os) await expect(page.locator(`#os-${o}`)).toBeVisible();
      else await expect(page.locator(`#os-${o}`)).toBeHidden();
    }
  }
});

test('Copy command copies the brew line and says so for 1.8 s', async ({ open }) => {
  const page = await load(open, { init: [clipboard(true)], clock: true });
  const b = page.locator('.term [data-copy]');
  await b.click();
  await expect(b).toHaveText('Copied');
  await expect(b).toHaveClass(/done/);
  expect(await page.evaluate(() => window.__clip)).toEqual([BREW]);
  await page.clock.runFor(1700);
  await expect(b).toHaveText('Copied');
  await page.clock.runFor(200);
  await expect(b).toHaveText('Copy command');
  await expect(b).not.toHaveClass(/done/);
});

test('without clipboard access the command is copied through a selected textarea', async ({ open }) => {
  const page = await load(open, { init: [clipboard(false)] });
  await page.locator('.term [data-copy]').click();
  await expect(page.locator('.term [data-copy]')).toHaveText('Copied');
  expect(await page.evaluate(() => window.__exec)).toEqual([['copy', BREW]]);
  await expect(page.locator('textarea')).toHaveCount(0);
});

test('when no way to copy works, the button still says Copied and leaves no textarea behind', async ({ open }) => {
  const page = await load(open, { init: [clipboard(false), call(() => { document.execCommand = () => { throw new Error('no'); }; })] });
  await page.locator('.term [data-copy]').click();
  await expect(page.locator('.term [data-copy]')).toHaveText('Copied');
  await expect(page.locator('textarea')).toHaveCount(0);
});

async function drive(page) {
  await page.locator('#in').click();
  await expect(page.locator('#status')).toHaveText("You're driving");
}

test('focusing the bar takes over and lists everything in groups', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await expect(page.locator('#hk')).toHaveText('esc');
  await expect(page.locator('#in')).toHaveAttribute('placeholder', 'Type a feature or a question');
  await expect(page.locator('#in')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#body')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#list .grp')).toHaveText(['Actions', 'Features', 'Questions']);
  await expect(rows(page)).toHaveCount(6 + 9 + 7);
  await expect(selected(page)).toHaveText('Download Meridian');
  await expect(page.locator('#in')).toHaveAttribute('aria-activedescendant', 'r0');
  await expect(page.locator('#list a.row[href="https://discord.gg/kuQRHfG39r"]')).toHaveAttribute('target', '_blank');
  await expect(page.locator(`#list a.row[href="${MAC_DMG}"]`)).not.toHaveAttribute('target', /.*/);
  // a second focus doesn't rebuild the list
  await page.keyboard.press('ArrowDown');
  await page.locator('#back').focus();
  await page.locator('#in').focus();
  await expect(selected(page)).toHaveText('Download for Mac');
});

const QUERIES = [
  // title words count double: the free question beats the download action whose keywords say free
  { q: 'free', first: 'Is it really free?', has: ['Download Meridian'] },
  // equal scores keep the page order
  { q: 'download', top: ['Download Meridian', 'Download for Mac', 'Download for Windows'] },
  // prefix, infix and a scattered first-letter match
  { q: 'spl', first: 'Split view & Peek' },
  { q: 'plit', first: 'Split view & Peek' },
  { q: 'sdbr', first: 'Spaces & sidebar' },
  { q: 'split zzz', none: true },
  // a whole word beats the start of one
  { q: 'window', top: ['Why does Windows show a blue window?', 'Download for Windows'] },
  // scattered matches need three letters and the same first letter
  { q: 'sb', none: true },
  { q: 'plt', none: true },
];

for (const c of QUERIES) {
  test(`typing "${c.q}" shows the right results`, async ({ open }) => {
    const page = await load(open, { clock: true });
    await drive(page);
    await page.keyboard.type(c.q);
    if (c.none) {
      await expect(rows(page)).toHaveCount(0);
      await expect(page.locator('#list .none')).toHaveText(`Nothing for ${c.q}.Try split, import, free or download.`);
      await expect(page.locator('#in')).not.toHaveAttribute('aria-activedescendant', /.*/);
      return;
    }
    await expect(page.locator('#list .grp')).toHaveCount(0);
    if (c.first) await expect(rows(page).first().locator('.tt')).toHaveText(c.first);
    if (c.top) expect((await titles(page)).slice(0, c.top.length)).toEqual(c.top);
    if (c.has) expect(await titles(page)).toEqual(expect.arrayContaining(c.has));
    await expect(selected(page)).toHaveText((await titles(page))[0]);
  });
}

test('the matched part of a title is marked, also at its end', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('meridian');
  await expect(rows(page).first().locator('.tt')).toHaveJSProperty('innerHTML', 'Download <mark>Meridian</mark>');
  await page.locator('#in').fill('');
  await page.keyboard.type('view');
  await expect(rows(page).first().locator('.tt')).toHaveJSProperty('innerHTML', 'Split <mark>view</mark> &amp; Peek');
  await page.locator('#in').fill('');
  await page.keyboard.type('split');
  await expect(rows(page).first().locator('.tt')).toHaveJSProperty('innerHTML', '<mark>Split</mark> view &amp; Peek');
});

test('a query of only spaces lists everything in groups', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('  ');
  await expect(page.locator('#list .grp')).toHaveText(['Actions', 'Features', 'Questions']);
  await expect(rows(page)).toHaveCount(6 + 9 + 7);
});

test('a query is shown escaped when nothing matches', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('<zzz>');
  await expect(page.locator('#list .none b').first()).toHaveText('<zzz>');
  await expect(page.locator('#list .none zzz')).toHaveCount(0);
});

test('arrows move the selection and wrap', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toHaveText('Is there a Linux build?');
  await expect(page.locator('#in')).toHaveAttribute('aria-activedescendant', 'r21');
  // the list scrolls to keep the selection in view
  const inView = () => page.evaluate(() => {
    const l = document.querySelector('#list').getBoundingClientRect(), r = document.querySelector('#list .row.sel').getBoundingClientRect();
    return r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5;
  });
  expect(await page.locator('#list').evaluate((l) => l.scrollHeight > l.clientHeight)).toBe(true);
  await expect.poll(inView).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveText('Download Meridian');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveText('Download for Mac');
  await expect(page.locator('#list .row.sel')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#in')).toBeFocused();
  await page.keyboard.type('zzz');
  await page.keyboard.press('ArrowDown');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#list .none')).toBeVisible();
});

test('the arrow test fails when the arrow step changes', async ({ open }) => {
  const page = await open(null, { userAgent: UA.mac });
  await pauseClock(page);
  await mutate(page, FILE, "(e.key === 'ArrowDown' ? 1 : -1)", "(e.key === 'ArrowDown' ? 2 : -1)");
  await page.goto(FILE);
  await drive(page);
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).not.toHaveText('Download for Mac');
});

test('Enter on a feature opens its panel; arrows, Esc and Back return to the list', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('split');
  await page.keyboard.press('Enter');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  await expect(panelOn(page).locator('h3')).toHaveText('Split view & Peek');
  await expect(panelOn(page).locator('img')).toHaveAttribute('src', '../../docs/readme/split-view.webp');
  await expect(page.locator('#list')).toBeHidden();
  await expect(page.locator('#in')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#core')).toHaveClass(/inpanel/);
  await expect(page.locator('#bar')).toHaveClass(/hit/);
  await page.keyboard.press('Enter');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  await page.keyboard.press('ArrowDown');
  await expect(panelOn(page)).toHaveCount(0);
  await expect(selected(page)).toHaveText('Split view & Peek');
  await page.keyboard.press('Enter');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  await page.keyboard.press('Escape');
  await expect(selected(page)).toHaveText('Split view & Peek');
  await expect(page.locator('#in')).toHaveValue('split');
  await page.keyboard.press('Enter');
  await page.locator('#back').click();
  await expect(selected(page)).toHaveText('Split view & Peek');
  await expect(page.locator('#in')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#in')).toHaveValue('');
  await expect(page.locator('#list .grp')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('#status')).toHaveText('Autoplay · type to take over');
  await expect(page.locator('#hk')).toHaveText('/');
  await expect(page.locator('#in')).not.toBeFocused();
  await expect(page.locator('#in')).toHaveAttribute('placeholder', '');
  await expect(page.locator('#body')).not.toHaveAttribute('aria-live', /.*/);
  await page.clock.runFor(200);
  await expect(ghost(page)).toHaveText(/^s/);
});

test('Enter with no results does nothing', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('zzz');
  await page.keyboard.press('Enter');
  await expect(page.locator('#list .none')).toBeVisible();
  await expect(panelOn(page)).toHaveCount(0);
});

test('Enter on a download row follows its link', async ({ open }) => {
  const page = await load(open, { clock: true });
  // 204: the browser stays on the page
  const asked = [];
  await page.route(MAC_DMG, (r) => { asked.push(r.request().url()); return r.fulfill({ status: 204 }); });
  await drive(page);
  await page.keyboard.type('mac');
  await expect(selected(page)).toHaveText('Download for Mac');
  await page.keyboard.press('Enter');
  await expect.poll(() => asked).toEqual([MAC_DMG]);
});

test('Enter on an outside link opens it in a new tab', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('discord');
  await expect(selected(page)).toHaveText('Discord');
  const [popup] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('Enter')]);
  await expect.poll(() => popup.evaluate(() => window.opener === null)).toBe(true);
  expect(page.url()).toContain(FILE);
});

test('Enter on Copy brew command copies it, marks the row for 1.6 s and keeps it selected', async ({ open }) => {
  const page = await load(open, { init: [clipboard(true)], clock: true });
  await drive(page);
  await page.keyboard.type('brew');
  await page.keyboard.press('ArrowDown');
  const sel = (await selected(page).textContent());
  await page.keyboard.press('ArrowUp');
  await expect(selected(page)).toHaveText('Copy brew command');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__clip)).toEqual([BREW]);
  await expect(page.locator('#list .row.sel .ty')).toHaveText('Copied');
  await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveText(sel);
  await page.clock.runFor(1700);
  await expect(page.locator('#list .row .ty').first()).toHaveText('Action');
  await expect(selected(page)).toHaveText(sel);
});

test('Enter on Copy brew command lower in the list keeps that row selected', async ({ open }) => {
  const page = await load(open, { init: [clipboard(true)], clock: true });
  await drive(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await expect(selected(page)).toHaveText('Copy brew command');
  await page.keyboard.press('Enter');
  await expect(page.locator('#list .row.sel .ty')).toHaveText('Copied');
  await expect(selected(page)).toHaveText('Copy brew command');
});

test('a panel loads its picture only when it opens', async ({ open }) => {
  const page = await load(open, { clock: true });
  const srcs = () => page.locator('#body .panel img').evaluateAll((ims) => ims.map((i) => [i.closest('.panel').dataset.id, !!i.getAttribute('src')]));
  const before = await srcs();
  expect(before.length).toBeGreaterThan(3);
  expect(before.every(([, has]) => !has)).toBe(true);
  await drive(page);
  await page.keyboard.type('import');
  await page.keyboard.press('Enter');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'import');
  expect((await srcs()).filter(([, has]) => has).map(([id]) => id)).toEqual(['import']);
});

test('a copy timer that ends while a panel is open leaves the panel alone', async ({ open }) => {
  const page = await load(open, { init: [clipboard(true)], clock: true });
  await drive(page);
  await page.keyboard.type('copy brew');
  await page.keyboard.press('Enter');
  await expect(page.locator('#list .row.sel .ty')).toHaveText('Copied');
  await page.locator('#in').fill('split');
  await page.keyboard.press('Enter');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  await page.clock.runFor(1700);
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  await expect(page.locator('#list')).toBeHidden();
});

test('hovering a row selects it; pressing it opens it and keeps focus in the bar', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  const row = page.locator('#list .row', { hasText: 'One-click Arc import' });
  await row.hover();
  await expect(selected(page)).toHaveText('One-click Arc import');
  await page.mouse.move(5, 5);
  await row.hover();
  await expect(selected(page)).toHaveText('One-click Arc import');
  await row.click();
  await expect(panelOn(page)).toHaveAttribute('data-id', 'import');
  await expect(page.locator('#in')).toBeFocused();
});

test('pressing a link row leaves it to the link and keeps focus', async ({ open }) => {
  const page = await load(open, { clock: true });
  const asked = [];
  await page.route(WIN_EXE, (r) => { asked.push(r.request().url()); return r.fulfill({ status: 204 }); });
  await drive(page);
  await page.locator('#list .row', { hasText: 'Download for Windows' }).click();
  await expect.poll(() => asked).toEqual([WIN_EXE]);
  await expect(page.locator('#in')).toBeFocused();
  await expect(panelOn(page)).toHaveCount(0);
});

test('a click anywhere on the bar focuses the input', async ({ open }) => {
  const page = await load(open, { clock: true });
  await page.locator('#bar > img').click();
  await expect(page.locator('#in')).toBeFocused();
  await expect(page.locator('#status')).toHaveText("You're driving");
});

for (const key of ['/', 'Meta+k', 'Control+K']) {
  test(`${key} from lower on the page jumps to the bar`, async ({ open }) => {
    const page = await load(open, { clock: true });
    await page.locator('#faq').scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(500);
    await page.keyboard.press(key);
    await expect(page.locator('#in')).toBeFocused();
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('#stage').getBoundingClientRect().top))).toBe(0);
    await expect(page.locator('#in')).toHaveValue('');
  });
}

test('/ while typing in the bar is just a character', async ({ open }) => {
  const page = await load(open, { clock: true });
  await drive(page);
  await page.keyboard.type('a/');
  await expect(page.locator('#in')).toHaveValue('a/');
});

test('a chip takes over and opens its panel', async ({ open }) => {
  const page = await load(open, { clock: true });
  const chips = page.locator('#chips .chip');
  await expect(chips).toHaveText(['split view', 'import from arc', 'ask this page', 'is it free', 'download', 'mcp server']);
  await chips.nth(4).click();
  await expect(page.locator('#status')).toHaveText("You're driving");
  await expect(page.locator('#in')).toHaveValue('download');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'download');
  for (let i = 0; i < 6; i++) await expect(chips.nth(i)).toHaveClass(i === 4 ? /\bon\b/ : /^chip$/);
});

const ghostIs = (t) => document.querySelector('#ghost b').textContent === t;
const panelIs = (id) => document.querySelector('#body .panel.on')?.dataset.id === id;

// Takes over at the current step, checks the loop stopped there, and hands the bar back.
async function interrupt(page, still) {
  const before = await ghost(page).textContent();
  await page.locator('#in').click();
  await page.clock.runFor(7000);
  await expect(ghost(page)).toHaveText(before);
  if (still) await still();
  await page.keyboard.press('Escape');
  await expect(page.locator('#status')).toHaveText('Autoplay · type to take over');
}

test('the autoplay stops at whatever step the reader takes over', async ({ open }) => {
  // hundreds of clock steps, slow under parallel load
  test.setTimeout(120000);
  const page = await load(open, { init: [RANDOM_ZERO], clock: true });
  await until(page, ghostIs, 'spl');
  await interrupt(page);
  // typed, before its panel opens (it stays so for 48 + 320 ms)
  await until(page, ghostIs, 'split view', 40);
  await page.clock.runFor(100);
  await interrupt(page, () => expect(panelOn(page)).toHaveCount(0));
  // while its panel shows (5.2 s)
  await until(page, panelIs, 'split', 50);
  await interrupt(page);
  // while erasing; coarse steps through the hold, then fine ones
  await until(page, panelIs, 'split', 50);
  await page.clock.runFor(5000);
  await until(page, ghostIs, 'split vi');
  await interrupt(page);
  // erased, before the next one starts
  await until(page, panelIs, 'split', 50);
  await page.clock.runFor(5000);
  await until(page, ghostIs, '');
  // past the last erase step's 22 ms
  await page.clock.runFor(30);
  await interrupt(page, () => expect(page.locator('#chips .chip.on')).toHaveCount(0));
});

test('the take-over test fails when waits ignore the reader', async ({ open }) => {
  test.setTimeout(120000);
  const page = await open(null, { userAgent: UA.mac, viewport: { width: 1280, height: 800 }, init: [RANDOM_ZERO] });
  await pauseClock(page);
  await mutate(page, FILE, 'return my === token; }', 'return true; }');
  await page.goto(FILE);
  await until(page, panelIs, 'split', 50);
  await expect(interrupt(page)).rejects.toThrow(/toHaveText/);
});

test('the autoplay plays every chip in turn and starts over', async ({ open }) => {
  // hundreds of clock steps, slow under parallel load
  test.setTimeout(120000);
  const page = await load(open, { init: [RANDOM_ZERO], clock: true });
  const chips = page.locator('#chips .chip');
  const DEMO = [['split view', 'split'], ['import from arc', 'import'], ['ask this page', 'ai'], ['is it free', 'q0'], ['download', 'download'], ['mcp server', 'mcp']];
  for (const [i, [q, id]] of DEMO.entries()) {
    await until(page, ghostIs, q, 250);
    await expect(chips.nth(i)).toHaveClass(/\bon\b/);
    await until(page, panelIs, id, 500);
    await expect(chips.nth(i)).toHaveClass(/\brun\b/);
    await expect(page.locator('#chips .chip.on')).toHaveCount(1);
  }
  await until(page, () => document.querySelector('#chips .chip').classList.contains('on'), null, 250);
  await expect(ghost(page)).toHaveText(/^s/);
  await expect(chips.nth(5)).not.toHaveClass(/\bon\b/);
});

test('the autoplay waits while the stage is off screen', async ({ open }) => {
  // hundreds of clock steps, slow under parallel load
  test.setTimeout(120000);
  const page = await load(open, { init: [RANDOM_ZERO, SPY], clock: true });
  await until(page, ghostIs, 'spl');
  await page.evaluate(() => scrollTo(0, 3000));
  // the observer reports on a real frame; once the ghost holds still, it has
  await expect.poll(async () => {
    const a = await ghost(page).textContent();
    await page.clock.runFor(300);
    return a === await ghost(page).textContent();
  }).toBe(true);
  const held = await ghost(page).textContent();
  const grid = await gridPrint(page);
  await page.clock.runFor(8000);
  await expect(ghost(page)).toHaveText(held);
  await expect(panelOn(page)).toHaveCount(0);
  expect(await gridPrint(page)).toBe(grid);
  await page.evaluate(() => scrollTo(0, 0));
  await expect.poll(async () => {
    await page.clock.runFor(300);
    return (await ghost(page).textContent()).length > held.length;
  }).toBe(true);
  expect(await gridPrint(page)).not.toBe(grid);
});

test('the off-screen test fails when waits ignore the stage', async ({ open }) => {
  const page = await open(null, { userAgent: UA.mac, viewport: { width: 1280, height: 800 }, init: [RANDOM_ZERO] });
  await pauseClock(page);
  await mutate(page, FILE, '(!stageSeen || document.hidden)', '(document.hidden)');
  await page.goto(FILE);
  await until(page, ghostIs, 'spl');
  await page.evaluate(() => scrollTo(0, 3000));
  const held = await ghost(page).textContent();
  await page.clock.runFor(8000);
  await expect(ghost(page)).not.toHaveText(held);
});

test('with reduced motion the bar shows one answer, still, and everything is revealed', async ({ open }) => {
  const page = await load(open, { reducedMotion: 'reduce', clock: true });
  await expect(ghost(page)).toHaveText('split view');
  await expect(page.locator('#chips .chip').first()).toHaveClass(/\bon\b/);
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  await expect(page.locator('#bar')).not.toHaveClass(/hit/);
  const grid = await gridPrint(page);
  await page.clock.runFor(10000);
  await expect(ghost(page)).toHaveText('split view');
  await expect(page.locator('.rv:not(.in)')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const c = document.querySelector('#grid');
    return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0);
  })).toBe(true);
  await page.mouse.move(150, 700);
  await page.clock.runFor(500);
  expect(await gridPrint(page)).toBe(grid);
  expect(await orangeNear(page, 150, 700, 60)).toBe(0);
});

test('without reduced motion sections reveal as they scroll in', async ({ open }) => {
  const page = await load(open, { clock: true });
  const rv = page.locator('.rv');
  const n = await rv.count();
  await expect(page.locator('#faq .faq.rv')).not.toHaveClass(/\bin\b/);
  for (let i = 0; i < n; i++) {
    await rv.nth(i).scrollIntoViewIfNeeded();
    await expect(rv.nth(i)).toHaveClass(/\bin\b/);
  }
});

const ORANGE = [255, 90, 38];
const orangeNear = (page, x, y, r) => page.evaluate(([x, y, r, o]) => {
  const c = document.querySelector('#grid'), d = c.width / c.clientWidth;
  const px = c.getContext('2d').getImageData((x - r) * d, (y - r) * d, 2 * r * d, 2 * r * d).data;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] === o[0] && px[i + 1] === o[1] && px[i + 2] === o[2] && px[i + 3] > 0) n++;
  return n;
}, [x, y, r, ORANGE]);

test('the pointer lights the dots near it, and they cool when it leaves', async ({ open }) => {
  const page = await load(open, { clock: true });
  // an empty spot of the stage, below the bar's output
  const [x, y] = [150, 700];
  expect(await orangeNear(page, x, y, 60)).toBe(0);
  await page.mouse.move(x, y);
  await page.clock.runFor(1000);
  expect(await orangeNear(page, x, y, 60)).toBeGreaterThan(0);
  await page.mouse.move(x, 900);
  await page.clock.runFor(1500);
  expect(await orangeNear(page, x, y, 60)).toBe(0);
});

test('opening a panel sends a ring out from the bar that fades', async ({ open }) => {
  const page = await load(open, { clock: true });
  // focus without the mouse: a pointer over the stage would light dots too
  await page.locator('#in').focus();
  await page.keyboard.type('split');
  const box = await page.locator('#bar').boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  const ringAt = () => page.evaluate(([cx, cy]) => {
    const c = document.querySelector('#grid'), g = c.getContext('2d');
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const ds = [];
    for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 90) {
      const p = i / 4, x = p % c.width, y = Math.floor(p / c.width);
      ds.push(Math.hypot(x - cx, y - cy));
    }
    return ds.length ? Math.round(ds.reduce((a, b) => a + b) / ds.length) : 0;
  }, [cx, cy]);
  expect(await ringAt()).toBe(0);
  await page.keyboard.press('Enter');
  await page.clock.runFor(500);
  const r1 = await ringAt();
  await page.clock.runFor(500);
  const r2 = await ringAt();
  expect(r1).toBeGreaterThan(0);
  expect(r2).toBeGreaterThan(r1);
  await page.clock.runFor(2000);
  expect(await ringAt()).toBe(0);
});

test('the grid draws once a frame, however often it is woken', async ({ open }) => {
  const page = await load(open, { init: [call(() => {
    window.__draws = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...a) { window.__draws++; return clear.apply(this, a); };
  })] });
  // a visibility event while the loop runs must not start a second one
  await page.evaluate(() => { for (let i = 0; i < 3; i++) document.dispatchEvent(new Event('visibilitychange')); });
  const [frames, draws] = await page.evaluate(() => new Promise((done) => {
    const d0 = window.__draws;
    let n = 0;
    const tick = () => { if (++n < 30) requestAnimationFrame(tick); else done([n, window.__draws - d0]); };
    requestAnimationFrame(tick);
  }));
  expect(draws).toBeLessThanOrEqual(frames + 1);
  expect(draws).toBeGreaterThanOrEqual(frames - 1);
});

test('Enter on a panel already open sends no second ring', async ({ open }) => {
  const page = await load(open, { clock: true });
  // focus without the mouse: a pointer over the stage would light dots too
  await page.locator('#in').focus();
  await page.keyboard.type('split');
  await page.keyboard.press('Enter');
  await expect(panelOn(page)).toHaveAttribute('data-id', 'split');
  const lit = () => page.evaluate(() => {
    const c = document.querySelector('#grid'), px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 90) n++;
    return n;
  });
  await page.clock.runFor(500);
  expect(await lit()).toBeGreaterThan(0);
  // past the ring's 2.6 s
  await page.clock.runFor(3000);
  expect(await lit()).toBe(0);
  await page.keyboard.press('Enter');
  await page.clock.runFor(300);
  expect(await lit()).toBe(0);
});

test('the canvas matches the screen density, up to 2x', async ({ open }) => {
  for (const [dpr, scale] of [[1, 1], [3, 2]]) {
    const page = await load(open, { deviceScaleFactor: dpr });
    await expect.poll(() => page.evaluate(() => {
      const c = document.querySelector('#grid'), s = document.querySelector('#stage');
      return [c.width / s.clientWidth, c.height / s.clientHeight];
    })).toEqual([scale, scale]);
  }
});

test('a missing devicePixelRatio counts as 1', async ({ open }) => {
  const page = await load(open, { deviceScaleFactor: 2, init: [call(() => Object.defineProperty(window, 'devicePixelRatio', { get: () => 0 }))] });
  await expect.poll(() => page.evaluate(() => {
    const c = document.querySelector('#grid'), s = document.querySelector('#stage');
    return [c.width - s.clientWidth, c.height - s.clientHeight, s.clientWidth > 0];
  })).toEqual([0, 0, true]);
});

// The eased pointer stops exactly on a dot only for these doubles (found by iterating the page's
// px += (tx - px) * 0.14 in node); a real mouse never lands there, a synthetic event can.
const DOT = [626, 433.5], AIM = [626.0000000000003, 433.50000000000017];
// Those dots assume a 1280x839 stage, whose height comes from font metrics (the fonts differ by
// platform), so the stage is pinned before the page parses.
const STAGE_839 = () => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('#stage{height:840px!important;min-height:0!important}'); // border-box, 1px bottom border
  document.adoptedStyleSheets = [sheet];
};

async function pointerOnDot(page) {
  await expect.poll(() => page.evaluate(() => [document.querySelector('#stage').clientWidth, document.querySelector('#stage').clientHeight])).toEqual([1280, 839]);
  await page.evaluate(([dot, [x, y]]) => {
    window.__watch = dot;
    document.querySelector('#stage').dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
  }, [DOT, AIM]);
  await page.clock.runFor(16 * 400);
}

test('a dot exactly under the pointer is still drawn, lit, in place', async ({ open }) => {
  const page = await load(open, { init: [SPY, STAGE_839], clock: true });
  await pointerOnDot(page);
  expect(await page.evaluate(() => window.__bad)).toBe(0);
  expect(await page.evaluate(() => window.__at.at(-1))).toBe('#ff5a26');
});

test('the dot-under-pointer test fails without the zero-distance guard', async ({ open }) => {
  const page = await open(null, { userAgent: UA.mac, viewport: { width: 1280, height: 800 }, init: [SPY, STAGE_839] });
  await pauseClock(page);
  await mutate(page, FILE, 'dx = (ex / (d || 1)) * k * 9; dy = (ey / (d || 1)) * k * 9;', 'dx = (ex / d) * k * 9; dy = (ey / d) * k * 9;');
  await page.goto(FILE);
  await pointerOnDot(page);
  expect(await page.evaluate(() => window.__bad)).toBeGreaterThan(0);
});
