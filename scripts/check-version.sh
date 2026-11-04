#!/bin/bash
# usage: [BASE_REF=origin/main] check-version.sh [manifest]
# Exit 0 when the manifest (default .claude-plugin/plugin.json) has a semantic version
# (MAJOR.MINOR.PATCH, optional pre-release). With BASE_REF set (a pull request), a version that differs
# from the one at BASE_REF must also be higher than the latest tag. Run it inside the git checkout.
manifest=${1:-.claude-plugin/plugin.json}
source "$(dirname "$0")/semver.sh"
fail() { echo "check-version: $*"; exit 1; }

version=$(jq -r '.version // ""' "$manifest" 2>/dev/null) || fail "cannot read $manifest"
[[ "$version" =~ $semver ]] || fail "$manifest has version '$version', which is not MAJOR.MINOR.PATCH"

if [ -n "$BASE_REF" ]; then
  old=$(git show "$BASE_REF:$manifest" 2>/dev/null | jq -r '.version // ""' 2>/dev/null)
  if [ "$old" != "$version" ]; then
    latest=""
    for t in $(git tag --list 'v[0-9]*'); do
      [[ "${t#v}" =~ $semver ]] || continue
      if [ -z "$latest" ] || semver_higher "${t#v}" "${latest#v}"; then latest=$t; fi
    done
    if [ -n "$latest" ] && ! semver_higher "$version" "${latest#v}"; then
      fail "version $version is not higher than the latest tag $latest"
    fi
  fi
fi
echo "check-version: $version ok"
