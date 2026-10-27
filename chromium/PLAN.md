# Porting Meridian to Chromium: the plan

The goal is a clean, standard browser that is safe to use every day. Everything lives inside Chromium:
there is no Node.js, no helper process and no open debugging port. Google passwords, passkeys, sync,
extensions and the Web Store work as they do in Chrome, because this *is* Chromium.

We ship one release, once everything below is done and covered by tests.

## Principles

- **Use what Chromium already has before building our own.** Split view, link preview (Peek),
  incognito, profiles, password manager and passkeys, downloads, find in page, zoom, permissions,
  session restore, the trackpad history swipe and extensions all exist in Chromium. We theme them and
  wire them to the Meridian UI; we don't reimplement them.
- **UI in WebUI (TypeScript/Lit), logic in C++ services, a mojo interface between them.** C++ code
  goes in `chrome/browser/meridian/`, which is ours, so rebases don't conflict there. Edits to
  upstream files stay small hooks.
- **Every feature gets an E2E test** (chromium/tests, real input over CDP) before it counts as done.
  C++ services get unit tests where the logic is non-trivial.

## Map: Electron feature → Chromium implementation

### Browser shell
| Feature | Implementation |
|---|---|
| Sidebar, vertical tabs, page card | WebUI browser (`kWebium`) restyled ✅ |
| Name, icon, bundle id, About | `chrome/app/theme/meridian` branding + `is_chrome_branded=false` product strings |
| Spaces (colour, icon, gradient theme) | `MeridianSpacesService` (per profile, persisted in the profile dir). Tabs carry a space id; the UI shows the current space. Window tint from the space |
| Spaces with their own profile | One `Browser` window per Chromium profile, stacked in the same frame; switching to a space in another profile swaps the visible window (Arc's model on Chromium) |
| Pinned tabs + folders, home URL, `/` back to home | sidebar model in `MeridianSpacesService`; tab ↔ item link |
| Favorites grid (per profile) | same model, profile-wide |
| Today + auto-archive after N h, Archive view | `MeridianArchiveService` (SQLite in the profile dir), archive WebUI |
| Command bar ⌘T/⌘L | overlay in the WebUI: omnibox autocomplete (the webui searchbox already uses it) + open tabs across spaces + archive + commands |
| Split view | Chromium's native split tabs (`SplitTab` in TabStripService) |
| Peek | Chromium link preview (`kLinkPreview`), restyled; Expand → tab/split |
| Little window | `Browser::TYPE_POPUP` with a minimal WebUI frame + "Open in Meridian" |
| Air Traffic Control | hook in external-URL launch (`StartupBrowserCreator`), rules in prefs |
| Private window | incognito, Meridian-themed |
| Hide sidebar ⌘S, hover reveal, right side | WebUI + prefs |
| Drag & drop between favorites/pinned/folders/Today | WebUI, `MoveNode` / model ops |
| Two-finger swipe (Arc design) | Chromium's native mac overscroll navigation; arrow restyled to the Arc disc |
| Shortcuts (all, customizable) | Meridian accelerator table + prefs; Settings → Shortcuts |
| Downloads popover | Chromium download bubble, themed |
| Settings | `chrome://settings` + a Meridian section (WebUI) |
| Home / onboarding (personas, presets) | NTP replacement `chrome://meridian-home` |
| Ad & tracker blocking | Chromium `subresource_filter` with EasyList/EasyPrivacy rulesets (no extension) |
| Import from Arc (sidebar + cookies) | C++ importer: Arc's `StorableSidebar.json`; cookies re-encrypted from the Arc Safe Storage key (keychain prompt, warned beforehand) |
| Updates | in-app updater: GitHub release check, download, verify SHA256, swap the bundle, relaunch |

### AI and agents
| Feature | Implementation |
|---|---|
| MCP server (21 tools) | C++ in the browser process: JSON-RPC over a per-launch unix socket + bearer token (same security model); tools on TabStripModel / WebContents (isolated-world JS, synthetic input, `CopyFromSurface`). Stdio bridge = `Meridian --mcp-bridge` (the browser binary itself, no Node) |
| Access levels, confirm dialogs, agent glow, activity bar + Stop | C++ policy + WebUI dialogs |
| Ask panel ⌘J, chats, Ask in ⌘T, Tidy Today, link previews | WebUI side panel; `MeridianAiService` (SimpleURLLoader to the Anthropic/OpenAI-compatible APIs, Ollama/LM Studio local) |
| Keys (Claude + cloud providers), vault | `OSCrypt`-encrypted store in the profile |
| Local agents (12 CLI providers) | `base::LaunchProcess` with the login-shell env, same flags as now |
| Mission Control | unix-socket event listener (same protocol) + WebUI |
| Workbench (file tree, Monaco, terminals, plugins, user.css, snapshots, Safe Mode) | `chrome://workbench` WebUI (Monaco + xterm.js bundled); C++ pty service (`openpty`), file service |
| Sandboxes (Docker/OrbStack) | C++ launches `docker` with the same hardening flags |
| Hubs | C++ scaffold + pin to sidebar |

### Shipping
| | |
|---|---|
| macOS arm64 build, signed with "Meridian Signing" | local release build (Chromium is too big for free CI runners) |
| `.dmg`, `install.sh`, SHA256SUMS | packaging script in `chromium/` |
| Migration from Electron Meridian | first run imports spaces/pinned/favorites/archive/settings from `~/Library/Application Support/Meridian` |
| Windows / Linux | after macOS; needs bigger build machines |

## Order

1. Branding → spaces & sidebar model (pinned, folders, favorites, Today) → command bar → shortcuts.
2. Split, Peek, Little window, ATC, archive, private window, swipe, drag & drop, sidebar hide/right.
3. Settings section, home/onboarding, ad blocking, Arc import, Electron migration.
4. MCP server + access policy + glow/activity; Ask/AI service, keys, vault.
5. Local agents, Mission Control, Workbench, sandboxes, hubs.
6. Updater, packaging, signing, release.
