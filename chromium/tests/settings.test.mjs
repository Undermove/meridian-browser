// Meridian > Settings (⌘,): General, Links (Air Traffic Control), Advanced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const ST = 'app.$.settings.shadowRoot';
const C = { showSettings: 13 };
const open = (b) => b.eval(`app.$.tabstrip.runCommand(${C.showSettings}, 0)`).then(() => b.waitFor(`app.$.settings.open && !!${ST}.getElementById('general')`));
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
