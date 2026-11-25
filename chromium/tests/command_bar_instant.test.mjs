// The command bar's instant modes, as in Arc or Raycast: the answer is the first row while typing
// and Return copies it or acts. A calculator, units and currencies (the ECB's and the National Bank
// of Georgia's rates, from stand-in servers here: never the real network), the time somewhere,
// Meridian's commands by name, a site by its name then Tab ("youtube ⇥ cats") and "translate".
// The parsers are tested in the UI page first, then each mode with real key presses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const BAR = 'app.$.commandBar';
const CB = `${BAR}.shadowRoot`;
const open = `${BAR}.open`;
const ECB = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='2026-11-20'>
<Cube currency='USD' rate='1.25'/><Cube currency='GBP' rate='0.85'/></Cube></Cube></gesmes:Envelope>`;
const NBG = JSON.stringify([{ date: '2026-11-25T00:00:00.000Z', currencies: [
  { code: 'EUR', quantity: 1, rate: 3.0 }, { code: 'USD', quantity: 1, rate: 2.4 },
  { code: 'RUB', quantity: 100, rate: 3.2 }] }]);
// Screenshots of each mode's first row, to look at (MERIDIAN_SHOTS=<dir>).
const SHOTS = process.env.MERIDIAN_SHOTS || '';

async function rateServers({ fail = false } = {}) {
  const calls = { ecb: 0, nbg: 0 };
  const server = http.createServer((req, res) => {
    const nbg = req.url.startsWith('/nbg');
    calls[nbg ? 'nbg' : 'ecb']++;
    if (fail) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': nbg ? 'application/json' : 'text/xml' });
    res.end(nbg ? NBG : ECB);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { calls, close: () => server.close(),
           args: [`--meridian-test-ecb-url=${base}/ecb.xml`, `--meridian-test-nbg-url=${base}/nbg/json`] };
}

function bar(b) {
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
  const quick = () => b.eval(`(() => { const q = ${CB}.getElementById('quick'); return q ? { value: q.querySelector('.quick-value').textContent.trim(), detail: q.querySelector('.hint').textContent.trim(), kind: q.dataset.kind, action: q.dataset.action, eq: !!q.querySelector('.eq'), sel: q.classList.contains('sel'), go: q.querySelector('.switch')?.textContent.trim() || '' } : null; })()`);
  const answer = async (text) => {
    await typeIn(text);
    await new Promise((r) => setTimeout(r, 120));
    return quick();
  };
  const rows = () => b.eval(`[...${CB}.querySelectorAll('#features .tab-row')].map((r) => (r.classList.contains('sel') ? '>' : '') + r.querySelector('.tab-title').textContent + ' | ' + (r.querySelector('.keys')?.textContent || ''))`);
  const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await new Promise((r) => setTimeout(r, 600)); await b.screenshot(path.join(SHOTS, `${name}.png`)); } };
  // What the bar opens, caught here instead of loading the real site.
  const catchOpens = () => b.eval(`(() => { window.__opened = []; app.$.tabstrip.openUrl = (u) => { window.__opened.push(u); }; return true; })()`);
  const opened = () => b.eval('window.__opened');
  return { typeIn, quick, answer, rows, shot, catchOpens, opened };
}

test('the instant parsers: sums with functions, units, times, translations, currencies, site names', async () => {
  const b = await launch([]);
  try {
    await b.waitFor(`typeof app !== 'undefined' && !!app.$.tabstrip?.state_`);
    const r = await b.eval(`(async () => {
      const { quickAnswer, translateQuery } = await import('./meridian/quick_answers.js');
      const { siteSearchFor, SITE_SEARCHES } = await import('./meridian/site_searches.js');
      const now = new Date(Date.UTC(2026, 10, 25, 12, 0));
      const rates = { rates: { USD: 1.25, GEL: 3, RUB: 93.75 }, date: '2026-11-20', nbgCodes: ['GEL', 'RUB'], nbgDate: '2026-11-25' };
      const q = (t, o) => quickAnswer(t, now, rates, o);
      const v = (t) => q(t)?.value ?? null;
      const out = {};
      for (const t of ['2+2*3', 'sqrt(16) + 2^3', 'sin(pi/2)', '2pi', '200 + 10%', '50 - 10%', '5!', '3 x 4',
                       'ln(e)', 'log 1000', 'abs(-7) * 2', '(1+2)*(3+4)', '10 % 3', '15% of 240', '1,000 * 3',
                       'cos 60°', '-2^2', '2^-1', '7 / 2', 'sqrt 2', 'square root of 81', '2 * (3 + 4',
                       '2024', '-5', 'pi', 'pie', 'hello', 'x', 'xbox', 'covid-19', '2026-11-25', 'e 5',
                       '10 km in miles', '72 f to c', '72°f to c', '1 lb to kg', '5 pounds in kg', '3 cups to ml',
                       '50€ in gel', '100 usd to eur', '10 dollars in lari', '1000 rub in usd', '$20 to gel',
                       '100 usd in xyz']) {
        out[t] = v(t);
      }
      out.kinds = ['2+2', '1 km in m', '50€ in gel', 'time in tokyo', 'translate hi to georgian'].map((t) => q(t)?.kind);
      out.gelDetail = q('50€ in gel').detail;
      out.usdDetail = q('100 usd to eur').detail;
      out.unavailable = quickAnswer('50€ in gel', now, null, { ratesUnavailable: true });
      out.waiting = quickAnswer('50€ in gel', now, null, {});
      out.batumi = q('time in batumi');
      out.nyc = q('now in nyc');
      out.tokyoTime = q('tokyo time');
      out.london = q('3pm london to batumi');
      out.tbilisi = q('17:30 tbilisi in new york');
      out.noZone = q('time in narnia');
      out.tr = q('translate hello to georgian');
      out.tr2 = translateQuery('tr привет');
      out.tr3 = translateQuery('tr hello georgian');
      out.tr4 = translateQuery('translate do it', ['en-US']);
      out.tr5 = translateQuery('tr good morning', ['en-US', 'ru']);
      out.tr6 = translateQuery('переведи кошка на грузинский');
      out.trNo = translateQuery('trip to rome');
      out.sites = ['youtube', 'github', 'wiki', 'maps', 'x', 'reddit', 'amazon', 'figma', 'pinterest', 'Twitter', 'yt', 'nothing']
          .map((w) => siteSearchFor(w)?.name ?? null);
      out.siteCount = SITE_SEARCHES.length;
      return out;
    })()`);
    // A calculator: precedence, functions, constants, "200 + 10%", factorial, degrees.
    const calc = {
      '2+2*3': '8', 'sqrt(16) + 2^3': '12', 'sin(pi/2)': '1', '2pi': '6.2831853072', '200 + 10%': '220',
      '50 - 10%': '45', '5!': '120', '3 x 4': '12', 'ln(e)': '1', 'log 1000': '3', 'abs(-7) * 2': '14',
      '(1+2)*(3+4)': '21', '10 % 3': '1', '15% of 240': '36', '1,000 * 3': '3,000', 'cos 60°': '0.5',
      '-2^2': '-4', '2^-1': '0.5', '7 / 2': '3.5', 'sqrt 2': '1.4142135624', 'square root of 81': '9',
    };
    for (const [t, want] of Object.entries(calc)) assert.equal(r[t], want, t);
    // Not sums: a number, a word, a date, half a sum: searches.
    for (const t of ['2 * (3 + 4', '2024', '-5', 'pi', 'pie', 'hello', 'x', 'xbox', 'covid-19', '2026-11-25', 'e 5']) {
      assert.equal(r[t], null, t);
    }
    // Units.
    assert.equal(r['10 km in miles'], '6.21371 mi');
    assert.equal(r['72 f to c'], '22.22 °C');
    assert.equal(r['72°f to c'], '22.22 °C');
    assert.equal(r['1 lb to kg'], '0.453592 kg');
    assert.equal(r['5 pounds in kg'], '2.26796 kg', 'pounds of weight, not money');
    assert.equal(r['3 cups to ml'], '709.765 ml');
    // Currencies: through the euro; the lari and the rouble from the NBG.
    assert.equal(r['50€ in gel'], '150.00 GEL');
    assert.equal(r['100 usd to eur'], '80.00 EUR');
    assert.equal(r['10 dollars in lari'], '24.00 GEL');
    assert.equal(r['1000 rub in usd'], '13.33 USD');
    assert.equal(r['$20 to gel'], '48.00 GEL');
    assert.equal(r['100 usd in xyz'], null);
    assert.equal(r.gelDetail, '50 EUR · National Bank of Georgia rate of 2026-11-25');
    assert.equal(r.usdDetail, '100 USD · ECB rate of 2026-11-20');
    assert.equal(r.unavailable.value, 'Rates unavailable');
    assert.equal(r.unavailable.action, 'none');
    assert.equal(r.waiting, null, 'nothing while the rates are on their way');
    assert.deepEqual(r.kinds, ['calc', 'unit', 'currency', 'time', 'translate']);
    // Time zones (12:00 UTC on 25 November 2026).
    assert.equal(r.batumi.value, 'Wed 4:00 PM');
    assert.match(r.batumi.detail, /Asia\/Tbilisi/);
    assert.equal(r.nyc.value, 'Wed 7:00 AM');
    assert.equal(r.tokyoTime.value, 'Wed 9:00 PM');
    assert.equal(r.london.value, 'Wed 7:00 PM', '3 pm in London is 7 pm in Batumi');
    assert.equal(r.tbilisi.value, 'Wed 8:30 AM');
    assert.equal(r.noZone, null);
    // Translate: Google Translate with the text; the language named, or English for other scripts,
    // or the person's other language.
    assert.equal(r.tr.kind, 'translate');
    assert.equal(r.tr.action, 'open');
    assert.equal(r.tr.url, 'https://translate.google.com/?sl=auto&tl=ka&text=hello&op=translate');
    assert.equal(r.tr.value, '“hello” → Georgian');
    assert.deepEqual(r.tr2, { text: 'привет', code: 'en', label: 'English' });
    assert.deepEqual(r.tr3, { text: 'hello', code: 'ka', label: 'Georgian' });
    assert.deepEqual(r.tr4, { text: 'do it', code: 'en', label: 'English' });
    assert.deepEqual(r.tr5, { text: 'good morning', code: 'ru', label: 'Russian' });
    assert.deepEqual(r.tr6, { text: 'кошка', code: 'ka', label: 'Georgian' });
    assert.equal(r.trNo, null);
    // Sites by name.
    assert.deepEqual(r.sites, ['YouTube', 'GitHub', 'Wikipedia', 'Google Maps', 'X', 'Reddit', 'Amazon', 'Figma',
                               'Pinterest', 'X', 'YouTube', null]);
  } finally { await b.close(); }
});

test('instant modes in the bar: "= 8" copies, units, "50€ in gel" from the central banks, the time in Batumi, translate opens Google Translate', async () => {
  const rates = await rateServers();
  const b = await launch(['about:blank'], { args: rates.args });
  const { typeIn, answer, shot, catchOpens, opened, quick } = bar(b);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // A calculator: "= 8" first, picked; Return copies.
    const sum = await answer('2+2*3');
    assert.deepEqual([sum.value, sum.eq, sum.sel, sum.go], ['8', true, true, 'Copy']);
    await shot('calc');
    assert.equal((await answer('sqrt(16) + 2^3')).value, '12');
    assert.equal((await answer('200 + 10%')).value, '220');
    // Units.
    assert.equal((await answer('10 km in miles')).value, '6.21371 mi');
    await shot('units');
    assert.equal((await answer('72 f to c')).value, '22.22 °C');
    // Currencies: fetched when first asked (both banks, once), with the day of the rate.
    assert.equal(rates.calls.ecb + rates.calls.nbg, 0, 'no fetch before a currency is asked for');
    await typeIn('50€ in gel');
    await b.waitFor(`${CB}.getElementById('quick')?.dataset.kind === 'currency'`, 10000);
    assert.deepEqual(await quick().then((q) => [q.value, q.detail]),
                     ['150.00 GEL', '50 EUR · National Bank of Georgia rate of 2026-11-25']);
    await shot('currency');
    assert.deepEqual(await answer('100 usd to eur').then((q) => [q.value, q.detail]),
                     ['80.00 EUR', '100 USD · ECB rate of 2026-11-20']);
    assert.deepEqual(rates.calls, { ecb: 1, nbg: 1 });
    // The time somewhere.
    const batumi = await answer('time in batumi');
    assert.equal(batumi.kind, 'time');
    assert.match(batumi.detail, /Asia\/Tbilisi/);
    await shot('time');
    // (7 pm in winter, 6 pm while London is on summer time.)
    assert.match((await answer('3pm london to batumi')).value, /^[A-Z][a-z]{2} [67]:00 PM$/);
    assert.equal((await answer('now in nyc')).kind, 'time');

    // Translate: Return opens Google Translate with the text.
    await catchOpens();
    const tr = await answer('translate hello to georgian');
    assert.deepEqual([tr.kind, tr.value, tr.go, tr.sel], ['translate', '“hello” → Georgian', 'Open', true]);
    await shot('translate');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open}`);
    assert.deepEqual(await opened(), ['https://translate.google.com/?sl=auto&tl=ka&text=hello&op=translate']);

    // Return copies a sum, and the bar closes.
    await answer('6*7');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open}`);
  } finally { await b.close(); rates.close(); }
});

test('Meridian commands by name in the bar, with their shortcuts; "settings ai" opens Settings at AI', async () => {
  const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title><h1>${req.url}</h1>`); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const b = await launch([`${base}/one`, `${base}/two`]);
  const { typeIn, rows, shot } = bar(b);
  const first = async (text) => {
    await typeIn(text);
    await b.waitFor(`${CB}.querySelectorAll('#features .tab-row').length > 0`);
    return (await rows())[0];
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 2`);
    const mac = process.platform === 'darwin';
    assert.equal(await first('split view'), `>Split View | ${mac ? '⌃⇧=' : 'Ctrl+Alt+='}`);
    await shot('commands');
    assert.equal(await first('little window'), `>Little Window | ${mac ? '⌥⌘N' : 'Ctrl+Alt+N'}`);
    assert.match(await first('boost'), /^>Boost This Site \| $/);
    assert.match(await first('new space'), /^>New Space/);
    assert.match(await first('archive'), /^>Archive \| /);
    assert.match(await first('import from another browser'), /^>Import from Another Browser/);
    assert.match(await first('send a report'), /^>Send a report/);
    assert.match(await first('try with claude'), /^>Try with Claude/);
    // "settings ai": the AI section, picked.
    assert.equal(await first('settings ai'), '>AI | ');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open} && app.$.settings.open && !!app.$.settings.shadowRoot.getElementById('ai')`);
    // Settings has the keys: Escape closes it.
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.settings.open`);

    // Split View by name: the two tabs side by side.
    await b.eval(`app.$.tabstrip.activateTab([...app.$.tabstrip.tabs_.values()].find((t) => t.url.endsWith('/one')).id)`);
    await first('split view');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open} && app.splits_.length === 1`, 10000);
  } finally { await b.close(); site.close(); }
});

