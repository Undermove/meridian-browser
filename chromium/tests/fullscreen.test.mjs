// macOS full screen: the "exit full screen" hint shows at the top and goes away after a few
// seconds, as in Chrome. It stayed for as long as full screen lasted: the hide timer waited for
// presentation feedback that the WebUI window's full screen never sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';

test('full screen: the exit hint shows, then goes away by itself', async () => {
  const b = await launch(['data:text/html,<title>P</title>page'], { args: ['--meridian-test-keys', '--meridian-test-bubbles'] });
  const hint = async () => (await b.eval(`${T}.handler_.testBubbles('').then((r) => r.bubbles)`))
      .includes('SubtleNotificationView');
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval(`${T}.handler_.testCommand(34030)`);  // IDC_FULLSCREEN: macOS's own Space
    let shown = false;
    for (const end = Date.now() + 3000; Date.now() < end && !shown; await sleep(200)) shown = await hint();
    assert.ok(shown, 'the hint shows');
    let gone = false;
    for (const end = Date.now() + 10000; Date.now() < end && !gone; await sleep(250)) gone = !(await hint());
    assert.ok(gone, 'and goes away within 10 s');
    await b.eval(`${T}.handler_.testCommand(34030)`);
    await sleep(1500);
  } finally { await b.close(); }
});
