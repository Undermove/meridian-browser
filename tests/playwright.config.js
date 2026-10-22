// Playwright config for the Meridian Electron e2e suite.
//   npm run test:e2e                      # whole suite
//   npm run test:e2e -- tests/e2e/tabs.spec.js
//   npm run test:e2e -- --grep-invert @shortcut   # skip tests that rely on real key presses
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  // One Electron window at a time: tests that move keyboard focus would fight each other.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '../test-results/e2e-results.json' }]],
  outputDir: '../test-results/artifacts',
  globalTimeout: 30 * 60_000,
});
