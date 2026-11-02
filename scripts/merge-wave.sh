#!/bin/bash
# usage: merge-wave.sh [--person] <owner/repo> <pr>:<checked sha>[:auto] [<pr>:<checked sha>[:auto] ...]
# Merges PRs in order with merge-pr.sh, without waiting for CI, and stops at the first one that is not
# cleanly mergeable. The :auto suffix becomes --auto; --person is passed through.
# Use land-wave.sh when CI may still be running.
person=""
[ "$1" = "--person" ] && { person=--person; shift; }
R=$1; shift
[ -n "$1" ] || { echo "usage: merge-wave.sh [--person] <owner/repo> <pr>:<sha>[:auto] [...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
tries=6; pause=10
[ "$PIPELINE_TEST_FAST" = 1 ] && { tries=1; pause=0; }
for arg in "$@"; do
  pr=${arg%%:*}; rest=${arg#*:}; sha=${rest%%:*}; suffix=auto_none
  [ "$rest" != "$sha" ] && suffix=${rest#*:}
  [ "$pr" != "$arg" ] && [ -n "$sha" ] && { [ "$suffix" = auto_none ] || [ "$suffix" = auto ]; } || { echo "need <pr>:<sha> or <pr>:<sha>:auto, got $arg"; exit 2; }
  auto=""; [ "$suffix" = auto ] && auto=--auto
  for _ in $(seq 1 "$tries"); do
    pull=$(gh api "repos/$R/pulls/$pr") || { echo "STOP #$pr cannot be read"; exit 3; }
    read -r branch state <<<"$(jq -r '.head.ref + " " + (if .mergeable == true then "MERGEABLE" elif .mergeable == false then "CONFLICTING" else "UNKNOWN" end)' <<<"$pull")"
    [ "$state" != "UNKNOWN" ] && break
    sleep "$pause"
  done
  if [ "$state" != "MERGEABLE" ]; then echo "STOP #$pr is $state"; exit 3; fi
  bash "$M" $auto $person "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr merge failed"; exit 4; }
  sleep "$((pause / 2))"
done
echo "all merged"
