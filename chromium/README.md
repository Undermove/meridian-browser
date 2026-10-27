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

Chromium lives outside this repo, by default in `~/repos/chromium` (set `CHROMIUM_DIR` to move it).
Plan for about 60 GB free: about 32 GB of source, about 9 GB of build, and Xcode.

## Working on it

```sh
chromium/setup.sh          # once
chromium/build.sh
open ~/repos/chromium/src/out/Release/Chromium.app
```

Edit files in `~/repos/chromium/src` (the Meridian UI is in `chrome/browser/resources/webui_browser/`),
commit on the `meridian` branch, run `build.sh`, then `export.sh` and commit `patches/` here.

## Status

- [x] Stock Chromium build; Google sign-in passes
- [x] WebUI browser on by default, sidebar layout: address field, vertical tabs, page as a card
- [x] Meridian name, icon, bundle id, keychain item, strings in 81 languages
- [x] Spaces, pinned tabs, folders, favorites, Today (C++ SidebarService + sidebar UI), survive restart
- [ ] Spaces, pinned tabs, command bar, split view, Mission Control, MCP, vault: port from `src/renderer`
- [ ] Tab drag reordering in the vertical list (the stock drag delegate is horizontal)
- [ ] Windows and Linux builds
