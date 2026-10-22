// Builders for state.json seeds (same shape as defaultState() in src/renderer/app.js).

const crypto = require('crypto');

const id = () => crypto.randomUUID();
const COLORS = ['#8a8fe0', '#e08a9b', '#e0b27a', '#7fbf8e', '#6fb6d9', '#b48ae0', '#d98a6f', '#9aa3ad'];

function tab(url, extra = {}) {
  return { id: id(), type: 'tab', url, title: extra.title || url, lastActive: Date.now(), ...extra };
}
function pinnedTab(url, extra = {}) {
  const t = { id: id(), type: 'tab', url, title: extra.title || url, ...extra };
  return t;
}
function folder(title, children = [], extra = {}) {
  return { id: id(), type: 'folder', title, collapsed: false, children, ...extra };
}
function space(name, extra = {}) {
  return { id: id(), name, icon: null, color: COLORS[0], profileId: 'default', pinned: [], today: [], activeTabId: null, split: null, ...extra };
}

function seedState({ spaces, settings = {}, favorites, profiles, archive = [], history = {}, activeSpace = 0 } = {}) {
  const sps = (spaces && spaces.length ? spaces : [space('Personal', { icon: '🏠' })]).map((s, i) => ({ color: COLORS[i % COLORS.length], ...s }));
  return {
    version: 1,
    profiles: profiles || [{ id: 'default', name: 'Default' }],
    spaces: sps,
    activeSpaceId: sps[activeSpace].id,
    favorites: favorites || { default: [] },
    archive,
    history,
    settings: {
      searchEngine: 'google', archiveAfterHours: 12, adblock: false, sidebarRight: false, sidebarHidden: false,
      extensions: [], agentAccess: 'off', agentAllowJs: false, aiUseTools: false, ...settings,
    },
    onboarded: true,
  };
}

// Synthetic "big profile": 250 pinned tabs in 20 folders + 40 Today tabs, plus two lighter spaces.
// URLs point at the fixture server but tabs stay unloaded until activated, like a real restored session.
function bigProfile(base) {
  const pinned = [];
  let n = 0;
  for (let f = 0; f < 20; f++) {
    const kids = [];
    const count = f < 10 ? 13 : 12; // 130 + 120 = 250
    for (let i = 0; i < count; i++) kids.push(pinnedTab(`${base}/p/pin-${n}`, { title: `Pinned ${n++} — some longer title text` }));
    pinned.push(folder(`Folder ${f + 1}`, kids, { collapsed: f % 3 === 0 }));
  }
  const today = [];
  for (let i = 0; i < 40; i++) today.push(tab(`${base}/p/today-${i}`, { title: `Today ${i}` }));
  const main = space('Big', { icon: '🧪', pinned, today, activeTabId: today[0].id });
  const s2 = space('Work', { today: [tab(`${base}/p/work-0`, { title: 'Work 0' })] });
  s2.activeTabId = s2.today[0].id;
  const s3 = space('Play', { today: [tab(`${base}/p/play-0`, { title: 'Play 0' })] });
  s3.activeTabId = s3.today[0].id;
  return seedState({ spaces: [main, s2, s3] });
}

module.exports = { seedState, bigProfile, tab, pinnedTab, folder, space, id };
