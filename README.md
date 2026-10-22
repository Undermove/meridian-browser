<p align="center"><img src="build/icon-1024.png" width="112" alt="Meridian"></p>

<h1 align="center">Meridian</h1>
<p align="center"><b>The open-source Arc browser alternative for macOS, Windows and Linux, built for AI agents.</b></p>

Arc is being sunset. Meridian keeps the Arc workflow you're used to (spaces, pinned tabs, a Today list that tidies itself, split view, Peek, the command bar) and imports your Arc sidebar in one click. It's also built around AI from the start: a built-in Claude assistant, and an **MCP server** so Claude Code, Claude Desktop or any MCP client can read and drive your browser, with access you control.

## Features

**The Arc workflow**
- **Spaces** with their own colour, icon and **profile** (separate cookies and logins: work vs. personal). Switch with `Ctrl+1…9` on macOS, `Alt+1…9` on Windows/Linux, or `⌘⌥←/→`.
- **Pinned tabs and folders** that remember their home URL. Navigate away and a `/` button takes you back.
- **Favorites** grid at the top, shared across spaces of the same profile.
- **Today**: unpinned tabs auto-archive after 12 h (configurable). Everything archived stays searchable.
- **Command bar** (`⌘T` / `⌘L`): search open tabs across spaces, history, the archive, commands, or the web.
- **Split view** (`Ctrl+Shift+=`) with a draggable divider.
- **Peek**: links from pinned tabs to other sites open in an overlay. Expand to a tab or a split.
- **Little window**: links from other apps open in a small window. "Open in Meridian" moves them in.
- Hide the sidebar (`⌘S`) and reveal it by hovering the window edge. Sidebar can sit on the right.
- Drag and drop tabs between favorites, pinned, folders and Today.
- **Import from Arc**: spaces, colours, icons, pinned tabs, folders, favorites and Today tabs, read locally from Arc's sidebar file on macOS and Windows.

**AI-centric**
- **Ask Claude** panel (`⌘J`): summarize, ask about the current page, or let Claude act in the browser (open tabs, read pages, click, type).
- **MCP server** with 21 browser tools: `list_spaces`, `list_tabs`, `search_tabs`, `search_history`, `read_page`, `get_interactive_elements`, `screenshot`, `open_tab`, `navigate`, `history_nav`, `activate_tab`, `close_tab`, `click`, `type_text`, `press_key`, `scroll`, `wait_for`, `organize_tab`, `split_view`, `create_space`, and opt-in `run_javascript`.
- Tabs an agent is working in glow. An activity bar shows what it did and has a **Stop** button.

**Also**
- Built-in ad and tracker blocking (Ghostery engine), per-site permission prompts, downloads, find in page, zoom, reopen closed tab, session restore.
- Chromium engine: sites work like in Chrome. Experimental unpacked Chrome extension loading.

## Install

Download a build from Releases (`.dmg` for macOS, `Setup.exe` for Windows, `.AppImage` / `.deb` for Linux), or build it yourself:

```bash
git clone https://github.com/<you>/meridian-browser && cd meridian-browser
npm install
npm start            # run from source
npm run dist:mac     # or dist:win / dist:linux → installers in dist/
```

macOS builds are ad-hoc signed. To share them with other people, sign and notarize them with an Apple Developer ID.

## Connect Claude Code (MCP)

1. In Meridian open **Settings → AI** and pick an agent access level.
2. Copy the command shown there, e.g.

   ```bash
   claude mcp add meridian -- node /path/to/meridian-browser/mcp/meridian-mcp.js
   ```

   For Claude Desktop, add the same `command` / `args` to `claude_desktop_config.json`.
3. Ask: *"Read my open GitHub tabs and summarize the PRs"*, *"Find the Grafana dashboard I had open yesterday"*, *"Open three tabs comparing these laptops and put them in split view"*.

## Security model

Agents act inside your logged-in browser, so access is explicit and layered:

| Level | What agents can do |
|---|---|
| **Off** (default) | Nothing. The control socket isn't even open. |
| **Read only** | List tabs and spaces, read pages, screenshots, history search. |
| **Ask before acting** | Everything else too, but every navigate / click / type / tab change needs your confirmation in a native dialog. |
| **Full control** | Acts without asking. Meant for agents you trust. |

- Running JavaScript in pages is a **separate opt-in**, off by default.
- MCP clients connect over a **unix socket** (named pipe on Windows) with a random per-launch **bearer token** in a `chmod 600` file. There's no TCP port, so websites can't reach it, and requests carrying an `Origin` header are rejected.
- Page text given to models is wrapped as **untrusted content**. The assistant is told never to follow instructions found in pages.
- Agent page scripts run in an **isolated JS world**, so pages can't tamper with them. Agents can only open `http(s)` URLs.
- The Claude API key is **encrypted with the OS keychain** (safeStorage) and only used in the main process. Web content and the UI page never see it.
- Electron hardening: sandboxed UI renderer with context isolation, `<webview>` preferences forced safe in `will-attach-webview`, IPC sender validation, page-initiated navigation to `file:` or other privileged schemes blocked, external app links (`mailto:`, `zoommtg:` …) ask first, WebUSB/HID/Serial denied, camera/mic/location/notifications prompt per site, and Electron fuses (no `RunAsNode`, no `NODE_OPTIONS`, ASAR integrity, cookie encryption).

Found a vulnerability? Please open a private security advisory on GitHub.

## Keyboard shortcuts

| | macOS | Windows / Linux |
|---|---|---|
| New tab / command bar | `⌘T` | `Ctrl+T` |
| Edit URL | `⌘L` | `Ctrl+L` |
| Close tab | `⌘W` | `Ctrl+W` |
| Reopen closed tab | `⇧⌘T` | `Ctrl+Shift+T` |
| Pin / unpin | `⌘D` | `Ctrl+D` |
| Toggle sidebar | `⌘S` | `Ctrl+S` |
| Ask Claude | `⌘J` | `Ctrl+J` |
| Split view / close | `⌃⇧=` / `⌃⇧-` | `Ctrl+Shift+=` / `Ctrl+Shift+-` |
| Spaces | `⌃1…9`, `⌘⌥←/→` | `Alt+1…9`, `Ctrl+Alt+←/→` |
| Tabs | `⌘1…9`, `⌃Tab` | `Ctrl+1…9`, `Ctrl+Tab` |
| Copy URL | `⇧⌘C` | `Ctrl+Shift+C` |
| New folder | `⇧⌘N` | `Ctrl+Shift+N` |
| Little window | `⌘⌥N` | `Ctrl+Alt+N` |

## Known limitations

- Logins don't transfer from Arc (cookies are encrypted with Arc's keychain key). Sign in once per profile.
- No built-in password manager or sync yet. Use your password manager's desktop app.
- Chrome extensions are experimental: background and content scripts load, but toolbar popups don't yet.
- No Boosts, Easels or Notes.

## Roadmap

Extension toolbar, a password manager integration, sync between devices, AI tab tidying (group Today into folders), Boosts-style site tweaks.

## License

MIT. Meridian is an independent project, not affiliated with or endorsed by The Browser Company. "Arc" is a trademark of its respective owner and is used here only to describe compatibility.
