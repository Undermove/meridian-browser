import { test, expect, mutate } from './fixtures.mjs';
import { load as loadAt, press } from './scene-helpers.mjs';

const load = (open, before) => loadAt(open, '#spl', { before });

const grip = (page) => page.locator('#grip');
const link = (page, k) => page.locator(`#spl .lnk[data-k="${k}"]`);
const width = (page, sel) => page.locator(sel).evaluate((e) => e.style.width);

test('the divider starts in the middle', async ({ open }) => {
  const page = await load(open);
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '50');
  expect(await width(page, '#pl')).toBe('372px');
  expect(await width(page, '#pr')).toBe('372px');
  await expect(page.locator('#pr')).toHaveCSS('left', '8px');
});

test('arrow keys move the divider by 5% and stop at 28% and 72%', async ({ open }) => {
  const page = await load(open);
  await grip(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '55');
  await expect(page.locator('#spl')).toHaveClass(/\bsnap\b/);
  // 760 * .55 - 8
  expect(await width(page, '#pl')).toBe('410px');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '45');
  await page.keyboard.press('a');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '45');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '72');
  for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowLeft');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '28');
});

test('dragging the grip moves the divider with the pointer', async ({ open }) => {
  const page = await load(open);
  const spl = page.locator('#spl');
  const b = await grip(page).boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect(spl).toHaveClass(/\bdrag\b/);
  await page.mouse.move(x + 60, y, { steps: 4 });
  const mid = Number(await grip(page).getAttribute('aria-valuenow'));
  expect(mid).toBeGreaterThan(50);
  expect(mid).toBeLessThan(72);
  await page.mouse.move(x + 1000, y, { steps: 4 });
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '72');
  await page.mouse.up();
  await expect(spl).not.toHaveClass(/\bdrag\b/);
  // after the drop, moving the pointer over the grip does nothing
  await page.mouse.move(x - 1000, y, { steps: 2 });
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '72');

  const c = await grip(page).boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x - 1000, c.y + c.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '28');
});

test('the switch turns split view off and on', async ({ open }) => {
  const page = await load(open);
  const keys = page.locator('#keys');
  await grip(page).focus();
  await page.keyboard.press('ArrowRight');
  await keys.click();
  await expect(keys).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#spl')).toHaveClass(/\bone\b/);
  expect(await width(page, '#pl')).toBe('760px');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '50');
  await keys.click();
  await expect(keys).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#spl')).not.toHaveClass(/\bone\b/);
  expect(await width(page, '#pl')).toBe('372px');
});

test('a link opens in the peek card; another link swaps it; the same link closes it', async ({ open }) => {
  const page = await load(open);
  const spl = page.locator('#spl'), pk = page.locator('#pk');
  await press(link(page, 'train'));
  await expect(spl).toHaveClass(/\bopen\b/);
  await expect(link(page, 'train')).toHaveClass(/\bcur\b/);
  await expect(pk.locator('.pkh span')).toHaveText('Night train times');
  await expect(pk.locator('.big')).toHaveText('21:40');
  await expect(pk.locator('.thin')).toHaveText('Friday, platform 4');
  await expect(pk).not.toHaveClass(/\bswap\b/);

  await press(link(page, 'cafe'));
  await expect(pk.locator('.pkh span')).toHaveText('The station café');
  await expect(pk).toHaveClass(/\bswap\b/);
  await expect(page.locator('#spl .lnk.cur')).toHaveCount(1);

  await press(link(page, 'cafe'));
  await expect(spl).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#spl .lnk.cur')).toHaveCount(0);
});

test('the × and Escape close the peek', async ({ open }) => {
  const page = await load(open);
  const spl = page.locator('#spl');
  await press(link(page, 'home'));
  await expect(spl).toHaveClass(/\bopen\b/);
  await press(page.locator('#x'));
  await expect(spl).not.toHaveClass(/\bopen\b/);

  await press(link(page, 'home'));
  await expect(spl).toHaveClass(/\bopen\b/);
  await page.keyboard.press('Enter');
  await expect(spl).not.toHaveClass(/\bopen\b/);
  await press(link(page, 'home'));
  await page.keyboard.press('Shift');
  await expect(spl).toHaveClass(/\bopen\b/);
  await page.keyboard.press('Escape');
  await expect(spl).not.toHaveClass(/\bopen\b/);
});

test('"beside" makes the previewed page the right-hand tab', async ({ open }) => {
  const page = await load(open);
  const spl = page.locator('#spl'), pk = page.locator('#pk'), R = page.locator('#pr');
  await press(link(page, 'train'));
  await press(page.locator('#beside'));
  await expect(pk).toHaveClass(/\bland\b/);
  await expect(R).toHaveClass(/\bgone\b/);
  await expect(page.locator('#spl .lnk.cur')).toHaveCount(0);
  expect(await pk.evaluate((e) => [e.style.left, e.style.width])).toEqual(['8px', '372px']);

  // while it lands, links and a second press do nothing
  await page.locator('#beside').dispatchEvent('click');
  await link(page, 'cafe').dispatchEvent('click');
  await expect(pk.locator('.pkh span')).toHaveText('Night train times');

  await page.clock.runFor(800);
  await expect(R.locator('.big')).toHaveText('21:40');
  await expect(R.locator('.thin')).toHaveText('Friday, platform 4');
  await expect(R).not.toHaveClass(/\bgone\b/);
  await expect(pk).not.toHaveClass(/\bland\b/);
  await expect(spl).not.toHaveClass(/\bopen\b/);
  expect(await pk.evaluate((e) => [e.style.left, e.style.top, e.style.width, e.style.height])).toEqual(['-70px', '-176px', '400px', '262px']);

  // the card works again afterwards
  await press(link(page, 'home'));
  await expect(spl).toHaveClass(/\bopen\b/);
  await expect(pk.locator('.pkh span')).toHaveText('The long way home');
});

test('"beside" with nothing previewed does nothing', async ({ open }) => {
  const page = await load(open);
  await page.locator('#beside').dispatchEvent('click');
  await page.clock.runFor(900);
  await expect(page.locator('#pk')).not.toHaveClass(/\bland\b/);
  await expect(page.locator('#pr .big')).toHaveText('Write');
});

test('"beside" with split view off turns it back on with the page on the right', async ({ open }) => {
  const page = await load(open);
  const keys = page.locator('#keys');
  await keys.click();
  await expect(keys).toHaveAttribute('aria-checked', 'false');
  await press(link(page, 'cafe'));
  await press(page.locator('#beside'));
  await expect(keys).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#spl')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#spl')).not.toHaveClass(/\bone\b/);
  await expect(page.locator('#pr .big')).toHaveText('Café');
  await expect(page.locator('#pk')).not.toHaveClass(/\bland\b/);
});

test('peek and the divider work at the default viewport', async ({ page }) => {
  await page.goto('docs/index.html');
  const y = await page.locator('#split').evaluate((s) => s.offsetTop + 200);
  await page.evaluate((v) => scrollTo(0, v), y);
  await press(link(page, 'train'));
  await expect(page.locator('#spl')).toHaveClass(/\bopen\b/);
  await grip(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '55');
});

test('red: ArrowRight moves the divider right', async ({ open }) => {
  const page = await load(open, (p) => mutate(p, 'docs/index.html', "e.key === 'ArrowRight' ? .05", "e.key === 'ArrowRight' ? -.05"));
  await grip(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(grip(page)).not.toHaveAttribute('aria-valuenow', '55');
  await expect(grip(page)).toHaveAttribute('aria-valuenow', '45');
});
