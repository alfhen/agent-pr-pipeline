#!/bin/bash
# usage: bot-status.sh <owner/repo> <pr>
# Prints one JSON line: {"head", "approvedBy", "seenHead", "openThreads"}. approvedBy is the output of bot-approval.jq,
# the rule merge-pr.sh uses. seenHead lists the approving bots that looked at the head: their latest review
# is on the head, or their check run on the head has completed. openThreads counts
# the inline threads a bot opened that have no reply. Exits 1 when a GitHub read fails.
R=$1; pr=$2
[ -n "$pr" ] || { echo "usage: bot-status.sh <owner/repo> <pr>"; exit 2; }
here=$(dirname "$0")
bots="${BOT_LOGINS:-coderabbit|gitar|\\[bot\\]}"
fail() { echo "bot-status: $1" >&2; exit 1; }

tmp=$(mktemp -d) || fail "cannot make a temporary folder"
trap 'rm -rf "$tmp"' EXIT

pull=$(gh api "repos/$R/pulls/$pr") || fail "cannot read the pull request"
head=$(jq -r .head.sha <<<"$pull") || fail "unexpected pull request answer"
gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" >"$tmp/checks" || fail "cannot read the check runs"
gh api --paginate "repos/$R/pulls/$pr/reviews?per_page=100" >"$tmp/reviews" || fail "cannot read the reviews"
gh api --paginate "repos/$R/pulls/$pr/comments?per_page=100" >"$tmp/comments" || fail "cannot read the review comments"

# Files and --slurpfile, not --argjson: a busy PR passes the 128 KiB limit of one argument on Linux.
input=$(jq -n -c --arg head "$head" --arg bots "$bots" --slurpfile reviews "$tmp/reviews" --slurpfile comments "$tmp/comments" --slurpfile checks "$tmp/checks" \
  '{reviews: ($reviews | add // []), comments: ($comments | add // []), checks: [$checks[].check_runs[]], head: $head, bots: $bots}') || fail "cannot build the input"
approved=$(jq -c -f "$here/bot-approval.jq" <<<"$input") || fail "cannot judge the reviews"
seen=$(jq -c --argjson approved "$approved" '. as $in
  | [$approved[] | sub(" \\((answered|approved earlier)\\)$"; "") | . as $login
    | select(([$in.reviews[] | select(.user.login == $login)] | sort_by(.submitted_at) | last | .commit_id) == $in.head
        or ([$in.checks[] | select((.name | ascii_downcase) as $check | .status == "completed" and (($login | ascii_downcase) | contains($check)))] | length) > 0)]' <<<"$input") || fail "cannot judge which bots saw the head"
open=$(jq --arg bots "$bots" '[.comments[] | select(.in_reply_to_id != null) | .in_reply_to_id] as $answered
  | [.comments[] | select(.in_reply_to_id == null and (.user.login | test($bots)) and ([.id] | inside($answered) | not))] | length' <<<"$input") || fail "cannot count the threads"
jq -n -c --arg head "$head" --argjson approved "$approved" --argjson seen "$seen" --argjson open "$open" '{head: $head, approvedBy: $approved, seenHead: $seen, openThreads: $open}'
