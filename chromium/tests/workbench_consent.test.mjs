// Starting an agent that works with an AI on the internet (Claude Code, Codex…) from the Workbench:
// Meridian first says where what you type and the project's files go. Cancel starts nothing; Start
// starts it (and asks again in a new Workbench); Always is remembered. A plain shell doesn't ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
  assert.ok(p.w > 0, `${expr} is on screen`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

test('Workbench: Meridian asks before an online agent starts; Cancel, Start, Always', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wc-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "AGENT claude"\nread x\n', { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify', '--meridian-test-ai-consent'] });
  let wb;
  const claudeButton = `[...document.querySelectorAll('#launcher .launch')].find((e) => e.textContent.includes('Claude Code'))`;
  const modalText = `document.getElementById('modal-overlay')?.hidden === false ? document.getElementById('modal-overlay').textContent : ''`;
  const claudeTerms = `S.terms.filter((t) => t.kind === 'claude').length`;
  const openWorkbench = async () => {
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden || !!S.project`, 15000);
    if (!(await wb.eval('!!S.project'))) {
      await wb.eval(`document.querySelector('#open-folder').click()`);
      await wb.waitFor('!!S.project');
    }
    await wb.waitFor(`!!S.info?.agents?.claude?.installed && !!(${claudeButton})`, 10000);
  };
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    await openWorkbench();

    // Claude Code: the question first, nothing started.
    await click(wb, claudeButton);
    await wb.waitFor(`${modalText}.includes('Anthropic (Claude)')`);
    assert.equal(await wb.eval(claudeTerms), 0);
    await click(wb, `document.querySelector('#modal-overlay [data-a="cancel"]')`);
    await wb.waitFor(`document.getElementById('modal-overlay').hidden`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await wb.eval(claudeTerms), 0, 'Cancel starts nothing');

    // Start: it starts; the next one in this Workbench doesn't ask; not remembered.
    await click(wb, claudeButton);
    await wb.waitFor(`${modalText}.includes('Anthropic (Claude)')`);
    await click(wb, `document.querySelector('#modal-overlay [data-a="ok"]')`);
    await wb.waitFor(`${claudeTerms} === 1`);
    await click(wb, claudeButton);
    await wb.waitFor(`${claudeTerms} === 2`);
    assert.equal(await wb.eval(modalText), '');
    assert.equal(await wb.eval('window.workbench.aiConsent()'), '');

    // A new Workbench asks again; Always is remembered for every Workbench after it.
    await wb.eval('location.reload(), true').catch(() => {});
    wb.close();
    await openWorkbench();
    await click(wb, claudeButton);
    await wb.waitFor(`${modalText}.includes('Anthropic (Claude)')`);
    await click(wb, `document.querySelector('#modal-overlay [data-a="always"]')`);
    await wb.waitFor(`${claudeTerms} >= 1`);
    await wb.waitFor(`window.workbench.aiConsent().then((s) => s === 'always')`);
    await wb.eval('location.reload(), true').catch(() => {});
    wb.close();
    await openWorkbench();
    const n = await wb.eval(claudeTerms);
    await click(wb, claudeButton);
    await wb.waitFor(`${claudeTerms} === ${n + 1}`);
    assert.equal(await wb.eval(modalText), '', 'Always: no question');
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
