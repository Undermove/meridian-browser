// Workbench customizations and hubs: the customization folder with its starter files, a plugin that
// runs only after the native approval (answered by a test switch) and only while its bytes match,
// switching plugins off, Safe Mode, snapshots with revert, and creating a hub from a template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Workbench customizations: approved plugins, Safe Mode, revert; hubs from templates', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-cust-')));
  const hubs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-hubs-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-')));
  const b = await launch(['about:blank'], {
    profile,
    args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, `--meridian-test-hub-parent=${hubs}`,
      '--meridian-no-notify', '--meridian-test-dialog-answer=Run this plugin'],
  });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    const call = (code) => wb.eval(`${code}.then((r) => r, (e) => 'ERR ' + e.message)`);
    // XHR: chrome:// isn't a fetch() scheme.
    const served = (rel) => wb.eval(`new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/custom/${rel}'); x.onload = () => res(x.status === 200 ? x.responseText : null); x.onerror = () => res(null); x.send(); })`);

    // The folder sits next to the profile, with the starter files.
    const root = path.join(profile, 'Meridian Workbench Custom');
    let st = await call('window.workbench.customState()');
    assert.equal(st.root, root);
    assert.equal(st.safeMode, false);
    assert.equal(st.settings.editor.fontSize, 13);
    for (const f of ['user.css', 'settings.json', 'AGENTS.md', 'API.md', 'CLAUDE.md', 'examples/hello-button.js']) {
      assert.ok(fs.existsSync(path.join(root, f)), f);
    }
    assert.ok(st.snapshots.some((s) => s.reason === 'initial'));
    const initial = st.snapshots.find((s) => s.reason === 'initial').id;

    // An agent drops in a plugin: it waits for approval; "Review…" opens the native prompt (approved
    // by the test switch) and then it runs.
    fs.copyFileSync(path.join(root, 'examples', 'hello-button.js'), path.join(root, 'plugins', 'hello.js'));
    await wb.waitFor(`document.querySelector('#notice .msg')?.textContent.includes('hello.js is waiting for your approval')`, 15000);
    await wb.eval(`[...document.querySelectorAll('#notice button')].find((b) => b.textContent.includes('Review')).click()`);
    await wb.waitFor(`PRO.plugins.get('hello.js')?.status === 'active'`, 15000);
    assert.ok(await wb.eval(`document.body.textContent.includes('Hello')`));
    const approvals = JSON.parse(fs.readFileSync(path.join(profile, 'Meridian Workbench Plugins.json'), 'utf8'));
    assert.equal(approvals.plugins['hello.js'].sha256.length, 64);
    assert.match(await served('plugins/hello.js'), /workbenchPlugin/);
    assert.match(await served('user.css'), /./);

    // Changed bytes are not served until approved again (approval kept outside the folder).
    const approvalsFile = path.join(profile, 'Meridian Workbench Plugins.json');
    approvals.plugins['hello.js'].sha256 = '0'.repeat(64);
    fs.writeFileSync(approvalsFile, JSON.stringify(approvals));
    assert.equal(await served('plugins/hello.js'), null, 'bytes that don’t match the approval');
    // Never anything outside the plugin and style files.
    assert.equal(await served('settings.json'), null);
    assert.equal(await served('..%2F..%2FDefault%2FPreferences'), null);

    // Switched off: not served at all, even with a matching approval.
    await call(`window.workbench.customApprovePlugins()`);
    assert.match(await served('plugins/hello.js'), /workbenchPlugin/);
    assert.deepEqual(await call(`window.workbench.customTogglePlugin('hello.js', false)`), ['hello.js']);
    assert.equal(await served('plugins/hello.js'), null);
    await call(`window.workbench.customTogglePlugin('hello.js', true)`);

    // Safe Mode: the page reloads without anything from the folder.
    await wb.eval(`(() => { window.workbench.customSafeMode(true); return true; })()`);
    await sleep(1000);
    await wb.waitFor(`typeof PRO !== 'undefined' && PRO.custom?.safeMode === true && PRO.plugins.size === 0`, 15000);
    assert.equal(await wb.eval(`!!document.querySelector('script[data-plugin]')`), false);
    assert.equal(await served('user.css'), null);
    await call('window.workbench.customSafeMode(false)');
    assert.match(await served('user.css'), /./);
    await wb.waitFor(`PRO.plugins.get('hello.js')?.status === 'active'`, 15000);

    // Every change is snapshotted; revert brings back the first state (and removes the plugin).
    for (let i = 0; i < 50; i++) {
      st = await call('window.workbench.customState()');
      if (st.snapshots.some((s) => s.reason === 'auto' && s.files.includes('plugins/hello.js'))) break;
      await sleep(200);
    }
    assert.ok(st.snapshots.some((s) => s.files.includes('plugins/hello.js')));
    assert.equal(await call(`window.workbench.customRestore(${JSON.stringify(initial)})`), true);
    assert.equal(fs.existsSync(path.join(root, 'plugins', 'hello.js')), false);
    assert.match(await call(`window.workbench.customRestore('../../x')`), /^ERR bad snapshot id/);

    // Hubs: the templates are offered; a knowledge base is created and opened as the project.
    const info = await call('window.workbench.info()');
    assert.deepEqual(info.hubTemplates.map((t) => t.id), ['content', 'knowledge', 'code']);
    assert.match(await call(`window.workbench.hubCreate({ name: 'Notes', template: 'knowledge' })`), /^ERR Choose where/);
    // The "New hub" wizard, clicked through (the folder dialog is answered by a test switch).
    await wb.eval(`document.querySelector('#new-hub').click()`);
    await wb.waitFor(`!!document.querySelector('#hub-name')`);
    await wb.eval(`(() => { document.querySelector('#hub-name').value = 'Notes'; document.querySelector('input[name="tpl"][value="knowledge"]').click(); document.querySelector('#hub-git').checked = false; document.querySelector('[data-a="pick"]').click(); return true; })()`);
    await wb.waitFor(`document.querySelector('#hub-parent')?.textContent === ${JSON.stringify(hubs)}`);
    await wb.eval(`document.querySelector('[data-a="create"]').click()`);
    await wb.waitFor(`S.project?.root === ${JSON.stringify(path.join(hubs, 'Notes'))}`, 15000);
    await wb.waitFor(`document.querySelector('#notice .msg')?.textContent.includes('Hub “Notes” is ready: no git')`);
    assert.match(fs.readFileSync(path.join(hubs, 'Notes', 'AGENTS.md'), 'utf8'), /^# Notes — instructions for agents/);
    assert.ok(fs.existsSync(path.join(hubs, 'Notes', '.claude', 'skills', 'hub-conventions', 'SKILL.md')));
    const hub = await call('window.workbench.hubInfo()');
    assert.equal(hub.isHub, true);
    assert.deepEqual(hub.skills, ['hub-conventions']);
    assert.ok(hub.conventions.find((c) => c.path === 'AGENTS.md').headings.some((h) => h.text === 'Structure'));
    assert.match(await call(`window.workbench.hubCreate({ name: 'Notes', template: 'knowledge', git: false })`), /already exists/);
    assert.match(await call(`window.workbench.hubCreate({ name: '../up', template: 'code', git: false })`), /plain folder name/);

    // "Pin to sidebar": the hub becomes a pinned item that reopens it, even after its tab is gone.
    const notes = path.join(hubs, 'Notes');
    await wb.eval(`[...document.querySelectorAll('#notice button')].find((b) => b.textContent.includes('Pin to sidebar')).click()`);
    await b.waitFor(`app.$.tabstrip.state_.spaces[0].pinned.some((i) => i.title === 'Notes')`);
    assert.equal(await b.eval(`app.$.tabstrip.state_.spaces[0].pinned.find((i) => i.title === 'Notes').url`), `chrome://workbench/?project=${encodeURIComponent(notes)}`);
    wb.close(); wb = null;
    // The pinned tab is closed (its item stays).
    await b.eval(`(() => { const s = app.$.tabstrip.state_; const item = s.spaces[0].pinned.find((i) => i.title === 'Notes'); const t = s.tabs.find((x) => x.itemId === item.id); app.$.tabstrip.tabStripService_.closeNodes([t.tabId]); return true; })()`);
    await b.waitFor(`(() => { const el = [...${SB}.querySelectorAll('#pinned > meridian-item')].find((e) => e.item.title === 'Notes'); return el && el.shadowRoot.querySelector('.row').classList.contains('unloaded'); })()`);
    await b.click(`[...${SB}.querySelectorAll('#pinned > meridian-item')].find((e) => e.item.title === 'Notes').shadowRoot.querySelector('.row')`);
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`S.project?.root === ${JSON.stringify(notes)}`, 15000);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, hubs, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
