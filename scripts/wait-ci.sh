#!/bin/bash
# usage: wait-ci.sh <owner/repo> <pr> <minutes>
# Polls the PR head's check runs and commit statuses once a minute and prints one JSON line:
# A head with no check runs yet counts as pending: GitHub creates them a few seconds after a push.
# head, state (pending, success, failure), failed (names), timedOut. Stops when nothing is pending or the time is up.
# One call waits at most 9 minutes, so it fits in one shell command. WAIT_CI_INTERVAL: seconds between polls (default 60).
# Exits 0 with the line, 2 on bad usage, 3 when a GitHub call fails.
R=$1; pr=$2; minutes=$3
{ [ -n "$R" ] && [ -n "$pr" ] && [ -n "$minutes" ]; } || { echo "usage: wait-ci.sh <owner/repo> <pr> <minutes>"; exit 2; }
case "$minutes" in *[!0-9]*) echo "wait-ci: minutes must be a whole number"; exit 2 ;; esac
interval=${WAIT_CI_INTERVAL:-60}
polls=$((10#$minutes)); [ "$polls" -gt 9 ] && polls=9; [ "$polls" -lt 1 ] && polls=1

i=1
while :; do
  head=$(gh api "repos/$R/pulls/$pr" --jq .head.sha) || { echo "wait-ci: cannot read #$pr" >&2; exit 3; }
  runs=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" | jq -s -c '[.[].check_runs[] | {name, status, conclusion}]'; exit "${PIPESTATUS[0]}") || { echo "wait-ci: cannot read check runs" >&2; exit 3; }
  sts=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100" | jq -s -c '[.[].statuses[] | {context, state}]'; exit "${PIPESTATUS[0]}") || { echo "wait-ci: cannot read statuses" >&2; exit 3; }
  line=$(jq -n -c --arg head "$head" --argjson r "$runs" --argjson s "$sts" '
    ([$r[] | select(.status != "completed")] + [$s[] | select(.state == "pending")] | length) as $inflight
    | (if ($r | length) == 0 then 1 else $inflight end) as $pending
    | ([$r[] | select(.status == "completed" and (.conclusion | IN("success", "neutral", "skipped") | not)) | .name]
       + [$s[] | select(.state | IN("failure", "error")) | .context]) as $failed
    | {head: $head, state: (if ($failed | length) > 0 then "failure" elif $pending > 0 then "pending" else "success" end), failed: $failed}') || { echo "wait-ci: unreadable answer from GitHub" >&2; exit 3; }
  if [ "$(jq -r .state <<<"$line")" != pending ]; then jq -c '. + {timedOut: false}' <<<"$line"; exit 0; fi
  [ "$i" -ge "$polls" ] && break
  i=$((i+1)); sleep "$interval"
done
jq -c '. + {timedOut: true}' <<<"$line"
