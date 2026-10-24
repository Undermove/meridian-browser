// What Meridian's AI knows about Meridian itself, so "how do I split the screen?" gets a real answer.
// The shortcut list is built from the live table (user remaps included).

const FEATURES = `Meridian is an open-source browser modelled on Arc (by The Browser Company), for macOS, Windows and Linux.

Sidebar & tabs
- Spaces: separate sidebars for work, life, projects — each with its own colour, icon and optionally its own profile (separate cookies/logins). Switch with the space shortcuts, the dots at the bottom of the sidebar, or a two-finger swipe on the sidebar.
- Favorites: the big icons at the top of the sidebar, shared by spaces of the same profile.
- Pinned: tabs and folders above the "Today" divider. They stay; a pinned tab remembers its home URL and a "/" button takes it back there.
- Today: unpinned tabs. They're archived automatically after 12 hours unused (Settings → General → Archive Today tabs after). Archived tabs are searchable in the command bar and in the Archive view.
- Folders: drag tabs onto each other or use New Folder. Drag and drop moves tabs between Favorites, Pinned, folders and Today.
- Command bar (New Tab shortcut): search open tabs in every space, history, the archive, commands and the web; type a question and pick "Ask" to get an AI answer right there.
- Split view: two pages side by side; drag the divider. Peek: links from pinned tabs to other sites open in a preview you can expand into a tab or a split.
- Little window: links from other apps open in a small window; "Open in Meridian" moves them into the main window. Air Traffic Control (Settings → Links) routes links from other apps to a chosen space by domain.
- Hide the sidebar for full-width pages; hover the window edge to bring it back. The sidebar can be on the right (Settings → General).
- Private windows keep nothing after closing. Reopen Closed Tab brings back the last closed tab.
- Import from Arc (Settings → General or the welcome tour): spaces, colours, pinned tabs, folders, favorites, Today tabs, and — on macOS — logins (cookies) after you allow access in the system dialog.
- Home page (shown when no tab is open): a search field, what Meridian can do for different people, and "Set up for me" presets that add spaces and favorites. In ⌘T, ⇧↵ opens a result in split view, and the bar shows the keys for what's selected.
- Built-in ad and tracker blocking (Settings → Advanced). Downloads popover, find in page, zoom, session restore.

AI
- "Power Up Meridian with AI" (home page or ⌘T) connects a Claude API key: Meridian checks it with Anthropic before saving it, encrypted.
- Ask from the command bar, the ⌘J side panel and the Chat view use the AI you connect in Settings → AI: a Claude API key, GitHub Copilot, or a free local model (Ollama, LM Studio). With "Other agents" on: Codex, Cursor, OpenCode, Qwen Code, Amp, Goose, Droid, with your own account under their terms. Claude Code and Gemini CLI run in the Workbench terminal.
- With a Claude API key and agent access enabled, ⌘J can also act in the browser (open tabs, read pages, click, type) — always within the access level you set (Off / Read only / Ask before acting / Full control).
- Developers: the Workbench is a small IDE (file tree, editor, terminals) that starts Claude Code / Codex in a project; Mission Control shows every running agent and subagent; Meridian has an MCP server so external agents can use the browser.
- Tidy Today suggests folders and shorter titles for Today tabs; Link previews: hold Shift over a link (Settings → AI).

Settings are under the Settings shortcut (General, Profiles, Links, Shortcuts, AI, Advanced). Every shortcut can be changed in Settings → Shortcuts. The welcome tour is in the Help menu.`;

function meridianGuide(shortcuts = []) {
  const keys = shortcuts
    .filter((s) => s.display && !s.alias)
    .map((s) => `- ${s.label}: ${s.display}`)
    .join('\n');
  return `${FEATURES}\n\nKeyboard shortcuts on this computer:\n${keys}`;
}

module.exports = { meridianGuide };
