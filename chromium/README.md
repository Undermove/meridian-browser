# Meridian on Chromium

Meridian as a real Chromium build instead of Electron. Google sign-in, passkeys and the full
extension API work, because to every site it *is* Chromium.

The browser window's UI is a web page, `chrome://webui-browser`. That is Chromium's own
experimental WebUI browser (the `Webium` feature), which Meridian turns on by default and restyles.
Tabs come from Chromium's `TabStripService` mojo API, and each tab's page is a guest attached to the UI.
So the Meridian UI stays HTML/CSS/TypeScript, much like the Electron renderer, and runs the same
way on macOS, Windows and Linux.

## Layout

| Path | What |
|---|---|
| `CHROMIUM_REVISION` | the Chromium commit the patches apply to |
| `patches/` | Meridian's changes to Chromium, one commit per patch |
| `args.gn` | build settings (lean release build) |
| `setup.sh` | one time: fetch Chromium (~32 GB), apply the patches, generate `out/Release` |
| `apply.sh` | re-apply the patches onto a fresh `meridian` branch in Chromium's `src` |
| `build.sh` | incremental build, a few minutes; first build ~2.5 h on an M4 |
| `export.sh` | write the commits on the `meridian` branch back into `patches/` |
| `package.sh`, `package_win.sh` | release packaging: the signed app on macOS, the installer on Windows |
| `RELEASE_CHECKLIST.md`, `tools/quality_gate.sh` | the gate before a release: the newcomer journey on each "real computer", the isolation guard, Mac-only words, crash reports |

Chromium lives outside this repo, by default in `~/repos/chromium` (set `CHROMIUM_DIR` to move it).
Plan for about 60 GB free: about 32 GB of source, about 9 GB of build, and Xcode.

## Working on it

```sh
chromium/setup.sh          # once
chromium/build.sh
open ~/repos/chromium/src/out/Release/Meridian.app
```

Edit files in `~/repos/chromium/src` (the Meridian UI is in `chrome/browser/resources/webui_browser/`),
commit on the `meridian` branch, run `build.sh`, then `export.sh` and commit `patches/` here.

## On Linux and Windows

The same scripts run in a Linux shell and in Git Bash on Windows (`tools/platform.sh` holds what
differs). The build is `out/Release/chrome` or `chrome.exe`, with Meridian's own files (ad blocking
rules, the Workbench page) next to it.

- **Linux** (checked on Ubuntu 24.04): `setup.sh` also installs Chromium's build dependencies and
  asks for `sudo` once. The E2E tests need Node 22 and a display (`xvfb-run -a chromium/tests/run.sh`).
- **Windows** (checked on Windows 11): Visual Studio 2026 Build Tools with the C++ workload and the
  Windows 11 SDK 10.0.28000, Git for Windows, and `depot_tools` on `PATH` with
  `DEPOT_TOOLS_WIN_TOOLCHAIN=0`. If Visual Studio is under `Program Files (x86)`, point
  `vs2026_install` at it. Fetching Chromium there was done with `gclient sync` directly; `apply.sh`,
  `build.sh` and the tools run from Git Bash. Keep `python3` from `depot_tools` ahead of the
  Microsoft Store's stub.

Meridian's C++ is one code base: where it leans on POSIX (the Workbench's symlink-safe file access,
unix sockets to the agents' hooks, ptys, process groups), Windows gets the same promises over Win32
in `chrome/browser/meridian/win/` and the `*_win.cc` files.

Not there yet outside macOS:

- code signing on Windows (SmartScreen warns on the first run of the installer). Windows has an
  installer and the in-app updater: `package_win.sh` makes `Meridian-<version>-win-<arch>-setup.exe`
  and `SHA256SUMS-win.txt`; upload them to the release, then sign the checksums on the Mac, where
  the release key stays in the Keychain (`tools/sign_win_sums.sh <tag> <installer sha256>`).
  A release only reaches installed Meridians when it is published as a full release, not a
  pre-release. Linux has neither an installer nor an updater (Settings shows the version);
