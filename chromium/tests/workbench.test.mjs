// The Workbench (chrome://workbench): a project, Monaco, ⌘S, a terminal, and paths outside the
// project refused (lexically and through symlinks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Workbench: opens a project, edits and saves with ⌘S, runs a terminal, stays inside the project', async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wb-')));
  const project = path.join(base, 'proj');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hello world\n');
  const outside = path.join(base, 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET');
  fs.symlinkSync(outside, path.join(project, 'sneaky-link.txt'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`] });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    // The sidebar button opens it; the first screen leads with "Open a project folder".
    await b.plus('Workbench');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    assert.equal(await wb.eval(`document.querySelector('#open-folder').textContent.trim()`), 'Open a project folder');
    assert.deepEqual(await wb.eval('[typeof window.workbench, typeof require === "function" && !!require.config]'), ['object', true]);
    // ⇧⌘E again: the same tab, not a second one.
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    await sleep(500);
    assert.equal((await b.tabs()).filter((t) => t.url.startsWith('chrome://workbench')).length, 1);

    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor(`S.project && S.project.root === ${JSON.stringify(project)}`);
    // The tab follows the project.
    await b.waitFor(`[...${SB}.querySelectorAll('meridian-tab-row')].some((r) => r.tab.title === 'proj')`);

    // Monaco opens the file; a real ⌘S in the editor saves it (the editor's meaning wins).
    await wb.waitFor('loadMonaco().then(() => !!window.monaco && !!S.editor)', 20000);
    await wb.eval(`openFile('hello.txt', { focus: true }).then(() => true)`);
    assert.equal(await wb.eval('S.editor.getModel().getValue()'), 'hello world\n');
    assert.equal(await wb.eval('!!document.querySelector("#editor-host .monaco-editor")'), true);
    await wb.eval(`(() => { S.editor.getModel().setValue('saved by the e2e test\\n'); S.editor.focus(); return true; })()`);
    await wb.waitFor('!!document.activeElement?.closest("#editor-host")');
    for (const type of ['rawKeyDown', 'keyUp']) {
      await wb.cdp.send('Input.dispatchKeyEvent', { type, modifiers: 4, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, commands: type === 'rawKeyDown' ? ['save'] : [] });
    }
    for (let i = 0; i < 50 && fs.readFileSync(path.join(project, 'hello.txt'), 'utf8') !== 'saved by the e2e test\n'; i++) await sleep(100);
    assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'saved by the e2e test\n');
    assert.equal(await b.eval(`app.hasAttribute('sidebar-hidden')`), false, '⌘S didn’t hide the sidebar');

    // A file an agent writes shows up in the tree.
    fs.writeFileSync(path.join(project, 'from-agent.md'), '# new\n');
    await wb.waitFor(`[...document.querySelectorAll('#tree [data-path]')].some((n) => n.dataset.path === 'from-agent.md')`);

    // A terminal runs in the project folder.
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor('S.terms.length === 1');
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, 'echo meridian-$((40+2)) && pwd\\r'); return true; })()`);
    // Wrapped lines joined back (a long path wraps).
    const termText = `S.activeTerm.xterm.buffer.active ? Array.from({ length: S.activeTerm.xterm.buffer.active.length }, (_, i) => { const l = S.activeTerm.xterm.buffer.active.getLine(i); return (l?.isWrapped ? '' : '\\n') + (l?.translateToString(true) || ''); }).join('') : ''`;
    await wb.waitFor(`(${termText}).includes('meridian-42')`, 15000);
    assert.ok((await wb.eval(termText)).includes(project));

    // Output keeps coming while the tab is in the background.
    await b.eval(`app.$.tabstrip.openUrl('about:blank')`);
    await sleep(500);
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, 'echo hidden-$((1+1))\\r'); return true; })()`);
    await wb.waitFor(`(${termText}).includes('hidden-2')`, 10000);

    // Outside the project: refused.
    const tryCall = (code) => wb.eval(`${code}.then(() => 'ok', (e) => 'refused: ' + e.message)`);
    assert.match(await tryCall(`window.workbench.read('../outside-secret.txt')`), /^refused: .*outside the project/);
    assert.match(await tryCall(`window.workbench.read(${JSON.stringify(outside)})`), /^refused: .*relative to the project/);
    assert.match(await tryCall(`window.workbench.read('sneaky-link.txt')`), /^refused: .*symlink/);
    assert.match(await tryCall(`window.workbench.write('../evil.txt', 'x')`), /^refused/);
    assert.match(await tryCall(`window.workbench.write('sneaky-link.txt', 'x')`), /^refused: .*symlink/);
    assert.match(await tryCall(`window.workbench.list('..')`), /^refused/);
    assert.equal(fs.existsSync(path.join(base, 'evil.txt')), false);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE-SECRET');

    // Closing the tab ends its terminals.
    const pid = Number((await wb.eval(`new Promise((res) => { let out = ''; const off = window.workbench.onPtyData((d) => { out += d.data; const m = /PID=(\\d+)/.exec(out); if (m) { off(); res(m[1]); } }); window.workbench.ptyWrite(S.activeTerm.id, 'echo PID=$$\\r'); })`)));
    assert.ok(pid > 0);
    wb.close(); wb = null;
    const tab = (await b.tabs()).find((t) => t.url.startsWith('chrome://workbench'));
    await b.eval(`app.$.tabstrip.tabStripService_.closeNodes([${JSON.stringify(tab.id)}])`);
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { await sleep(100); try { process.kill(pid, 0); } catch { alive = false; } }
    assert.equal(alive, false, 'the shell ended with the tab');
  } finally {
    wb?.close();
    await b.close();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('Workbench: an agent started here gets Meridian’s browser tools for that session', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-wb-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  // A stand-in Claude Code: reads the --mcp-config it was given and asks Meridian for its tabs.
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/python3
import json, subprocess, sys
config = json.load(open(sys.argv[sys.argv.index('--mcp-config') + 1]))['mcpServers']['meridian']
p = subprocess.Popen([config['command']] + config['args'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\\n')
p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'list_tabs', 'arguments': {}}}) + '\\n')
p.stdin.flush()
p.stdout.readline()
answer = json.loads(p.stdout.readline())
p.kill()
print('AGENT SAW: ' + answer['result']['content'][0]['text'].replace('\\n', ' ')[:300])
`, { mode: 0o755 });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  fs.mkdirSync(path.join(profile, 'Default'));
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ meridian: { agent_access: 'read' } }));
  const b = await launch(['data:text/html,<title>Marker Tab</title>'], { profile, args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`] });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    // Installed agents are offered on the first screen.
    await wb.waitFor(`document.querySelector('#welcome-agents').textContent.includes('Claude Code')`);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('claude').then((t) => !!t)`);
    const termText = `S.activeTerm?.xterm.buffer.active ? Array.from({ length: S.activeTerm.xterm.buffer.active.length }, (_, i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true) || '').join('') : ''`;
    await wb.waitFor(`(${termText}).includes('AGENT SAW')`, 20000);
    assert.match(await wb.eval(termText), /AGENT SAW: .*Marker Tab/);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
