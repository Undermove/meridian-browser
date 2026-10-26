// Workbench launch specs (src/dev/agents.js) without a window: which agents get Meridian's browser tools
// and how, and that every agent is told which vault secrets are in its environment (names only).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchSpec, detect } = require('../../src/dev/agents');

function fakeBin(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mer-agents-'));
  for (const n of names) { fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, n), 0o755); }
  fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  return dir;
}

test('more agents: Copilot and OpenCode get the browser tools, the rest start without; all learn the vault secret names', () => {
  const bin = fakeBin(['claude', 'copilot', 'opencode', 'goose']);
  const base = { searchPath: bin, mcp: { command: 'node', args: ['/app/mcp.js'] }, dataDir: '/data', secretNames: ['OPENAI_API_KEY', 'STRIPE_KEY'] };
  try {
    const found = detect(bin);
    expect(found.copilot).toMatchObject({ installed: true, mcp: true, extra: true });
    expect(found.amp).toMatchObject({ installed: false, extra: true });
    expect(found.claude.extra).toBe(false);

    const claude = launchSpec('claude', base);
    const i = claude.args.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(claude.args[i + 1]).toContain('OPENAI_API_KEY, STRIPE_KEY');
    expect(claude.args[i + 1]).toContain('blank on purpose');
    expect(claude.args.at(-2)).toBe('--mcp-config'); // variadic: still last
    expect(claude.env.MERIDIAN_VAULT_SECRETS).toBe('OPENAI_API_KEY,STRIPE_KEY');

    const copilot = launchSpec('copilot', base);
    const j = copilot.args.indexOf('--additional-mcp-config');
    expect(copilot.args[j + 1].startsWith('@')).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(copilot.args[j + 1].slice(1), 'utf8'));
    expect(cfg.mcpServers.meridian).toMatchObject({ type: 'local', args: ['/app/mcp.js'], tools: ['*'], env: { MERIDIAN_DATA_DIR: '/data' } });
    expect(copilot.browserTools).toBe(true);
    expect(copilot.notes.join(' ')).toContain('OPENAI_API_KEY, STRIPE_KEY');

    const oc = launchSpec('opencode', base);
    const ocCfg = JSON.parse(fs.readFileSync(oc.env.OPENCODE_CONFIG, 'utf8'));
    expect(ocCfg.mcp.meridian).toMatchObject({ type: 'local', enabled: true, environment: { MERIDIAN_DATA_DIR: '/data' } });
    expect(ocCfg.mcp.meridian.command.slice(1)).toEqual(['/app/mcp.js']);
    expect(oc.browserTools).toBe(true);

    const goose = launchSpec('goose', base);
    expect(goose.browserTools).toBe(false);
    expect(goose.notes.join(' ')).toContain('without Meridian browser tools');
    expect(goose.env.MERIDIAN_VAULT_SECRETS).toBe('OPENAI_API_KEY,STRIPE_KEY');

    // No secrets: nothing extra.
    expect(launchSpec('claude', { ...base, secretNames: [] }).args).not.toContain('--append-system-prompt');
    for (const s of [claude, copilot, oc, goose]) for (const d of s.cleanup) fs.rmSync(d, { recursive: true, force: true });
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});
