// Answers right in the command bar as you type (as in Raycast or Brk): arithmetic, units, currencies
// (the ECB's daily rates, from a stand-in server here) and the time somewhere. Return copies the
// answer; a plain number or a word is still a search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const BAR = 'app.$.commandBar';
const CB = `${BAR}.shadowRoot`;
const open = `${BAR}.open`;
const ECB = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='2026-11-20'>
<Cube currency='USD' rate='1.25'/><Cube currency='GBP' rate='0.85'/><Cube currency='JPY' rate='160.0'/></Cube></Cube></gesmes:Envelope>`;

test('the command bar answers sums, units, currencies and times as you type; Return copies the answer', async () => {
  let ecbCalls = 0;
  const ecb = http.createServer((req, res) => { ecbCalls++; res.writeHead(200, { 'content-type': 'text/xml' }); res.end(ECB); });
  await new Promise((r) => ecb.listen(0, '127.0.0.1', r));
  const b = await launch(['about:blank'], { args: [`--meridian-test-ecb-url=http://127.0.0.1:${ecb.address().port}/eurofxref-daily.xml`] });
  const typeIn = async (text) => {
    if (!(await b.eval(open))) {
      await b.click(`${SB}.getElementById('newTabButton')`);
      await b.waitFor(open);
      await b.waitFor(`${BAR}.$.address.matches(':focus-within')`);
    }
    await b.eval(`(() => { const i = ${BAR}.$.address.shadowRoot.querySelector('cr-searchbox-input').shadowRoot.querySelector('input'); i.select(); return true; })()`);
    await b.type(text);
    await b.key('ArrowRight', 'ArrowRight', 39);  // a key up: the bar reads the field
    await b.waitFor(`${BAR}.query_ === ${JSON.stringify(text)}`);
  };
  const answer = async (text) => {
    await typeIn(text);
    await new Promise((r) => setTimeout(r, 150));
    return b.eval(`(() => { const q = ${CB}.getElementById('quick'); return q ? { value: q.querySelector('.quick-value').textContent.trim(), detail: q.querySelector('.hint').textContent.trim(), kind: q.dataset.kind } : null; })()`);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // Arithmetic, with the precedence a calculator has.
    assert.deepEqual(await answer('2+2*3'), { value: '8', detail: '2+2*3', kind: 'calc' });
    assert.equal((await answer('(1.5 + 2.5) / 3')).value, '1.3333333333');
    assert.equal((await answer('15% of 240')).value, '36');
    assert.equal((await answer('2^10')).value, '1,024');
    // Units, temperatures.
    assert.equal((await answer('5 km in miles')).value, '3.10686 mi');
    assert.equal((await answer('100 f to c')).value, '37.78 °C');
    assert.equal((await answer('2 GiB in MB')).value, '2,147.48 MB');
    // A number or a word alone is a search: no answer.
    assert.equal(await answer('2024'), null);
    assert.equal(await answer('weather in tokyo'), null);
    // The time somewhere.
    const tokyo = await answer('time in tokyo');
    assert.equal(tokyo.kind, 'time');
    assert.match(tokyo.value, /^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
    assert.match(tokyo.detail, /Asia\/Tokyo/);
    // Currencies: the rates come when one is asked for (once), through the euro.
    assert.equal(ecbCalls, 0, 'no fetch before a currency is asked for');
    await typeIn('100 usd in eur');
    await b.waitFor(`${CB}.getElementById('quick')?.dataset.kind === 'currency'`, 10000);
    assert.deepEqual(await answer('100 usd in eur'), { value: '80.00 EUR', detail: '100 USD · ECB rate of 2026-11-20', kind: 'currency' });
    assert.equal((await answer('£10 to jpy')).value, '1,882.35 JPY');
    assert.equal(ecbCalls, 1, 'fetched once');

    // Return copies the answer, and the bar closes.
    await answer('6*7');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`${CB}.getElementById('quick')?.querySelector('.switch').textContent === 'Copied'`);
    await b.waitFor(`!${open}`);
    if (process.platform === 'darwin') assert.equal(execFileSync('pbpaste').toString(), '42');
    if (process.platform === 'win32') assert.equal(execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard']).toString().trim(), '42');
  } finally { await b.close(); ecb.close(); }
});
