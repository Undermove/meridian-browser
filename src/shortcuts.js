// One table for every app shortcut. The main process matches keys in `before-input-event` on the UI
// windows and on every <webview> guest, so shortcuts work no matter what has focus (menu accelerators
// alone don't fire when a page swallows the key, e.g. ⌘⌥←/→ in a page that scrolls or edits text).
// The menu shows the same accelerators as labels.
//
// `soft` shortcuts are left to the page first and only reach us through the menu when the page doesn't
// use the key (⌘←/→ moves the caret in text fields on macOS).

const IS_MAC = process.platform === 'darwin';

function shortcutTable(isMac = IS_MAC) {
  // macOS: Ctrl+N switches spaces, Cmd+N tabs (as in Arc). Elsewhere Ctrl is the tab modifier, so spaces use Alt.
  const spaceMod = isMac ? 'Ctrl' : 'Alt';
  const t = [
    { id: 'settings', accel: 'CmdOrCtrl+,', cmd: ['settings'] },
    { id: 'command-bar', accel: 'CmdOrCtrl+T', cmd: ['command-bar'] },
    { id: 'mini-window', accel: 'CmdOrCtrl+Alt+N', run: 'mini-window' },
    { id: 'new-window', accel: 'CmdOrCtrl+N', run: 'new-window' },
    { id: 'new-folder', accel: 'CmdOrCtrl+Shift+N', cmd: ['new-folder'] },
    { id: 'edit-url', accel: 'CmdOrCtrl+L', cmd: ['edit-url'] },
    { id: 'reopen-tab', accel: 'CmdOrCtrl+Shift+T', cmd: ['reopen-tab'] },
    { id: 'close-tab', accel: 'CmdOrCtrl+W', cmd: ['close-tab'] },
    { id: 'copy-url', accel: 'CmdOrCtrl+Shift+C', cmd: ['copy-url'] },
    { id: 'find', accel: 'CmdOrCtrl+F', cmd: ['find'] },
    { id: 'find-next', accel: 'CmdOrCtrl+G', cmd: ['find-next'], repeat: true },
    { id: 'find-prev', accel: 'CmdOrCtrl+Shift+G', cmd: ['find-prev'], repeat: true },
    { id: 'toggle-sidebar', accel: 'CmdOrCtrl+S', cmd: ['toggle-sidebar'] },
    { id: 'ai-panel', accel: 'CmdOrCtrl+J', cmd: ['ai-panel'] },
    { id: 'open-workbench', accel: 'CmdOrCtrl+Shift+E', cmd: ['open-workbench'] },
    { id: 'split', accel: 'Ctrl+Shift+=', cmd: ['split'] },
    { id: 'unsplit', accel: 'Ctrl+Shift+-', cmd: ['unsplit'] },
    { id: 'reload', accel: 'CmdOrCtrl+R', cmd: ['reload'] },
    { id: 'hard-reload', accel: 'CmdOrCtrl+Shift+R', cmd: ['hard-reload'] },
    { id: 'zoom-in', accel: 'CmdOrCtrl+=', cmd: ['zoom', 1], repeat: true },
    { id: 'zoom-in-plus', accel: 'CmdOrCtrl+Plus', cmd: ['zoom', 1], repeat: true },
    { id: 'zoom-out', accel: 'CmdOrCtrl+-', cmd: ['zoom', -1], repeat: true },
    { id: 'zoom-reset', accel: 'CmdOrCtrl+0', cmd: ['zoom', 0] },
    { id: 'devtools', accel: 'CmdOrCtrl+Alt+I', cmd: ['devtools'] },
    { id: 'ui-devtools', accel: 'CmdOrCtrl+Alt+Shift+I', run: 'ui-devtools' },
    { id: 'back', accel: 'CmdOrCtrl+[', cmd: ['back'] },
    { id: 'forward', accel: 'CmdOrCtrl+]', cmd: ['forward'] },
    // macOS: ⌘←/→ edit text, so the page goes first. Elsewhere Ctrl+←/→ jump words; browsers use Alt+←/→.
    isMac
      ? { id: 'back-arrow', accel: 'Cmd+Left', cmd: ['back'], soft: true }
      : { id: 'back-arrow', accel: 'Alt+Left', cmd: ['back'] },
    isMac
      ? { id: 'forward-arrow', accel: 'Cmd+Right', cmd: ['forward'], soft: true }
      : { id: 'forward-arrow', accel: 'Alt+Right', cmd: ['forward'] },
    { id: 'toggle-pin', accel: 'CmdOrCtrl+D', cmd: ['toggle-pin'] },
    { id: 'next-tab', accel: 'Ctrl+Tab', cmd: ['tab-step', 1], repeat: true },
    { id: 'prev-tab', accel: 'Ctrl+Shift+Tab', cmd: ['tab-step', -1], repeat: true },
    { id: 'next-tab-arrow', accel: 'CmdOrCtrl+Alt+Down', cmd: ['tab-step', 1], repeat: true },
    { id: 'prev-tab-arrow', accel: 'CmdOrCtrl+Alt+Up', cmd: ['tab-step', -1], repeat: true },
    { id: 'clear-today', accel: 'CmdOrCtrl+Shift+K', cmd: ['clear-today'] },
    { id: 'next-space', accel: 'CmdOrCtrl+Alt+Right', cmd: ['space-step', 1], repeat: true },
    { id: 'prev-space', accel: 'CmdOrCtrl+Alt+Left', cmd: ['space-step', -1], repeat: true },
  ];
  for (let i = 1; i <= 9; i++) t.push({ id: `tab-${i}`, accel: `CmdOrCtrl+${i}`, cmd: ['tab-index', i - 1] });
  for (let i = 1; i <= 9; i++) t.push({ id: `space-${i}`, accel: `${spaceMod}+${i}`, cmd: ['space-index', i - 1] });
  return t.map((s) => ({ ...s, match: parseAccelerator(s.accel, isMac) }));
}

const NAMED = {
  '=': ['Equal', 'NumpadEqual'], '-': ['Minus', 'NumpadSubtract'], Plus: ['Equal', 'NumpadAdd'],
  '[': ['BracketLeft'], ']': ['BracketRight'], ',': ['Comma'],
  Left: ['ArrowLeft'], Right: ['ArrowRight'], Up: ['ArrowUp'], Down: ['ArrowDown'], Tab: ['Tab'],
};

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
  return { ...m, codes, letter, isMac };
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
  return table.find((s) => !s.soft && matches(s.match, input)) || null;
}

module.exports = { shortcutTable, findShortcut, parseAccelerator, matches };
