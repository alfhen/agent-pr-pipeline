#!/bin/bash
# usage: land-wave.sh [--person] <owner/repo> <pr>:<checked sha>[:auto] [<pr>:<checked sha>[:auto] ...]
# The pairs come from the workflow result (each PR's "land" field). The :auto suffix becomes --auto for
# merge-pr.sh; --person is passed through. For each PR in order: wait for CI
# (up to 45 min), then merge it with merge-pr.sh, which refuses unless the head is still the checked sha,
# every check passed and a review bot cleared the gate (approved, or its comments answered and not repeated). A PR whose head moved after the check stops the wave with
# "HEAD MOVED"; one that conflicts or has a failing check stops it with "LAND FIX". Run the workflow for
# that PR (landFix: true, or skipImpl to check the new head), then run this again.
person=""
[ "$1" = "--person" ] && { person=--person; shift; }
R=$1; shift
[ -n "$1" ] || { echo "usage: land-wave.sh [--person] <owner/repo> <pr>:<sha>[:auto] [...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
tries=90; pause=30; mtries=6; mpause=10
[ "$PIPELINE_TEST_FAST" = 1 ] && { tries=1; pause=0; mtries=1; mpause=0; }
for arg in "$@"; do
  pr=${arg%%:*}; rest=${arg#*:}; sha=${rest%%:*}; suffix=auto_none
  [ "$rest" != "$sha" ] && suffix=${rest#*:}
  [ "$pr" != "$arg" ] && [ -n "$sha" ] && { [ "$suffix" = auto_none ] || [ "$suffix" = auto ]; } || { echo "need <pr>:<sha> or <pr>:<sha>:auto, got $arg"; exit 2; }
  auto=""; [ "$suffix" = auto ] && auto=--auto
  for _ in $(seq 1 "$tries"); do
    pull=$(gh api "repos/$R/pulls/$pr") || { echo "cannot read #$pr"; exit 5; }
    head=$(jq -r .head.sha <<<"$pull")
    runs=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" | jq -s -c '[.[].check_runs[]]')
    pending=$(jq '[.[] | select(.status != "completed")] | length' <<<"$runs")
    [ "$pending" = "0" ] && break
    sleep "$pause"
  done
  for _ in $(seq 1 "$mtries"); do
    pull=$(gh api "repos/$R/pulls/$pr") || { echo "cannot read #$pr"; exit 5; }
    read -r head branch state <<<"$(jq -r '.head.sha + " " + .head.ref + " " + (if .mergeable == true then "MERGEABLE" elif .mergeable == false then "CONFLICTING" else "UNKNOWN" end)' <<<"$pull")"
    [ "$state" != "UNKNOWN" ] && break
    sleep "$mpause"
  done
  if [ "$head" != "$sha" ]; then echo "HEAD MOVED #$pr: checked ${sha:0:7}, now ${head:0:7}. Check the new head before merging."; exit 6; fi
  runs=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" | jq -s -c '[.[].check_runs[]]')
  failing=$(jq -r '[.[] | select(.conclusion | IN("failure", "timed_out", "action_required")) | .name] | join(",")' <<<"$runs")
  if [ "$state" = "CONFLICTING" ] || [ -n "$failing" ]; then
    echo "LAND FIX #$pr state=$state failing=[$failing]"; exit 3
  fi
  if [ "$pending" != "0" ]; then echo "WAITING #$pr: CI still running after 45 min"; exit 4; fi
  bash "$M" $auto $person "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr not merged (see the merge-pr.sh output above)"; exit 5; }
  sleep "$((pause / 6))"
done
echo "all merged"
