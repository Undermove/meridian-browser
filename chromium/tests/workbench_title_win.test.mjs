// Windows: a program that sets no title of its own gets its path as the console's title (ConPTY).
// That isn't a name: the tab and Mission Control keep the agent's name ("Claude Code"), and a shell
// tab is "cmd" or "PowerShell", not C:\Windows\system32\cmd.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tabNames = `[...document.querySelectorAll('#term-tab-list .ttab .name')].map((e) => e.textContent)`;

// A stand-in Claude Code that prints a line and waits, and never sets a title.
const SILENT_CS = `class Claude { static void Main(string[] args) {
  System.Console.WriteLine("SILENT AGENT"); System.Console.ReadLine(); } }`;
function silentClaude(bin) {
  fs.writeFileSync(path.join(bin, 'claude.cs'), SILENT_CS);
  const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(csc, ['/nologo', '/out:' + path.join(bin, 'claude.exe'), path.join(bin, 'claude.cs')], { stdio: 'pipe' });
}

async function openWorkbench(b) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`, 15000);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor('!!S.project');
  return wb;
}

test('Windows: a tab whose program sets no title keeps its name, not the program\'s path', { skip: !WIN && 'Windows consoles only' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-title-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  silentClaude(bin);
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  let wb;
  try {
    wb = await openWorkbench(b);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm && [...Array(S.activeTerm.xterm.buffer.active.length).keys()].some((i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true).includes('SILENT AGENT'))`, 15000);
    await sleep(1500);  // a title would have come by now
    assert.deepEqual(await wb.eval(tabNames), ['Claude Code']);
    // Mission Control shows it under the tab's name.
    const labels = async () => (await b.eval('app.$.tabstrip.handler_.getMissionState().then(({snapshotJson}) => JSON.parse(snapshotJson))'))
      .nodes.filter((n) => n.kind === 'session').map((n) => n.label);
    let last;
    for (let i = 0; i < 25; i++) { last = await labels(); if (last.length) break; await sleep(200); }
    assert.deepEqual(last, ['Claude Code']);

    // A shell tab: cmd or PowerShell, by name.
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor(`S.activeTerm?.kind === 'shell'`);
    await sleep(2500);  // the shell has started and set its title
    const shell = (await wb.eval(tabNames))[1];
    assert.ok(['cmd', 'PowerShell'].includes(shell), `the shell tab is named by the shell: ${shell}`);
  } finally {
    try { wb?.close(); } catch {}
    await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
