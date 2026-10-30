# Meridian: how to work here without breaking things

Meridian is meant to be indistinguishable from Arc. Most bugs the user finds sit on a boundary:
macOS/AppKit ↔ the browser process (C++) ↔ the WebUI page (Lit) ↔ the tab pages embedded in it.
Examples: keyboard focus, key routing, sessions, profiles, windows. A test that calls a handler
from JS (`b.eval('handler_.foo()')`) skips every one of those boundaries, so it passes while the
feature is broken. Most of the rules below follow from that.

## 1. A bug report becomes a failing test first
- Reproduce it before touching code, with the user's own steps: the same keys, the same starting
  state (see §3).
- Videos: copy the file into the scratchpad. Make frame sheets with
  `ffmpeg -i x.mov -vf "fps=2,crop=…,scale=700:-1,tile=4x5" sheet.png` and zoom into the
  interesting part. Compare our video with Arc's frame by frame, then write Arc's behaviour down
  as assertions: what is selected, in what order, what a key does.
- The new test must **fail on the installed build**. Run it with
  `MERIDIAN_APP=/Applications/Meridian.app/Contents/MacOS/Meridian` (temp profile, so it is
  safe). If it passes there, it isn't testing the bug.

## 2. Drive it like a person
- Keys: `handler_.testKeyPress(keyCode, chars, modifiers)` sends a real NSEvent through AppKit,
  the menus and the focused page (needs `--meridian-test-keys`). CDP `Input.insertText` and
  `dispatchKeyEvent` bypass native focus, so they don't count for keyboard features.
- Mouse: `b.click()` (a CDP mouse event at the element's centre).
- Menu-only shortcuts don't reach a background test window: use `handler_.testCommand(IDC_…)`.
- Links from other apps: `tests/tools/open_url.swift` sends a GetURL Apple event to the test
  browser's pid. **Never** use `open -a`: it picks by bundle id, and the user's Meridian gets the
  link.
- Assert on structured state, not pixels. Dump focus chains, the selected row and the visible
  rows (`command_bar_keys.test.mjs` `state()` does this). Use window truth from
  `handler_.testWindowState()`.

## 3. The starting-state matrix
Before calling a UI feature done, run it from each of these starting states:
- focus in the **page** vs in the sidebar/UI (⌘T from a focused page is the common case);
- the active tab **loading** vs loaded (Esc means Stop while loading);
- input **empty** vs typed, with real history and several tabs;
- a space of the **main** profile vs **another** profile;
- **windowed** vs macOS **full screen**;
- the **second** time (reopen after Enter, after Esc, after a tab switch);
- **after a restart** (session restore), for anything stored.

## 4. Root cause, not patches
- Look at the real state before changing code: the first responder, the focused WebContents, the
  session file contents. A temporary `LOG(ERROR) << "MERIDIAN_DEBUG …"` read with
  `MERIDIAN_LOG=<file>` is fine; remove it afterwards.
- If a second fix for the same symptom fails, stop. Find the architectural reason. The profile
  window swapping took about 8 hours of patches before being replaced by the Arc model in one go.
- Read Chromium's TODOs near the bug. The ⌘T focus bug was crbug.com/508638062 in
  `surface_embed_host.cc`.

## 5. A flaky test is a bug until proven otherwise
- Run every new test 5–8 times before committing.
- Wait for a settled state (the same value for ~500 ms, or an explicit condition), never fixed
  sleeps.
- Flakiness has found real bugs here: suggestions kept arriving during arrow presses because
  autocomplete wasn't stopped.

## 6. Before saying "done"
1. Run `chromium/tests/run.sh`. All green; anything red is explained (re-run alone, check it
   against the installed build).
2. `chromium/package.sh`, then run the touched tests against the **packaged** app.
3. Install only when the user asks.
   - Quit Meridian gracefully.
   - Back up the app **and the profile** to `~/Library/Application Support/Meridian Backups/`.
   - Warn about the keychain prompt **before** the first launch of a new build: ad-hoc signing
     means every build asks once.

## 7. Never touch the user's system state from tests
Keep these intact:
- the keyboard layout (`--meridian-keep-keyboard-layout`);
- the clipboard (`run.sh` restores it);
- the user's running Meridian (§2);
- the real Arc data (fixtures only).

## Map
- **Chromium:** `~/repos/chromium/src`, branch `meridian`.
  - Logic: `chrome/browser/meridian/`.
  - UI: `chrome/browser/resources/webui_browser/`.
  - After committing, run `chromium/export.sh` here.
- **Profiles per space:** `chrome/browser/meridian/space_profiles.h` (one window holds every
  profile's tabs).
- **Tests:** `chromium/tests/*.test.mjs` (node + CDP, `harness.mjs`). Build with
  `chromium/build.sh`.
