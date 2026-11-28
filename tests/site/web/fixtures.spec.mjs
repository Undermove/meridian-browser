// The fixtures every browser test trusts. Their init scripts never show in page coverage, so these
// tests pin what they do.
import { test, expect, mutate } from './fixtures.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_DIR } from './coverage.mjs';

const PAGE = 'docs/changelog.html';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  linux: 'Mozilla/5.0 (Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  x11: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  unknown: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko)',
};

const platforms = (page) => page.evaluate(() => ({
  hasUAData: !!self.NavigatorUAData,
  platform: navigator.platform,
  uaPlatform: navigator.userAgentData?.platform,
}));

// Android says "Linux" too: the Android check must come first.
const PLATFORM_CASES = [
  ['Windows', UA.windows, 'Win32', 'Windows'],
  ['an iPhone', UA.iphone, 'iPhone', ''],
  ['an iPad', UA.ipad, 'iPhone', ''],
  ['a Mac', UA.mac, 'MacIntel', 'macOS'],
  ['Android', UA.android, 'Linux armv8l', 'Android'],
  ['Linux', UA.linux, 'Linux x86_64', 'Linux'],
  ['X11 without Linux', UA.x11, 'Linux x86_64', 'Linux'],
  ['an unknown system', UA.unknown, '', ''],
];

for (const [name, userAgent, platform, uaPlatform] of PLATFORM_CASES) {
  test(`the platform follows the user agent: ${name}`, async ({ open }) => {
    const page = await open(PAGE, { userAgent });
    expect(await platforms(page)).toEqual({ hasUAData: true, platform, uaPlatform });
  });
}

test('the platform of the default user agent is a Mac, in `page` too', async ({ page }) => {
  await page.goto(PAGE);
  expect(await platforms(page)).toEqual({ hasUAData: true, platform: 'MacIntel', uaPlatform: 'macOS' });
});

test("a test's own init script can still pin another platform", async ({ open }) => {
  const page = await open(PAGE, {
    userAgent: UA.windows,
    init: `Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Pinned', configurable: true });
      Object.defineProperty(NavigatorUAData.prototype, 'platform', { get: () => 'PinnedToo', configurable: true });`,
  });
  expect(await platforms(page)).toEqual({ hasUAData: true, platform: 'Pinned', uaPlatform: 'PinnedToo' });
});

// Registered after the fixtures' scripts, like the pages' own listeners.
const RECORD = `window.__seen = [];
  for (const type of ['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mouseenter', 'mousemove'])
    addEventListener(type, (e) => __seen.push([type, e.clientX, e.clientY, e.isTrusted]), true);`;
const seen = (page) => page.evaluate(() => window.__seen.splice(0));
const untrusted = (page) => page.evaluate(() =>
  document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 0 })));

test('a pointer at (0, 0) before any other never reaches the page', async ({ open }) => {
  const page = await open(PAGE, { init: RECORD });
  await page.mouse.move(0, 0);
  await page.mouse.move(0, 0);
  // A round trip through the page, so a trusted event, had it got through, is recorded by now.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await seen(page)).toEqual([]);

  await untrusted(page);
  expect(await seen(page)).toEqual([['mousemove', 0, 0, false]]);

  // On the left edge but not the corner: only (0, 0) itself is the phantom.
  await page.mouse.move(0, 30);
  const real = await seen(page);
  expect(real).toContainEqual(['pointermove', 0, 30, true]);
  expect(real).toContainEqual(['mousemove', 0, 30, true]);

  await page.mouse.move(0, 0);
  const back = await seen(page);
  expect(back).toContainEqual(['pointermove', 0, 0, true]);
  expect(back).toContainEqual(['mousemove', 0, 0, true]);
});

