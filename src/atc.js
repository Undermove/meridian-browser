// Air Traffic Control: where a link opened from another app goes (like Arc's).
//
// settings.atc = { fallback: 'little' | 'main', rules: [{ id, pattern, target }] }
//   pattern  "github.com"           the domain and its subdomains
//            "*.google.com"         subdomains only
//            "notion.so/acme/*"     a URL prefix/glob (matched against host + path, scheme ignored)
//   target   "little"               the Little window
//            "main"                 a new tab in the space you're in
//            "space:<id>"           a new tab in that space (falls back to "main" if it's gone)
// Rules are checked top to bottom; the first match wins.

const MAX_RULES = 200;

function normalizePattern(p) {
  return String(p || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '');
}

function globToRegExp(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${re}$`);
}

function ruleMatches(pattern, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = normalizePattern(pattern);
  if (!p) return false;
  if (!p.includes('/')) {
    if (p.startsWith('*.')) return host.endsWith(p.slice(1));
    if (p.includes('*')) return globToRegExp(p).test(host);
    return host === p || host.endsWith('.' + p);
  }
  const target = host + u.pathname.toLowerCase() + u.search.toLowerCase();
  if (p.includes('*')) return globToRegExp(p).test(target) || globToRegExp(p.replace(/\/\*$/, '')).test(target);
  return target === p || target.startsWith(p.endsWith('/') ? p : p + '/') || target.startsWith(p + '?');
}

// -> { target: 'little' | 'main' | 'space', spaceId?, rule? }
function routeLink(atc, url, spaceIds = []) {
  const cfg = atc && typeof atc === 'object' ? atc : {};
  const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  for (const r of rules) {
    if (!r || !ruleMatches(r.pattern, url)) continue;
    return resolveTarget(r.target, spaceIds, r);
  }
  return resolveTarget(cfg.fallback || 'little', spaceIds, null);
}

function resolveTarget(target, spaceIds, rule) {
  if (typeof target === 'string' && target.startsWith('space:')) {
    const spaceId = target.slice(6);
    if (spaceIds.includes(spaceId)) return { target: 'space', spaceId, rule };
    return { target: 'main', rule };
  }
  return { target: target === 'main' ? 'main' : 'little', rule };
}

// Cleans what the settings page sends; returns null if it isn't usable.
function sanitizeAtc(v) {
  if (!v || typeof v !== 'object') return null;
  const okTarget = (t) => t === 'little' || t === 'main' || (typeof t === 'string' && /^space:[\w-]{1,64}$/.test(t));
  const rules = (Array.isArray(v.rules) ? v.rules : []).slice(0, MAX_RULES)
    .filter((r) => r && typeof r.pattern === 'string' && normalizePattern(r.pattern) && okTarget(r.target))
    .map((r) => ({ id: typeof r.id === 'string' && r.id.length <= 64 ? r.id : Math.random().toString(36).slice(2, 10), pattern: String(r.pattern).trim().slice(0, 300), target: r.target }));
  return { fallback: v.fallback === 'main' ? 'main' : 'little', rules };
}

module.exports = { routeLink, ruleMatches, sanitizeAtc };
