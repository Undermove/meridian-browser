# Release checklist: the quality gate

On 26.11 people met bugs the E2E suite never saw, because it ran in a sterile world: one stand-in
CLI, a clean HOME. Crashes after the move to Chromium 159; a tour that said Claude was connected
when nothing worked; "Not signed in" because an old `/usr/local/bin/claude` came first on the PATH;
an empty Resume once a space used another Claude account; the Mac's Keychain card on Windows; and a
test that wrote into the owner's real `~/.claude-personal/.claude.json`. A release goes out only
when every box below is ticked, on the build that ships.

`chromium/tools/quality_gate.sh [<log dir>]` runs 1–5 in order (`MERIDIAN_APP=<binary>` for the
packaged app). Run it when no build or other test run is going on (`pgrep -f autoninja`,
`pgrep -f 'node --test'`): the suite takes one browser at a time.

## The gate

1. **Mac-only words** — `node chromium/tools/lint_platform_words.mjs`: no Keychain, "your Mac",
   ⌘, Finder, "Applications folder", System Settings… in shared UI that isn't behind a Mac check.
   Fix it (`isMac`, `BUILDFLAG(IS_MAC)`, `keyText()`), or, when a person has checked that Windows
   never shows it, add it to `chromium/tools/platform_words_allow.txt` with the reason.
2. **The newcomer journey on every real computer** — `chromium/tests/run.sh journey`
   (`journey.test.mjs`). Each machine of `tests/machines.mjs` goes through first run → moving in
   from Arc → Yes to the AI → the end of the tour → Improve with AI → ⌘J Ask → the Workbench's
   Claude tab → Resume → Settings › AI, checked against what is true on that machine:
   - `native-and-old-on-path`: the current `~/.local/bin/claude`, never the old `/usr/local/bin` copy;
   - `npm-global`: npm's shims (on Windows `claude.cmd`, no .exe);
   - `editor-extension-only`: VS Code + the Codex/Copilot extensions, no CLI;
   - `claude-desktop-with-servers`, `claude-desktop-fresh`: its own servers kept, never "connected"
     before Claude Desktop starts Meridian;
   - `claude-code-signed-out`: signed in right in the tour;
   - `two-claude-accounts`: `CLAUDE_CONFIG_DIR=~/.claude-personal` and `~/.claude`, sessions in each;
   - `run-from-disk-image` (macOS): nothing connected to a path on the disk image;
   - `codex-only`: `CODEX_HOME` respected.
   **On the Mac, and on Windows by the Windows session** (`chromium/tests/run.sh journey` there;
   the npm machine is where `.cmd`-only installs show up). `todo` lines name the branch whose
   feature they wait for (`PENDING` at the top of `journey.test.mjs`): take the line out when that
   branch is merged, so they count.
3. **Onboarding alone** — `node --test onboarding.test.mjs onboard_claude.test.mjs
   platform_words.test.mjs` on its own, not only inside the full run (a leftover state from an
   earlier file must not be what makes it pass).
4. **The full suite in two halves** — the sorted test files, first half then second half, each
   its own `node --test` run (a half that hangs doesn't take the other down; a file that only
   passes after another one shows up). All green, or every red one explained: re-run alone, and
   checked against the installed build.
5. **The isolation guard is green** — every test file hashes the owner's real AI configs before
   and after (`tests/isolation.mjs`: `~/.claude.json`, `~/.claude-personal/.claude.json`,
   `~/.codex/config.toml`, Claude Desktop's `claude_desktop_config.json`, VS Code's user `mcp.json`,
   `~/.copilot/mcp-config.json`). Any `ISOLATION GUARD` failure stops the release until the leak is
   found. It also takes the owner's login environment (CLAUDE_*, CODEX_HOME, tokens, the PATH
   folders with his real AI CLIs) out of everything a test starts. Never set `MERIDIAN_GUARD_OFF`
   for a release run.
6. **Crash reports of the test build** — `node chromium/tools/test_crashes.mjs --since <start>`:
   macOS's reports in `~/Library/Logs/DiagnosticReports` of a Meridian that ran from a build folder
   (`out/Release`, shown as `/Users/USER/…`) or a test profile. A suite can be green while a
   renderer or the browser crashed behind it. Each crash is either fixed or filed with the test
   that ran then. On Windows: `%LOCALAPPDATA%\CrashDumps`.

## A new Chromium

`chromium/update_chromium.sh` (by hand, or the "Chromium update" workflow) moves to the new
Chromium, builds, runs the tests and packages, then commits on a new branch
`chromium-<Chromium version>`, pushes it and opens a pull request to `main`. It never pushes to
`main` and never drafts a release. The gate above runs on that branch's build; the release is made
from `main` after the PR is reviewed and merged.

## Then, as before (chromium/README.md, CLAUDE.md §6)

- `chromium/package.sh` (`package_win.sh`), and the touched tests plus `journey.test.mjs` against
  the packaged app (`MERIDIAN_APP=…`).
- Install only when the owner asks; back up the app and the profile first.
