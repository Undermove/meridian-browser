// A Workbench terminal tab shows the session's name and its context gauge (a click: Context
// Insights), never a dollar amount (on a subscription that isn't money the person pays). How the
// session runs (its AI account, browser tools, permission mode, vault secrets) is behind one settings button on the tab, each row in plain words; a dot on the tab only when
// something risky is on (bypass, browser tools in full control). The status bar says the same in
// one group: "Browser tools: Full control · 5 secrets".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, SB } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE_CLAUDE = `#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv
open('argv.log', 'a').write(json.dumps(args[1:]) + '\\n')
settings = json.load(open(args[args.index('--settings') + 1]))
cwd = os.getcwd()
env = dict(os.environ, HOME=os.path.join(cwd, 'home'))
env.pop('CLAUDE_CONFIG_DIR', None)
status = {'session_id': 's1', 'session_name': 'Personal finance dashboard', 'transcript_path': os.path.join(cwd, 'session.jsonl'),
  'model': {'id': 'claude-opus-5-5', 'display_name': 'Opus 5.5'}, 'workspace': {'project_dir': cwd, 'current_dir': cwd},
  'context_window': {'context_window_size': 200000, 'used_percentage': 14, 'current_usage': {'input_tokens': 10, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 28000, 'output_tokens': 1}},
  'cost': {'total_cost_usd': 1.2}}
