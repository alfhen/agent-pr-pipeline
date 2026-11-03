#!/bin/bash
# usage: wait-bots.sh <owner/repo> <pr> <minutes>
# Polls bot-status.sh once a minute inside one command and prints the last status line with "timedOut" added.
# Stops when seenHead is not empty or the time is up, and exits 0 either way. One call waits at most 9 minutes, so it fits
# in one shell command (the Bash tool kills a call at 10 minutes). WAIT_BOTS_INTERVAL: seconds between polls (default 60).
# Exits 1 when bot-status.sh fails.
R=$1; pr=$2; minutes=$3
{ [ -n "$R" ] && [ -n "$pr" ] && [ -n "$minutes" ]; } || { echo "usage: wait-bots.sh <owner/repo> <pr> <minutes>"; exit 2; }
case "$minutes" in *[!0-9]*) echo "wait-bots: minutes must be a whole number"; exit 2 ;; esac
here=$(dirname "$0")
interval=${WAIT_BOTS_INTERVAL:-60}
polls=$((10#$minutes)); [ "$polls" -gt 9 ] && polls=9; [ "$polls" -lt 1 ] && polls=1

i=1
while :; do
  status=$(bash "$here/bot-status.sh" "$R" "$pr") || { echo "wait-bots: bot-status failed" >&2; exit 1; }
  if [ "$(jq '.seenHead | length' <<<"$status")" -gt 0 ]; then
    jq -c '. + {timedOut: false}' <<<"$status"; exit 0
  fi
  [ "$i" -ge "$polls" ] && break
  i=$((i+1)); sleep "$interval"
done
jq -c '. + {timedOut: true}' <<<"$status"
