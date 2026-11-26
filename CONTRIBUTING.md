# Contributing

`main` is the only long-lived branch. Everything ships from it: the browser (`chromium/`), the
Workbench and MCP sources (`src/`, `mcp/`), tests and the website (`site/`, `docs/`).

## Changes

1. Branch from `main` (`feat/…`, `fix/…`, `site/…`).
2. Open a pull request to `main`.
3. Wait for the checks (CI, Chromium checks, code scanning) to pass.
4. Merge. Delete the feature branch.

No other long-lived branches. A branch that lives longer than its pull request gets merged or closed.

## Releases

1. Bump the version on `main` (`kVersion` in `chrome/browser/meridian/update_check.h`, through the
   patches; `chromium/update_chromium.sh` does it), in a pull request like any other change.
2. Tag `main`'s commit: `vX.Y.Z`.
3. Package and publish the release from that tag (`chromium/package.sh`, `chromium/package_win.sh`).
   `release-check` and `release-attest` run on publish.

## Hotfixes

1. Branch from the release tag: `git switch -c fix/… vX.Y.Z`.
2. Fix it, open a pull request to `main`, merge when green.
3. Release the next patch version from `main` as above.

## Security

- Dependabot alerts and code scanning findings are reviewed weekly: fixed, or dismissed with a written
  reason.
- Dependabot security pull requests are merged as soon as their checks are green.
- Version updates (npm, GitHub Actions, Docker) come weekly from `.github/dependabot.yml`, grouped.
- Reporting a vulnerability: see [SECURITY.md](SECURITY.md).
