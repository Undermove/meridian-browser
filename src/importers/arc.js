// Reads Arc's local sidebar file (~/Library/Application Support/Arc/StorableSidebar.json)
// and converts spaces, pinned tabs, folders, Today tabs and favorites into Meridian's shape.
// Nothing leaves the machine: it's a local file read.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Dev/test only (main.js sets it when !app.isPackaged and MERIDIAN_ARC_DIR is given): a fake Arc
// data folder (StorableSidebar.json + "User Data") used instead of the real one.
let arcRootOverride = null;
function setArcRootOverride(dir) { arcRootOverride = dir || null; }

// Arc's own data folder: ~/Library/Application Support/Arc on macOS. (Arc for Windows is an MSIX
// package; its folder is found by findSidebarFile below.)
function arcRoot() {
  if (arcRootOverride) return arcRootOverride;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Arc');
  return null;
}

// Arc for macOS keeps its data in Application Support; Arc for Windows is an MSIX package.
function findSidebarFile() {
  const candidates = [];
  if (arcRootOverride) {
    candidates.push(path.join(arcRootOverride, 'StorableSidebar.json'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Arc', 'StorableSidebar.json'));
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    try {
      for (const pkg of fs.readdirSync(path.join(local, 'Packages'))) {
        if (pkg.startsWith('TheBrowserCompany.Arc')) {
          candidates.push(path.join(local, 'Packages', pkg, 'LocalCache', 'Local', 'Arc', 'StorableSidebar.json'));
        }
      }
    } catch {}
  }
  return candidates.find((f) => fs.existsSync(f)) || null;
}

function arcDataExists() {
  return !!findSidebarFile();
}

// Arc stores maps as flat arrays: [key, value, key, value, ...]
function pairs(arr) {
  const out = new Map();
  for (let i = 0; i + 1 < arr.length; i += 2) {
    if (typeof arr[i] === 'string') out.set(arr[i], arr[i + 1]);
  }
  return out;
}

// Arc profile → Meridian profile id. Arc names a custom profile by its folder in "User Data"
// ("Profile 3" → 'arc-profile-3'); the cookie importer maps those folders with profileIdForDir.
function profileIdForDir(base) {
  return base && base !== 'Default' ? 'arc-' + base.toLowerCase().replace(/\s+/g, '-') : 'default';
}
function profileIdFrom(profile) {
  if (!profile || profile.default) return 'default';
  return profileIdForDir(profile.custom?._0?.directoryBasename);
}

function toHex(c) {
  if (!c) return null;
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.red) + h(c.green) + h(c.blue);
}

function spaceColor(customInfo) {
  const theme = customInfo?.windowTheme;
  const palette = theme?.primaryColorPalette;
  if (palette?.midTone) return toHex(palette.midTone);
  // Newer Arc themes: background.single._0.style.color._0.blendedGradient._0.overlayColors
  const grad = theme?.background?.single?._0?.style?.color?._0?.blendedGradient?._0;
  const solid = grad?.overlayColors?.find((c) => c.alpha > 0.2);
  return toHex(solid) || null;
}

const newId = () => crypto.randomUUID();

function importFromArc() {
  const file = findSidebarFile();
  if (!file) throw new Error('Arc data not found on this computer');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const container = (raw.sidebar?.containers || []).find((c) => Array.isArray(c.items));
  if (!container) throw new Error('Unexpected Arc sidebar format');

  const items = pairs(container.items);

  const convert = (id) => {
    const it = items.get(id);
    if (!it) return null;
    const title = it.title || null;
    if (it.data?.tab) {
      const url = it.data.tab.savedURL;
      if (!url) return null;
      return { id: newId(), type: 'tab', url, title: title || it.data.tab.savedTitle || url };
    }
    if (it.data?.list) {
      return {
        id: newId(), type: 'folder', title: title || 'Folder', collapsed: true,
        children: (it.childrenIds || []).map(convert).filter(Boolean),
      };
    }
    // Arc's split views / easels: flatten their tabs
    if (it.childrenIds?.length) {
      return { id: newId(), type: 'folder', title: title || 'Group', collapsed: true, children: it.childrenIds.map(convert).filter(Boolean) };
    }
    return null;
  };
  const childrenOf = (containerId) => (items.get(containerId)?.childrenIds || []).map(convert).filter(Boolean);

  // Favorites ("top apps") per profile
  const favorites = {};
  const top = container.topAppsContainerIDs || [];
  for (let i = 0; i + 1 < top.length; i += 2) {
    const pid = profileIdFrom(top[i]);
    const tabs = [];
    const flatten = (n) => { if (!n) return; if (n.type === 'tab') tabs.push(n); else n.children.forEach(flatten); };
    childrenOf(top[i + 1]).forEach(flatten);
    if (tabs.length) favorites[pid] = tabs;
  }

  const profiles = new Map([['default', { id: 'default', name: 'Default' }]]);
  const spaces = [];
  for (const [id, s] of pairs(container.spaces || [])) {
    if (!s || typeof s !== 'object') continue;
    const ids = s.containerIDs || [];
    const pinnedId = ids[ids.indexOf('pinned') + 1];
    const unpinnedId = ids[ids.indexOf('unpinned') + 1];
    const profileId = profileIdFrom(s.profile);
    if (!profiles.has(profileId)) {
      profiles.set(profileId, { id: profileId, name: s.profile?.custom?._0?.directoryBasename || s.title || 'Profile' });
    }
    const today = [];
    const flatten = (n) => { if (!n) return; if (n.type === 'tab') today.push(n); else n.children.forEach(flatten); };
    if (ids.includes('unpinned')) childrenOf(unpinnedId).forEach(flatten);
    spaces.push({
      id: newId(),
      arcId: id,
      name: s.title || 'Space',
      icon: s.customInfo?.iconType?.emoji_v2 || null,
      color: spaceColor(s.customInfo) || '#8a8fe0',
      profileId,
      pinned: ids.includes('pinned') ? childrenOf(pinnedId) : [],
      today: today.map((t) => ({ ...t, lastActive: Date.now() })),
    });
  }
  // Name profiles after the first space that uses them — friendlier than "Profile 3".
  for (const p of profiles.values()) {
    const sp = spaces.find((s) => s.profileId === p.id);
    if (sp && p.id !== 'default') p.name = sp.name;
  }

  return { spaces, favorites, profiles: [...profiles.values()] };
}

module.exports = { importFromArc, arcDataExists, arcRoot, setArcRootOverride, profileIdForDir };
