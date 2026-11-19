// Source Control in the Workbench, as in VS Code: the branch and the number of changes in the top bar;
// the panel lists the changed files (staged and not); a click shows the diff side by side; stage,
// commit with a message, discard; push to a remote; the pull requests of the GitHub CLI. git runs only
// with the commands the panel uses, inside the project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function mouse(wb, expr, { hoverFirst } = {}) {
  if (hoverFirst) {
    const h = await wb.eval(`(() => { const e = ${hoverFirst}; const r = e.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()`);
    await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h.x, y: h.y });
    await sleep(100);
  }
  const p = await wb.eval(`(() => { const e = ${expr}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`);
  assert.ok(p.w > 0, `${expr} is on screen`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await wb.cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  }
}

test('Source Control: changes, a diff, stage, commit, discard, push, pull requests; git stays inside the project', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-scm-')));
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-scm-remote-')));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  git(project, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(project, 'app.txt'), 'one\ntwo\nthree\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'First');
  git(project, 'remote', 'add', 'origin', remote);
  // The work: one file changed, one new.
  fs.writeFileSync(path.join(project, 'app.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(project, 'notes.md'), '# Notes\n');
  // A stand-in GitHub CLI: one open pull request.
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[{"number":7,"title":"Fix the login","headRefName":"fix-login","url":"https://github.com/example/app/pull/7","state":"OPEN"}]'; fi\n`, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');

    // The top bar: the branch and two changes.
    await wb.waitFor(`document.querySelector('#scm-chip .scm-branch')?.textContent === 'main' && document.querySelector('#scm-chip .scm-count')?.textContent === '2'`, 15000).catch(async (e) => {
      throw new Error(e.message + ' ' + JSON.stringify(await wb.eval(`[typeof SCM === 'undefined' ? 'no SCM' : JSON.stringify({ info: SCM.info, repo: SCM.repo, loaded: SCM.loaded, error: SCM.error, branch: SCM.branch, n: SCM.changes.length }), typeof window.workbench.git, [...document.scripts].map((s) => s.src.split('/').pop()).join(',')]`)));
    });
    await mouse(wb, `document.getElementById('scm-chip')`);
    await wb.waitFor(`PRO.activePanel === 'scm' && document.querySelectorAll('#side-body .scm-row[data-path]').length === 2`);
    const rows = await wb.eval(`[...document.querySelectorAll('#side-body .scm-row[data-path]')].map((r) => [r.dataset.path, r.querySelector('.scm-code').textContent])`);
    assert.deepEqual(rows.sort(), [['app.txt', 'M'], ['notes.md', 'U']]);

    // The diff, side by side.
    const row = (p) => `document.querySelector('#side-body .scm-row[data-path=${JSON.stringify(p)}]')`;
    await mouse(wb, row('app.txt'));
    await wb.waitFor(`!document.getElementById('diff-pane')?.hidden && !!S.diffEditor?.getModel()`);
    assert.deepEqual(await wb.eval(`[S.diffEditor.getModel().original.getValue(), S.diffEditor.getModel().modified.getValue()]`), ['one\ntwo\nthree\n', 'one\nTWO\nthree\n']);
    await wb.waitFor(`S.diffEditor.getLineChanges()?.length === 1`, 5000);

    // Stage app.txt (its + on hover), then commit it with a message: notes.md stays a change.
    await mouse(wb, `${row('app.txt')}.querySelector('.stage')`, { hoverFirst: row('app.txt') });
    await wb.waitFor(`[...document.querySelectorAll('#side-body .scm-group-title')].some((t) => t.textContent.startsWith('Staged (1)'))`);
    await mouse(wb, `document.getElementById('scm-message')`);
    await wb.cdp.send('Input.insertText', { text: 'Shout the second line' });
    await mouse(wb, `document.querySelector('#side-body .scm-commit')`);
    await wb.waitFor(`document.querySelector('#scm-chip .scm-count')?.textContent === '1'`, 10000);
    assert.equal(git(project, 'log', '-1', '--format=%s'), 'Shout the second line');
    assert.equal(git(project, 'status', '--porcelain'), '?? notes.md');
    await wb.waitFor(`[...document.querySelectorAll('#side-body .scm-commit-row .scm-name')].map((e) => e.textContent).join() === 'Shout the second line,First'`);

    // Discard a change (after saying so): the committed version is back.
    fs.writeFileSync(path.join(project, 'app.txt'), 'oops\n');
    await wb.waitFor(`!!${row('app.txt')}`, 10000);
    await mouse(wb, `${row('app.txt')}.querySelector('.discard')`, { hoverFirst: row('app.txt') });
    await wb.waitFor(`!!document.querySelector('#modal-overlay [data-a="ok"]')`);
    await mouse(wb, `document.querySelector('#modal-overlay [data-a="ok"]')`);
    await wb.waitFor(`!${row('app.txt')}`, 10000);
    assert.equal(fs.readFileSync(path.join(project, 'app.txt'), 'utf8'), 'one\nTWO\nthree\n');

    // Push: the branch is published to its remote.
    await mouse(wb, `document.querySelector('#side-body .scm-push')`);
    await wb.waitFor(`!SCM.busy && SCM.upstream === 'origin/main'`, 20000);
    assert.equal(git(remote, 'log', '-1', '--format=%s', 'main'), 'Shout the second line');

    // Pull requests, from gh.
    await wb.waitFor(`document.querySelector('#side-body .scm-pr .scm-name')?.textContent === 'Fix the login'`, 10000);

    // git only as the panel uses it, inside the project.
    const refused = (args) => wb.eval(`window.workbench.git(${JSON.stringify(args)}).then(() => 'ran', (e) => e.message)`);
    assert.match(await refused(['config', 'core.editor', 'x']), /isn't available/);
    assert.match(await refused(['-c', 'core.pager=sh', 'log']), /isn't available/);
    assert.match(await refused(['log', '--output=/tmp/x']), /isn't available/);
    assert.match(await refused(['add', '--', '../outside']), /outside the project/);
    assert.match(await refused(['show', 'HEAD:../../etc/passwd']), /outside the project/);
    assert.match(await refused(['push', 'ext::sh -c touch% /tmp/pwned']), /isn't available|address/);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, remote, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