test('requests off 127.0.0.1 are aborted unless the test answers them', async ({ page }) => {
  const failed = [];
  page.on('requestfailed', (r) => failed.push([r.url(), r.failure().errorText]));
  await page.route('https://answered.example/x', (route) =>
    route.fulfill({ body: 'answered', headers: { 'access-control-allow-origin': '*' } }));
  await page.goto(PAGE);
  const get = (url) => page.evaluate((u) => fetch(u).then((r) => r.text(), (e) => 'failed: ' + e.name), url);

  expect(await get('https://answered.example/x')).toBe('answered');
  expect(await get('https://blocked.example/x')).toBe('failed: TypeError');
  // Same server, another host name: only 127.0.0.1 counts as local.
  const other = new URL('/' + PAGE, page.url().replace('127.0.0.1', 'localhost')).href;
  expect(await get(other)).toBe('failed: TypeError');
  expect(await get('/' + PAGE)).toContain("<title>What's new in Meridian</title>");
  // The page's own analytics script is blocked too, so only the URLs asked for are matched.
  const blocked = 'net::ERR_BLOCKED_BY_CLIENT.Inspector';
  expect(failed).toContainEqual(['https://blocked.example/x', blocked]);
  expect(failed).toContainEqual([other, blocked]);
  for (const [url, error] of failed) {
    expect(url).not.toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(error).toBe(blocked);
  }
});

test('mutate() serves the changed page', async ({ page }) => {
  await mutate(page, PAGE, "<title>What's new in Meridian</title>", '<title>Mutated</title>');
  await page.goto(PAGE);
  await expect(page).toHaveTitle('Mutated');
});

test("mutate() throws when `from` isn't in the file", async ({ page }) => {
  await expect(mutate(page, PAGE, 'no such text anywhere', 'x')).rejects.toThrow(
    'mutate: "no such text anywhere" is not in docs/changelog.html');
});

// MUTANT is read when a worker starts, so it runs a child Playwright on a one-test spec.
test('MUTANT serves the changed page to every test', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-e2e-'));
  fs.writeFileSync(path.join(dir, 'probe.spec.mjs'), `
    import { test, expect } from ${JSON.stringify(path.join(HERE, 'fixtures.mjs'))};
    test('probe', async ({ page }) => {
      await page.goto(${JSON.stringify(PAGE)});
      await expect(page).toHaveTitle('MUTANT-PROBE', { timeout: 2000 });
    });`);
  fs.writeFileSync(path.join(dir, 'probe.config.mjs'), `export default ${JSON.stringify({
    testDir: dir, outputDir: path.join(dir, 'results'), reporter: 'line',
    use: { baseURL: testInfo.project.use.baseURL, browserName: 'chromium' },
  })};`);
  const run = (env) => spawnSync('npx', ['playwright', 'test', '--config', path.join(dir, 'probe.config.mjs')], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, COVERAGE_DIR: path.join(dir, 'cov'), MUTANT: '', FORCE_COLOR: '0', ...env },
  });
  try {
    const mutant = JSON.stringify({ file: PAGE, from: "<title>What's new in Meridian</title>", to: '<title>MUTANT-PROBE</title>' });
    const on = run({ MUTANT: mutant });
    expect(on.status, on.stdout + on.stderr).toBe(0);
    expect(on.stdout).toContain('1 passed');
    const off = run({});
    expect(off.status, off.stdout + off.stderr).toBe(1);
    expect(off.stdout).toContain('1 failed');
    expect(off.stdout).toContain(`Received: "What's new in Meridian"`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The fixture saves coverage after a test ends, so the next test reads the file.
test.describe.serial('coverage files', () => {
  let probe;

  test('a page opened in a test has its coverage saved', async ({ page }, testInfo) => {
    probe = `/__coverage-probe-${process.pid}-${testInfo.repeatEachIndex}-${Date.now()}.html`;
    await page.route('**' + probe, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<script>window.ran = 1;</script>' }));
    await page.goto(probe);
    expect(await page.evaluate(() => window.ran)).toBe(1);
  });

  test("the file's name starts with the spec's name", async ({}, testInfo) => {
    const files = fs.readdirSync(RAW_DIR).filter((f) =>
      fs.readFileSync(path.join(RAW_DIR, f), 'utf8').includes(JSON.stringify(probe)));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^fixtures-${testInfo.workerIndex}-[0-9a-f-]{36}\\.json$`));
    const [entry] = JSON.parse(fs.readFileSync(path.join(RAW_DIR, files[0]), 'utf8'));
    expect(entry.url).toBe(probe);
    expect(entry.source).toBe('window.ran = 1;');
  });
});
