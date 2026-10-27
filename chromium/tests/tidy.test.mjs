// Tidy Today against a stand-in Anthropic API: the proposal, unticking a title, Apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { launch, SB } from './harness.mjs';

const KEY = 'sk-ant-test-000000000000000000000000';
const TD = 'app.$.tidy.shadowRoot';

test('Tidy Today: Claude proposes folders and titles; only what is kept is applied', async () => {
  const requests = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      requests.push(json);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!json.output_config?.format) return res.end(JSON.stringify({ content: [{ type: 'text', text: 'H' }], stop_reason: 'max_tokens' }));
      const prompt = json.messages[0].content;
      const key = (title) => new RegExp(`(t\\d+)\\t${title}`).exec(prompt)[1];
      const plan = {
        folders: [{ name: 'Tbilisi Trip', tabs: [key('Flights'), key('Hotels')] }],
        renames: [{ tab: key('Flights'), title: 'Flights' }, { tab: key('Inbox'), title: 'Gmail' }, { tab: key('Recipe'), title: 'Khachapuri' }],
      };
      res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(plan) }], stop_reason: 'end_turn' }));
    });
  });
  const site = http.createServer((req, res) => {
    const titles = { '/f': 'Flights to Tbilisi | Kayak', '/h': 'Hotels in Tbilisi | Booking.com', '/m': 'Inbox (3) - Mail', '/r': 'Recipe: the best khachapuri ever - Food Blog' };
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>${titles[req.url] || 'x'}</title>`);
  });
  await Promise.all([new Promise((r) => api.listen(0, '127.0.0.1', r)), new Promise((r) => site.listen(0, '127.0.0.1', r))]);
  const s = `http://127.0.0.1:${site.address().port}`;
  const b = await launch([`${s}/f`, `${s}/h`, `${s}/m`, `${s}/r`], { args: [`--meridian-ai-base-url=http://127.0.0.1:${api.address().port}`] });
  try {
    await b.waitFor(`[...${SB}.querySelectorAll('#today meridian-tab-row')].filter((r) => r.tab?.title && r.tab.title !== r.tab.url).length === 4`);
    // No key yet: the dialog says what's missing.
    await b.click(`${SB}.getElementById('tidyToday')`);
    await b.waitFor(`${TD}.getElementById('error')?.textContent.includes('Claude API key')`);
    await b.eval('app.$.tidy.hide()');

    assert.equal((await b.eval(`app.$.tabstrip.handler_.setAiKey(${JSON.stringify(KEY)})`)).ok, true);
    await b.click(`${SB}.getElementById('tidyToday')`);
    await b.waitFor(`${TD}.querySelectorAll('.group').length === 2`);
    const sent = requests.find((r) => r.output_config?.format);
    assert.equal(sent.output_config.format.type, 'json_schema');
    assert.match(sent.messages[0].content, /<untrusted_tabs>/);
    assert.equal(await b.eval(`${TD}.querySelector('.group .name').textContent`), 'Tbilisi Trip');
    assert.equal(await b.eval(`${TD}.querySelectorAll('.group')[1].querySelectorAll('.rename').length`), 2, 'loose shorter titles');
    // Keep "Gmail", drop "Khachapuri".
    await b.eval(`[...${TD}.querySelectorAll('.rename')].find((r) => r.textContent.includes('Khachapuri')).querySelector('input').click()`);
    await b.click(`${TD}.getElementById('apply')`);

    await b.waitFor(`${SB}.querySelectorAll('#pinned meridian-item').length === 1`);
    const state = await b.eval('app.$.tabstrip.handler_.getState().then(({state}) => state)');
    const folder = state.spaces[0].pinned[0];
    assert.equal(folder.isFolder, true);
    assert.equal(folder.title, 'Tbilisi Trip');
    assert.deepEqual(folder.children.map((c) => c.title).sort(), ['Flights', 'Hotels in Tbilisi | Booking.com']);
    await b.waitFor(`${SB}.querySelectorAll('#today meridian-tab-row').length === 2`);
    const today = await b.eval(`[...${SB}.querySelectorAll('#today meridian-tab-row')].map((r) => r.shadowRoot.querySelector('.title').textContent).sort()`);
    assert.deepEqual(today, ['Gmail', 'Recipe: the best khachapuri ever - Food Blog']);
  } finally { await b.close(); api.close(); site.close(); }
});
