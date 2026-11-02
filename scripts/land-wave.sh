#!/bin/bash
# usage: land-wave.sh <owner/repo> <pr>:<checked sha> [<pr>:<checked sha> ...]
# The pairs come from the workflow result (each PR's "land" field). For each PR in order: wait for CI
# (up to 45 min), then merge it with merge-pr.sh, which refuses unless the head is still the checked sha,
# every check passed and a bot approved. A PR whose head moved after the check stops the wave with
# "HEAD MOVED"; one that conflicts or has a failing check stops it with "LAND FIX". Run the workflow for
# that PR (landFix: true, or skipImpl to check the new head), then run this again.
R=$1; shift
[ -n "$1" ] || { echo "usage: land-wave.sh <owner/repo> <pr>:<sha> [...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
for arg in "$@"; do
  pr=${arg%%:*}; sha=${arg#*:}
  [ "$sha" != "$arg" ] && [ -n "$sha" ] || { echo "need <pr>:<sha>, got $arg"; exit 2; }
  for _ in $(seq 1 90); do
    pending=$(gh pr checks "$pr" -R "$R" --json bucket --jq '[.[]|select(.bucket=="pending")]|length' 2>/dev/null)
    [ "$pending" = "0" ] && break
    sleep 30
  done
  for _ in 1 2 3 4 5 6; do
    read -r head branch state <<<"$(gh pr view "$pr" -R "$R" --json headRefOid,headRefName,mergeable --jq '.headRefOid + " " + .headRefName + " " + .mergeable')"
    [ "$state" != "UNKNOWN" ] && break
    sleep 10
  done
  if [ "$head" != "$sha" ]; then echo "HEAD MOVED #$pr: checked ${sha:0:7}, now ${head:0:7}. Check the new head before merging."; exit 6; fi
  failing=$(gh pr checks "$pr" -R "$R" --json name,bucket --jq '[.[]|select(.bucket=="fail")|.name]|join(",")')
  if [ "$state" = "CONFLICTING" ] || [ -n "$failing" ]; then
    echo "LAND FIX #$pr state=$state failing=[$failing]"; exit 3
  fi
  if [ "$pending" != "0" ]; then echo "WAITING #$pr: CI still running after 45 min"; exit 4; fi
  bash "$M" "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr not merged (no bot approval, or a check did not pass)"; exit 5; }
  sleep 5
done
echo "all merged"
