// Prints coverage after every run. With COVERAGE_ENFORCE=1 (yarn test:web, CI) a page whose
// scripts have missed lines, beyond coverage-exclusions.json, fails the run.
import { check } from './coverage.mjs';

export default function teardown() {
  console.log('\nInline script coverage (lines):');
  const failing = check({ only: (process.env.COVERAGE_ONLY || '').split(',').filter(Boolean) });
  if (process.env.COVERAGE_ENFORCE === '1' && failing.length) {
    throw new Error(`coverage below 100% in: ${failing.join(', ')}`);
  }
}
