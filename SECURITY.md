# Security

## Reporting a vulnerability

Please report it privately: **[Report a vulnerability](https://github.com/Undermove/meridian-browser/security/advisories/new)**
(GitHub's private advisories). Don't open a public issue. You'll get an answer within a few days;
a fix ships as a new release, which Meridian installs through its updater.

Bugs in Chromium itself go to Chromium: https://bugs.chromium.org/p/chromium/issues/entry?template=Security+Bug

## Supported versions

Only the latest release. Meridian 0.5 and later are built on Chromium (macOS, Apple silicon); 0.4.x
(Electron) no longer gets fixes.

## How Meridian stays current with Chrome

- Meridian is built on a Chromium **stable/beta branch** (the one Chrome ships), recorded in
  `chromium/CHROMIUM_VERSION`, not on Chromium's development trunk.
- A daily GitHub Action (`chromium-watch`) compares it with Google's releases and opens an issue as soon
  as a newer build of the branch (Chrome ships security fixes this way) or a newer stable branch is out;
  it's marked urgent after 14 days.
- `chromium/update_chromium.sh` moves to that Chromium, builds, runs every test, packages and drafts the
  release. With the self-hosted runner (`chromium-update`), this starts by itself.
- Target: a release within days of a Chrome security release.

## Releases and updates

- Every release is signed with the same certificate ("Meridian Signing"), with the hardened runtime and
  the same per-process entitlements as Chrome (JIT only for renderers and GPU).
- The in-app updater downloads only over HTTPS from GitHub releases. It trusts the release's
  `SHA256SUMS.txt` only with a valid `SHA256SUMS.txt.sig`: an Ed25519 signature by Meridian's release
  key, whose public half is built into Meridian (the private key is kept off the repo and off GitHub).
  It checks the zip against that checksum, refuses zip entries that are absolute or contain `..`,
  unpacks into a fresh private folder, and only installs an app whose code signature meets the running
  app's designated requirement (or a trusted Developer ID team, see below) and whose sealed
  `Contents/Resources/meridian-version` is the release's version and newer than the running one, so it
  never installs an older version. The signature is checked once more right before the swap. Its test
  switches only work for a profile in the temp folder.
- `install.sh` checks the same checksum and the signature.
- Every published release is installed on a clean Mac by a GitHub Action (`release-check`) and the whole
  end-to-end suite runs against it; on failure the release goes back to pre-release.

### Moving to an Apple Developer ID

Users' updaters only accept the certificate their copy was signed with. To move to a Developer ID
without stranding them:

1. Add the Team ID to `kTrustedTeams` in `chrome/browser/meridian/update_check.h` and ship a release
   still signed with "Meridian Signing".
2. From the next release on, sign with the Developer ID
   (`MERIDIAN_SIGN_ID="Developer ID Application: … (TEAMID)" MERIDIAN_NOTARY_PROFILE=… chromium/package.sh`),
   which also notarizes it and keeps library validation on.

## What Meridian adds to Chromium, and how it's guarded

- **MCP server for AI agents:** a per-launch unix socket in the profile, a random bearer token in a
  0600 file, access levels (read-only / ask / full) set by the user; uploading files and other sensitive
  tools always ask in a native dialog web pages can't answer. Agents only reach web pages (http, https,
  about:blank, the new tab page): never `chrome://` pages, Workbench or local files. In "ask" mode the
  Allow button takes no click for its first 600 ms.
- **Workbench:** terminals and Docker sandboxes run code by design; files stay inside the opened
  project; plugins run only after approval and only while their bytes match the approved SHA-256;
  Safe Mode turns all customizations off.
- **Secrets** (AI keys, the vault) are encrypted with the OS keychain key, never stored as plain text.
- **Arc import** reads Arc's cookies only after saying macOS will ask for the keychain.

Chromium's sandbox, site isolation, permission and certificate checks are unchanged; the patches in
`chromium/patches/` are UI and Meridian's own services.

## Known limitations

- **Safe Browsing** (warnings about phishing, malware and unwanted-software sites) is in releases from
  0.5.2. It checks against Google's lists kept on your Mac and refreshed every half hour or so; Chrome's
  extra real-time checks of new sites answer only Chrome's own key. It needs a Google API key built in:
  a build made without `~/.config/meridian/google_api_keys` (`google_api_key = "…"`, a key limited to the
  Safe Browsing API) has no such warnings, only the download warnings Chromium gives without it.
- **Not notarized** while releases are signed with the self-signed "Meridian Signing" certificate: macOS
  asks to allow the first launch (System Settings → Privacy & Security → Open Anyway).
- **Any program running as you can use the MCP server:** the token file is readable by your user, so a
  program running under your account can connect as an agent with the access level you set. Use "ask"
  or "off" unless you need "full". Planned: approving each new agent app on its first connection.
