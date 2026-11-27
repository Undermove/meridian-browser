// Customize, simplified: on top three pictures of the Workbench's looks in a row (Familiar, Calm,
// Minimal), the one in use marked, «As it was» only while one is on; then one field with three ideas;
// everything else folded under «More ideas and add-ons». A click shows a look at once and the toast's
// Undo takes it back; no look hides the left pane (Files, Changes, and Chats in the beta); Calm's old
// name ('designer') still means Calm. The real workbench.html, workbench.css, workbench.js and
// workbench-pro.js in a headless page, with a stand-in for the host bridge; side panel 240/320/480 px,
// light and dark.
// Needs Playwright's Chromium (npx playwright install chromium); skipped without it.
// Run: node --test 'tests/unit/*.test.js'
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DEV = path.join(__dirname, '../../src/renderer/dev');
const read = (f) => fs.readFileSync(path.join(DEV, f), 'utf8');

// The real scripts, with a stand-in for the host bridge (window.workbench) and without the boot
// (no project, no terminals, no editor): only the Customize panel is opened.
const BRIDGE = `
window.workbench = new Proxy({ platform: 'darwin' }, { get: (o, k) => (k in o ? o[k] : async () => ({})) });
const realAdd = document.addEventListener.bind(document);
document.addEventListener = (type, fn, opts) => { if (type !== 'DOMContentLoaded') realAdd(type, fn, opts); };
`;

