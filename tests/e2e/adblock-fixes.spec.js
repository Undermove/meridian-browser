// Site fixes for the ad/tracker blocker (src/adblock-fixes.js): the blocked request is let through on
// that site only, whatever type Electron gives it. Pure Node, against Ghostery's engine.
const { test, expect } = require('@playwright/test');
const { FiltersEngine, Request } = require('@ghostery/adblocker');
const { SITE_FIXES } = require('../../src/adblock-fixes');

test('Reddit’s Sentry module is allowed (its pages break without it), even when the requesting site is unknown', () => {
  const engine = FiltersEngine.parse('||redditstatic.com/shreddit/sentry-') // the rule as Ghostery's tracker list has it;
  const url = 'https://www.redditstatic.com/shreddit/sentry-BnateBsO.js';
  const req = (sourceUrl, type) => Request.fromRawDetails({ url, sourceUrl, type });
  expect(engine.match(req('https://www.reddit.com/settings/profile', 'script')).match).toBe(true);
  engine.updateFromDiff({ added: SITE_FIXES });
  for (const type of ['script', 'other', 'xhr', 'fetch']) expect(engine.match(req('https://www.reddit.com/settings/profile', type)).match).toBe(false);
  expect(engine.match(req('', 'script')).match).toBe(false); // Electron sometimes reports no source
  // Only that file: another tracker rule still blocks.
  const other = FiltersEngine.parse('||redditstatic.com/shreddit/sentry-\n||w3-reporting.reddit.com^');
  other.updateFromDiff({ added: SITE_FIXES });
  expect(other.match(Request.fromRawDetails({ url: 'https://w3-reporting.reddit.com/reports', sourceUrl: 'https://www.reddit.com/', type: 'ping' })).match).toBe(true);
});

// Scriptlets only expand with Ghostery's resource library (downloaded with the real lists), so this checks the
// rule itself; the behaviour was verified against the shipped engine (Reddit: 0 scriptlets, YouTube: 30).
test('no scriptlets on reddit.com (two json-prune ones recurse and break the page) — the rule is a scoped unhide', () => {
  const { parseFilters } = require('@ghostery/adblocker');
  const { cosmeticFilters, networkFilters } = parseFilters(SITE_FIXES.join('\n'), { loadCosmeticFilters: true, loadNetworkFilters: true });
  expect(networkFilters.every((f) => f.isException())).toBe(true);
  const js = cosmeticFilters.find((f) => f.isScriptInject());
  expect(js).toBeTruthy();
  expect(js.isUnhide()).toBe(true);
  expect(js.match('www.reddit.com', 'reddit.com')).toBe(true); // domains are hashed in toString()
  expect(js.match('www.youtube.com', 'youtube.com')).toBe(false);
});
