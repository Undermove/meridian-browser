// Meridian > Settings (⌘,): General, Links (Air Traffic Control), Advanced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const ST = 'app.$.settings.shadowRoot';
const C = { showSettings: 13 };
// Settings opens on the member's tab (Arc's); most tests then go to General.
const open = async (b, section = 'general') => {
  await b.eval(`app.$.tabstrip.runCommand(${C.showSettings}, 0)`);
  await b.waitFor(`app.$.settings.open && !!${ST}.getElementById('member')`);
  if (section !== 'member') {
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === ${JSON.stringify(section)})`);
    await b.waitFor(`!!${ST}.getElementById(${JSON.stringify(section)})`);
  }
};
const settings = (b) => b.eval(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings)`);

test('General: sidebar side, theme and archive time apply and are kept', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['about:blank'], { profile });
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b);
    await b.click(`${ST}.getElementById('sidebarRight')`);
    await b.waitFor(`app.hasAttribute('sidebar-right')`);
    // The sidebar is now right of the page.
    await b.waitFor(`app.shadowRoot.getElementById('sidebar').getBoundingClientRect().left >= app.$.contentRegion.getBoundingClientRect().right`);
    await b.click(`[...${ST}.querySelectorAll('.seg')].find((s) => s.dataset.value === 'dark')`);
    await b.waitFor(`matchMedia('(prefers-color-scheme: dark)').matches`);
    await b.eval(`(() => { const s = ${ST}.getElementById('archiveAfter'); s.value = '24'; s.dispatchEvent(new Event('change')); })()`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.archiveAfterHours === 24)`);
    await b.key('Escape', 'Escape', 27);
    await b.waitFor(`!app.$.settings.open`);
    await b.quit();

    b = await launch([], { profile });
    await b.waitFor(`app.hasAttribute('sidebar-right')`);
    const s = await settings(b);
    assert.equal(s.appearance, 'dark');
    assert.equal(s.archiveAfterHours, 24);
    // Back to the defaults.
    await open(b);
    await b.click(`${ST}.getElementById('sidebarLeft')`);
    await b.waitFor(`!app.hasAttribute('sidebar-right')`);
    await b.click(`[...${ST}.querySelectorAll('.seg')].find((s) => s.dataset.value === 'system')`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.appearance === 'system')`);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('Links: a rule, then Try it says where a link goes; Chromium settings open in a tab', async () => {
  const b = await launch(['about:blank']);
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    const space = (await b.state()).spaces[0].name;
    await open(b);
    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'links')`);
    await b.waitFor(`!!${ST}.getElementById('addRule')`);
    await b.click(`${ST}.getElementById('addRule')`);
    await b.waitFor(`!!${ST}.querySelector('.rule-pattern')`);
    await b.click(`${ST}.querySelector('.rule-pattern')`);
    await b.type('github.com');
    await b.key('Tab', 'Tab', 9);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.atc.rules[0]?.pattern === 'github.com')`);
    // The new rule sends links to the first space.
    assert.match((await settings(b)).atc.rules[0].target, /^space:/);
    await b.click(`${ST}.getElementById('tryUrl')`);
    await b.type('gist.github.com/x');
    await b.waitFor(`${ST}.getElementById('tryResult').textContent.includes('${space}')`);
    assert.match(await b.eval(`${ST}.getElementById('tryResult').textContent`), /rule “github\.com”/);
    await b.eval(`(() => { const i = ${ST}.getElementById('tryUrl'); i.value = 'example.org'; i.dispatchEvent(new Event('input')); })()`);
    await b.waitFor(`${ST}.getElementById('tryResult').textContent.includes('Little Window (no rule matched)')`);
    // Deleting it.
    await b.click(`${ST}.querySelector('.rule .icon-btn.danger')`);
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.atc.rules.length === 0)`);

    await b.click(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'general')`);
    await b.eval(`${ST}.getElementById('allSettings').scrollIntoView()`);
    await b.click(`${ST}.getElementById('allSettings')`);
    await b.waitFor(`!app.$.settings.open`);
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.url.startsWith('chrome://settings'))`);
  } finally { await b.close(); }
});

test('AI: choosing an access level starts the agent socket; Connect shows the exact command first', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const b = await launch(['about:blank'], { profile });
  const endpoint = path.join(profile, 'Meridian Agent.json');
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    assert.equal(fs.existsSync(endpoint), false, 'off by default');
    await open(b);
    await b.eval(`[...${ST}.querySelectorAll('.tab')].find((t) => t.dataset.id === 'ai').click()`);
    await b.waitFor(`!!${ST}.getElementById('agentsAsk')`);
    await b.eval(`${ST}.getElementById('agentsAsk').click()`);
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(endpoint), 'the socket is up');
    assert.equal((await settings(b)).agentAccess, 'ask');
    // The CLIs, with the command Connect would run (never run here).
    await b.waitFor(`${ST}.querySelectorAll('.row-desc.mono').length === 2`);
    assert.match(await b.eval(`${ST}.querySelector('.row-desc.mono').textContent`), /mcp add -s user meridian -- .*Meridian --mcp-bridge/);
    // An installed CLI's Connect… (the rows with a command), not the other AI buttons.
    const connect = `[...${ST}.querySelectorAll('.row-desc.mono')].map((d) => d.closest('.row').querySelector('.btn')).find((x) => !x.disabled)`;
    if (await b.eval(`!!${connect}`)) {
      await b.eval(`${connect}.click()`);
      await b.waitFor(`!!${ST}.querySelector('.command')`);
      assert.match(await b.eval(`${ST}.querySelector('.command').textContent`), /--mcp-bridge/);
      await b.eval(`[...${ST}.querySelectorAll('.confirm .btn')].find((x) => x.textContent.trim() === 'Cancel').click()`);
      await b.waitFor(`!${ST}.querySelector('.command')`);
    }
    // Off again: the socket and its token file go.
    await b.eval(`[...${ST}.querySelectorAll('.seg')].find((x) => x.dataset.name === 'agents' && x.dataset.value === 'off').click()`);
    for (let i = 0; i < 50 && fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(endpoint), false);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});

test('The member tab: the card shows the name and since when; clicking the name changes it, and it stays', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  let b = await launch(['about:blank'], { profile });
  const MC = `${ST}.querySelector('meridian-member-card').shadowRoot`;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await open(b, 'member');
    await b.waitFor(`${MC}.querySelector('.since').textContent.startsWith('Member since')`);
    assert.match(await b.eval(`${MC}.querySelector('.no').textContent`), /^No\. \d{4} \d{4}$/);
    await b.click(`${MC}.getElementById('name')`);
    await b.waitFor(`${MC}.querySelector('input.name-input')`);
    await b.eval(`(() => { const i = ${MC}.querySelector('input.name-input'); i.value = 'Ada Lovelace'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await b.waitFor(`${MC}.getElementById('name')?.textContent.trim() === 'Ada Lovelace'`);
    // The first tab and the title carry the first name, like Arc.
    await b.waitFor(`${ST}.querySelector('.tab[data-id="member"]').textContent.trim() === 'Ada'`);
    assert.equal(await b.eval(`${ST}.querySelector('#toolbar .title').textContent.trim()`), 'Ada');
    await b.waitFor(`app.$.tabstrip.handler_.getSettings().then((r) => r.settings.memberName === 'Ada Lovelace')`);
    await b.quit();
    b = await launch(['about:blank'], { profile });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
    await open(b, 'member');
    await b.waitFor(`${MC}.getElementById('name')?.textContent.trim() === 'Ada Lovelace'`);
  } finally { await b.close(); fs.rmSync(profile, { recursive: true, force: true }); }
});
