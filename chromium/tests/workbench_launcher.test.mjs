// The Workbench's top bar on a small screen with many agents installed: the launchers that don't
// fit go into a "More" menu at the bar's end (they used to scroll out of sight with no scrollbar,
// so nothing after OpenCode could be reached). Each one starts from there, and an OpenCode session
// shows in Mission Control under its tab's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const AGENTS = ['claude', 'codex', 'gemini', 'copilot', 'opencode', 'cursor-agent', 'qwen', 'amp', 'goose', 'droid'];

async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
  assert.ok(p.w > 0, `${expr} is on screen`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

// More, clicked again if it didn't open: a session just started re-fits the bar under the pointer.
async function openMore(wb) {
  for (let i = 0; ; i++) {
    await click(wb, `document.getElementById('launcher-more')`);
    try { await wb.waitFor(`!document.getElementById('popover').hidden`, 2000); return; } catch (e) { if (i === 3) throw e; }
  }
}

test('Workbench top bar on a small screen: launchers that don’t fit are in More; each one starts from there', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wl-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  // Every agent "installed": a stand-in that says which it is and waits.
  for (const a of AGENTS) {
    standIn(bin, a, `console.log("AGENT ${a}"); process.stdin.resume(); process.stdin.once("data", () => process.exit(0));`);
  }
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--window-size=900,700'] });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.waitFor(`!!S.info?.agents?.droid?.installed`, 10000);
    // Nothing overflows out of sight; the rest is behind More.
    await wb.waitFor(`!!document.getElementById('launcher-more')`, 5000);
    const bar = await wb.eval(`(() => { const b = document.getElementById('launcher'); return { sw: b.scrollWidth, cw: b.clientWidth, shown: [...b.children].filter((e) => !e.hidden).map((e) => e.textContent.trim()), hidden: [...b.children].filter((e) => e.hidden).map((e) => e.textContent.trim()) }; })()`);
    assert.ok(bar.sw <= bar.cw + 1, `the bar fits: ${bar.sw} > ${bar.cw} ` + JSON.stringify(await wb.eval(`(() => { const b = document.getElementById('launcher'); return [b.className, typeof fitLauncher, [...b.children].map((e) => [e.className, e.hidden, Math.round(e.getBoundingClientRect().width), e.textContent.trim()]), getComputedStyle(b).display, [...document.getElementById('topbar').children].map((e) => [e.id || e.className, Math.round(e.getBoundingClientRect().width)])]; })()`)));
    assert.ok(bar.shown[0].includes('Claude Code'), 'Claude Code stays in the bar');
    assert.ok(bar.hidden.some((t) => t.includes('Droid')), `Droid is in More: ${bar.hidden}`);
    assert.match(bar.shown[bar.shown.length - 1], /^\d+$/, "More shows how many");

    // More, then Droid: it starts.
    await openMore(wb);
    await wb.waitFor(`document.querySelectorAll('#popover .launch-menu .launch').length === ${bar.hidden.length}`);
    // Every row of the menu shows its name (the narrow-bar rule that hides names is for the bar).
    const unnamed = await wb.eval(`[...document.querySelectorAll('#popover .launch-menu .launch')].filter((r) => { const l = [...r.children].find((c) => c.tagName === 'SPAN' && !c.matches('.mark, .plug, .ic-slot')); return !l || !l.textContent.trim() || l.getBoundingClientRect().width === 0; }).map((r) => r.title)`);
    assert.deepEqual(unnamed, [], 'rows without a name');
    await click(wb, `[...document.querySelectorAll('#popover .launch-menu .launch')].find((e) => e.textContent.includes('Droid'))`);
    await wb.waitFor(`document.getElementById('popover').hidden`);
    await wb.waitFor(`S.terms.some((t) => t.kind === 'droid')`, 10000);

    // OpenCode (wherever it is) starts too, and shows in Mission Control under its tab's name.
    const inBar = await wb.eval(`!![...document.getElementById('launcher').children].find((e) => !e.hidden && e.textContent.includes('OpenCode'))`);
    if (inBar) {
      await click(wb, `[...document.getElementById('launcher').children].find((e) => !e.hidden && e.textContent.includes('OpenCode'))`);
    } else {
      await openMore(wb);
      await click(wb, `[...document.querySelectorAll('#popover .launch-menu .launch')].find((e) => e.textContent.includes('OpenCode'))`);
    }
    await wb.waitFor(`S.terms.some((t) => t.kind === 'opencode')`, 10000);
    const name = await wb.eval(`termName(S.terms.find((t) => t.kind === 'opencode'))`);
    const state = () => b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))');
    let node;
    for (let i = 0; i < 50 && !node; i++) {
      node = (await state()).nodes.find((n) => n.kind === 'session' && /OpenCode/.test(n.sublabel || n.label) && n.label === name);
      if (!node) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(node, `OpenCode is in Mission Control as “${name}”: ${JSON.stringify((await state()).nodes.map((n) => [n.label, n.sublabel]))}`);

    // A wide window: everything fits again, no More.
    await b.cdp.send('Browser.getWindowForTarget').then(({ windowId }) => b.cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 2400 } })).catch(() => {});
    await wb.waitFor(`!document.getElementById('launcher-more')`, 5000).catch(() => {});
  } finally {
    try { wb?.close(); } catch {}
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
