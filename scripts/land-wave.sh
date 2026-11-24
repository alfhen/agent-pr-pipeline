#!/bin/bash
# usage: land-wave.sh [--review] [--person] <owner/repo> <pr>:<checked sha>[:auto] [<pr>:<checked sha>[:auto] ...]
# The pairs come from the workflow result (each PR's "land" field). The :auto suffix becomes --auto for
# merge-pr.sh; --person is passed through. For each PR in order: wait for CI
# (up to 45 min), then merge it with merge-pr.sh, which refuses unless the head is still the checked sha,
# every check passed and a review bot cleared the gate (approved, its comments answered and not repeated, or a clean review that was asked for). A PR whose head moved after the check stops the wave with
# "HEAD MOVED"; one that conflicts or has a failing check stops it with "LAND FIX". Run the workflow for
# that PR (landFix: true, or skipImpl to check the new head), then run this again.
# When every failing check is in knownFlakes (.github/pipeline.json on the default branch), the failed jobs
# are rerun once and CI is awaited again; only a check that still fails stops the wave.
# The key reviewOnRequest (true) in .github/pipeline.json on the default branch acts as --review, for a repo whose bot reviews only on request.
# A settings file that cannot be read, or a value that is not a boolean, acts as false and prints one WARN line.
# With --review, a PR that no bot has cleared (and has no open bot comment) first gets request-review.sh, which asks CodeRabbit for a
# review (two requests at most, 64 minutes apart), so a PR can wait hours: run it in the background, one --review land at a time for a
# repo (there is no lock). A review that did not come stops the wave with "REVIEW #<pr>: <cause>" (exit 9). Open bot comments or an
# unanswered review body, before the request or in the review that came, stop it with "ANSWER #<pr> <sha>: ..." (exit 10).
# A PR that is already merged at the checked sha prints "MERGED #<pr> already" and the run goes on, so the same command can be run again
# after a stop. It posts no merge record and deletes no branch for that PR. A merged PR with another head, or a closed PR that was not
# merged, stops the wave with "STOP #<pr>: ..." (exit 5).
person=""; review=0
while :; do
  case "$1" in
    --person) person=--person ;;
    --review) review=1 ;;
    *) break ;;
  esac
  shift
