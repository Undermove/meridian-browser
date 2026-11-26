// Workbench Pro: the secrets vault (encrypted, Reveal only through a native confirm), moving .env keys
// into it, secrets reaching terminals as environment variables, and the secret-file guard that stops a
// Claude Code session from reading .env (the native prompt is answered by a test switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';
import { standIn } from './stand_in.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'sk-ant-api03-REALLOOKINGKEY0123456789abcdef';

// A stand-in Claude Code that runs its PreToolUse hooks for "Read .env" like the real one would
// (each hook's command through the system's shell, the event on its stdin). JavaScript, so the
// same stand-in runs on Windows too (stand_in.mjs).
const FAKE_CLAUDE = `const fs = require('fs'), { execSync } = require('child_process');
const args = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8'));
const event = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: process.cwd() };
for (const entry of settings.hooks.PreToolUse) {
  const matcher = entry.matcher || '*';
  if (!matcher.split('|').includes('Read') && matcher !== '*') continue;
  for (const h of entry.hooks) {
    if (h.async) continue;
    let out = '';
    try { out = execSync(h.command, { input: JSON.stringify(event), encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
    console.log('HOOK SAID ' + out);
  }
}
console.log('SECRETS ' + (process.env.MERIDIAN_VAULT_SECRETS || ''));
process.stdin.once('data', () => process.exit(0));
`;

async function openProject(b) {
  await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length >= 1`);
  await b.eval('app.$.tabstrip.runCommand(16, 0)');
  const wb = await b.page('chrome://workbench');
  await wb.waitFor(`!document.querySelector('#welcome').hidden || !!S.project`, 15000);
  if (!(await wb.eval('!!S.project'))) {
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
  }
  return wb;
}

const termText = `S.activeTerm?.xterm.buffer.active ? Array.from({ length: S.activeTerm.xterm.buffer.active.length }, (_, i) => S.activeTerm.xterm.buffer.active.getLine(i)?.translateToString(true) || '').join('') : ''`;

test('Workbench Pro: vault, .env migration, secrets in terminals, the secret-file guard', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-pro-')));
  fs.mkdirSync(path.join(project, '.git'));
  fs.writeFileSync(path.join(project, '.env'), `PORT=3000\nANTHROPIC_API_KEY=${KEY}\n`);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  standIn(bin, 'claude', FAKE_CLAUDE);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-'));
  const args = [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'];
  let b = await launch(['about:blank'], { profile, args: [...args, '--meridian-test-dialog-answer=Move keys to vault'] });
  let wb;
  try {
    wb = await openProject(b);
    const call = (code) => wb.eval(`${code}.then((r) => r, (e) => 'ERR ' + e.message)`);
    // The scan finds the .env with a credential.
    const scan = await call('window.workbench.secretScan()');
    assert.deepEqual(scan.map((f) => [f.path, f.keys]), [['.env', ['ANTHROPIC_API_KEY']]]);
    // A global secret; names that would change how processes start are refused.
    assert.match(await call(`window.workbench.vaultSet({ name: 'PATH', value: 'x', scope: 'global' })`), /system variable/);
    const set = await call(`window.workbench.vaultSet({ name: 'DEPLOY_TOKEN', value: 'deploy-secret-value-42', scope: 'global', note: 'CI' })`);
    assert.equal(set.name, 'DEPLOY_TOKEN');
    // Reveal takes a native confirm; Cancel is the default.
    assert.equal(await call(`window.workbench.vaultReveal(${JSON.stringify(set.id)})`), 'ERR Not revealed.');

    // The guard: a Claude Code session asks to read .env; the person moves the keys into the vault.
    await wb.eval(`launch('claude').then((t) => !!t)`);
    await wb.waitFor(`(${termText}).includes('HOOK SAID')`, 20000);
    const said = await wb.eval(termText);
    assert.match(said, /"permissionDecision":"allow"/);
    assert.match(said, /moved to the Meridian vault/);
    assert.match(said, /SECRETS DEPLOY_TOKEN/);
    // The file keeps only the key; the value went to the vault; git won't see it.
    assert.match(fs.readFileSync(path.join(project, '.env'), 'utf8'), /^# Values of the empty keys[\s\S]*PORT=3000\nANTHROPIC_API_KEY=\n$/);
    assert.equal(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), '/.env\n');
    const list = await call('window.workbench.vaultList()');
    assert.deepEqual(list.items.map((i) => [i.name, i.scope]).sort(), [['ANTHROPIC_API_KEY', 'project'], ['DEPLOY_TOKEN', 'global']]);
    assert.equal(list.unavailable, null);

    // A new shell gets the secrets as environment variables (names shown, values never).
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.waitFor('S.activeTerm?.kind === "shell"');
    assert.deepEqual(await wb.eval('S.activeTerm.info?.secrets || S.terms.at(-1).secrets'), ['ANTHROPIC_API_KEY', 'DEPLOY_TOKEN']);
    // (Windows: cmd.exe's way, then PowerShell's: one of them is the shell, the other prints itself.)
    const echo = process.platform === 'win32'
      ? 'echo got:%ANTHROPIC_API_KEY%\\r echo "got:$env:ANTHROPIC_API_KEY"\\r'
      : 'echo "got:$ANTHROPIC_API_KEY"\\r';
    await wb.eval(`(() => { window.workbench.ptyWrite(S.activeTerm.id, '${echo}'); return true; })()`);
    await wb.waitFor(`(${termText}).includes('got:${KEY}')`, 10000);

    // Nothing in the profile holds a value in plain text.
    wb.close(); wb = null;
    await b.quit();
    const vault = fs.readFileSync(path.join(profile, 'Default', 'Meridian Vault.json'), 'utf8');
    assert.ok(!vault.includes(KEY) && !vault.includes('deploy-secret-value-42'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(profile, 'Default', 'Meridian Vault.json')).mode & 0o777, 0o600);

    // After a restart, Reveal (confirmed) decrypts it again.
    b = await launch(['about:blank'], { profile, args: [...args, '--meridian-test-dialog-answer=Reveal'] });
    wb = await openProject(b);
    const again = await wb.eval(`window.workbench.vaultList()`);
    const id = again.items.find((i) => i.name === 'ANTHROPIC_API_KEY').id;
    assert.equal(await wb.eval(`window.workbench.vaultReveal(${JSON.stringify(id)})`), KEY);
  } finally {
    wb?.close();
    await b.close();
    for (const d of [project, bin, profile]) fs.rmSync(d, { recursive: true, force: true });
  }
});
