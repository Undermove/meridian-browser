/* Meridian — "does this text look like a secret?" (Workbench Pro).
 *
 * Shared by the workbench page (terminal paste guard), the main UI (⌘J assistant input) and the main
 * process (.env scanning). Pure functions, no I/O. Loaded as a classic script in pages (global
 * `MeridianSecrets`) and with require() in main.
 *
 * It is a nudge, not a guarantee: known token prefixes plus long, high-entropy values assigned to
 * names like *_KEY / *_TOKEN / *_SECRET / *_PASSWORD.
 */
(function (root) {
  'use strict';

  const KNOWN = [
    { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, name: 'ANTHROPIC_API_KEY', kind: 'Anthropic API key' },
    { re: /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, name: 'OPENAI_API_KEY', kind: 'OpenAI API key' },
    { re: /github_pat_[A-Za-z0-9_]{22,}/g, name: 'GITHUB_TOKEN', kind: 'GitHub token' },
    { re: /gh[pousr]_[A-Za-z0-9]{30,}/g, name: 'GITHUB_TOKEN', kind: 'GitHub token' },
    { re: /glpat-[A-Za-z0-9_-]{20,}/g, name: 'GITLAB_TOKEN', kind: 'GitLab token' },
    { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, name: 'AWS_ACCESS_KEY_ID', kind: 'AWS access key' },
    { re: /xox[bpas]-[A-Za-z0-9-]{10,}/g, name: 'SLACK_TOKEN', kind: 'Slack token' },
    { re: /AIza[0-9A-Za-z_-]{35}/g, name: 'GOOGLE_API_KEY', kind: 'Google API key' },
    { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, name: 'PRIVATE_KEY', kind: 'private key' },
  ];
  // NAME=value / NAME: value where NAME smells like a credential.
  const ASSIGN = /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH))\s*[=:]\s*["']?([^\s"'`]{16,})/gi;

  function entropy(s) {
    const counts = {};
    for (const c of s) counts[c] = (counts[c] || 0) + 1;
    let h = 0;
    for (const k in counts) { const p = counts[k] / s.length; h -= p * Math.log2(p); }
    return h;
  }

  const looksRandom = (v) => v.length >= 16 && entropy(v) >= 3.4 && /\d/.test(v) && /[A-Za-z]/.test(v) && !/^\$\{?[A-Za-z_]/.test(v);

  // -> [{ start, end, value, name, kind }] sorted by position, non-overlapping.
  function find(text) {
    text = String(text || '');
    if (!text || text.length > 200000) return [];
    const out = [];
    const overlaps = (s, e) => out.some((m) => s < m.end && e > m.start);
    for (const k of KNOWN) {
      k.re.lastIndex = 0;
      let m;
      while ((m = k.re.exec(text))) {
        if (!overlaps(m.index, m.index + m[0].length)) out.push({ start: m.index, end: m.index + m[0].length, value: m[0], name: k.name, kind: k.kind });
      }
    }
    ASSIGN.lastIndex = 0;
    let m;
    while ((m = ASSIGN.exec(text))) {
      const value = m[2];
      const start = m.index + m[0].length - value.length;
      if (overlaps(start, start + value.length)) {
        // A known token assigned to a name: prefer the name the user gave it.
        const hit = out.find((x) => start < x.end && start + value.length > x.start);
        if (hit && /^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1])) hit.name = m[1].toUpperCase();
        continue;
      }
      if (!looksRandom(value)) continue;
      out.push({ start, end: start + value.length, value, name: m[1].toUpperCase(), kind: 'credential' });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  // Env-var name rules shared with the vault (main re-validates).
  const NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
  function cleanName(s) {
    const n = String(s || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^([0-9])/, '_$1').slice(0, 64);
    return NAME_RE.test(n) ? n : 'SECRET';
  }

  // Masked preview for UI: never shows more than the first 4 / last 2 characters.
  const mask = (v) => { v = String(v || ''); return v.length <= 8 ? '••••' : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`; };

  const api = { find, cleanName, mask, entropy, NAME_RE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeridianSecrets = api;
})(typeof window !== 'undefined' ? window : globalThis);
