#!/bin/bash
# usage: wait-ci.sh <owner/repo> <pr> <minutes>
# Polls the PR head's check runs and commit statuses once a minute and prints one JSON line:
# A head with no check runs counts as pending on the first poll of that head: GitHub creates them a few seconds after a push, and an early
# green status must not end the wait. A head with only statuses is accepted from the second poll of that head on.
# head, state (pending, success, failure, noRuns), failed (names), timedOut. The state noRuns (with noRuns: true) means no check run and only
# successful commit statuses: not ready. The rule is scripts/ci-state.jq. Stops when nothing is pending or the time is up.
# One call waits at most 9 minutes, so it fits in one shell command. WAIT_CI_INTERVAL: seconds between polls (default 60).
# A GitHub reply that fails or is not JSON is tried again (3 tries in all, 2 s apart).
# Exits 0 with the line, 2 on bad usage, 3 when a GitHub call still fails after the last try.
R=$1; pr=$2; minutes=$3
{ [ -n "$R" ] && [ -n "$pr" ] && [ -n "$minutes" ]; } || { echo "usage: wait-ci.sh <owner/repo> <pr> <minutes>"; exit 2; }
case "$minutes" in *[!0-9]*) echo "wait-ci: minutes must be a whole number"; exit 2 ;; esac
interval=${WAIT_CI_INTERVAL:-60}
# A bad reply is tried again a fixed number of times after a fixed short wait, never the poll interval: the land fixer waits at most a few seconds more.
MAX_TRIES=3; RETRY_WAIT=2
polls=$((10#$minutes)); [ "$polls" -gt 9 ] && polls=9; [ "$polls" -lt 1 ] && polls=1

# One read of the head, its check runs and its statuses. A failed request or a reply that is not JSON sets why and returns 1.
# gh's stderr goes to a file, never to the output: its last line is added to the give-up message after a prefix, so no output line starts with the "{" of a JSON error.
errf=$(mktemp) || { echo "wait-ci: cannot make a temporary file" >&2; exit 3; }
trap 'rm -f "$errf"' EXIT
read_ci() {
  head=$(gh api "repos/$R/pulls/$pr" --jq .head.sha 2>"$errf") && [ -n "$head" ] || { why="cannot read #$pr"; return 1; }
  runs=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" 2>"$errf" | jq -s -c '[.[].check_runs[] | {name, status, conclusion, details_url}]' 2>/dev/null; exit "${PIPESTATUS[0]}") && [ -n "$runs" ] || { why="cannot read check runs"; return 1; }
  sts=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100" 2>"$errf" | jq -s -c '[.[].statuses[] | {context, state}]' 2>/dev/null; exit "${PIPESTATUS[0]}") && [ -n "$sts" ] || { why="cannot read statuses"; return 1; }
  return 0
}

i=1; prev=""
while :; do
  tries=0
  while :; do
    tries=$((tries+1))
    read_ci && break
    [ "$tries" -ge "$MAX_TRIES" ] && { last=$(grep -v '^[[:space:]]*$' "$errf" | tail -n 1); echo "wait-ci: $why, gave up after $tries tries${last:+ (last error: $last)}" >&2; exit 3; }
    echo "wait-ci: $why, try $tries of $MAX_TRIES failed, trying again in ${RETRY_WAIT}s" >&2; sleep "$RETRY_WAIT"
  done
  first=false; [ "$head" != "$prev" ] && first=true; prev=$head
  # The rule is scripts/ci-state.jq. A head with no check run waits on its first poll (GitHub creates the runs a few seconds
  # after a push, and an early green status must not end the wait) and, with no status either, for the whole time.
  # Two steps, not one pipe: a failed classifier must not leave an empty line that exits 0 with no record.
  ci=$(jq -n -c --argjson r "$runs" --argjson s "$sts" '{runs: $r, statuses: $s}' | jq -c -f "$(dirname "$0")/ci-state.jq") && [ -n "$ci" ] || { echo "wait-ci: unreadable answer from GitHub" >&2; exit 3; }
  line=$(jq -c --arg head "$head" --argjson first "$first" --argjson nostatus "$(jq 'length == 0' <<<"$sts")" '
        (.state == "noRuns") as $nr
        | (($nostatus or $first) | not) as $ready
        | {head: $head, state: (if $nr and ($ready | not) then "pending" else .state end), failed: .failed}
        + (if $nr and $ready then {noRuns: true} else {} end)' <<<"$ci") && [ -n "$line" ] || { echo "wait-ci: unreadable answer from GitHub" >&2; exit 3; }
  if [ "$(jq -r .state <<<"$line")" != pending ]; then jq -c '. + {timedOut: false}' <<<"$line"; exit 0; fi
  [ "$i" -ge "$polls" ] && { [ "$first" = false ] || [ "$(jq length <<<"$runs")" != 0 ] || [ "$i" -gt "$polls" ]; } && break
  i=$((i+1)); sleep "$interval"
done
jq -c '. + {timedOut: true}' <<<"$line"
