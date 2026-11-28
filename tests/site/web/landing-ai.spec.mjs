import { test, expect, mutate } from './fixtures.mjs';
import { load as loadAt, freeze } from './scene-helpers.mjs';

const load = (open, options = {}, before) => loadAt(open, '#aiw', { before, ...options });

const faces = (page) => page.locator('#aipg .face').evaluateAll((els) => els.map((e) => e.className));
const button = (page, a) => page.locator(`#aiw .ab[data-a="${a}"]`);

test('the page starts as written, with no button down', async ({ open }) => {
  const page = await load(open);
  expect(await faces(page)).toEqual(['face f-base']);
  await expect(page.locator('#aipg .face .thin')).toHaveText('The morning paper');
  await expect(page.locator('#aipg .face .big')).toHaveText('Morning');
  await expect(page.locator('#aiq')).toHaveText('Ask about this page');
  await expect(page.locator('#aiw .ab.on')).toHaveCount(0);
});

test('Summarize turns the page into three points and types the question', async ({ open }) => {
  const page = await load(open);
  const aiw = page.locator('#aiw');
  await button(page, 'sum').click();
  // the button goes down and the wipe starts in the same frame
  await expect(button(page, 'sum')).toHaveClass(/\bon\b/);
  await expect(aiw).toHaveClass(/\bbusy\b/);
  expect(await faces(page)).toEqual(['face f-base', 'face f-sum wip']);
  await expect(page.locator('#aipg .f-sum')).toHaveAttribute('style', /translateZ\(1\.1px\)/);

  await page.clock.runFor(800);
  expect(await faces(page)).toEqual(['face f-sum']);
  await expect(page.locator('#aipg .bl')).toHaveText(['The night train leaves at 21:40', 'Three stops, two nights', 'Breakfast from six']);
  await expect(page.locator('#aiq')).toHaveText('Summarize this page');
  await expect(aiw).not.toHaveClass(/\bbusy\b/);
  await expect(aiw).toHaveClass(/\bpop\b/);
  await page.clock.runFor(600);
  await expect(aiw).not.toHaveClass(/\bpop\b/);
});

test('pressing the same button again puts the page back', async ({ open }) => {
  const page = await load(open);
  await button(page, 'tr').click();
  await page.clock.runFor(800);
  await expect(page.locator('#aipg .face .thin')).toHaveText('Le journal du matin');
  await expect(page.locator('#aipg .face .big')).toHaveText('Matin');

  await button(page, 'tr').click();
  await expect(page.locator('#aiq')).toHaveText('Ask about this page');
  await expect(page.locator('#aiw .ab.on')).toHaveCount(0);
  await page.clock.runFor(800);
  expect(await faces(page)).toEqual(['face f-base']);
  // each sheet lies a hair above the one before it
  await expect(page.locator('#aipg .face')).toHaveAttribute('style', /translateZ\(1\.15px\)/);
});

test('a press while the page is changing is ignored', async ({ open }) => {
  const page = await load(open);
  await button(page, 're').click();
  await button(page, 'sum').click();
  await page.clock.runFor(800);
  expect(await faces(page)).toEqual(['face f-re']);
  await expect(page.locator('#aipg .face .thin')).toHaveText('Sheet 01 · The morning paper');
  await expect(page.locator('#aiq')).toHaveText('Make it a blueprint');
  await expect(page.locator('#aiw .ab.on')).toHaveAttribute('data-a', 're');

  // once it has settled, the next press is taken
  await button(page, 'sum').click();
  await page.clock.runFor(800);
  expect(await faces(page)).toEqual(['face f-sum']);
});

test('the new sheet wipes in from nothing', async ({ open }) => {
  const page = await load(open);
  await button(page, 'sum').click();
  // a width transition runs only if the sheet was drawn at 0px before it was set to 100%
  const wipes = await page.locator('#aipg .face.f-sum, #aipg .fw.wip').evaluateAll((els) =>
    els.map((e) => e.getAnimations().filter((a) => a.transitionProperty === 'width').length));
  expect(wipes).toEqual([1, 1]);
});

test('the old sheet stays until the wipe is over (730 ms)', async ({ open }) => {
  const page = await load(open);
  await button(page, 'sum').click();
  await page.clock.runFor(720);
  expect(await faces(page)).toEqual(['face f-base', 'face f-sum wip']);
  await expect(page.locator('#aiw')).toHaveClass(/\bbusy\b/);
  await page.clock.runFor(20);
  expect(await faces(page)).toEqual(['face f-sum']);
});

test('the buttons work at the default viewport too', async ({ page }) => {
  await page.clock.install();
  await page.goto('docs/index.html');
  await freeze(page);
  const y = await page.locator('#ai').evaluate((s) => s.offsetTop + 200);
  await page.evaluate((v) => scrollTo(0, v), y);
  await button(page, 'tr').click();
  await page.clock.runFor(800);
  await expect(page.locator('#aipg .face .thin')).toHaveText('Le journal du matin');
});

test('red: the question follows the text in the code', async ({ open }) => {
  const page = await load(open, {}, (p) => mutate(p, 'docs/index.html', "'Translate to French'", "'Traduis'"));
  await button(page, 'tr').click();
  await page.clock.runFor(800);
  await expect(page.locator('#aiq')).not.toHaveText('Translate to French');
  await expect(page.locator('#aiq')).toHaveText('Traduis');
});
