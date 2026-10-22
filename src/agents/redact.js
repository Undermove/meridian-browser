// Mission Control: make short agent summaries safe to show and keep.
//
// Summaries come from hooks (file names, command heads, hosts). They can still carry secrets:
// `API_KEY=sk-… npm test`, `curl -H "Authorization: Bearer …"`, `https://user:pass@host`. Everything
// shown in Mission Control goes through clean(): control characters stripped, length capped, known
// token formats and credential-looking assignments masked, and exact vault values (when the caller
// provides them) replaced by their names.

const { find } = require('../renderer/dev/secret-detect');

const MASK = '•••';
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|CREDENTIALS?|AUTH|COOKIE|SESSION|PRIVATE|SIGNATURE)/i;

function redact(text, secretValues = []) {
  let s = String(text ?? '');
  // Exact vault values first (longest first so prefixes don't leave tails).
  for (const { name, value } of [...secretValues].filter((x) => x && typeof x.value === 'string' && x.value.length >= 6).sort((a, b) => b.value.length - a.value.length)) {
    s = s.split(value).join(`$${name}`);
  }
  // Known token formats + high-entropy values assigned to credential-like names.
  const hits = find(s);
  for (let i = hits.length - 1; i >= 0; i--) s = s.slice(0, hits[i].start) + MASK + s.slice(hits[i].end);
  // Authorization schemes first (before NAME: value eats the scheme word).
  s = s.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`);
  // NAME=value / --name=value / NAME: value where NAME smells like a credential (any value length).
  s = s.replace(/\b([A-Za-z_][\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'`&;|]+)/g, (m, name, sep, val) => (SECRET_NAME.test(name) && val !== MASK && !/^\$\{?\w+\}?$/.test(val) ? `${name}${sep}${MASK}` : m));
  // Authorization headers, bearer tokens, URL credentials, token-ish query parameters.
  s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1$2:${MASK}@`);
  s = s.replace(/([?&](?:access_token|token|key|api_key|apikey|secret|sig|signature|password|auth|code)=)[^&\s#"']+/gi, `$1${MASK}`);
  // -p<password> (mysql style) and --password <value>
  s = s.replace(/(--?(?:password|passwd|token|secret|api-key|apikey)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/gi, `$1${MASK}`);
  // JWTs and long opaque strings (40+ chars of base64/hex) are almost never useful to show.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK);
  s = s.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (/^[a-f0-9]{40}$/i.test(m) ? m.slice(0, 10) : MASK)); // keep short git SHAs
  return s;
}

// Plain one-line text, capped, redacted.
function clean(text, max = 160, secretValues = []) {
  if (text == null) return null;
  const s = String(text).replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const r = redact(s.slice(0, max * 2), secretValues);
  return r.length > max ? r.slice(0, max - 1) + '…' : r;
}

module.exports = { redact, clean, MASK };
