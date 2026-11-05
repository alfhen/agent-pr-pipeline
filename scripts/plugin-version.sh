#!/bin/bash
# usage: plugin-version.sh <running version>
# Compares the running workflow's version and the version in this plugin folder with the latest release of
# the plugin repo. Prints one WARN line for each that is older, or OK. Exit 3 (CHECK FAILED) when it cannot
# tell. It only reads: it never installs or updates anything.
here=$(cd "$(dirname "$0")" && pwd)
source "$here/semver.sh"
running=$1
[ -n "$running" ] || { echo "usage: plugin-version.sh <running version>"; exit 2; }
failed() { echo "CHECK FAILED $*"; exit 3; }

manifest="$here/../.claude-plugin/plugin.json"
root=$(jq -r '.version // ""' "$manifest" 2>/dev/null) || failed "cannot read $manifest"
repo=$(bash "$here/plugin-repo.sh" 2>/dev/null) || repo=""
[[ "$root" =~ $semver ]] || failed "$manifest has version '$root'"
[ -n "$repo" ] || failed "$manifest has no usable repository"
what="the latest release"
if ! tag=$(gh api "repos/$repo/releases/latest" --jq .tag_name 2>&1); then
  # The cloud proxy refuses this read for a repo that is not attached; main is the latest release or one ahead.
  [[ "$tag" == *"is not enabled for this session"* ]] || failed "cannot read the latest release of $repo ($tag)"
  tag=$(curl -fsSL "https://raw.githubusercontent.com/$repo/main/.claude-plugin/plugin.json" 2>/dev/null | jq -r '.version // ""' 2>/dev/null)
  [ -n "$tag" ] || failed "cannot read the version on main of $repo"
  what="the latest version on main"
fi
latest=${tag#v}
[[ "$latest" =~ $semver ]] || failed "the latest release tag '$tag' is not a version"

warns=0
check() {
  [[ "$1" =~ $semver ]] || failed "version '$1' is not a version"
  if semver_higher "$latest" "$1"; then
    echo "WARN plugin $1 ($2) is older than $what $tag: run claude plugin update agent-pr-pipeline@agent-pr-pipeline, then /reload-plugins"
    warns=1
  fi
}
check "$running" running
check "$root" pluginRoot
[ "$warns" = 1 ] || echo OK
