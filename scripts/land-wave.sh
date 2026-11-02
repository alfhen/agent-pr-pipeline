#!/bin/bash
# usage: land-wave.sh <owner/repo> <pr> [<pr> ...]
# For each PR in order: wait for CI to finish (up to 45 min), then merge it with merge-pr.sh if it is
# mergeable, green and bot-approved. A PR that conflicts or has a failing check is reported as
# "LAND FIX #n", and the wave stops there: run the workflow for it with landFix: true, then rerun this.
R=$1; shift
[ -n "$1" ] || { echo "usage: land-wave.sh <owner/repo> <pr> [<pr> ...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
for pr in "$@"; do
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
  failing=$(gh pr checks "$pr" -R "$R" --json name,bucket --jq '[.[]|select(.bucket=="fail")|.name]|join(",")')
  if [ "$state" = "CONFLICTING" ] || [ -n "$failing" ]; then
    echo "LAND FIX #$pr state=$state failing=[$failing]"; exit 3
  fi
  if [ "$pending" != "0" ]; then echo "WAITING #$pr: CI still running after 45 min"; exit 4; fi
  bash "$M" "$R" "$pr" "$head" "$branch" || { echo "STOP #$pr not merged (no bot approval yet?)"; exit 5; }
  sleep 5
done
echo "all merged"
