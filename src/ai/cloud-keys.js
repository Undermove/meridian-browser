// API keys for the other big model providers (OpenAI, Google Gemini, OpenRouter, xAI, Mistral, DeepSeek,
// Groq). They all speak the OpenAI chat-completions protocol, so one client covers them; Claude keys keep
// their own path (assistant.js), the only one that can also act in the browser.
//
//  - Keys are encrypted with the OS keychain (safeStorage) in ai-keys.json, like the Claude key. Only the
//    main process ever reads them.
//  - A pasted key is matched to its provider by its shape, then checked with GET /models (free, no tokens).
//  - The model is picked from the provider's own list: the user's choice, else a fast, capable default.

const fs = require('fs');
const path = require('path');

const CLOUD = {
  openai: { label: 'OpenAI', short: 'ChatGPT', base: 'https://api.openai.com/v1', console: 'https://platform.openai.com/api-keys',
    prefer: [/^gpt-5(\.\d+)*-mini$/, /^gpt-5(\.\d+)*$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/],
    keep: /^(gpt-|o\d|chatgpt-)/ },
  gemini: { label: 'Google Gemini', short: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', console: 'https://aistudio.google.com/apikey',
    prefer: [/^(models\/)?gemini-[\d.]+-flash$/, /^(models\/)?gemini-flash-latest$/, /^(models\/)?gemini-[\d.]+-pro$/],
    keep: /gemini/ },
  openrouter: { label: 'OpenRouter', short: 'OpenRouter', base: 'https://openrouter.ai/api/v1', console: 'https://openrouter.ai/settings/keys',
    prefer: [/^openrouter\/auto$/], fallback: 'openrouter/auto', keep: /./ },
  xai: { label: 'xAI', short: 'Grok', base: 'https://api.x.ai/v1', console: 'https://console.x.ai',
    prefer: [/^grok-[\d.]+-fast/, /^grok-[\d.]+-mini/, /^grok-[\d.]+$/, /^grok-/], keep: /^grok-/ },
  mistral: { label: 'Mistral', short: 'Mistral', base: 'https://api.mistral.ai/v1', console: 'https://console.mistral.ai/api-keys',
    prefer: [/^mistral-medium-latest$/, /^mistral-small-latest$/, /^mistral-large-latest$/], keep: /^(mistral|magistral|ministral|open-mistral)/ },
  deepseek: { label: 'DeepSeek', short: 'DeepSeek', base: 'https://api.deepseek.com', console: 'https://platform.deepseek.com/api_keys',
    prefer: [/^deepseek-chat$/], keep: /^deepseek-/ },
  groq: { label: 'Groq', short: 'Groq', base: 'https://api.groq.com/openai/v1', console: 'https://console.groq.com/keys',
    prefer: [/^openai\/gpt-oss-120b$/, /^llama-3\.3-70b-versatile$/, /^moonshotai\/kimi/, /^qwen\//], keep: /./ },
};

// Not chat models (or not usable for plain chat).
const NOT_CHAT = /embed|whisper|tts|audio|image|dall-e|moderation|realtime|transcri|speech|guard|search|computer-use|-codex|instruct$|vision-preview|aqa|veo|imagen|learnlm|gemma-?3n/i;

// Which providers a key could belong to, most likely first.
function detect(key) {
  key = String(key || '').trim();
  if (/^sk-ant-/.test(key)) return ['anthropic'];
  if (/^sk-or-/.test(key)) return ['openrouter'];
  if (/^AIza[0-9A-Za-z_-]{30,}$/.test(key)) return ['gemini'];
  if (/^xai-/.test(key)) return ['xai'];
  if (/^gsk_/.test(key)) return ['groq'];
  if (/^sk-(proj|svcacct|admin)-/.test(key)) return ['openai'];
  if (/^sk-[0-9a-f]{32}$/.test(key)) return ['deepseek', 'openai'];
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return ['openai', 'deepseek'];
  if (/^[A-Za-z0-9]{32}$/.test(key)) return ['mistral'];
  return [];
}

// Tests point every provider at a local mock (dev builds only).
function baseOf(id) {
  const mock = process.env.MERIDIAN_CLOUD_BASE;
  if (mock) { try { if (!require('electron').app?.isPackaged) return `${mock}/${id}`; } catch { return `${mock}/${id}`; } }
  return CLOUD[id].base;
}

function headersFor(id, key) {
  const h = { authorization: `Bearer ${key}` };
  // OpenRouter shows which app sent the request (their optional attribution headers).
  if (id === 'openrouter') { h['HTTP-Referer'] = 'https://undermove.github.io/meridian-browser/'; h['X-Title'] = 'Meridian'; }
  return h;
}

async function listModels(id, key, timeout = 10_000) {
  const r = await fetch(`${baseOf(id)}/models`, { headers: headersFor(id, key), signal: AbortSignal.timeout(timeout) });
  if (r.status === 401 || r.status === 403) { const e = new Error('rejected'); e.rejected = true; throw e; }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const p = CLOUD[id];
  return (j.data || j.models || []).map((m) => String(m.id || m.name || '')).filter((m) => m && p.keep.test(m) && !NOT_CHAT.test(m));
}

// The user's pick if the provider still has it, else the first preferred model (newest version first).
function pickModel(id, models, chosen) {
  if (chosen && models.includes(chosen)) return chosen;
  const p = CLOUD[id];
  const newestFirst = [...models].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const re of p.prefer) { const m = newestFirst.find((x) => re.test(x)); if (m) return m; }
  return p.fallback || newestFirst[0] || null;
}

class CloudKeys {
  constructor({ userDataDir, safeStorage }) {
    this.file = path.join(userDataDir, 'ai-keys.json');
    this.safe = safeStorage;
    this.models = new Map(); // id -> { at, list }
  }

  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { return {}; } }

  has(id) { return !!this.read()[id]; }

  saved() { return Object.keys(this.read()).filter((id) => CLOUD[id]); }

  get(id) {
    const sealed = this.read()[id];
    if (!sealed) return null;
    try { return this.safe.decryptString(Buffer.from(sealed, 'base64')); } catch { return null; }
  }

  set(id, key) {
    if (!CLOUD[id]) throw new Error('Unknown provider');
    const all = this.read();
    if (!key) delete all[id];
    else {
      if (!this.safe.isEncryptionAvailable()) throw new Error('Meridian couldn’t reach the system keychain to store the key safely. Quit Meridian, open it again and try once more.');
      all[id] = this.safe.encryptString(String(key).trim()).toString('base64');
    }
    this.models.delete(id);
    fs.writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 });
  }

  async modelList(id) {
    const c = this.models.get(id);
    if (c && Date.now() - c.at < 3_600_000) return c.list;
    const key = this.get(id);
    if (!key) return [];
    const list = await listModels(id, key);
    this.models.set(id, { at: Date.now(), list });
    return list;
  }

  // Find whose key this is and check it: { ok, provider, label } or { ok: false, error }.
  async test(key) {
    key = String(key || '').trim();
    const candidates = detect(key).filter((id) => CLOUD[id]);
    if (!candidates.length) return { ok: false, error: 'That doesn’t look like an API key. A key is one long code, like “sk-…” or “AIza…”: copy the whole thing from the provider’s page. Meridian knows keys from Anthropic, OpenAI, Google Gemini, OpenRouter, xAI, Mistral, DeepSeek and Groq.' };
    let lastErr = null;
    for (const id of candidates) {
      try {
        const list = await listModels(id, key);
        this.models.set(id, { at: Date.now(), list });
        return { ok: true, provider: id, label: CLOUD[id].label };
      } catch (err) { lastErr = err; }
    }
    const who = CLOUD[candidates[0]].label;
    if (lastErr?.rejected) return { ok: false, error: `${who} didn’t accept this key. Copy it again from your ${who} account.` };
    return { ok: false, error: `Couldn’t reach ${who} to check the key (${lastErr?.message || 'no answer'}). Check your connection and try again.` };
  }
}

module.exports = { CLOUD, CloudKeys, detect, pickModel, baseOf, headersFor };
