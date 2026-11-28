// Browser tests for the site (docs/, the built pages) and the design lab (site/lab/).
// Run: yarn test:web. Coverage of every inline <script> is checked after the run (tests/site/web/coverage.mjs).
import { defineConfig } from '@playwright/test';
import { USER_AGENT } from './tests/site/web/fixtures.mjs';

const PORT = Number(process.env.SITE_PORT || 8010);

export default defineConfig({
  testDir: 'tests/site/web',
  testMatch: '**/*.spec.mjs',
  // Beside the coverage data, so parallel runs with their own COVERAGE_DIR don't wipe each other's traces.
  outputDir: `${process.env.COVERAGE_DIR || 'coverage/site-web'}/results`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/site/web/global-setup.mjs',
  globalTeardown: './tests/site/web/global-teardown.mjs',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    browserName: 'chromium',
    userAgent: USER_AGENT,
    trace: 'retain-on-failure',
  },
  // `yarn lab` builds docs/ from site/ and serves the repo root, so the lab's ../../docs/ links resolve.
  webServer: {
    command: `python3 site/build.py > /dev/null && python3 -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/docs/index.html`,
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