test('a site by its name then Tab searches it ("youtube ⇥ lofi"), with Chromium\'s engine when there is one', async () => {
  const b = await launch(['about:blank']);
  const { typeIn, shot, catchOpens, opened } = bar(b);
  const pill = () => b.eval(`(() => { const m = ${CB}.getElementById('mode'); return m ? { label: m.querySelector('.mode-label').textContent.trim(), site: m.dataset.site, keyword: m.dataset.keyword } : null; })()`);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await catchOpens();
    // The name alone offers it ("Search YouTube ⇥"); Tab turns the bar into it.
    await typeIn('youtube');
    await b.waitFor(`${CB}.getElementById('siteHint')?.querySelector('.tab-title').textContent === 'Search YouTube'`);
    await shot('site-hint');
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`!!${CB}.getElementById('mode')`);
    assert.deepEqual(await pill(), { label: 'Search YouTube', site: 'youtube.com', keyword: '' });
    await b.type('lofi beats');
    await shot('site-mode');
    await b.key('Enter', 'Enter', 13);
    await b.waitFor(`!${open}`);
    assert.deepEqual(await opened(), ['https://www.youtube.com/results?search_query=lofi%20beats']);

    const want = {
      github: ['Search GitHub', 'https://github.com/search?q=kiwi'],
      wiki: ['Search Wikipedia', 'https://en.wikipedia.org/w/index.php?search=kiwi'],
      maps: ['Search Google Maps', 'https://www.google.com/maps/search/kiwi'],
      x: ['Search X', 'https://x.com/search?q=kiwi'],
      reddit: ['Search Reddit', 'https://www.reddit.com/search/?q=kiwi'],
      amazon: ['Search Amazon', 'https://www.amazon.com/s?k=kiwi'],
      figma: ['Search Figma', 'https://www.figma.com/community/search?resource_type=mixed&query=kiwi'],
      pinterest: ['Search Pinterest', 'https://www.pinterest.com/search/pins/?q=kiwi'],
      translate: ['Search Google Translate', 'https://translate.google.com/?sl=auto&tl=ka&text=kiwi&op=translate'],
    };
    for (const [word, [label, url]] of Object.entries(want)) {
      await catchOpens();
      await typeIn(word);
      await b.key('Tab', 'Tab', 9);
      await b.waitFor(`!!${CB}.getElementById('mode')`);
      assert.equal((await pill()).label, label, word);
      await b.type(word === 'translate' ? 'kiwi to georgian' : 'kiwi');
      await b.key('Enter', 'Enter', 13);
      await b.waitFor(`!${open}`);
      assert.deepEqual(await opened(), [url], word);
    }

    // A site the person has a search engine for goes through Chromium's (its keyword is the site's
    // address): the default engine's keyword, whatever this build has.
    const { keywords } = await b.eval(`app.$.tabstrip.handler_.getSearchKeywords()`);
    const google = keywords.find((k) => k.keyword === 'google.com');
    if (google) {
      await catchOpens();
      await typeIn('google');
      await b.key('Tab', 'Tab', 9);
      await b.waitFor(`!!${CB}.getElementById('mode')`);
      assert.equal((await pill()).keyword, 'google.com');
      await b.type('kiwi');
      await b.key('Enter', 'Enter', 13);
      await b.waitFor(`window.__opened.length === 1`, 10000);
      assert.match((await opened())[0], /^https:\/\/www\.google\.com\/search\?.*q=kiwi/);
    }
    // A word that names no site: Tab does what it did.
    await typeIn('kiwi');
    assert.equal(await b.eval(`!!${CB}.getElementById('siteHint')`), false);
  } finally { await b.close(); }
});

