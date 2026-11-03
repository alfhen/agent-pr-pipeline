#!/bin/bash
# usage: [BASE_REF=origin/main] check-version.sh [manifest]
# Exit 0 when the manifest (default .claude-plugin/plugin.json) has a semantic version
# (MAJOR.MINOR.PATCH, optional pre-release). With BASE_REF set (a pull request), a version that differs
# from the one at BASE_REF must also be higher than the latest tag. Run it inside the git checkout.
manifest=${1:-.claude-plugin/plugin.json}
semver='^([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.-]+)?$'
fail() { echo "check-version: $*"; exit 1; }

version=$(jq -r '.version // ""' "$manifest" 2>/dev/null) || fail "cannot read $manifest"
[[ "$version" =~ $semver ]] || fail "$manifest has version '$version', which is not MAJOR.MINOR.PATCH"

# a is higher than b: the core first, then a release beats its own pre-release, then the pre-release text
higher() {
  [[ "$1" =~ $semver ]]; local ac=${BASH_REMATCH[1]} ap=${BASH_REMATCH[2]#-}
  [[ "$2" =~ $semver ]]; local bc=${BASH_REMATCH[1]} bp=${BASH_REMATCH[2]#-}
  if [ "$ac" != "$bc" ]; then [ "$(printf '%s\n%s\n' "$ac" "$bc" | sort -V | tail -1)" = "$ac" ]; return; fi
  [ "$ap" = "$bp" ] && return 1
  [ -z "$ap" ] && return 0
  [ -z "$bp" ] && return 1
  [ "$(printf '%s\n%s\n' "$ap" "$bp" | sort -V | tail -1)" = "$ap" ]
}

if [ -n "$BASE_REF" ]; then
  old=$(git show "$BASE_REF:$manifest" 2>/dev/null | jq -r '.version // ""' 2>/dev/null)
  if [ "$old" != "$version" ]; then
    latest=""
    for t in $(git tag --list 'v[0-9]*'); do
      [[ "${t#v}" =~ $semver ]] || continue
      if [ -z "$latest" ] || higher "${t#v}" "${latest#v}"; then latest=$t; fi
    done
    if [ -n "$latest" ] && ! higher "$version" "${latest#v}"; then
      fail "version $version is not higher than the latest tag $latest"
    fi
  fi
fi
echo "check-version: $version ok"
