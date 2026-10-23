// Site fixes for the ad/tracker blocker (src/adblock-fixes.js): the blocked request is let through on
// that site only, whatever type Electron gives it. Pure Node, against Ghostery's engine.
const { test, expect } = require('@playwright/test');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { SITE_FIXES } = require('../../src/adblock-fixes');

test('Reddit’s Sentry module is allowed on reddit.com (pages stay blank without it), still blocked elsewhere', () => {
  const engine = FiltersEngine.parse('||redditstatic.com/shreddit/sentry-') // the rule as Ghostery's tracker list has it;
  const url = 'https://www.redditstatic.com/shreddit/sentry-BnateBsO.js';
  const req = (sourceUrl, type) => Request.fromRawDetails({ url, sourceUrl, type });
  expect(engine.match(req('https://www.reddit.com/settings/profile', 'script')).match).toBe(true);
  engine.updateFromDiff({ added: SITE_FIXES });
  for (const type of ['script', 'other', 'xhr', 'fetch']) expect(engine.match(req('https://www.reddit.com/settings/profile', type)).match).toBe(false);
  expect(engine.match(req('https://example.com/', 'script')).match).toBe(true);
});
