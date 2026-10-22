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
- **Air Traffic Control** (Settings → Links): route links from other apps by domain or URL pattern to a chosen space, or to the Little window.
- **Private windows** (`⇧⌘N`): an in-memory profile; no history, cookies or site data survive closing the window.
- **Archive** view (`⌥⌘A`) to browse, search and restore archived tabs; a downloads popover; a space theme editor with gradients and icons.
- Hide the sidebar (`⌘S`) and reveal it by hovering the window edge. Sidebar can sit on the right.
- Drag and drop tabs between favorites, pinned, folders and Today.
- **Import from Arc**: spaces, colours, icons, pinned tabs, folders, favorites and Today tabs, read locally from Arc's sidebar file on macOS and Windows.

**AI-centric**
- **Ask Claude** panel (`⌘J`): summarize, ask about the current page, or let Claude act in the browser (open tabs, read pages, click, type).
- **MCP server** with 21 browser tools: `list_spaces`, `list_tabs`, `search_tabs`, `search_history`, `read_page`, `get_interactive_elements`, `screenshot`, `open_tab`, `navigate`, `history_nav`, `activate_tab`, `close_tab`, `click`, `type_text`, `press_key`, `scroll`, `wait_for`, `organize_tab`, `split_view`, `create_space`, and opt-in `run_javascript`.
- Tabs an agent is working in glow. An activity bar shows what it did and has a **Stop** button.
- **Mission Control** (`⇧⌘M`): a live tree of every agent working with Meridian: Claude Code and Codex sessions started from the Workbench (locally or in a Docker sandbox) with their subagents and nested subagents, MCP clients driving the browser, and ⌘J chats. Status (thinking / running a tool / waiting for you / done), the current tool with a redacted summary, elapsed time, tool calls, project. Click to jump to the agent's terminal or tab. A notification and a sidebar badge when an agent waits for you; "N agents working" in the sidebar and the Workbench.
- **Tidy Today**: Claude proposes folders and shorter titles for your Today tabs; you review a diff and apply what you want. **Ask Claude** straight from the command bar. **Link previews**: hold `⇧` over a link for a short summary of the page (opt-in, Settings → AI).

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

1. In Meridian open **Settings → AI** (or the welcome tour) and pick an agent access level.
2. Click **Connect** next to Claude Code or Codex: Meridian shows the exact command and runs it after you confirm. Or run it yourself, e.g.

   ```bash
   claude mcp add -s user meridian -- node /path/to/meridian-browser/mcp/meridian-mcp.js
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

- Running JavaScript in pages is a **separate opt-in**, off by default. In "ask" mode the dialog shows the full code (code too long to review is refused), and `type_text` shows the full text, including whether it will submit.
- Click confirmations show the element's visible text next to its page-supplied label, its link and its form target. After you approve, the element is checked again so it can't move or be covered while the dialog is open. Dialogs default to **Deny**.
- The assistant's preset buttons (Summarize, …) never get browser tools, and "use browser" is off until you turn it on for a chat.
- MCP clients connect over a **unix socket** (named pipe on Windows) with a random name and a random **bearer token**, both new on every start, advertised only after the socket is bound, in a `chmod 600` file. The bridge checks that the socket is owned by the current user. There's no TCP port, so websites can't reach it, and requests carrying an `Origin` header are rejected.
- Page text given to models is wrapped as **untrusted content**, with any attempt to close the wrapper tags neutralized, and is read in an isolated world so pages can't fake it. Models are told never to follow instructions found in pages.
- Agent page scripts run in an **isolated JS world**, so pages can't tamper with them. Agents can only open `http(s)` URLs.
- **Mission Control** gets agent events over a private local channel: a unix socket in a `0700` temp dir (a random named pipe on Windows), a per-session random token in the agent's environment, size- and rate-limited JSON lines, nothing sent back. Claude Code hooks are added to the session's own `--settings` file as async hooks (they never block the agent) next to the secret guard; Codex gets a per-session `notify` override. Hooks send only short summaries (file names, command heads, hosts), which Meridian redacts again (tokens, `KEY=value`, URL credentials, vault values). Prompts, tool inputs and outputs are never sent; the persisted history holds only labels, times and counts.
- The Claude API key is **encrypted with the OS keychain** (safeStorage) and only used in the main process. Web content and the UI page never see it.
- Electron hardening: sandboxed UI renderer with context isolation, `<webview>` preferences forced safe in `will-attach-webview`, IPC sender validation, page-initiated navigation to `file:` or other privileged schemes blocked, server redirects to such schemes blocked, external app links (`mailto:`, `zoommtg:` …) allowlisted and confirmed every time, executable and HTML downloads and download bursts need confirmation, WebUSB/HID/Serial and Bluetooth pickers denied, client certificates chosen by you, camera and mic as separate per-site prompts (resettable in Settings), favicons fetched through the site's profile and shown as `data:` URLs, dev/test hooks disabled in packaged builds, and Electron fuses (no `RunAsNode`, no `NODE_OPTIONS`, no inspector flags, ASAR integrity, cookie encryption, no extra `file://` privileges).

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
| Mission Control | `⇧⌘M` | `Ctrl+Shift+M` |
| Split view / close | `⌃⇧=` / `⌃⇧-` | `Ctrl+Shift+=` / `Ctrl+Shift+-` |
| Spaces | `⌃1…9`, `⌘⌥←/→` | `Alt+1…9`, `Ctrl+Alt+←/→` |
| Tabs | `⌘1…9`, `⌃Tab` | `Ctrl+1…9`, `Ctrl+Tab` |
| Copy URL | `⇧⌘C` | `Ctrl+Shift+C` |
| New folder | `⌥⇧⌘N` | `Ctrl+Alt+Shift+N` |
| Little window | `⌘⌥N` | `Ctrl+Alt+N` |
| Private window | `⇧⌘N` | `Ctrl+Shift+N` |
| Archive / Downloads | `⌥⌘A` / `⇧⌘J` | `Ctrl+Alt+A` / `Ctrl+Shift+J` |
| Settings / all shortcuts | `⌘,` / `⌘/` | `Ctrl+,` / `Ctrl+/` |

Every shortcut can be changed in **Settings → Shortcuts**.

## Known limitations

- Logins don't transfer from Arc (cookies are encrypted with Arc's keychain key). Sign in once per profile.
- No built-in password manager or sync yet. Use your password manager's desktop app.
- Chrome extensions are experimental: background and content scripts load, but toolbar popups don't yet.
- No Boosts, Easels or Notes.

## Roadmap

Extension toolbar, a password manager integration, sync between devices, Boosts-style site tweaks.

## License

MIT. Meridian is an independent project, not affiliated with or endorsed by The Browser Company. "Arc" is a trademark of its respective owner and is used here only to describe compatibility.
