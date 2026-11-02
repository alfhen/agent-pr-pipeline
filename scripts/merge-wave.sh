#!/bin/bash
# usage: merge-wave.sh <owner/repo> <pr>:<checked sha> [<pr>:<checked sha> ...]
# Merges PRs in order with merge-pr.sh, without waiting for CI, and stops at the first one that is not
# cleanly mergeable. Use land-wave.sh when CI may still be running.
R=$1; shift
[ -n "$1" ] || { echo "usage: merge-wave.sh <owner/repo> <pr>:<sha> [...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
for arg in "$@"; do
  pr=${arg%%:*}; sha=${arg#*:}
  [ "$sha" != "$arg" ] && [ -n "$sha" ] || { echo "need <pr>:<sha>, got $arg"; exit 2; }
  for _ in 1 2 3 4 5 6; do
    read -r branch state <<<"$(gh pr view "$pr" -R "$R" --json headRefName,mergeable --jq '.headRefName + " " + .mergeable')"
    [ "$state" != "UNKNOWN" ] && break
    sleep 10
  done
  if [ "$state" != "MERGEABLE" ]; then echo "STOP #$pr is $state"; exit 3; fi
  bash "$M" "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr merge failed"; exit 4; }
  sleep 5
done
echo "all merged"
