// Chat view conversations (src/renderer/chat.js), kept by main in userData/chats.json (0600) — not in
// state.json, which is rewritten on every tab change and shouldn't carry long transcripts.
//
// The renderer sends whole chats; everything is validated here: known fields only, strings only,
// at most MAX_CHATS chats (oldest dropped) and about MAX_CHAT_BYTES per chat (oldest messages dropped).
// Private and Little windows never reach this (main registers the channels for the main window only).

const fs = require('fs');
const path = require('path');

const MAX_CHATS = 200;
const MAX_CHAT_BYTES = 200_000;
const MAX_MESSAGES = 400;
const MAX_TEXT = 100_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const time = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : Date.now());

function cleanMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role === 'user' || m.role === 'assistant' ? m.role : null;
  const text = str(m.text, MAX_TEXT);
  if (!role || !text) return null;
  const out = { role, text, ts: time(m.ts) };
  if (role === 'assistant') {
    const provider = str(m.provider, 40);
    if (provider && /^[a-z0-9-]+$/.test(provider)) out.provider = provider;
    if (m.stopped === true) out.stopped = true;
  }
  return out;
}

// A chat as the renderer sent it -> a safe, size-limited copy (or null).
function cleanChat(c) {
  if (!c || typeof c !== 'object' || !ID_RE.test(String(c.id || ''))) return null;
  let messages = (Array.isArray(c.messages) ? c.messages.slice(-MAX_MESSAGES) : []).map(cleanMessage).filter(Boolean);
  const chat = {
    id: String(c.id),
    title: str(c.title, 120).replace(/[\u0000-\u001f]/g, ' ').trim() || 'New chat',
    createdAt: time(c.createdAt),
    updatedAt: time(c.updatedAt),
    messages,
  };
  // Oldest turns go first when a chat outgrows its budget; the newest message always stays.
  while (messages.length > 1 && JSON.stringify(chat).length > MAX_CHAT_BYTES) { messages = messages.slice(1); chat.messages = messages; }
  if (JSON.stringify(chat).length > MAX_CHAT_BYTES) chat.messages = messages.map((m) => ({ ...m, text: m.text.slice(-Math.floor(MAX_CHAT_BYTES / 2)) }));
  return chat;
}

class ChatsStore {
  constructor({ userDataDir, writeAtomic }) {
    this.file = path.join(userDataDir, 'chats.json');
    this.writeAtomic = writeAtomic;
    this.chats = null; // id -> chat, loaded lazily
  }

  load() {
    if (this.chats) return this.chats;
    this.chats = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const c of Array.isArray(data?.chats) ? data.chats : []) { const clean = cleanChat(c); if (clean) this.chats.set(clean.id, clean); }
    } catch {}
    return this.chats;
  }

  async persist() {
    const chats = [...this.load().values()].sort((a, b) => b.updatedAt - a.updatedAt);
    await this.writeAtomic(this.file, JSON.stringify({ version: 1, chats }), { mode: 0o600 });
  }

  // Newest first, without the messages.
  list() {
    return [...this.load().values()].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length }));
  }

  get(id) {
    return this.load().get(String(id)) || null;
  }

  async save(chat) {
    const clean = cleanChat(chat);
    if (!clean) return false;
    const chats = this.load();
    chats.set(clean.id, clean);
    if (chats.size > MAX_CHATS) {
      const oldest = [...chats.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, chats.size - MAX_CHATS);
      for (const c of oldest) chats.delete(c.id);
    }
    await this.persist();
    return true;
  }

  async delete(id) {
    if (!this.load().delete(String(id))) return false;
    await this.persist();
    return true;
  }
}

module.exports = { ChatsStore, cleanChat, MAX_CHATS, MAX_CHAT_BYTES };
