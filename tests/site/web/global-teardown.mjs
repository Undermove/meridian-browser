// Prints coverage after every run. With COVERAGE_ENFORCE=1 (yarn test:web, CI) a page whose
// scripts have missed lines, beyond coverage-exclusions.json, fails the run.
import { check } from './coverage.mjs';

// Playwright passes its config first; the second argument is for tests (env, plus check()'s options).
export default function teardown(_config, { env = process.env, log = console.log, ...opts } = {}) {
  log('\nInline script coverage (lines):');
  const failing = check({ only: (env.COVERAGE_ONLY || '').split(',').filter(Boolean), log, ...opts });
  if (env.COVERAGE_ENFORCE === '1' && failing.length) {
    throw new Error(`coverage below 100% in: ${failing.join(', ')}`);
  }
}