function page() {
  const html = read('workbench.html');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<!-- xterm'));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${read('workbench.css')}</style></head><body>${body}
<script>${BRIDGE}</script>
<script>${fs.readFileSync(path.join(DEV, '../icons.js'), 'utf8')}</script>
<script>${read('workbench.js')}</script><script>${read('workbench-pro.js')}</script>
<script>
  PRO.custom = { settings: null, plugins: [], history: [] };
  PRO.settings = effectiveSettings(null);
  applySettings(null);
  $('#welcome').hidden = true; $('#main').hidden = false;
  openPanel('customize');
</script></body></html>`;
}

// A page at an http origin (its own localStorage), seeded with what the Workbench stored before.
async function open(browser, opts, stored = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route('http://wb.test/**', (r) => r.fulfill({ contentType: 'text/html', body: page() }));
  await ctx.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem('wb.' + k, v); }, stored);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto('http://wb.test/');
  return { ctx, p, errors };
}

// The top of the panel as the person sees it.
const TOP = `(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = document.querySelector('#side-body .panel');
  return {
    panel: box(panel),
    looks: [...panel.querySelectorAll('.custom-looks .look')].map((c) => ({
      id: c.dataset.preset, on: c.classList.contains('on'), name: c.querySelector('.look-name').textContent,
      box: box(c), thumb: box(c.querySelector('.look-thumb')), label: box(c.querySelector('.look-name')),
      clipped: c.querySelector('.look-name').scrollWidth > c.querySelector('.look-name').clientWidth + 1,
      statusShown: getComputedStyle(c.querySelector('.lt-status')).display !== 'none',
      thumbBg: getComputedStyle(c.querySelector('.lt-main')).backgroundColor,
      thumbRadius: getComputedStyle(c.querySelector('.look-thumb')).borderRadius,
    })),
    back: !!panel.querySelector('.look-back'),
    field: !!panel.querySelector('.custom-ask input'),
    chips: [...panel.querySelectorAll('.custom-chips .idea')].map((b) => b.textContent),
    chipBoxes: [...panel.querySelectorAll('.custom-chips .idea')].map(box),
    moreOpen: panel.querySelector('.custom-more').open,
    moreTop: box(panel.querySelector('.custom-more')).t - box(panel).t,
    headers: [...panel.querySelectorAll('h2, h3')].filter((e) => e.checkVisibility()).map((e) => e.textContent),
  };
})()`;
const overlap = (a, b) => a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
const inside = (a, b) => a.l >= b.l - 0.5 && a.r <= b.r + 0.5 && a.t >= b.t - 0.5 && a.b <= b.b + 0.5;

let chromium = null;
try { ({ chromium } = require('playwright')); } catch {}

test('Customize: three looks in a row, one field, the rest folded; looks apply at once with Undo and keep the left pane', { skip: !chromium && 'no Playwright' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch { t.skip('no Playwright Chromium'); return; }
  try {
    for (const scheme of ['light', 'dark']) {
      for (const sideW of [240, 320, 480]) {
        const { ctx, p, errors } = await open(browser, { viewport: { width: 1280, height: 900 }, colorScheme: scheme });
        await p.evaluate((w) => document.documentElement.style.setProperty('--side-w', w + 'px'), sideW);
        const tag = `${scheme} ${sideW}px`;
        assert.deepEqual(errors, [], tag);
        let top = await p.evaluate(TOP);
        assert.deepEqual(top.looks.map((l) => l.id), ['familiar', 'calm', 'minimal'], tag);
        assert.deepEqual(top.looks.map((l) => l.on), [false, false, false], `${tag}: none on at first`);
        assert.equal(top.back, false, `${tag}: no «As it was» while nothing is on`);
        assert.equal(top.field, true);
        assert.deepEqual(top.chips, ['Bigger text', 'Taller terminal', 'A “Run tests” button']);
        assert.equal(top.moreOpen, false, `${tag}: the rest is folded`);
        top.chipBoxes.forEach((c, i) => {
          assert.ok(c.b - c.t >= 20 && inside(c, top.panel), `${tag}: idea ${i + 1} is a chip inside the panel`);
          top.chipBoxes.slice(i + 1).forEach((d, j) => assert.ok(!overlap(c, d) && (Math.abs(c.t - d.t) > 0.5 || Math.abs(c.r - d.l) >= 4 || Math.abs(d.r - c.l) >= 4), `${tag}: ideas ${i + 1} and ${i + j + 2} touch`));
        });
        assert.deepEqual(top.headers, ['Customize'], `${tag}: one header`);
        assert.ok(top.moreTop < 300, `${tag}: the top fits in ${top.moreTop}px`);
        const [fam, calm, min] = top.looks;
        assert.ok(Math.abs(fam.box.t - calm.box.t) < 0.5 && Math.abs(calm.box.t - min.box.t) < 0.5, `${tag}: one row`);
        for (let i = 0; i < 3; i++) {
          const l = top.looks[i];
          assert.ok(inside(l.box, top.panel), `${tag} ${l.id}: outside the panel`);
          assert.ok(!overlap(l.thumb, l.label), `${tag} ${l.id}: picture over its name`);
          assert.equal(l.clipped, false, `${tag} ${l.id}: name cut off`);
          for (let j = i + 1; j < 3; j++) assert.ok(!overlap(l.box, top.looks[j].box), `${tag}: ${l.id} overlaps ${top.looks[j].id}`);
        }
        // The pictures differ: Calm warm and rounded, Minimal without the status bar.
        assert.notEqual(calm.thumbBg, fam.thumbBg, `${tag}: Calm's picture in its own colours`);
        assert.notEqual(calm.thumbRadius, fam.thumbRadius, `${tag}: Calm's picture rounder`);
        assert.equal(fam.statusShown && calm.statusShown && !min.statusShown, true, `${tag}: only Minimal's picture has no status bar`);

        // Calm: at once, marked, «As it was» appears, a toast with Undo; the left pane stays.
        await p.click('.look[data-preset="calm"]');
        assert.equal(await p.evaluate(`document.body.dataset.look`), 'soft');
        top = await p.evaluate(TOP);
        assert.deepEqual(top.looks.map((l) => l.name), ['Familiar', 'Calm ✓', 'Minimal'], tag);
        assert.equal(top.back, true);
        assert.equal(await p.evaluate(`$('#tree-pane').hidden`), false, `${tag}: Calm keeps the left pane`);
        assert.match(await p.evaluate(`$('#toasts .toast-action')?.textContent || ''`), /Calm applied\s*Undo/);
        await p.click('#toasts .toast-action button');
        assert.equal(await p.evaluate(`document.body.dataset.look`), 'default');
        assert.equal((await p.evaluate(TOP)).back, false, `${tag}: Undo`);

        // Minimal: no status bar, the left pane (Files, Changes) still there.
        await p.click('.look[data-preset="minimal"]');
        assert.equal(await p.evaluate(`getComputedStyle($('#statusbar')).display`), 'none');
        assert.equal(await p.evaluate(`$('#tree-pane').hidden || $('#left-views').getBoundingClientRect().width === 0`), false, `${tag}: Minimal keeps the left pane`);
        // Familiar: the desktop editor's layout.
        await p.click('.look[data-preset="familiar"]');
        assert.deepEqual(await p.evaluate(`[PRO.settings.layout.showTree, PRO.settings.layout.showStatusBar, PRO.settings.layout.editorTabs, PRO.settings.layout.terminalTabs, PRO.settings.editor.minimap, document.body.dataset.look]`), [true, true, 'top', 'top', true, 'default'], tag);
        assert.equal(await p.evaluate(`getComputedStyle($('#statusbar')).display`), 'flex');
        // «As it was»: the person's own.
        await p.click('.look-back');
        assert.equal(await p.evaluate(`activePreset()`), '');
        if (process.env.MERIDIAN_SHOTS) {
          await p.click('.look[data-preset="calm"]');
          await p.locator('#side-pane').screenshot({ path: path.join(process.env.MERIDIAN_SHOTS, `customize-${scheme}-${sideW}.png`) });
        }
        await ctx.close();
      }
    }
    // Calm's old name.
    const { ctx, p } = await open(browser, {}, { preset: 'designer' });
    assert.equal(await p.evaluate(`document.body.dataset.look`), 'soft');
    assert.equal(await p.evaluate(`document.querySelector('.look.on').dataset.preset`), 'calm');
    await ctx.close();
  } finally { await browser.close(); }
});
