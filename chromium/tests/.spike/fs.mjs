import { launch, SB } from '../harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const b = await launch(['data:text/html,<title>P</title>hi'], { args: ['--meridian-test-keys', '--meridian-test-bubbles'] });
try {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await b.eval(`${T}.handler_.testCommand(34030)`);
  for (const t of [1, 3, 6, 10, 14]) { await sleep(t === 1 ? 1000 : (t - [1,3,6,10,14][[1,3,6,10,14].indexOf(t)-1]) * 1000); console.log(t + 's', JSON.stringify(await b.eval(`${T}.handler_.testBubbles('bounds').then((r) => r.bubbles)`))); }
  await b.eval(`${T}.handler_.testCommand(34030)`);
  await sleep(2000);
} finally { await b.close(); }
