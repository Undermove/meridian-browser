// The Customize panel, simple first: three looks in a row (Familiar, Calm, Minimal; «As it was» takes
// them off), one field to say what to change with three ideas, and the rest folded under «More ideas
// and add-ons»: examples by kind (each one a click that asks the AI for it), what isn't possible yet,
// empty states that explain; file names under "Advanced". settings.json moves the tab bars to the
// left as real vertical lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in Claude Code that echoes each line typed into it.
const FAKE_CLAUDE = `#!/usr/bin/python3
import sys
print('READY', flush=True)
for line in sys.stdin:
  print('GOT ' + line.strip(), flush=True)
`;

async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
const termText = `(() => { const t = S.activeTerm; if (!t) return ''; const b = t.xterm.buffer.active; return [...Array(b.length).keys()].map((k) => b.getLine(k)?.translateToString(true)).join('\\n'); })()`;
const panel = `document.querySelector('#side-body .panel')`;

test('the Customize panel explains what can be customized, asks the AI from an example, and has reversible looks', { skip: process.platform === 'win32' && 'the stand-in is a Python script' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-cp-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  let b, wb;
  try {
    b = await launch(['about:blank'], { profile, args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await click(wb, `document.querySelector('#open-folder')`);
    await wb.waitFor('!!S.project');
    await click(wb, `document.querySelector('#btn-customize')`);
    await wb.waitFor(`!!${panel}?.querySelector('.custom-looks')`);

    // The first screen: three looks, one field, three ideas; the rest folded.
    assert.deepEqual(await wb.eval(`[...${panel}.querySelectorAll('.custom-looks .look')].map((l) => l.dataset.preset)`), ['familiar', 'calm', 'minimal']);
    assert.equal(await wb.eval(`!!${panel}.querySelector('.custom-ask input')`), true);
    assert.equal(await wb.eval(`${panel}.querySelectorAll('.custom-chips .idea').length`), 3);
    assert.equal(await wb.eval(`${panel}.querySelector('details.custom-more').open`), false);
    // No file names (they are under Advanced, closed).
    const first = await wb.eval(`(() => { const c = ${panel}.cloneNode(true); c.querySelector('details.advanced')?.remove(); return c.textContent; })()`);
    for (const word of ['plugins/', 'user.css', 'settings.json', 'hello-button']) assert.ok(!first.includes(word), `"${word}" is not on the first screen`);
    assert.equal(await wb.eval(`${panel}.querySelector('details.advanced').open`), false);
    assert.match(await wb.eval(`${panel}.querySelector('details.advanced').textContent`), /user\.css/);
    // More ideas, by kind.
    await click(wb, `${panel}.querySelector('details.custom-more > summary')`);
    await wb.waitFor(`${panel}.querySelector('details.custom-more').open`);
    assert.deepEqual(await wb.eval(`[...${panel}.querySelectorAll('.idea-cat')].map((e) => e.textContent)`), ['Look', 'Layout', 'Buttons & commands', 'Panels', 'Launchers']);
    // What isn't possible (yet).
    const limits = await wb.eval(`${panel}.querySelector('.custom-limits').textContent`);
    for (const w of ['tab bars', 'terminal itself', 'internet', 'visual canvas', 'code editor']) assert.ok(limits.includes(w), `limits mention ${w}`);
    // Human empty states, each with something to do.
    assert.match(first, /No add-ons yet/);
    assert.match(first, /Nothing changed yet/);
    assert.ok(await wb.eval(`[...${panel}.querySelectorAll('.empty-state .btn')].some((b) => b.textContent.includes('Ask for an add-on'))`));

    // Calm: one click on (marked, the left pane stays); «As it was» takes it off; the person's files
    // are untouched.
    const settingsFile = path.join(await wb.eval('PRO.custom.root'), 'settings.json');
    const settingsBefore = fs.readFileSync(settingsFile, 'utf8');
    await click(wb, `${panel}.querySelector('.look[data-preset="calm"]')`);
    await wb.waitFor(`document.body.dataset.look === 'soft' && !document.querySelector('#tree-pane').hidden && ${panel}.querySelector('.look.on')?.dataset.preset === 'calm'`);
    assert.equal(await wb.eval('PRO.settings.editor.theme'), 'light');
    assert.equal(await wb.eval('PRO.settings.editor.minimap'), false);
    assert.doesNotMatch(await wb.eval('PRO.settings.editor.fontFamily'), /mono/i, 'a regular (not code) font');
    assert.match(await wb.eval(`document.querySelector('#toasts .toast-action')?.textContent || ''`), /Calm applied/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), settingsBefore, 'settings.json is not changed');
    await click(wb, `${panel}.querySelector('.look-back')`);
    await wb.waitFor(`document.body.dataset.look === 'default' && !document.querySelector('#tree-pane').hidden && getComputedStyle(document.querySelector('#statusbar')).display !== 'none'`);
    // Minimal: no status bar, the left pane stays; Undo in its toast takes it back.
    await click(wb, `${panel}.querySelector('.look[data-preset="minimal"]')`);
    await wb.waitFor(`!document.querySelector('#tree-pane').hidden && document.body.classList.contains('wb-no-statusbar') && document.body.dataset.look === 'minimal'`);
    await click(wb, `document.querySelector('#toasts .toast-action button')`);
    await wb.waitFor(`!document.body.classList.contains('wb-no-statusbar') && document.body.dataset.look === 'default'`);
    // Familiar: a desktop editor's layout (files left, tabs on top, status bar, minimap).
    await click(wb, `${panel}.querySelector('.look[data-preset="familiar"]')`);
    await wb.waitFor(`PRO.settings.editor.minimap === true && PRO.settings.layout.editorTabs === 'top' && !document.querySelector('#tree-pane').hidden`);
    await click(wb, `${panel}.querySelector('.look-back')`);
    await wb.waitFor(`activePreset() === ''`);

    // An example, clicked: Claude Code opens in the customization folder and gets the request.
    await click(wb, `[...${panel}.querySelectorAll('.idea')].find((b) => b.textContent === 'Hide the file tree')`);
    await wb.waitFor(`S.project?.root === PRO.custom.root && S.activeTerm?.kind === 'claude'`, 15000);
    await wb.waitFor(`${termText}.includes('GOT Hide the file tree.')`, 20000);
    // A second one goes to the same session.
    await wb.waitFor(`${panel}?.querySelector('details.custom-more')?.open`);
    await click(wb, `[...${panel}.querySelectorAll('.idea')].find((b) => b.textContent === 'Minimap off')`);
    await wb.waitFor(`${termText}.includes('GOT Turn the editor minimap off.')`, 20000);
    assert.equal(await wb.eval(`S.terms.filter((t) => t.kind === 'claude').length`), 1);
    // The field: said in one's own words, Return; the same session gets it.
    await wb.eval(`(() => { const f = ${panel}.querySelector('.custom-ask'); f.querySelector('input').value = 'Make the status bar blue'; f.requestSubmit(); })()`);
    await wb.waitFor(`${termText}.includes('GOT Make the status bar blue')`, 20000);
    assert.equal(await wb.eval(`S.terms.filter((t) => t.kind === 'claude').length`), 1);

    // settings.json: the tab bars on the left, as vertical lists.
    await wb.eval(`launch('shell').then((t) => !!t)`);
    const settings = JSON.parse(settingsBefore);
    settings.layout = { ...settings.layout, terminalTabs: 'left', editorTabs: 'left' };
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    await wb.waitFor(`document.body.dataset.termTabs === 'left' && document.body.dataset.editorTabs === 'left'`, 10000);
    await sleep(300);
    const geo = await wb.eval(`(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const tabs = [...document.querySelectorAll('.wb-term-tab')].map((e) => e.getBoundingClientRect());
      return { bar: r('.wb-term-tabs'), host: r('#term-host'), ebar: r('.wb-editor-tabs'), ehost: r('#editor-host'), tabs: tabs.map((t) => ({ x: t.x, y: t.y })) };
    })()`);
    assert.ok(geo.bar.w > 120 && geo.bar.w < 260 && geo.bar.h > 60, `the terminal tab bar is a column: ${JSON.stringify(geo.bar)}`);
    assert.ok(geo.host.x >= geo.bar.x + geo.bar.w - 1, 'the terminals are to its right');
    assert.equal(geo.tabs.length, 2);
    assert.ok(geo.tabs[1].y > geo.tabs[0].y && Math.abs(geo.tabs[1].x - geo.tabs[0].x) < 2, 'the tabs are stacked');
    assert.ok(geo.ehost.x >= geo.ebar.x + geo.ebar.w - 1 && geo.ebar.w > 120, 'the editor tab bar is on the left too');
    // And back.
    fs.writeFileSync(settingsFile, settingsBefore);
    await wb.waitFor(`document.body.dataset.termTabs === 'top' && document.body.dataset.editorTabs === 'top'`, 10000);
  } finally {
    try { wb?.close(); } catch {}
    await b?.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
