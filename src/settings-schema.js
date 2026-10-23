// What the Settings window may change. Main checks every patch against this before forwarding it to
// the UI renderer (which owns state.json); unknown keys and bad values are dropped.

const fs = require('fs');
const path = require('path');
const { isValidAccelerator } = require('./shortcuts');
const { sanitizeAtc } = require('./atc');

const oneOf = (...vals) => (v) => (vals.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);

function makeSchema(shortcutIds) {
  return {
    searchEngine: oneOf('google', 'duckduckgo', 'kagi', 'bing', 'yandex', 'perplexity'),
    archiveAfterHours: oneOf(12, 24, 168, 720, 0),
    unloadAfterMinutes: oneOf(15, 30, 60, 240, 0),
    adblock: bool,
    sidebarRight: bool,
    sidebarHidden: bool,
    appearance: oneOf('system', 'light', 'dark'),
    agentAccess: oneOf('off', 'read', 'ask', 'full'),
    agentAllowJs: bool,
    // Mission Control + Arc Max-style AI features (Settings → AI)
    missionNotify: bool,
    aiTidy: bool,
    aiAskFromBar: bool,
    aiLinkPreview: bool,
    // The name on the member card (Settings → General).
    memberName: (v) => (typeof v === 'string' && v.trim().length <= 40 ? v.trim().replace(/[\u0000-\u001f]/g, '') : undefined),
    // Only folders that really are unpacked extensions.
    extensions: (v) => {
      if (!Array.isArray(v) || v.length > 50) return undefined;
      const ok = v.filter((p) => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(path.join(p, 'manifest.json')));
      return [...new Set(ok)];
    },
    atc: (v) => sanitizeAtc(v) || undefined,
    shortcutOverrides: (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
      const out = {};
      for (const [id, accel] of Object.entries(v)) {
        if (!shortcutIds.has(id)) continue;
        if (accel === '' || isValidAccelerator(accel)) out[id] = accel;
      }
      return out;
    },
  };
}

function validatePatch(patch, shortcutIds) {
  const schema = makeSchema(shortcutIds);
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) continue;
    const clean = schema[k](v);
    if (clean !== undefined) out[k] = clean;
  }
  return out;
}

module.exports = { validatePatch };