test('currency rates: "Rates unavailable" with no connection; the last ones kept on disk with their day', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const good = await rateServers();
  try {
    // Fetched once, kept on disk.
    let b = await launch(['about:blank'], { profile, args: good.args });
    let ui = bar(b);
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
      await ui.typeIn('50€ in gel');
      await b.waitFor(`${CB}.getElementById('quick')?.dataset.kind === 'currency'`, 10000);
    } finally { await b.quit(); }
    const file = path.join(profile, 'Meridian Currency Rates.json');
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(kept.date, '2026-11-20');
    assert.equal(kept.nbg_date, '2026-11-25');
    assert.equal(kept.rates.GEL, 3);
    // A day later and offline: the kept ones, with their day.
    kept.fetched -= 24 * 3600;
    fs.writeFileSync(file, JSON.stringify(kept));
    const down = await rateServers({ fail: true });
    b = await launch(['about:blank'], { profile, args: down.args });
    ui = bar(b);
    try {
      await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
      await ui.typeIn('50€ in gel');
      await b.waitFor(`${CB}.getElementById('quick')?.dataset.kind === 'currency'`, 10000);
      assert.deepEqual(await ui.quick().then((q) => [q.value, q.detail]),
                       ['150.00 GEL', '50 EUR · National Bank of Georgia rate of 2026-11-25']);
      assert.equal(down.calls.ecb + down.calls.nbg, 2, 'it tried again');
    } finally { await b.close(); down.close(); }
  } finally { good.close(); fs.rmSync(profile, { recursive: true, force: true }); }

  // Nothing kept and no connection: a plain "Rates unavailable", which Return doesn't copy.
  const down = await rateServers({ fail: true });
  const b = await launch(['about:blank'], { args: down.args });
  const ui = bar(b);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await ui.typeIn('50€ in gel');
    await b.waitFor(`${CB}.getElementById('quick')?.dataset.action === 'none'`, 10000);
    const q = await ui.quick();
    assert.deepEqual([q.value, q.sel, q.go], ['Rates unavailable', false, '']);
    await ui.shot('currency-unavailable');
  } finally { await b.close(); down.close(); }
});