subprocess.run(settings['statusLine']['command'], shell=True, input=json.dumps(status), text=True, capture_output=True, env=env)
print('READY', flush=True)
sys.stdin.readline()
`;

// A real click in the Workbench page.
async function click(wb, expr) {
  const p = await wb.eval(`(() => { const e = ${expr}; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await wb.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

async function shot(wb, name, clip) {
  if (!process.env.MERIDIAN_SHOTS) return;
  const { data } = await wb.cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
  fs.writeFileSync(path.join(process.env.MERIDIAN_SHOTS, name), Buffer.from(data, 'base64'));
}

test('a terminal tab shows the name and the context gauge, no dollars; account, browser tools, permissions and secrets are in its settings', { skip: process.platform === 'win32' && 'the stand-in is a POSIX script' }, async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-tabset-')));
  fs.mkdirSync(path.join(project, 'home'));
  fs.writeFileSync(path.join(project, 'session.jsonl'), '');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-e2e-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const b = await launch(['about:blank'], { args: [`--meridian-test-project=${project}`, `--meridian-agents-path=${bin}`, '--meridian-no-notify'] });
  const runs = () => fs.readFileSync(path.join(project, 'argv.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let wb;
  try {
    await b.waitFor(`${SB}.querySelectorAll('meridian-tab-row').length === 1`);
    await b.eval('app.$.tabstrip.runCommand(16, 0)');
    wb = await b.page('chrome://workbench');
    await wb.waitFor(`!document.querySelector('#welcome').hidden`, 15000);
    await wb.eval(`document.querySelector('#open-folder').click()`);
    await wb.waitFor('!!S.project');
    await wb.eval(`launch('shell').then((t) => !!t)`);
    await wb.eval(`launch('claude').then((t) => !!t)`);
    const tab = `document.querySelector('#term-tab-list .ttab.active')`;
    await wb.waitFor(`${tab}?.querySelector('.name')?.textContent === 'Personal finance dashboard' && ${tab}.querySelector('.tab-usage .ctx-badge')?.textContent === '14%'`, 15000);
    // The status line says $1.20, but the tab shows no dollars.
    assert.equal(await wb.eval(`!!${tab}.querySelector('.tab-usage .cost')`), false);
    assert.doesNotMatch(await wb.eval(`${tab}.innerText + ' ' + ${tab}.querySelector('.tab-usage').title`), /\$|cost/i);

    // The person's case: the Personal account, browser tools in full control, five vault secrets, bypass.
    await wb.eval(`(() => { const t = S.activeTerm; t.account = 'Personal'; t.browserTools = true; t.secrets = ['OPENAI_API_KEY', 'STRIPE_KEY', 'DB_URL', 'SENTRY_DSN', 'GH_TOKEN'];
      t.permissionMode = 'bypassPermissions'; S.info.agentAccess = 'full'; renderBrowserTools();
      PRO.vault = { items: t.secrets.map((name) => ({ name, scope: 'global' })) }; renderVaultStatus(); renderTermTabs(); return true; })()`);
    await sleep(300);
    const strip = await wb.eval(`(() => { const r = document.getElementById('term-tabs').getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.min(r.width, 760), height: r.height }; })()`);
    await shot(wb, 'tab-after.png', strip);

    // On the tab: the name in full, the gauge (no cost), the settings button with a warning dot.
    const t = await wb.eval(`(() => { const el = ${tab}; const n = el.querySelector('.name'); return {
      text: el.innerText.replace(/\\s+/g, ' ').trim(), full: n.scrollWidth <= n.clientWidth,
      old: !!el.querySelector('.acct, .plug, .bypass-on, .tab-bypass'), risky: !!el.querySelector('.tab-settings.risky .risk-dot'),
      riskTitle: el.querySelector('.tab-settings').title }; })()`);
    assert.equal(t.full, true, 'the name is not cut');
    assert.equal(t.old, false, 'no account, globe, lock or Bypass chips on the tab');
    assert.doesNotMatch(t.text, /Personal\b(?! finance)|Bypass|🔒|\$/);
    assert.equal(t.risky, true);
    assert.match(t.riskTitle, /Bypass: it runs commands/);
    assert.match(t.riskTitle, /Browser tools: full control/);

    // The status bar: one group.
    assert.equal(await wb.eval(`document.getElementById('browser-tools').innerText + ' ' + document.getElementById('status-vault').innerText`), 'Browser tools: Full control 5 secrets');
    assert.equal(await wb.eval(`document.getElementById('browser-tools').nextElementSibling.id`), 'status-vault');

    // The settings: each row labelled in words.
    await click(wb, `${tab}.querySelector('.tab-settings')`);
    await wb.waitFor(`!document.getElementById('popover').hidden && document.getElementById('popover').classList.contains('term-settings')`);
    const row = (k) => `document.querySelector('#popover [data-row="${k}"]')`;
    assert.match(await wb.eval(`${row('account')}.innerText`), /Account\s+Personal/);
    assert.match(await wb.eval(`${row('browser')}.innerText`), /Browser tools\s+Full control[\s\S]*without asking/);
    assert.equal(await wb.eval(`${row('browser')}.classList.contains('risky')`), true);
    assert.equal(await wb.eval(`${row('mode')}.querySelector('select').value`), 'bypassPermissions');
    assert.equal(await wb.eval(`${row('mode')}.classList.contains('risky')`), true);
    assert.match(await wb.eval(`${row('secrets')}.innerText`), /Vault secrets\s+5[\s\S]*OPENAI_API_KEY/);
    const head = await wb.eval(`document.querySelector('#popover .ts-head').innerText`);
    assert.match(head, /Personal finance dashboard/);
    assert.doesNotMatch(head, /\$|so far/);
    const pop = await wb.eval(`(() => { const a = document.getElementById('term-tabs').getBoundingClientRect(), p = document.getElementById('popover').getBoundingClientRect();
      const x = Math.max(0, Math.min(a.x, p.x) - 8), y = Math.max(0, Math.min(a.y, p.y) - 8); return { x, y, width: Math.min(900, Math.max(a.x + 760, p.right) - x + 8), height: Math.max(a.bottom, p.bottom) - y + 8 }; })()`);
    await shot(wb, 'tab-settings-after.png', pop);

    // "Manage": the vault.
    await click(wb, `document.querySelector('#popover [data-a="vault"]')`);
    await wb.waitFor(`document.getElementById('popover').hidden && PRO.activePanel === 'secrets'`);

    // The context gauge: Context Insights about this session.
    await click(wb, `${tab}.querySelector('.tab-usage .ctx-badge')`);
    await wb.waitFor(`PRO.activePanel === 'insights'`);

    // Nothing risky: no dot, and the button only on the active or hovered tab.
    await wb.eval(`(() => { S.activeTerm.permissionMode = 'default'; S.info.agentAccess = 'read'; renderBrowserTools(); renderTermTabs(); return true; })()`);
    assert.equal(await wb.eval(`!!${tab}.querySelector('.tab-settings.risky')`), false);
    assert.equal(await wb.eval(`getComputedStyle(${tab}.querySelector('.tab-settings')).visibility`), 'visible');
    assert.equal(await wb.eval(`getComputedStyle(document.querySelector('#term-tab-list .ttab:not(.active) .tab-settings')).visibility`), 'hidden');
    // Risky on an inactive tab: only the dot shows there.
    await wb.eval(`(() => { S.activeTerm.permissionMode = 'bypassPermissions'; activateTerm(S.terms[0]); return true; })()`);
    await sleep(200);
    assert.equal(await wb.eval(`getComputedStyle(document.querySelector('#term-tab-list .ttab:not(.active) .tab-settings')).visibility`), 'visible');
    assert.equal(await wb.eval(`getComputedStyle(document.querySelector('#term-tab-list .ttab:not(.active) .tab-settings .risk-dot')).display`), 'block');
    await wb.eval(`(() => { S.activeTerm.permissionMode = ''; activateTerm(S.terms[1]); return true; })()`);

    // The permission mode is changed here: the same session again, asked first.
    await click(wb, `${tab}.querySelector('.tab-settings')`);
    await wb.waitFor(`!!document.querySelector('#popover [data-setting="mode"]')`);
    await wb.eval(`(() => { const s = document.querySelector('#popover [data-setting="mode"]'); s.value = 'acceptEdits'; s.dispatchEvent(new Event('change')); return true; })()`);
    await wb.waitFor(`!!document.querySelector('#modal-overlay [data-a="ok"]')`);
    assert.match(await wb.eval(`document.querySelector('#modal').innerText`), /Accept file edits/);
    await click(wb, `document.querySelector('#modal-overlay [data-a="ok"]')`);
    await wb.waitFor(`S.activeTerm?.permissionMode === 'acceptEdits' && S.activeTerm?.sessionId === 's1'`, 15000);
    for (let i = 0; i < 50 && runs().length < 2; i++) await sleep(200);
    const again = runs().at(-1);
    assert.equal(again[again.indexOf('--resume') + 1], 's1');
    assert.equal(again[again.indexOf('--permission-mode') + 1], 'acceptEdits');
  } finally {
    wb?.close(); await b.close();
    for (const d of [project, bin]) fs.rmSync(d, { recursive: true, force: true });
  }
});
