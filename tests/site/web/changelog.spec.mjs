import { test, expect } from './fixtures.mjs';

const lang = (page) => page.evaluate(() => [document.documentElement.lang, document.body.dataset.lang]);
const saved = (page) => page.evaluate(() => localStorage.getItem('lang'));
const NO_STORAGE = () => {
  Storage.prototype.getItem = () => { throw new Error('blocked'); };
  Storage.prototype.setItem = () => { throw new Error('blocked'); };
};

test.describe('built changelog', () => {
  test('the English page keeps English and remembers it', async ({ page }) => {
    await page.goto('docs/changelog.html');
    expect(await lang(page)).toEqual(['en', 'en']);
    expect(await saved(page)).toBe('en');
    // the build swaps the language buttons for a link to the other page
    await expect(page.locator('[data-set-lang]')).toHaveCount(0);
    await expect(page.locator('a.lang-link')).toHaveAttribute('href', 'https://meridianbrowser.app/ru/changelog.html');
  });

  test('the Russian page keeps Russian, whatever was saved before', async ({ open }) => {
    const page = await open(null, { init: () => localStorage.setItem('lang', 'en') });
    await page.goto('docs/ru/changelog.html');
    expect(await lang(page)).toEqual(['ru', 'ru']);
    expect(await saved(page)).toBe('ru');
  });

  test('with storage blocked the page still sets its language', async ({ open }) => {
    const page = await open(null, { init: NO_STORAGE });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('docs/ru/changelog.html');
    expect(await lang(page)).toEqual(['ru', 'ru']);
    expect(errors).toEqual([]);
  });
});

test.describe('changelog source (both languages, with buttons)', () => {
  const SRC = 'site/pages/changelog.html';

  test('a saved choice wins over the browser language', async ({ open }) => {
    const page = await open(null, { locale: 'ru-RU', init: () => localStorage.setItem('lang', 'en') });
    await page.goto(SRC);
    expect(await lang(page)).toEqual(['en', 'en']);
    await expect(page.locator('[data-set-lang="en"]')).toHaveClass('on');
    await expect(page.locator('[data-set-lang="ru"]')).not.toHaveClass('on');
  });

  test('with nothing saved, a Russian-family browser language picks Russian', async ({ open }) => {
    // the language part decides, in any case: a Belgian (BE) region is not Belarusian (be)
    for (const [locale, want] of [['uk-UA', 'ru'], ['kk-KZ', 'ru'], ['de-DE', 'en'], ['RU-RU', 'ru'], ['nl-BE', 'en']]) {
      const page = await open(SRC, { locale });
      expect((await lang(page))[0], locale).toBe(want);
    }
  });

  test('an unknown saved value falls back to the browser language', async ({ open }) => {
    const page = await open(null, { locale: 'be-BY', init: () => localStorage.setItem('lang', 'fr') });
    await page.goto(SRC);
    expect(await lang(page)).toEqual(['ru', 'ru']);
  });

  test('with no navigator.language the page picks English', async ({ open }) => {
    const page = await open(SRC, { init: () => Object.defineProperty(navigator, 'language', { get: () => '' }) });
    expect(await lang(page)).toEqual(['en', 'en']);
  });

  test('the buttons switch the language and remember it', async ({ open }) => {
    const page = await open(SRC, { locale: 'en-US' });
    await page.locator('[data-set-lang="ru"]').click();
    expect(await lang(page)).toEqual(['ru', 'ru']);
    await expect(page.locator('[data-set-lang="ru"]')).toHaveClass('on');
    expect(await saved(page)).toBe('ru');
    await page.locator('[data-set-lang="en"]').click();
    expect(await lang(page)).toEqual(['en', 'en']);
  });

  test('with storage blocked the browser language decides and the buttons still work', async ({ open }) => {
    const page = await open(SRC, { locale: 'ru-RU', init: NO_STORAGE });
    expect(await lang(page)).toEqual(['ru', 'ru']);
    await page.locator('[data-set-lang="en"]').click();
    expect(await lang(page)).toEqual(['en', 'en']);
  });
});
