#!/bin/bash
# Writes the weekly security digest into one pinned issue ("Security digest"), updated in place:
# open Dependabot, code scanning and secret scanning alerts, Dependabot PRs waiting for a person,
# and the open Chromium update issue. Needs GH_TOKEN (issues: write) and, for the alerts,
# ALERTS_TOKEN (or GH_TOKEN) that may read them. Usage: security-digest.sh [--dry-run]
# shellcheck disable=SC2016 # the single-quoted strings are jq programs
set -euo pipefail
repo="${GITHUB_REPOSITORY:-Undermove/meridian-browser}"
alerts_token="${ALERTS_TOKEN:-${GH_TOKEN:-}}"
title="Security digest"
url="https://github.com/$repo"

# alerts <api path> <jq summary> -> the summary, or a note if this token can't read them.
alerts() {
  local out
  if out="$(GH_TOKEN="$alerts_token" gh api --paginate "repos/$repo/$1?state=open&per_page=100" 2>/dev/null | jq -s 'add // []')"; then
    jq -r "$2" <<<"$out"
  else
    echo "_Not readable with this token. Add a SECURITY_DIGEST_TOKEN secret (fine-grained, read-only: Dependabot alerts, code scanning alerts, secret scanning alerts)._"
  fi
}

dependabot="$(alerts dependabot/alerts '
  if length == 0 then "None." else
  "\(length) open: " + (group_by(.security_advisory.severity) | map("\(.[0].security_advisory.severity) \(length)") | join(", ")) + "\n\n" +
  (sort_by({"critical":0,"high":1,"medium":2,"low":3}[.security_advisory.severity] // 4) | map("- [\(.dependency.package.name)](\(.html_url)) \(.security_advisory.severity), `\(.dependency.manifest_path)`, fixed in \(.security_vulnerability.first_patched_version.identifier // "no release yet")") | join("\n"))
  end')"
codescanning="$(alerts code-scanning/alerts '
  if length == 0 then "None." else
  "\(length) open: " + (group_by(.tool.name) | map("\(.[0].tool.name) \(length)") | join(", ")) + "\n\n" +
  (group_by(.tool.name + " " + .rule.id) | sort_by(-length) | .[:15] | map("- \(.[0].tool.name) `\(.[0].rule.id)` (\(.[0].rule.security_severity_level // .[0].rule.severity)): \(length), e.g. [\(.[0].most_recent_instance.location.path)](\(.[0].html_url))") | join("\n"))
  end')"
secrets="$(alerts secret-scanning/alerts '
  if length == 0 then "None." else
  "\(length) open:\n\n" + (map("- [\(.secret_type_display_name)](\(.html_url))") | join("\n"))
  end')"
prs="$(gh pr list -R "$repo" --author 'app/dependabot' --state open --json number,title,labels,url,createdAt \
  | jq -r 'if length == 0 then "None." else map("- [#\(.number)](\(.url)) \(.title)" + (if any(.labels[]; .name == "needs-review") then " **(needs review: major)**" else " (auto-merge once CI passes)" end) + ", opened \(.createdAt[:10])") | join("\n") end')"
chromium="$(gh issue list -R "$repo" --label chromium-update --state open --json number,title,url \
  | jq -r 'if length == 0 then "Up to date with Chrome stable." else map("- [#\(.number)](\(.url)) \(.title)") | join("\n") end')"

body="Updated $(date -u '+%Y-%m-%d %H:%M UTC') by the [Security digest workflow]($url/actions/workflows/security-digest.yml). It runs weekly; edits here are overwritten.

## Chromium
$chromium

## Dependabot PRs
$prs

## Dependabot alerts ([all]($url/security/dependabot))
$dependabot

## Code scanning alerts ([all]($url/security/code-scanning))
$codescanning

## Secret scanning alerts ([all]($url/security/secret-scanning))
$secrets"

if [ "${1:-}" = --dry-run ]; then printf '%s\n' "$body"; exit 0; fi

gh label create security --color b60205 --description "Security fix or advisory" -R "$repo" 2>/dev/null || true
n="$(gh issue list -R "$repo" --state open --label security --search "in:title \"$title\"" --json number,title \
  | jq -r --arg t "$title" '.[] | select(.title == $t) | .number' | head -1)"
if [ -n "$n" ]; then
  gh issue edit "$n" -R "$repo" --body "$body" >/dev/null
  echo "Updated #$n"
else
  n="$(gh issue create -R "$repo" --title "$title" --label security --body "$body" | grep -oE '[0-9]+$')"
  echo "Created #$n"
fi
gh issue pin "$n" -R "$repo" 2>/dev/null || true
