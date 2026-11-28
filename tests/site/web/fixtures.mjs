// Shared fixtures for the site's browser tests.
//
// - Every request that leaves 127.0.0.1 is aborted unless a test routes it (fonts, GitHub's API,
//   goatcounter): tests never reach the network, the real analytics or GitHub's rate limit.
// - JS coverage of every page a test opens is saved for coverage.mjs. Open pages with `open()` (or
//   use `page`), so their coverage is kept too.
import { test as base, expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR } from './coverage.mjs';

const LOCAL = /^http:\/\/127\.0\.0\.1:\d+\//;

// Headless Chromium on Linux sends the page a pointer at (0, 0) when it opens; macOS sends none. The
// pages react to the pointer, so every test would start in another state on CI. Until a pointer
// arrives anywhere else, events at (0, 0) are dropped before the page's own listeners see them.
function noPhantomPointer() {
  let real = false;
  for (const type of ['pointerover', 'pointerenter', 'pointermove', 'mouseover', 'mouseenter', 'mousemove']) {
    addEventListener(type, (e) => {
      if (real || !e.isTrusted) return;
      if (e.clientX === 0 && e.clientY === 0) e.stopImmediatePropagation();
      else real = true;
    }, true);
  }
}

// The pages pick a download by platform. Chromium reports the host's platform whatever the user agent
// says, so a test would see a Linux visitor on CI and a Mac one locally. The platform follows the user
// agent here, as in a real browser; a test's own init scripts run later and can still pin another.
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36';
function platformFromUserAgent() {
  const ua = navigator.userAgent;
  const [platform, uaPlatform] = /Windows/.test(ua) ? ['Win32', 'Windows']
    : /iPhone|iPad/.test(ua) ? ['iPhone', '']
    : /Macintosh/.test(ua) ? ['MacIntel', 'macOS']
    : /Android/.test(ua) ? ['Linux armv8l', 'Android']
    : /Linux|X11/.test(ua) ? ['Linux x86_64', 'Linux'] : ['', ''];
  Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform, configurable: true });
  if (self.NavigatorUAData) Object.defineProperty(NavigatorUAData.prototype, 'platform', { get: () => uaPlatform, configurable: true });
}

async function isolate(context) {
  await context.addInitScript(noPhantomPointer);
  await context.addInitScript(platformFromUserAgent);
  await context.route((url) => !LOCAL.test(url.href), (route) => route.abort('blockedbyclient'));
}

async function startCoverage(page) {
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
}

function saveCoverage(entries, testInfo) {
  const keep = entries
    .filter((e) => LOCAL.test(e.url) && e.source)
    .map(({ url, source, functions }) => ({ url: new URL(url).pathname, source, functions }));
  if (!keep.length) return;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const name = `${testInfo.workerIndex}-${crypto.randomUUID()}.json`;
  fs.writeFileSync(path.join(RAW_DIR, name), JSON.stringify(keep));
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await isolate(context);
    await use(context);
  },
  page: async ({ page }, use, testInfo) => {
    await startCoverage(page);
    await use(page);
    if (!page.isClosed()) saveCoverage(await page.coverage.stopJSCoverage(), testInfo);
  },
  // open(url, contextOptions): a page in a fresh context (its own user agent, viewport, reduced
  // motion…), isolated and covered like `page`. `init` scripts run before the page's own.
  open: async ({ browser }, use, testInfo) => {
    const opened = [];
    await use(async (url, { init = [], ...options } = {}) => {
      const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, userAgent: USER_AGENT, ...options });
      await isolate(context);
      for (const script of [].concat(init)) await context.addInitScript(script);
      const page = await context.newPage();
      await startCoverage(page);
      opened.push(page);
      if (url) await page.goto(url);
      return page;
    });
    for (const page of opened) {
      if (!page.isClosed()) saveCoverage(await page.coverage.stopJSCoverage(), testInfo);
      await page.context().close();
    }
  },
});

export { expect };

// A page's HTML with `from` replaced by `to`, served in place of the file: shows a test can fail
// when the code it checks changes, without editing the file.
export async function mutate(page, file, from, to) {
  const body = fs.readFileSync(path.resolve(file), 'utf8');
  if (!body.includes(from)) throw new Error(`mutate: ${JSON.stringify(from)} is not in ${file}`);
  await page.route((url) => url.pathname === '/' + file, (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: body.replace(from, to) }));
}
