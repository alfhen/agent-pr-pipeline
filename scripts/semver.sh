#!/bin/bash
# Version order, sourced by check-version.sh and plugin-version.sh. Run by itself it prints nothing.
semver='^([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.-]+)?$'

# a is higher than b: the core first, then a release beats its own pre-release, then the pre-release text
semver_higher() {
  [[ "$1" =~ $semver ]]; local ac=${BASH_REMATCH[1]} ap=${BASH_REMATCH[2]#-}
  [[ "$2" =~ $semver ]]; local bc=${BASH_REMATCH[1]} bp=${BASH_REMATCH[2]#-}
  if [ "$ac" != "$bc" ]; then [ "$(printf '%s\n%s\n' "$ac" "$bc" | sort -V | tail -1)" = "$ac" ]; return; fi
  [ "$ap" = "$bp" ] && return 1
  [ -z "$ap" ] && return 0
  [ -z "$bp" ] && return 1
  [ "$(printf '%s\n%s\n' "$ap" "$bp" | sort -V | tail -1)" = "$ap" ]
}
