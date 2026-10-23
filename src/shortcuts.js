// One table for every app shortcut. The main process matches keys in `before-input-event` on the UI
// windows and on every <webview> guest, so shortcuts work no matter what has focus (menu accelerators
// alone don't fire when a page swallows the key, e.g. ⌘⌥←/→ in a page that scrolls or edits text).
// The menu shows the same accelerators as labels, and Settings → Shortcuts lists (and remaps) them.
//
// `soft` shortcuts are left to the page first and only reach us through the menu when the page doesn't
// use the key (⌘←/→ moves the caret in text fields on macOS).

const IS_MAC = process.platform === 'darwin';

// Every entry: id, label (Settings → Shortcuts and help), group, accel (null = no default key, still
// assignable in Settings), and either cmd (sent to the focused UI window) or run (handled in main).
// `overrides` ({ id: accel | '' }) come from Settings; '' turns a shortcut off.
function shortcutTable(isMac = IS_MAC, overrides = {}) {
  // macOS: Ctrl+N switches spaces, Cmd+N tabs (as in Arc). Elsewhere Ctrl is the tab modifier, so spaces use Alt.
  const spaceMod = isMac ? 'Ctrl' : 'Alt';
  const G = { app: 'Meridian', win: 'Windows', tabs: 'Tabs', nav: 'Navigation', spaces: 'Spaces', view: 'View', find: 'Find', archive: 'Archive', dev: 'Developer' };
  const t = [
    { id: 'settings', label: 'Settings', group: G.app, accel: 'CmdOrCtrl+,', run: 'settings' },
    { id: 'shortcuts-help', label: 'Keyboard Shortcuts', group: G.app, accel: 'CmdOrCtrl+/', run: 'shortcuts-help' },
    { id: 'command-bar', label: 'New Tab / Command Bar', group: G.tabs, accel: 'CmdOrCtrl+T', cmd: ['command-bar'] },
    { id: 'new-window', label: 'New Window', group: G.win, accel: 'CmdOrCtrl+N', run: 'new-window' },
    { id: 'mini-window', label: 'New Little Window', group: G.win, accel: 'CmdOrCtrl+Alt+N', run: 'mini-window' },
    // ⇧⌘N opens a private window in Arc and Chrome; New Folder moved to ⌥⇧⌘N.
    { id: 'private-window', label: 'New Private Window', group: G.win, accel: 'CmdOrCtrl+Shift+N', run: 'private-window' },
    { id: 'new-folder', label: 'New Folder', group: G.tabs, accel: 'CmdOrCtrl+Alt+Shift+N', cmd: ['new-folder'] },
    { id: 'edit-url', label: 'Open Location / Edit URL', group: G.nav, accel: 'CmdOrCtrl+L', cmd: ['edit-url'] },
    { id: 'reopen-tab', label: 'Reopen Closed Tab', group: G.tabs, accel: 'CmdOrCtrl+Shift+T', cmd: ['reopen-tab'] },
    { id: 'close-tab', label: 'Close Tab', group: G.tabs, accel: 'CmdOrCtrl+W', cmd: ['close-tab'] },
    { id: 'copy-url', label: 'Copy URL', group: G.tabs, accel: 'CmdOrCtrl+Shift+C', cmd: ['copy-url'] },
    { id: 'duplicate-tab', label: 'Duplicate Tab', group: G.tabs, accel: null, cmd: ['duplicate-tab'] },
    { id: 'add-favorite', label: 'Add to Favorites', group: G.tabs, accel: null, cmd: ['favorite'] },
    { id: 'find', label: 'Find in Page', group: G.find, accel: 'CmdOrCtrl+F', cmd: ['find'] },
    { id: 'find-next', label: 'Find Next', group: G.find, accel: 'CmdOrCtrl+G', cmd: ['find-next'], repeat: true },
    { id: 'find-prev', label: 'Find Previous', group: G.find, accel: 'CmdOrCtrl+Shift+G', cmd: ['find-prev'], repeat: true },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar', group: G.view, accel: 'CmdOrCtrl+S', cmd: ['toggle-sidebar'] },
    { id: 'ai-panel', label: 'Ask AI', group: G.view, accel: 'CmdOrCtrl+J', cmd: ['ai-panel'] },
    { id: 'open-chat', label: 'Chat', group: G.view, accel: 'CmdOrCtrl+Alt+J', cmd: ['open-chat'] },
    { id: 'open-workbench', label: 'Workbench', group: G.view, accel: 'CmdOrCtrl+Shift+E', cmd: ['open-workbench'] },
    { id: 'mission-control', label: 'Mission Control', group: G.view, accel: 'CmdOrCtrl+Shift+M', cmd: ['mission-control'] },
    { id: 'downloads', label: 'Downloads', group: G.view, accel: 'CmdOrCtrl+Shift+J', cmd: ['downloads'] },
    { id: 'split', label: 'Split View', group: G.view, accel: 'Ctrl+Shift+=', cmd: ['split'] },
    { id: 'unsplit', label: 'Close Split View', group: G.view, accel: 'Ctrl+Shift+-', cmd: ['unsplit'] },
    { id: 'reload', label: 'Reload', group: G.nav, accel: 'CmdOrCtrl+R', cmd: ['reload'] },
    { id: 'hard-reload', label: 'Hard Reload', group: G.nav, accel: 'CmdOrCtrl+Shift+R', cmd: ['hard-reload'] },
    { id: 'zoom-in', label: 'Zoom In', group: G.view, accel: 'CmdOrCtrl+=', cmd: ['zoom', 1], repeat: true },
    { id: 'zoom-in-plus', label: 'Zoom In (+)', group: G.view, accel: 'CmdOrCtrl+Plus', cmd: ['zoom', 1], repeat: true, alias: true },
    { id: 'zoom-out', label: 'Zoom Out', group: G.view, accel: 'CmdOrCtrl+-', cmd: ['zoom', -1], repeat: true },
    { id: 'zoom-reset', label: 'Actual Size', group: G.view, accel: 'CmdOrCtrl+0', cmd: ['zoom', 0] },
    { id: 'devtools', label: 'Developer Tools (page)', group: G.dev, accel: 'CmdOrCtrl+Alt+I', cmd: ['devtools'] },
    { id: 'ui-devtools', label: 'Developer Tools (Meridian UI)', group: G.dev, accel: 'CmdOrCtrl+Alt+Shift+I', run: 'ui-devtools' },
    { id: 'back', label: 'Back', group: G.nav, accel: 'CmdOrCtrl+[', cmd: ['back'] },
    { id: 'forward', label: 'Forward', group: G.nav, accel: 'CmdOrCtrl+]', cmd: ['forward'] },
    // macOS: ⌘←/→ edit text, so the page goes first. Elsewhere Ctrl+←/→ jump words; browsers use Alt+←/→.
    isMac
      ? { id: 'back-arrow', label: 'Back (arrow)', group: G.nav, accel: 'Cmd+Left', cmd: ['back'], soft: true, alias: true }
      : { id: 'back-arrow', label: 'Back (arrow)', group: G.nav, accel: 'Alt+Left', cmd: ['back'], alias: true },
    isMac
      ? { id: 'forward-arrow', label: 'Forward (arrow)', group: G.nav, accel: 'Cmd+Right', cmd: ['forward'], soft: true, alias: true }
      : { id: 'forward-arrow', label: 'Forward (arrow)', group: G.nav, accel: 'Alt+Right', cmd: ['forward'], alias: true },
    { id: 'toggle-pin', label: 'Pin / Unpin Tab', group: G.tabs, accel: 'CmdOrCtrl+D', cmd: ['toggle-pin'] },
    { id: 'next-tab', label: 'Next Tab', group: G.tabs, accel: 'Ctrl+Tab', cmd: ['tab-step', 1], repeat: true },
    { id: 'prev-tab', label: 'Previous Tab', group: G.tabs, accel: 'Ctrl+Shift+Tab', cmd: ['tab-step', -1], repeat: true },
    { id: 'next-tab-arrow', label: 'Next Tab (arrow)', group: G.tabs, accel: 'CmdOrCtrl+Alt+Down', cmd: ['tab-step', 1], repeat: true, alias: true },
    { id: 'prev-tab-arrow', label: 'Previous Tab (arrow)', group: G.tabs, accel: 'CmdOrCtrl+Alt+Up', cmd: ['tab-step', -1], repeat: true, alias: true },
    { id: 'clear-today', label: 'Clear Today', group: G.tabs, accel: 'CmdOrCtrl+Shift+K', cmd: ['clear-today'] },
    { id: 'view-archive', label: 'View Archive', group: G.archive, accel: 'CmdOrCtrl+Alt+A', cmd: ['archive'] },
    { id: 'reopen-archived', label: 'Reopen Last Archived Tab', group: G.archive, accel: null, cmd: ['reopen-archived'] },
    { id: 'new-space', label: 'New Space', group: G.spaces, accel: null, cmd: ['new-space'] },
    { id: 'edit-theme', label: 'Edit Space Theme', group: G.spaces, accel: null, cmd: ['edit-theme'] },
    { id: 'next-space', label: 'Next Space', group: G.spaces, accel: 'CmdOrCtrl+Alt+Right', cmd: ['space-step', 1], repeat: true },
    { id: 'prev-space', label: 'Previous Space', group: G.spaces, accel: 'CmdOrCtrl+Alt+Left', cmd: ['space-step', -1], repeat: true },
  ];
  for (let i = 1; i <= 9; i++) t.push({ id: `tab-${i}`, label: i === 9 ? 'Last Tab' : `Tab ${i}`, group: G.tabs, accel: `CmdOrCtrl+${i}`, cmd: ['tab-index', i - 1] });
  for (let i = 1; i <= 9; i++) t.push({ id: `space-${i}`, label: `Space ${i}`, group: G.spaces, accel: `${spaceMod}+${i}`, cmd: ['space-index', i - 1] });
  return t.map((s) => {
    const defaultAccel = s.accel;
    let accel = defaultAccel;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, s.id)) {
      const o = overrides[s.id];
      if (o === '' || o === null) accel = null;
      else if (isValidAccelerator(o)) accel = o;
    }
    return { ...s, accel, defaultAccel, match: accel ? parseAccelerator(accel, isMac) : null };
  });
}