- Ask with an agent CLI (Codex, Cursor…): it only runs inside a sandbox that keeps it away from
  credentials, and that sandbox is macOS's `sandbox-exec`;
- Import from Arc works on Windows (spaces, pins, folders, favorites, Today, sign-ins, passwords,
  cards, icons; Arc has to be closed for the sign-ins), except Arc's extensions, which don't come
  over there yet. There is no Arc for Linux;
- on Linux the build still carries FFmpeg's H.264 and AAC decoders (macOS and Windows decode with
  the system's): to be settled before a Linux release;
- on Windows, a CLI that npm installed as a `.cmd` wrapper isn't found (only `.exe` programs are
  started), and tests that need a symlink to a file skip that part without Developer Mode.

## Status

- [x] Stock Chromium build; Google sign-in passes
- [x] WebUI browser on by default, sidebar layout: address field, vertical tabs, page as a card
- [x] Meridian name, icon, bundle id, keychain item, strings in 81 languages
- [x] Spaces, pinned tabs, folders, favorites, Today (C++ SidebarService + sidebar UI), survive restart
- [x] Command bar (⌘T / ⌘L / New Tab / URL pill) on the omnibox
- [x] Keyboard: tabs and spaces through the sidebar order, ⌘D pin, ⌘S hide sidebar (edge reveal, traffic lights hide), Spaces menu
- [x] Drag and drop in the sidebar (pin, reorder, folders, favorites, Today, other spaces)
- [x] Split view (Chromium split tabs), Peek, archive (auto-archive + ⌥⌘A + Clear Today)
- [x] Restore last session by default, loading indicators, link status bubble
- [x] Little window for links from other apps (Open in Meridian)
- [x] Air Traffic Control (rules; editor comes with Settings)
- [x] Import from Arc: spaces, pins, folders, favorites, open tabs (lazy), sign-ins (cookies)
- [x] Welcome tour (Arc move-in or a setup from the installed apps, default browser), Help > Welcome Tour
- [x] Settings (⌘,): theme, sidebar left/right, mode, archive time, default browser, Air Traffic Control editor, links to Chromium settings
- [x] Edit Space Theme, private window theme
- [x] Home page (new tab): search, feature cards, "Set up for me" presets, tips
- [x] Ad and tracker blocking: EasyList + EasyPrivacy through Chromium's subresource filter on every site (tools/adblock.sh), toggle in Settings, per-site exceptions in Site settings
- [ ] Swipe (Arc disc; needs a check on a real trackpad)
- [x] MCP server in C++ (`Meridian --mcp-bridge`, 20 browser tools, off/read/ask/full, JS opt-in, activity bar + Stop, Connect Claude Code/Codex)
- [x] AI: Claude API key (encrypted), Ask panel ⌘J with page context and browser tools, quick answers in ⌘T
- [x] Other AIs for Ask: Ollama, LM Studio, API keys (OpenAI, Gemini, OpenRouter, xAI, Mistral, DeepSeek, Groq) with a model picker, and agent CLIs (Codex, Copilot, Cursor, OpenCode, Qwen Code, Amp, Goose, Droid) behind "Other agents"
- [x] Tidy Today, link previews (⇧ over a link), Chat view (⌥⌘J) with saved chats
- [x] Workbench (⇧⌘E, chrome://workbench): project files, Monaco, terminals on a pty, coding agents with Meridian's browser tools
- [x] Mission Control (⇧⌘M): Workbench agent sessions and subagents (hooks via `Meridian --mission-hook`, no Node needed), MCP clients, ⌘J runs; redacted summaries, history, notifications
- [ ] Workbench Pro (vault, secret guard, sandboxes, customizations, hubs)
- [ ] Updater, packaging, signing
- [x] Windows and Linux builds: build, start, C++ unit tests pass (what is missing: "On Linux and Windows" above)
