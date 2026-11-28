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
# Any other failed check is rerun once too, when the head is a merge of the default branch head (second parent) into the previous
# head (first parent) and each parent has at least one run of each failed check name and every such run succeeded (green parents). A refusal prints
# "NO RERUN #<pr>: <cause>" before LAND FIX. One land call reruns a head at most once.
# Last, a failed job that failed in a setup or install step (or lost its runner) is rerun once (infra failure): every failed run of the head
# must be on its first attempt and hold only such failed jobs (cancelled siblings of a matrix are allowed). When both paths refuse, one line
# "NO RERUN #<pr>: <green-parents cause>; <infra cause>" is printed.
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
  local raw
  # gh writes an HTTP error body to stdout, so a failed read must not count as an answer.
  raw=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100") || return 1
  runs=$(jq -s -c '[.[].check_runs[] | {name, status, conclusion, details_url}]' <<<"$raw") || return 1
  raw=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100") || return 1
  sts=$(jq -s -c '[.[].statuses[] | {context, state}]' <<<"$raw") || return 1
}
# The CI state of the runs and statuses just fetched: scripts/ci-state.jq.
ci_state() {
  ci=$(jq -n -c --argjson r "$runs" --argjson s "${sts:-[]}" '{runs: $r, statuses: $s}' | jq -c -f "$(dirname "$0")/ci-state.jq") && [ -n "$ci" ] || { echo "STOP #$pr: cannot judge the check runs"; exit 5; }
}
# Ends when nothing is pending (a failed run does not end it while another check is pending, so a known flake is rerun only
# after everything has finished), when the head moved, or when the head has only successful commit statuses on the second poll.
# Sets pending (how many are still unfinished) and norun (1 when it stopped for a head with no check run).
wait_ci() {
  local nr=0
  norun=0
  for _ in $(seq 1 "$tries"); do
    pull=$(gh api "repos/$R/pulls/$pr") || { echo "cannot read #$pr"; exit 5; }
    head=$(jq -r .head.sha <<<"$pull")
    [ "$head" != "$sha" ] && break
    # One unreadable answer is one lost poll, not the end of the wait.
    fetch_checks || { sleep "$pause"; continue; }
    ci_state
    pending=$(jq '.pending | length' <<<"$ci")
    if [ "$(jq -r '.state == "noRuns"' <<<"$ci")" = true ]; then
      if [ "$(jq length <<<"${sts:-[]}")" = 0 ]; then pending=1
      else nr=$((nr + 1)); if [ "$nr" -ge 2 ]; then norun=1; else pending=1; fi
      fi
    else nr=0
    fi
    [ "$pending" = "0" ] && break
    # A failed commit status ends the wait at once. A failed run does not: see above.
    [ "$(jq '(.failedStatuses // []) | length' <<<"$ci")" != 0 ] && break
    sleep "$pause"
  done
}
read_failing() {
  fetch_checks || { echo "STOP #$pr: cannot read the check runs"; exit 5; }
  ci_state
  failing=$(jq -r '.failed | join(",")' <<<"$ci")
  # wait_ci set norun from an earlier poll; a head that has gained check runs since is no longer a head with none.
  if [ "$norun" = 1 ] && [ "$(jq -r '.noRuns' <<<"$ci")" != true ]; then
    # Runs that appeared after the statuses-only polls may still be in progress: wait for them, or ask_review and the merge would run before CI is green.
    norun=0
    if [ "$(jq '.pending | length' <<<"$ci")" != 0 ]; then
      wait_ci
      if [ "$head" != "$sha" ]; then echo "HEAD MOVED #$pr: checked ${sha:0:7}, now ${head:0:7}. Check the new head before merging."; exit 6; fi
      read_failing
      return
    fi
    pending=0
  fi
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
# The details_url of a check run is text the writing App chooses, so a run id counts only from a github.com URL of this repo.
runid_def='def runid($r): ("https://github.com/" + ($r | ascii_downcase) + "/actions/runs/") as $p | (.details_url // "" | ascii_downcase) | select(startswith($p)) | ltrimstr($p) | capture("^(?<id>[0-9]+)(/|$)").id;'
# Prints "<run_attempt|none> <head_sha>" of Actions run $1; fails when the read fails.
run_info() { gh api "repos/$R/actions/runs/$1" --jq '"\(.run_attempt // "none") \(.head_sha // "none")"' 2>/dev/null; }
# Prints the run ids to rerun when every failing check is a known flake, else nothing. Any doubt means no rerun.
flake_runs() {
  local flakes
  read_default_settings || return 0
  flakes=$(jq -c 'if (.knownFlakes // []) | (type == "array" and all(.[]; type == "string")) then (.knownFlakes // []) else error("flakes") end' <<<"$sj" 2>/dev/null) || return 0
  # A failed commit status is not a run, so it is never rerun, even when it is named like a failed run.
  jq -r --argjson f "$flakes" --arg r "$R" "$runid_def"'
    .failedRuns as $bad
    | if ((.failedStatuses // []) | length) > 0 or ($bad | length) == 0 or any($bad[]; . as $c | $f | index($c.name) | not)
         or any($bad[]; ([runid($r)] | length) == 0) then empty
      else [$bad[] | runid($r)] | unique | .[] end' <<<"$ci" 2>/dev/null
}
# Returns 0 and sets gp_ids and gp_p0 gp_p1 when the head may be rerun because both parents are green; else sets gp_cause and returns 1.
# Green: the head is a merge of the default branch head (second parent) into the previous head (first parent), and each parent
# has runs of each failed check name, all completed with the conclusion success. Any doubt, or a failed read, means no rerun.
green_parents() {
  local base bsha ps pa n p pruns v id att rsha nm names info
  gp_ids=""; gp_cause=""
  if [ "$(jq '(.failedStatuses // []) | length' <<<"$ci")" != 0 ]; then gp_cause="commit status failed"; return 1; fi
  nm=$(jq -r --arg r "$R" "$runid_def"'[.failedRuns[] | select(([runid($r)] | length) == 0) | .name] | first // empty' <<<"$ci" 2>/dev/null) || { gp_cause="read failed"; return 1; }
  if [ -n "$nm" ]; then gp_cause="no run id for $nm"; return 1; fi
  gp_ids=$(jq -r --arg r "$R" "$runid_def"'[.failedRuns[] | runid($r)] | unique | .[]' <<<"$ci" 2>/dev/null) || { gp_cause="read failed"; return 1; }
  names=$(jq -r '[.failedRuns[].name] | unique | .[]' <<<"$ci" 2>/dev/null) || { gp_cause="read failed"; return 1; }
  [ -n "$gp_ids" ] && [ -n "$names" ] || { gp_cause="read failed"; return 1; }
  ps=$(gh api "repos/$R/commits/$sha" --jq '[.parents[].sha] | join(" ")' 2>/dev/null) || { gp_cause="read failed"; return 1; }
  read -ra pa <<<"$ps"
  [ "${#pa[@]}" = 2 ] || { gp_cause="head does not have two parents"; return 1; }
  base=$(gh api "repos/$R" --jq .default_branch 2>/dev/null) && [ -n "$base" ] || { gp_cause="read failed"; return 1; }
  bsha=$(gh api "repos/$R/branches/$base" --jq .commit.sha 2>/dev/null) && [ -n "$bsha" ] || { gp_cause="read failed"; return 1; }
  if [ "${pa[1]}" != "$bsha" ]; then
    if [ "${pa[0]}" = "$bsha" ]; then gp_cause="first parent is the default branch head"; else gp_cause="no parent is the default branch head"; fi
    return 1
  fi
  for p in "${pa[@]}"; do
    pruns=$(gh api --paginate "repos/$R/commits/$p/check-runs?filter=all&per_page=100" 2>/dev/null) || { gp_cause="read failed"; return 1; }
    pruns=$(jq -s -c '[.[].check_runs[] | {name, status, conclusion}]' <<<"$pruns" 2>/dev/null) || { gp_cause="read failed"; return 1; }
    while IFS= read -r n; do
      v=$(jq -r --arg n "$n" '[.[] | select(.name == $n)] as $m
        | if length == 0 then "has no runs"
          elif ($m | length) == 0 then "has no run of " + $n
          elif any($m[]; .status == "completed" and .conclusion == "failure") then "is failure"
          elif any($m[]; .status != "completed") then "is pending"
          elif all($m[]; .conclusion == "success") then ""
          else "run of " + $n + " did not succeed" end' <<<"$pruns" 2>/dev/null) || { gp_cause="read failed"; return 1; }
      [ -z "$v" ] || { gp_cause="parent ${p:0:7} $v"; return 1; }
    done <<<"$names"
  done
  for id in $gp_ids; do
    info=$(run_info "$id") || { gp_cause="read failed"; return 1; }
    read -r att rsha <<<"$info"
    [ "$att" != none ] || { gp_cause="failed check is not an Actions run"; return 1; }
    [ "$att" = 1 ] || { gp_cause="run_attempt is not 1"; return 1; }
    [ "$rsha" = "$sha" ] || { gp_cause="failed check is not an Actions run"; return 1; }
  done
  gp_p0=${pa[0]}; gp_p1=${pa[1]}
}
# jq program for infra_runs: judges the jobs of one run. Prints "ok<TAB>job<TAB>step" or "no<TAB>cause". Names come from workflow files,
# so control characters become spaces and a name cannot start a second output line.
infra_jq='def clean: if type == "string" then explode | map(if . < 32 or (. >= 127 and . < 160) then 32 else . end) | implode | gsub("^ +| +$"; "") else "" end;
  def fs: [(.steps // [])[] | select(.conclusion == "failure" or .conclusion == "cancelled")] | first;
  def infra: fs as $s | $s == null or (($s.name // "") | ascii_downcase | test("^(set up|setup|install|checkout|run actions/checkout@|run actions/setup-|run actions/cache@)"));
  [.[] | .jobs | arrays | .[]] as $j
  | [$j[] | select(.conclusion != null and (.conclusion | test("^(success|skipped|neutral)$") | not))] as $f
  | if ($f | length) == 0 then "no\trun \($id) lists no failed job"
    else ([$f[] | select((.conclusion != "failure" and .conclusion != "cancelled") or (.conclusion == "failure" and (infra | not)))] | first) as $bad
    | if $bad != null then
        (if $bad.conclusion != "failure" then "no\trun \($id) job \($bad.name | clean) ended \($bad.conclusion | clean)"
         else "no\trun \($id) job \($bad.name | clean) failed in step \($bad | fs | .name | clean)" end)
      else ([$f[] | select(.conclusion == "failure")] | first) as $i
      | if $i == null then "no\trun \($id) job \($f[0].name | clean) ended cancelled"
        else "ok\t\($i.name | clean)\t\($i | fs | if . == null then "(no failed step)" else .name | clean end)" end
      end
    end'
# Returns 0 and sets ir_ids ir_job ir_step when the head may be rerun because every failed run failed only in setup or install steps
# (see choice 4 of plan 0.10.4); else sets ir_cause and returns 1. The run ids come from the failed checks, never from green_parents.
infra_runs() {
  local id info att rsha raw verdict tag a b nm
  ir_ids=""; ir_job=""; ir_step=""; ir_cause=""
  [ "$(jq '(.failedStatuses // []) | length' <<<"$ci")" = 0 ] || { ir_cause="commit status failed"; return 1; }
  nm=$(jq -r --arg r "$R" "$runid_def"'[.failedRuns[] | select(([runid($r)] | length) == 0) | .name] | first // empty' <<<"$ci" 2>/dev/null) || { ir_cause="read failed"; return 1; }
  [ -z "$nm" ] || { ir_cause="no run id for $nm"; return 1; }
  ir_ids=$(jq -r --arg r "$R" "$runid_def"'[.failedRuns[] | runid($r)] | unique | .[]' <<<"$ci" 2>/dev/null) || { ir_cause="read failed"; return 1; }
  [ -n "$ir_ids" ] || { ir_cause="read failed"; return 1; }
  for id in $ir_ids; do
    info=$(run_info "$id") || { ir_cause="cannot read run $id"; return 1; }
    read -r att rsha <<<"$info"
    # The head is tested first: the details_url of a check is chosen by the App that wrote it.
    [ "$rsha" = "$sha" ] || { ir_cause="run $id is not a run of the head"; return 1; }
    [ "$att" = 1 ] || { ir_cause="run $id has run_attempt $att"; return 1; }
    raw=$(gh api --paginate "repos/$R/actions/runs/$id/jobs?per_page=100" 2>/dev/null) || { ir_cause="cannot read the jobs of run $id"; return 1; }
    verdict=$(jq -s -r --arg id "$id" "$infra_jq" <<<"$raw" 2>/dev/null) && [ -n "$verdict" ] || { ir_cause="cannot read the jobs of run $id"; return 1; }
    IFS=$'\t' read -r tag a b <<<"$verdict"
    [ "$tag" = ok ] || { ir_cause=$a; return 1; }
    [ -n "$ir_job" ] || { ir_job=$a; ir_step=$b; }
  done
}
here=$(dirname "$0")
# Read once, when the first PR needs it, from the default branch only: a PR must not turn the request on for itself.
roq=""
read_review_on_request() {
  local v
  roq=0
  read_default_settings || { echo "WARN: cannot read .github/pipeline.json of $R, reviewOnRequest is taken as false"; return 0; }
  v=$(jq -r 'if .reviewOnRequest == null or .reviewOnRequest == false then "0" elif .reviewOnRequest == true then "1" else "bad" end' <<<"$sj" 2>/dev/null)
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
    rerun_ok=1; how="known flake(s) [$failing]"
    if [ -z "$ids" ]; then
      # Only when the known-flake path did not apply: a head is rerun at most once per call.
      if green_parents; then ids=$gp_ids; how="green parents ${gp_p0:0:7} ${gp_p1:0:7}"
      else
        case "$gp_cause" in
          # These are final for the infra path too: a status or a non-Actions check is never rerun.
          "commit status failed"|"no run id for "*|"failed check is not an Actions run") echo "NO RERUN #$pr: $gp_cause" ;;
          *)
            if infra_runs; then ids=$ir_ids; how="infra failure in $ir_job step $ir_step"
            else echo "NO RERUN #$pr: $gp_cause; $ir_cause"
            fi ;;
        esac
      fi
    else
      for id in $ids; do
        # run_attempt above 1 means a rerun already happened for this head, in this or an earlier call
        read -r att rsha <<<"$(run_info "$id")" || { rerun_ok=0; break; }
        { [ "$att" = 1 ] && [ "$rsha" = "$sha" ]; } || { rerun_ok=0; break; }
      done
    fi
    if [ -n "$ids" ] && [ "$rerun_ok" = 1 ]; then
      for id in $ids; do
        gh api -X POST "repos/$R/actions/runs/$id/rerun-failed-jobs" >/dev/null || rerun_ok=0
      done
      if [ "$rerun_ok" = 1 ]; then
        echo "RERUN #$pr: $how, failed jobs rerun once"
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
  if [ "$norun" = 1 ]; then echo "STOP #$pr: no check runs"; exit 5; fi
  if [ "$pending" != "0" ]; then echo "WAITING #$pr: CI still running after 45 min"; exit 4; fi
  if [ "$state" = MERGEABLE ]; then
    [ "$review" = 0 ] && [ -z "$roq" ] && read_review_on_request
    { [ "$review" = 1 ] || [ "$roq" = 1 ]; } && ask_review
  fi
  bash "$M" $auto $person "$R" "$pr" "$sha" "$branch" || { echo "STOP #$pr not merged (see the merge-pr.sh output above)"; exit 5; }
  sleep "$((pause / 6))"
done
echo "all merged"