const NAMED = {
  '=': ['Equal', 'NumpadEqual'], '-': ['Minus', 'NumpadSubtract'], Plus: ['Equal', 'NumpadAdd'],
  '[': ['BracketLeft'], ']': ['BracketRight'], ',': ['Comma'], '.': ['Period'], '/': ['Slash'],
  ';': ['Semicolon'], "'": ['Quote'], '`': ['Backquote'], '\\': ['Backslash'],
  Left: ['ArrowLeft'], Right: ['ArrowRight'], Up: ['ArrowUp'], Down: ['ArrowDown'], Tab: ['Tab'],
  Space: ['Space'], Enter: ['Enter', 'NumpadEnter'], Backspace: ['Backspace'], Delete: ['Delete'], Escape: ['Escape'],
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = [`F${i}`];
const MODIFIERS = new Set(['CmdOrCtrl', 'Cmd', 'Ctrl', 'Alt', 'Shift']);

// A string we can both match and hand to Electron's menu: known modifiers + one known key.
function isValidAccelerator(accel) {
  if (typeof accel !== 'string' || accel.length > 40) return false;
  const parts = accel.split('+');
  const key = parts.pop();
  if (!key || parts.some((p) => !MODIFIERS.has(p)) || new Set(parts).size !== parts.length) return false;
  if (!Object.prototype.hasOwnProperty.call(NAMED, key) && !/^[0-9A-Z]$/.test(key)) return false;
  return parts.length > 0 || /^F\d+$/.test(key); // a bare letter would break typing
}

function parseAccelerator(accel, isMac) {
  const parts = accel.split('+');
  // "CmdOrCtrl+Plus" splits into [..., 'Plus']; "Ctrl+Shift+=" into [..., '=']; a trailing '+' never occurs.
  const key = parts.pop();
  const m = { meta: false, control: false, alt: false, shift: false };
  for (const p of parts) {
    if (p === 'CmdOrCtrl') m[isMac ? 'meta' : 'control'] = true;
    else if (p === 'Cmd') m.meta = true;
    else if (p === 'Ctrl') m.control = true;
    else if (p === 'Alt') m.alt = true;
    else if (p === 'Shift') m.shift = true;
  }
  if (key === 'Plus') m.shift = true;
  let codes = NAMED[key];
  let letter = null;
  if (!codes && /^[0-9]$/.test(key)) codes = [`Digit${key}`];
  if (!codes && /^[A-Z]$/i.test(key)) { letter = key.toLowerCase(); codes = [`Key${key.toUpperCase()}`]; }
  return { ...m, codes: codes || [], letter, isMac };
}

// Letters match the typed character when it is a Latin letter (so Dvorak/AZERTY users get the letter
// they see), otherwise the physical key (Cyrillic and other layouts). Everything else matches the
// physical key, since Shift/Option change the character.
function matches(m, input) {
  if (!!input.meta !== m.meta || !!input.control !== m.control || !!input.alt !== m.alt || !!input.shift !== m.shift) return false;
  if (m.letter) {
    const k = String(input.key || '');
    if (/^[a-z]$/i.test(k)) return k.toLowerCase() === m.letter;
    // Windows/Linux: Ctrl+Alt is AltGr on many layouts; a typed character means the user is writing text.
    if (!m.isMac && m.control && m.alt && k.length === 1) return false;
    return m.codes.includes(input.code);
  }
  return m.codes.includes(input.code);
}

function findShortcut(table, input) {
  if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return null;
  return table.find((s) => s.match && !s.soft && matches(s.match, input)) || null;
}

// The accelerator for a keypress (Settings → Shortcuts records keys through main), or null.
const CODE_KEYS = {
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
  Quote: "'", Backquote: '`', Backslash: '\\', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Tab: 'Tab', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape',
};
function acceleratorFromInput(input, isMac = IS_MAC) {
  const code = String(input.code || '');
  let key = CODE_KEYS[code] || null;
  if (!key && /^Key[A-Z]$/.test(code)) key = /^[a-z]$/i.test(input.key || '') ? input.key.toUpperCase() : code.slice(3);
  if (!key && /^Digit[0-9]$/.test(code)) key = code.slice(5);
  if (!key && /^F([1-9]|1[0-2])$/.test(code)) key = code;
  if (!key) return null;
  const mods = [];
  if (isMac) { if (input.meta) mods.push('CmdOrCtrl'); if (input.control) mods.push('Ctrl'); }
  else { if (input.meta) return null; if (input.control) mods.push('CmdOrCtrl'); }
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  const accel = [...mods, key].join('+');
  return isValidAccelerator(accel) ? accel : null;
}

// "CmdOrCtrl+Shift+T" -> "⇧⌘T" (macOS) / "Ctrl+Shift+T" (elsewhere).
function formatAccelerator(accel, isMac = IS_MAC) {
  if (!accel) return '';
  const parts = accel.split('+');
  const key = parts.pop();
  const sym = { Left: '←', Right: '→', Up: '↑', Down: '↓', Enter: '↩', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Plus: '+' };
  if (isMac) {
    const order = [['Ctrl', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['CmdOrCtrl', '⌘'], ['Cmd', '⌘']];
    return order.filter(([m]) => parts.includes(m)).map(([, s]) => s).join('') + (sym[key] || (key === 'Tab' ? '⇥' : key));
  }
  const names = { CmdOrCtrl: 'Ctrl', Cmd: 'Win', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  return [...new Set(parts.map((p) => names[p]))].concat(sym[key] || key).join('+');
}

module.exports = { shortcutTable, findShortcut, parseAccelerator, matches, isValidAccelerator, acceleratorFromInput, formatAccelerator };
