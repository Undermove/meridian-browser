// The Source Control panel and a repository's own git settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

async function open(project) {
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, '--meridian-no-notify'] });
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
  await wb.eval(`document.querySelector('#open-folder').click()`);
  await wb.waitFor('!!S.project');
  return { b, wb, done: async () => { wb.close(); await b.close(); } };
}

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-git-')));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'first');
  return dir;
}

test('an ordinary repository works; settings of its own that start a program keep git from running', async () => {
  const dir = repo();
  const marker = path.join(dir, 'ran').split(path.sep).join('/');
  const s = await open(dir);
  try {
    const plain = await s.wb.eval(`wb.git(['status', '--porcelain'])`);
    assert.equal(plain.code, 0, JSON.stringify(plain));

    // Directly, and through a file the config includes.
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=x\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    for (const how of ['direct', 'included']) {
      if (how === 'direct') {
        git(dir, 'config', 'filter.x.clean', `touch ${marker}; cat`);
      } else {
        git(dir, 'config', '--unset', 'filter.x.clean');
        fs.writeFileSync(path.join(dir, '.git', 'more'), `[filter "x"]\n\tclean = touch ${marker}; cat\n`);
        git(dir, 'config', 'include.path', 'more');
      }
      const r = await s.wb.eval(`wb.git(['status', '--porcelain'])`);
      assert.equal(r.code, 1, JSON.stringify(r));
      assert.match(r.stderr, /can start a program/);
      assert.equal(fs.existsSync(marker), false, `${how}: nothing ran`);
    }
  } finally { await s.done(); fs.rmSync(dir, { recursive: true, force: true }); }
});
