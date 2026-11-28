// A stand-in for chromium/tests/harness.mjs, for the cli() test: importing the real one strips the
// environment, hooks every test and cleans temp folders (see harness.mjs / isolation.mjs).
import { fakeBrowser } from './fake_browser.mjs';

export const SB = 'FAKE_SB';
export const launches = [];
export async function launch(urls, opts) {
  const b = fakeBrowser();
  launches.push({ urls, opts, b });
  return b;
}
