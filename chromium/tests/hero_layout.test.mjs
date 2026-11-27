// «Кто вы?» in the first-run tour fits any window: four heroes in one row, scaled to the room there
// is; nothing scrolls, no head is cut, nothing runs under the tour's button, every perk line starts
// at the same left edge, and no text on screen is under 12 px. One screenshot per window size
// (MERIDIAN_SHOT_DIR, else a temp folder) for a look by eye.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.MERIDIAN_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hero-shots-'));
const OB = `app.$.onboarding.shadowRoot`;
const PICKER = `${OB}.querySelector('meridian-hero-picker')`;

// What the step looks like now, measured in the window.
const MEASURE = `(() => {
  const ob = ${OB};
  const picker = ${PICKER};
  const r = picker.shadowRoot;
  const page = ob.querySelector('.page.step-hero');
  const stage = ob.querySelector('.stage').getBoundingClientRect();
  const next = ob.querySelector('#next').getBoundingClientRect();
  const s = parseFloat(picker.style.getPropertyValue('--s'));
  const box = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const cards = [...r.querySelectorAll('.pc')].map((pc) => ({
    card: box(pc), art: box(pc.querySelector('.bust img.hero')), guess: pc.querySelector('.guess') ? box(pc.querySelector('.guess')) : null,
    perks: [...pc.querySelectorAll('.perks li > span:last-child')].map((x) => ({ l: x.getBoundingClientRect().left, align: getComputedStyle(x).textAlign })),
    // Lines under one another, none over the next or over «Opens …» (when the perks are shown).
    shown: getComputedStyle(pc.querySelector('.perks')).opacity !== '0',
    rows: [pc.querySelector('.cls'), ...pc.querySelectorAll('.perks li'), pc.querySelector('.opens')].map((x) => box(x)),
  }));
  // Text as it shows: its font size times the set's scale (only for what is in the cards).
  let smallest = 99, where = '';
  for (const el of r.querySelectorAll('.pc h3, .pc .cls, .pc .cls b, .pc .perks li, .pc .opens, .pc .guess')) {
    if (getComputedStyle(el).opacity === '0' || getComputedStyle(el.closest('.perks') || el).opacity === '0') continue;
    const px = parseFloat(getComputedStyle(el).fontSize) * s;
    if (px < smallest) { smallest = px; where = el.className || el.tagName; }
  }
  // What sticks out of the step, for the message when it scrolls.
  const pb = page.getBoundingClientRect();
  const out = [];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { const x = el.getBoundingClientRect(); if (x.width && (x.right > pb.right + 1 || x.bottom > pb.bottom + 1)) out.push((el.tagName + '.' + el.className).slice(0, 40) + ' ' + Math.round(x.right - pb.right) + '/' + Math.round(x.bottom - pb.bottom)); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(page);
  return { out: out.slice(0, 6), w: innerWidth, h: innerHeight, s, compact: picker.hasAttribute('compact'), stage: box(ob.querySelector('.stage')), next: box(ob.querySelector('#next')),
    scroll: page.scrollHeight - page.clientHeight, scrollX: page.scrollWidth - page.clientWidth, cards, smallest, where };
})()`;

const SIZES = [[1024, 640], [1280, 800], [1440, 900], [1728, 1117], ['full'], [900, 700]];

test('«Кто вы?» fits every window: one row, scaled; no scroll, no cut heads, nothing under the button, perks left-aligned, text ≥ 12 px', async () => {
  const b = await launch(['about:blank'], { args: ['--meridian-studio', '--lang=en-US'] });
  try {
    await b.waitFor(`!!app?.$?.onboarding?.show`, 15000);
    await b.eval(`app.$.onboarding.show('tour').then(() => true)`);
    await b.waitFor(`${OB}.querySelector('#root')?.dataset.step === 'hello'`);
    await b.eval(`${OB}.querySelector('#next').click(), true`);
    await b.waitFor(`${PICKER}?.shadowRoot?.querySelectorAll('.pc').length === 4`);
    // The window, through its tab (the window's own UI isn't a target it maps).
    const tab = await b.page('about:blank');
    const { windowId } = await tab.cdp.send('Browser.getWindowForTarget');
    const win = (method, params) => tab.cdp.send(method, { windowId, ...params });
    const report = [];
    for (const size of SIZES) {
      if (size[0] === 'full') {
        // The whole screen (macOS full screen itself would open a Space on the person's screen).
        const scr = await b.eval('({ w: screen.width, h: screen.height })');
        await win('Browser.setWindowBounds', { bounds: { windowState: 'normal' } }).catch(() => {});
        await win('Browser.setWindowBounds', { bounds: { left: 0, top: 0, width: scr.w, height: scr.h } });
      } else {
        await win('Browser.setWindowBounds', { bounds: { windowState: 'normal' } }).catch(() => {});
        await win('Browser.setWindowBounds', { bounds: { left: 0, top: 0, width: size[0], height: size[1] } });
      }
      await sleep(900);
      const m = await b.eval(MEASURE);
      const name = size[0] === 'full' ? 'full' : `${size[0]}x${size[1]}`;
      await b.screenshot(path.join(SHOTS, `hero-${name}.png`));
      report.push(`${name}: window ${m.w}×${m.h}, scale ${m.s}${m.compact ? ' (compact)' : ''}, smallest text ${m.smallest.toFixed(1)} px`);
      const at = `${name} (${m.w}×${m.h}, scale ${m.s})`;
      assert.ok(m.scroll <= 1 && m.scrollX <= 1, `${at}: the step scrolls (${m.scroll}, ${m.scrollX}): ${m.out.join(', ')}`);
      // One row.
      const tops = m.cards.map((c) => Math.round(c.card.t));
      assert.ok(Math.max(...tops) - Math.min(...tops) < 40, `${at}: not one row: ${tops}`);
      for (const [i, c] of m.cards.entries()) {
        assert.ok(c.art.t >= m.stage.t - 1, `${at}: hero ${i}'s head is cut (${c.art.t} < ${m.stage.t})`);
        assert.ok(c.card.l >= -1 && c.card.r <= m.w + 1, `${at}: card ${i} off the window sideways`);
        const low = Math.max(c.card.b, c.guess?.b || 0);
        assert.ok(low <= m.next.t - 2, `${at}: card ${i} runs under the button (${low} > ${m.next.t})`);
        assert.ok(low <= m.stage.b + 1, `${at}: card ${i} cut at the bottom`);
        if (i) assert.ok(c.card.l >= m.cards[i - 1].card.r - 1, `${at}: cards ${i - 1} and ${i} overlap`);
        if (c.shown) {
          for (let j = 1; j < c.rows.length; j++) {
            assert.ok(c.rows[j].t >= c.rows[j - 1].b - 1, `${at}: card ${i}: line ${j} runs over line ${j - 1} (${c.rows[j].t} < ${c.rows[j - 1].b})`);
          }
        }
        // Every perk line starts at the same left edge and reads left to right.
        const lefts = c.perks.map((p) => Math.round(p.l));
        assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, `${at}: card ${i}'s perks start at ${lefts}`);
        assert.ok(c.perks.every((p) => p.align === 'left' || p.align === 'start'), `${at}: card ${i}'s perks aren't left-aligned`);
      }
      assert.ok(m.smallest >= 11.95, `${at}: ${m.where} shows at ${m.smallest.toFixed(1)} px`);
    }
    console.error(`hero layout (shots in ${SHOTS}):\n  ${report.join('\n  ')}`);
  } finally {
    await b.close();
  }
});
