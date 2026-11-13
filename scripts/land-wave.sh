#!/bin/bash
# usage: land-wave.sh [--person] <owner/repo> <pr>:<checked sha>[:auto] [<pr>:<checked sha>[:auto] ...]
# The pairs come from the workflow result (each PR's "land" field). The :auto suffix becomes --auto for
# merge-pr.sh; --person is passed through. For each PR in order: wait for CI
# (up to 45 min), then merge it with merge-pr.sh, which refuses unless the head is still the checked sha,
# every check passed and a review bot cleared the gate (approved, or its comments answered and not repeated). A PR whose head moved after the check stops the wave with
# "HEAD MOVED"; one that conflicts or has a failing check stops it with "LAND FIX". Run the workflow for
# that PR (landFix: true, or skipImpl to check the new head), then run this again.
# When every failing check is in knownFlakes (.github/pipeline.json on the default branch), the failed jobs
# are rerun once and CI is awaited again; only a check that still fails stops the wave.
person=""
[ "$1" = "--person" ] && { person=--person; shift; }
R=$1; shift
[ -n "$1" ] || { echo "usage: land-wave.sh [--person] <owner/repo> <pr>:<sha>[:auto] [...]"; exit 2; }
M="$(dirname "$0")/merge-pr.sh"
tries=90; pause=30; mtries=6; mpause=10; rtries=6
[ "$PIPELINE_TEST_FAST" = 1 ] && { tries=3; pause=0; mtries=1; mpause=0; rtries=3; }
# Trimmed to the fields read below: one jq argument is limited to 128 KiB on Linux, and a full check run is several KB.
fetch_checks() {
  runs=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" | jq -s -c '[.[].check_runs[] | {name, status, conclusion, details_url}]')
  sts=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100" | jq -s -c '[.[].statuses[] | {context, state}]')
}
wait_ci() {
  for _ in $(seq 1 "$tries"); do
    pull=$(gh api "repos/$R/pulls/$pr") || { echo "cannot read #$pr"; exit 5; }
    head=$(jq -r .head.sha <<<"$pull")
    [ "$head" != "$sha" ] && break
    fetch_checks
    pending=$(jq -n --argjson r "$runs" --argjson s "${sts:-[]}" '[$r[] | select(.status != "completed")] + [$s[] | select(.state == "pending")] | length')
    [ "$(jq length <<<"$runs")" = 0 ] && pending=$((pending + 1))
    [ "$pending" = "0" ] && break
    [ "$(jq '[.[] | select(.state | IN("failure", "error"))] | length' <<<"${sts:-[]}")" != 0 ] && break
    sleep "$pause"
  done
}
read_failing() {
  fetch_checks
  failing=$(jq -n -r --argjson r "$runs" --argjson s "${sts:-[]}" '[$r[] | select(.conclusion | IN("failure", "timed_out", "action_required")) | .name] + [$s[] | select(.state | IN("failure", "error")) | .context] | join(",")')
}
# Waits until a rerun of run $1 shows: GitHub lists the new attempt a moment after the POST, and until then
# wait_ci would see the old failure.
wait_rerun_started() {
  for _ in $(seq 1 "$rtries"); do
    if st=$(gh api "repos/$R/actions/runs/$1" --jq '"\(.run_attempt) \(.status)"' 2>/dev/null); then
      { [ "${st%% *}" != 1 ] || [ "${st#* }" != completed ]; } && return 0
    fi
    sleep "$((pause / 3))"
  done
  return 1
}
# Prints the run ids to rerun when every failing check is a known flake, else nothing. The list is read from
# the default branch, never from the PR head, so a PR cannot add its own failing check to it. Any doubt means no rerun.
flake_runs() {
  local base settings flakes
  base=$(gh api "repos/$R" --jq .default_branch 2>/dev/null) || return 0
  settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=refs/heads/$base" 2>&1)
  if [ $? -ne 0 ]; then
    case $settings in
      *"HTTP 404"*) settings=$(cat "$here/../templates/pipeline.json" 2>/dev/null) || return 0 ;;
      *) return 0 ;;
    esac
  fi
  flakes=$(jq -c 'if (.knownFlakes // []) | (type == "array" and all(.[]; type == "string")) then (.knownFlakes // []) else error("flakes") end' <<<"$settings" 2>/dev/null) || return 0
  jq -n -r --argjson r "$runs" --argjson s "${sts:-[]}" --argjson f "$flakes" '
    [$r[] | select(.conclusion | IN("failure", "timed_out", "action_required"))] as $bad
    | if ([$s[] | select(.state | IN("failure", "error"))] | length) > 0 or ($bad | length) == 0 or any($bad[]; . as $c | $f | index($c.name) | not) then empty
      else [$bad[] | (.details_url // "") | capture("/actions/runs/(?<id>[0-9]+)") | .id] | unique | .[] end' 2>/dev/null
}
here=$(dirname "$0")
parse_arg() {
  pr=${arg%%:*}; rest=${arg#*:}; sha=${rest%%:*}; suffix=auto_none
  [ "$rest" != "$sha" ] && suffix=${rest#*:}
  [ "$pr" != "$arg" ] && [ -n "$sha" ] && { [ "$suffix" = auto_none ] || [ "$suffix" = auto ]; } || { echo "need <pr>:<sha> or <pr>:<sha>:auto, got $arg"; exit 2; }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "need the full 40-character commit id in $arg: a short id cannot match the PR head. Use the land value from the workflow result as it is."; exit 2; }
}
# Every argument is checked before the first gh call, so a bad one cannot stop the run after an earlier PR has merged.
for arg in "$@"; do parse_arg; done
for arg in "$@"; do
  parse_arg
  auto=""; [ "$suffix" = auto ] && auto=--auto
  wait_ci
  for _ in $(seq 1 "$mtries"); do
    pull=$(gh api "repos/$R/pulls/$pr") || { echo "cannot read #$pr"; exit 5; }
    read -r head branch state <<<"$(jq -r '.head.sha + " " + .head.ref + " " + (if .mergeable == true then "MERGEABLE" elif .mergeable == false then "CONFLICTING" else "UNKNOWN" end)' <<<"$pull")"
    [ "$state" != "UNKNOWN" ] && break
    sleep "$mpause"
  done
  if [ "$head" != "$sha" ]; then echo "HEAD MOVED #$pr: checked ${sha:0:7}, now ${head:0:7}. Check the new head before merging."; exit 6; fi
  read_failing
  if [ "$state" != "CONFLICTING" ] && [ -n "$failing" ]; then
    ids=$(flake_runs)
    rerun_ok=1
    for id in $ids; do
      # run_attempt above 1 means a rerun already happened for this head, in this or an earlier call
      att=$(gh api "repos/$R/actions/runs/$id" --jq .run_attempt 2>/dev/null) || { rerun_ok=0; break; }
      [ "$att" = 1 ] || { rerun_ok=0; break; }
    done
    if [ -n "$ids" ] && [ "$rerun_ok" = 1 ]; then
      for id in $ids; do
        gh api -X POST "repos/$R/actions/runs/$id/rerun-failed-jobs" >/dev/null || rerun_ok=0
      done
      if [ "$rerun_ok" = 1 ]; then
        echo "RERUN #$pr: known flake(s) [$failing], failed jobs rerun once"
        for id in $ids; do wait_rerun_started "$id" || { echo "STOP #$pr: the rerun of run $id did not show a new attempt"; exit 5; }; done
        wait_ci
        if [ "$head" != "$sha" ]; then echo "HEAD MOVED #$pr: checked ${sha:0:7}, now ${head:0:7}. Check the new head before merging."; exit 6; fi
        read_failing
      fi
    fi
  fi
  if [ "$state" = "CONFLICTING" ] || [ -n "$failing" ]; then
    echo "LAND FIX #$pr state=$state failing=[$failing]"; exit 3
  fi
  if [ "$pending" != "0" ]; then echo "WAITING #$pr: CI still running after 45 min"; exit 4; fi
  bash "$M" $auto $person "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr not merged (see the merge-pr.sh output above)"; exit 5; }
  sleep "$((pause / 6))"
done
echo "all merged"
