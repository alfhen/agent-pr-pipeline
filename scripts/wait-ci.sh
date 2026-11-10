#!/bin/bash
# usage: wait-ci.sh <owner/repo> <pr> <minutes>
# Polls the PR head's check runs and commit statuses once a minute and prints one JSON line:
# A head with no check runs counts as pending on the first poll of that head: GitHub creates them a few seconds after a push, and an early
# green status must not end the wait. A head with only statuses is accepted from the second poll of that head on.
# head, state (pending, success, failure), failed (names), timedOut. Stops when nothing is pending or the time is up.
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
read_ci() {
  head=$(gh api "repos/$R/pulls/$pr" --jq .head.sha 2>/dev/null) && [ -n "$head" ] || { why="cannot read #$pr"; return 1; }
  runs=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" 2>/dev/null | jq -s -c '[.[].check_runs[] | {name, status, conclusion}]' 2>/dev/null; exit "${PIPESTATUS[0]}") && [ -n "$runs" ] || { why="cannot read check runs"; return 1; }
  sts=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100" 2>/dev/null | jq -s -c '[.[].statuses[] | {context, state}]' 2>/dev/null; exit "${PIPESTATUS[0]}") && [ -n "$sts" ] || { why="cannot read statuses"; return 1; }
  return 0
}

i=1; prev=""
while :; do
  tries=0
  while :; do
    tries=$((tries+1))
    read_ci && break
    [ "$tries" -ge "$MAX_TRIES" ] && { echo "wait-ci: $why, gave up after $tries tries" >&2; exit 3; }
    echo "wait-ci: $why, try $tries of $MAX_TRIES failed, trying again in ${RETRY_WAIT}s" >&2; sleep "$RETRY_WAIT"
  done
  first=false; [ "$head" != "$prev" ] && first=true; prev=$head
  # Only failure, timed_out and action_required fail a check run: the same set as land-wave.sh. A cancelled or stale run does not.
  line=$(jq -n -c --arg head "$head" --argjson r "$runs" --argjson s "$sts" --argjson first "$first" '
    ([$r[] | select(.status != "completed")] + [$s[] | select(.state == "pending")] | length) as $inflight
    | (if ($r | length) == 0 and ($s | length) == 0 then 1 elif ($r | length) == 0 and $first then 1 else $inflight end) as $pending
    | ([$r[] | select(.conclusion | IN("failure", "timed_out", "action_required")) | .name]
       + [$s[] | select(.state | IN("failure", "error")) | .context]) as $failed
    | {head: $head, state: (if ($failed | length) > 0 then "failure" elif $pending > 0 then "pending" else "success" end), failed: $failed}') || { echo "wait-ci: unreadable answer from GitHub" >&2; exit 3; }
  if [ "$(jq -r .state <<<"$line")" != pending ]; then jq -c '. + {timedOut: false}' <<<"$line"; exit 0; fi
  [ "$i" -ge "$polls" ] && { [ "$first" = false ] || [ "$(jq length <<<"$runs")" != 0 ] || [ "$i" -gt "$polls" ]; } && break
  i=$((i+1)); sleep "$interval"
done
jq -c '. + {timedOut: true}' <<<"$line"