done
R=$1; shift
[ -n "$1" ] || { echo "usage: land-wave.sh [--review] [--person] <owner/repo> <pr>:<sha>[:auto] [...]"; exit 2; }
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
errf=$(mktemp) || { echo "STOP: cannot make a temporary file"; exit 5; }
trap 'rm -f "$errf"' EXIT
# Sets $sj to the settings file of the default branch, never of a PR head, so a PR cannot change its own rules.
# A missing file (404) means the template defaults. Any other failure returns 1.
sj=""
read_default_settings() {
  local base
  base=$(gh api "repos/$R" --jq .default_branch 2>/dev/null) || return 1
  sj=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=refs/heads/$base" 2>"$errf")
  if [ $? -ne 0 ]; then
    case "$sj $(cat "$errf")" in
      *"HTTP 404"*) sj=$(cat "$here/../templates/pipeline.json" 2>/dev/null) || return 1 ;;
      *) return 1 ;;
    esac
  fi
}
# Prints the run ids to rerun when every failing check is a known flake, else nothing. Any doubt means no rerun.
flake_runs() {
  local flakes
  read_default_settings || return 0
  flakes=$(jq -c 'if (.knownFlakes // []) | (type == "array" and all(.[]; type == "string")) then (.knownFlakes // []) else error("flakes") end' <<<"$sj" 2>/dev/null) || return 0
  jq -n -r --argjson r "$runs" --argjson s "${sts:-[]}" --argjson f "$flakes" '
    [$r[] | select(.conclusion | IN("failure", "timed_out", "action_required"))] as $bad
    | if ([$s[] | select(.state | IN("failure", "error"))] | length) > 0 or ($bad | length) == 0 or any($bad[]; . as $c | $f | index($c.name) | not) then empty
      else [$bad[] | (.details_url // "") | capture("/actions/runs/(?<id>[0-9]+)") | .id] | unique | .[] end' 2>/dev/null
}
here=$(dirname "$0")
# Read once, when the first PR needs it, from the default branch only: a PR must not turn the request on for itself.
roq=""
read_review_on_request() {
  local v
  roq=0
  read_default_settings || { echo "WARN: cannot read .github/pipeline.json of $R, reviewOnRequest is taken as false"; return 0; }
  v=$(jq -r 'if has("reviewOnRequest") | not then "0" elif .reviewOnRequest == false then "0" elif .reviewOnRequest == true then "1" else "bad" end' <<<"$sj" 2>/dev/null)
  case "$v" in
    0) ;;
    1) roq=1 ;;
    *) echo "WARN: reviewOnRequest in .github/pipeline.json is not true or false, taken as false" ;;
  esac
}
parse_arg() {
  pr=${arg%%:*}; rest=${arg#*:}; sha=${rest%%:*}; suffix=auto_none
  [ "$rest" != "$sha" ] && suffix=${rest#*:}
  [ "$pr" != "$arg" ] && [ -n "$sha" ] && { [ "$suffix" = auto_none ] || [ "$suffix" = auto ]; } || { echo "need <pr>:<sha> or <pr>:<sha>:auto, got $arg"; exit 2; }
  [[ "$pr" =~ ^[0-9]+$ ]] || { echo "need a PR number in $arg"; exit 2; }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "need the full 40-character commit id in $arg: a short id cannot match the PR head. Use the land value from the workflow result as it is."; exit 2; }
}
# Exit 10 sends the PR to an answer run; merge-pr.sh refusals stay exit 5 because the answer agent starts only on these counts.
answer_stop() {
  local threads bodies
  read -r threads bodies <<<"$(jq -r '"\(.openThreads // 0) \(.reviewBodies // 0)"' <<<"$1")"
  if [ "$threads" -gt 0 ] || [ "$bodies" -gt 0 ]; then
    echo "ANSWER #$pr $sha: $threads threads, $bodies review bodies; run the bots step with answer: true, then land again"; exit 10
  fi
}
# The review request can take an hour, so a status read must name the checked head before it routes the PR.
status_head() {
  local h; h=$(jq -r '.head // ""' <<<"$1")
  [ "$h" = "$sha" ] || { echo "HEAD MOVED #$pr: checked ${sha:0:7}, now ${h:0:7}. Check the new head before merging."; exit 6; }
}
# Runs between the WAITING test and merge-pr.sh. Returns when merge-pr.sh should run; stops the wave when no review came.
ask_review() {
  local st failed rrout rrc cause
  st=$(bash "$here/bot-status.sh" "$R" "$pr") || { echo "STOP #$pr: cannot read the bot status"; exit 5; }
  status_head "$st"
  if [ "$(jq -r '(.approvedBy | length) > 0' <<<"$st")" = true ]; then
    failed=$(gh api --paginate "repos/$R/commits/$sha/check-runs?per_page=100") || { echo "STOP #$pr: cannot read the check runs"; exit 5; }
    # Same rule as fourthWhy in bot-approval.jq: only the newest bot run counts.
    failed=$(jq -s '[.[].check_runs[] | select((.app.slug // "") == "coderabbitai" and .started_at != null)] | sort_by(.started_at) | last | (. != null and .conclusion == "success" and (.output.title // "") == "Review failed")' <<<"$failed") || { echo "STOP #$pr: cannot read the check runs"; exit 5; }
    [ "$failed" = true ] || return 0
  fi
  # A failed newest review does not take approvedBy, so the open-comment stop applies here too.
  answer_stop "$st"
  rrout=$(mktemp) || { echo "STOP #$pr: cannot make a temporary file"; exit 5; }
  bash "$here/request-review.sh" "$R" "$pr" "$sha" | tee "$rrout"; rrc=${PIPESTATUS[0]}
  cause=$(tail -n 1 "$rrout"); rm -f "$rrout"
  [ "$rrc" = 0 ] || { echo "REVIEW #$pr: ${cause#NO REVIEW #$pr: }"; exit 9; }
  # The review that came may have left comments; an approval of a bot still goes to merge-pr.sh.
  st=$(bash "$here/bot-status.sh" "$R" "$pr") || { echo "STOP #$pr: cannot read the bot status"; exit 5; }
  status_head "$st"
  [ "$(jq -r '(.approvedBy | length) > 0' <<<"$st")" = true ] && return 0
  answer_stop "$st"
}
# Every argument is checked before the first gh call, so a bad one cannot stop the run after an earlier PR has merged.
for arg in "$@"; do parse_arg; done
for arg in "$@"; do
  parse_arg
  auto=""; [ "$suffix" = auto ] && auto=--auto
  pull=$(gh api "repos/$R/pulls/$pr") || { echo "cannot read #$pr"; exit 5; }
  read -r pmerged pstate phead <<<"$(jq -r '"\(.merged // false) \(.state // "open") \(.head.sha)"' <<<"$pull")"
  if [ "$pmerged" = true ]; then
    [ "$phead" = "$sha" ] || { echo "STOP #$pr: merged at ${phead:0:7}, not at the checked ${sha:0:7}. A person looks at the commits that were merged."; exit 5; }
    echo "MERGED #$pr already"
    continue
  fi
  [ "$pstate" = closed ] && { echo "STOP #$pr: closed, not merged"; exit 5; }
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
  if [ "$state" = MERGEABLE ]; then
    [ "$review" = 0 ] && [ -z "$roq" ] && read_review_on_request
    { [ "$review" = 1 ] || [ "$roq" = 1 ]; } && ask_review
  fi
  bash "$M" $auto $person "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr not merged (see the merge-pr.sh output above)"; exit 5; }
  sleep "$((pause / 6))"
done
echo "all merged"
