// A crash of the browser took every Workbench terminal with it, Claude Code sessions mid-work too.
// Now the terminal host keeps them: the program goes on while the browser is down, and the reopened
// Workbench shows the same terminal (with what it printed meanwhile) instead of starting anew.
// A clean quit still closes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = 'app.$.tabstrip';
const TEXT = `(() => { const t = S.terms[0]; if (!t) return ''; const b = t.xterm.buffer.active; return Array.from({ length: b.length }, (_, i) => { const l = b.getLine(i); return (l?.isWrapped ? '' : '\\n') + (l?.translateToString(true) || ''); }).join(''); })()`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lastTick = (text) => Math.max(-1, ...[...text.matchAll(/tick-(\d+)/g)].map((m) => Number(m[1])));

async function open(profile, project) {
  const b = await launch(['about:blank'], { profile, args: [`--meridian-test-project=${project}`, '--meridian-term-host-test'] });
  await b.waitFor(`typeof app !== 'undefined' && !!${T}?.state_`);
  // After a restart the Workbench's tab comes back by itself (with its project): that one.
  let wb = await b.page('chrome://workbench', 4000).catch(() => null);
  if (!wb) {
    await b.eval(`${T}.openUrl('chrome://workbench')`);
    wb = await b.page('chrome://workbench');
  }
  await wb.waitFor(`!document.querySelector('#welcome').hidden || !!S.project`, 15000);
  if (!(await wb.eval('!!S.project'))) {
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor(`S.project?.root === ${JSON.stringify(project)}`);
  }
  return { b, wb };
}

test('a Workbench terminal outlives a crash of the browser and comes back in the reopened one', { skip: process.platform === 'win32' && 'pseudoconsoles live in the browser on Windows' }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-proj-')));
  let shell = 0;
  let { b, wb } = await open(profile, project);
  try {
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor('S.terms.length === 1 && !!S.activeTerm');
    const run = (cmd) => wb.eval(`(() => { window.workbench.ptyWrite(S.terms[0].id, ${JSON.stringify(cmd + '\r')}); return true; })()`);
    await run(`echo PID-$$; i=0; while true; do echo tick-$i; i=$((i+1)); sleep 0.3; done`);
    await wb.waitFor(`${TEXT}.includes('tick-3')`, 15000);
    shell = Number((await wb.eval(TEXT)).match(/PID-(\d+)/)[1]);
    const before = lastTick(await wb.eval(TEXT));

    // The browser crashes.
    process.kill(b.proc.pid, 'SIGKILL');  // as a crash does (no crash report)
    await sleep(3000);
    assert.ok(alive(shell), 'the shell is still running while the browser is down');
    await b.close();

    // Reopened: the same terminal, with what it printed meanwhile, still going and still listening.
    ({ b, wb } = await open(profile, project));
    await wb.waitFor('S.terms.length === 1', 15000);
    await wb.waitFor(`${TEXT}.includes('this session kept running')`, 10000);
    const back = await wb.eval(TEXT);
    assert.ok(lastTick(back) > before + 5, `it went on while the browser was down (${before} → ${lastTick(back)})`);
    await wb.waitFor(`(${lastTick.toString()})(${TEXT}) > ${lastTick(back)}`, 10000);
    await wb.eval(`(() => { window.workbench.ptyWrite(S.terms[0].id, '\\x03'); return true; })()`);
    await sleep(300);
    await wb.eval(`(() => { window.workbench.ptyWrite(S.terms[0].id, 'echo ALIVE-$$\\r'); return true; })()`);
    await wb.waitFor(`${TEXT}.includes('ALIVE-${shell}')`, 10000);

    // A clean quit closes it, as before.
    await b.quit();
    for (let i = 0; i < 30 && alive(shell); i++) await sleep(200);
    assert.equal(alive(shell), false, 'quitting closes the terminal');
  } finally {
    if (shell && alive(shell)) process.kill(shell, 'SIGKILL');
    await b.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
