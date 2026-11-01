#!/bin/bash
# usage: merge-wave.sh <owner/repo> <pr> [<pr> ...]
# Merges PRs in order with merge-pr.sh and stops at the first one that is not cleanly mergeable.
R=$1; shift
[ -n "$1" ] || { echo "usage: merge-wave.sh <owner/repo> <pr> [<pr> ...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
for pr in "$@"; do
  for _ in 1 2 3 4 5 6; do
    read -r head branch state <<<"$(gh pr view "$pr" -R "$R" --json headRefOid,headRefName,mergeable --jq '.headRefOid + " " + .headRefName + " " + .mergeable')"
    [ "$state" != "UNKNOWN" ] && break
    sleep 10
  done
  if [ "$state" != "MERGEABLE" ]; then echo "STOP #$pr is $state"; exit 3; fi
  bash "$M" "$R" "$pr" "$head" "$branch" || { echo "STOP #$pr merge failed"; exit 4; }
  sleep 5
done
echo "all merged"
