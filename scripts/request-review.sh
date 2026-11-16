#!/bin/bash
# usage: request-review.sh <owner/repo> <pr> <head sha>
# Asks CodeRabbit for a review of the head and follows the run. The request, push-time and completed-review rules are in
# review-request.jq. Counts the requests from GitHub (comments of the user from GET /user after the push), posts at most two for a
# head, and never sooner than 64 minutes after the newest request of the user on any PR of the repo.
# Prints WAIT <seconds> #<pr> before a wait, then "REVIEWED #<pr> run <id>" (exit 0) or "NO REVIEW #<pr>: <cause>" (exit 1).
# PIPELINE_TEST_FAST=1 makes the sleeps and the polls short; the WAIT number stays real.
R=$1; pr=$2; sha=$3
[ -n "$sha" ] || { echo "usage: request-review.sh <owner/repo> <pr> <head sha>"; exit 2; }
here=$(dirname "$0")
APP=coderabbitai
gap=3840; window=2700; pause=30; tries=0
[ "$PIPELINE_TEST_FAST" = 1 ] && { pause=0; tries=5; }
no_review() { echo "NO REVIEW #$pr: $1"; exit 1; }
tmp=$(mktemp -d) || no_review "cannot make a temporary folder"
trap 'rm -rf "$tmp"' EXIT
# Dates are compared as epoch seconds, so a fraction of a second in a fixture or an answer cannot change the order.
epoch='def t: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;'

pull=$(gh api "repos/$R/pulls/$pr") || no_review "cannot read the pull request"
head=$(jq -r .head.sha <<<"$pull") || no_review "unexpected pull request answer"
[ "$head" = "$sha" ] || no_review "the head is ${head:0:7}, not the checked ${sha:0:7}"
user=$(gh api user --jq .login) && [ -n "$user" ] || no_review "cannot read the user from GET /user"
gh api --paginate "repos/$R/commits/$sha/check-suites?per_page=100" >"$tmp/suites" || no_review "cannot read the check suites"
push=$(jq -s -r -L "$here" 'include "review-request"; pushTime([.[].check_suites[]]) // ""' "$tmp/suites") || no_review "cannot read the push time"
[ -n "$push" ] || no_review "the head has no check suite, so there is no push time"
count=0; mine=0; any=0
# Reads the requests again at every call, so a request made by hand while the script waits is counted. Keeps the larger values.
refresh() {
  local c m a
  gh api --paginate "repos/$R/issues/$pr/comments?per_page=100" >"$tmp/pr-comments" || no_review "cannot read the comments of the pull request"
  local since
  since=$(jq -n -r 'now - 3900 | todate')
  gh api --paginate "repos/$R/issues/comments?since=$since&sort=created&direction=desc&per_page=100" >"$tmp/repo-comments" || no_review "cannot read the comments of the repo"
  read -r c m a <<<"$(jq -n -r -L "$here" --arg user "$user" --arg push "$push" --slurpfile pc "$tmp/pr-comments" --slurpfile rc "$tmp/repo-comments" \
    "include \"review-request\"; $epoch"'
    ($pc | add // []) as $c | ($rc | add // []) as $r | ($push | t) as $p
    | [$c[] | select(isRequest($user) and (.created_at | t) > $p) | .created_at | t] | sort as $mine
    | [($c + $r)[] | select(isRequest($user)) | .created_at | t] as $all
    | "\($mine | length) \($mine | last // 0) \($all | max // 0)"')" || no_review "cannot count the requests"
  [ -n "$a" ] || no_review "cannot count the requests"
  [ "$c" -gt "$count" ] && count=$c
  [ "$m" -gt "$mine" ] && mine=$m
  [ "$a" -gt "$any" ] && any=$a
  return 0
}
refresh
text=$(jq -n -r -L "$here" 'include "review-request"; requestText') || no_review "cannot read the request text"

post_request() {
  local now secs out want=$((count + 1)) waited=-1
  while :; do
    refresh
    [ "$count" -ge "$want" ] && return 0
    now=$(date -u +%s)
    secs=$((any + gap - now))
    [ "$secs" -le 0 ] && break
    # In test mode the sleep is skipped, so an unchanged newest request ends the loop.
    [ "$any" = "$waited" ] && break
    echo "WAIT $secs #$pr"
    [ "$PIPELINE_TEST_FAST" = 1 ] || sleep "$secs"
    waited=$any
  done
  # The wait can last an hour, so a push during it must not get a request for the old head.
  head=$(gh api "repos/$R/pulls/$pr" --jq .head.sha) || no_review "cannot read the pull request"
  [ "$head" = "$sha" ] || no_review "the head is ${head:0:7}, not the checked ${sha:0:7}"
  out=$(gh api -X POST "repos/$R/issues/$pr/comments" -f body="$text") || no_review "cannot post the request"
  mine=$(jq -r "$epoch"' .created_at | t' <<<"$out" 2>/dev/null) && [ -n "$mine" ] || no_review "the answer to the request has no created_at"
  any=$mine
  count=$want
}

# Sets run_id and run_kind: reviewed, bad (a run that is no completed review), late (a run that did not complete) or none.
follow() {
  local q=$1 i=0 run now expired
  while :; do
    i=$((i + 1))
    gh api --paginate "repos/$R/commits/$sha/check-runs?per_page=100" >"$tmp/runs" || no_review "cannot read the check runs"
    run=$(jq -s -c -L "$here" --argjson q "$q" --argjson window "$window" --arg app "$APP" "include \"review-request\"; $epoch"'
      [.[].check_runs[] | select((.app.slug // "") == $app and .started_at != null and (.started_at | t) > $q and (.started_at | t) < $q + $window)]
      | sort_by(.started_at | t) | last // null' "$tmp/runs") || no_review "cannot read the check runs"
    now=$(date -u +%s)
    expired=0
    { [ "$now" -ge $((q + window)) ] || { [ "$tries" -gt 0 ] && [ "$i" -ge "$tries" ]; }; } && expired=1
    run_id=$(jq -r '.id // ""' <<<"$run")
    if [ "$run" = null ]; then
      run_kind=none
    elif [ "$(jq -r .status <<<"$run")" != completed ]; then
      run_kind=late
    elif jq -e -L "$here" 'include "review-request"; completedReview' <<<"$run" >/dev/null; then
      run_kind=reviewed; return 0
    else
      run_kind=bad
      run_what=$(jq -r '"\(.conclusion // "") \(.output.title // "")"' <<<"$run")
      return 0
    fi
    [ "$expired" = 1 ] && return 0
    sleep "$pause"
  done
}

[ "$count" = 0 ] && post_request
while :; do
  follow "$mine"
  case $run_kind in
    reviewed) echo "REVIEWED #$pr run $run_id"; exit 0 ;;
    late) no_review "run $run_id started after request $count and did not complete in 45 minutes" ;;
  esac
  cause="no run of the bot started in 45 minutes after request $count"
  [ "$run_kind" = bad ] && cause="run $run_id after request $count is not a completed review ($run_what)"
  [ "$count" -ge 2 ] && no_review "two requests and no completed review: $cause"
  post_request
done
