#!/bin/bash
# usage: bot-status.sh <owner/repo> <pr>
# Prints one JSON line: {"head", "approvedBy", "seenHead", "finishedOnHead", "pending", "openThreads", "reviewBodies"}. approvedBy is the output of bot-approval.jq,
# the rule merge-pr.sh uses. seenHead lists the approving bots that looked at the head: their latest review
# is on the head, or their check run on the head has completed. finishedOnHead lists each configured bot (BOT_LOGINS), approved or not,
# whose latest review is on the head or whose own check run on the head completed with a conclusion other than skipped (a bot that reviews only on request has a skipped run on every PR). openThreads counts
# the inline threads a bot opened that have no reply of that bot or of the user from GET /user. pending lists the bot check runs on the head that have not completed:
# a bot posts its review body just before its check run completes. reviewBodies counts the bot reviews on the head whose
# body can hold a finding: not empty, and not a known no-finding text. A review whose id is in the second line of a trusted
# answer comment of the head, <!-- pipeline-reviews <id>,<id> -->, is not counted. Such a comment starts with <!-- pipeline-bot-answer head=<sha> --> and is by the account from GET /user (trusted-comment.jq). A comment with no such line lists no review. Times are not compared. Exits 1 when a GitHub read fails.
R=$1; pr=$2
[ -n "$pr" ] || { echo "usage: bot-status.sh <owner/repo> <pr>"; exit 2; }
here=$(dirname "$0")
bots="${BOT_LOGINS:-coderabbitai[bot],gitar-bot[bot]}"
fail() { printf '\nbot-status: %s\n' "$1" >&2; exit 1; }
IFS=, read -ra logins <<<"$bots,"
for l in "${logins[@]}"; do
  [[ "$l" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || { echo "bot-status: BOT_LOGINS must be a comma-separated list of logins (letters, digits and hyphens, with or without the ending [bot]), got: $bots" >&2; exit 2; }
done

tmp=$(mktemp -d) || fail "cannot make a temporary folder"
trap 'rm -rf "$tmp"' EXIT

user=$(gh api user --jq .login) || fail "cannot read GET /user"
[ -n "$user" ] || fail "GET /user returned no login"
pull=$(gh api "repos/$R/pulls/$pr") || fail "cannot read the pull request"
head=$(jq -r .head.sha <<<"$pull") || fail "unexpected pull request answer"
gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" >"$tmp/checks" || fail "cannot read the check runs"
gh api --paginate "repos/$R/commits/$head/check-suites?per_page=100" >"$tmp/suites" || fail "cannot read the check suites"
gh api --paginate "repos/$R/pulls/$pr/reviews?per_page=100" >"$tmp/reviews" || fail "cannot read the reviews"
gh api --paginate "repos/$R/pulls/$pr/comments?per_page=100" >"$tmp/comments" || fail "cannot read the review comments"
gh api --paginate "repos/$R/issues/$pr/comments?per_page=100" >"$tmp/issue-comments" || fail "cannot read the PR comments"

# Files and --slurpfile, not --argjson: a busy PR passes the 128 KiB limit of one argument on Linux.
input=$(jq -n -c --arg head "$head" --argjson bots "$(jq -n -c --arg b "$bots" '$b | split(",")')" --arg user "$user" --slurpfile reviews "$tmp/reviews" --slurpfile comments "$tmp/comments" --slurpfile issue "$tmp/issue-comments" --slurpfile checks "$tmp/checks" --slurpfile suites "$tmp/suites" \
  '{reviews: ($reviews | add // []), comments: ($comments | add // []), issueComments: ($issue | add // []), suites: [$suites[].check_suites[]], checks: [$checks[].check_runs[]], head: $head, bots: $bots, user: $user}') || fail "cannot build the input"
approved=$(jq -c -f "$here/bot-approval.jq" <<<"$input") || fail "cannot judge the reviews"
seen=$(jq -c --argjson approved "$approved" '. as $in
  | [$approved[] | sub(" \\((answered|approved earlier|clean review)\\)$"; "") | . as $login
    | select(([$in.reviews[] | select(.user.login == $login)] | sort_by(.submitted_at) | last | .commit_id) == $in.head
        or ([$in.checks[] | select(.status == "completed" and (.app.slug // "") != "" and (.app.slug + "[bot]") == $login)] | length) > 0)]' <<<"$input") || fail "cannot judge which bots saw the head"
finished=$(jq -c '. as $in | [$in.bots[] | select(. != "") | . as $login
  | select(([$in.reviews[] | select(.user.login == $login)] | sort_by(.submitted_at) | last | .commit_id) == $in.head
      or ([$in.checks[] | select(.status == "completed" and .conclusion != "skipped" and (.app.slug // "") != "" and (.app.slug + "[bot]") == $login)] | length) > 0)]' <<<"$input") || fail "cannot judge which bots finished on the head"
open=$(jq --arg user "$user" '. as $in | def answered($t): any($in.comments[]; .in_reply_to_id == $t.id and (.user.login == $t.user.login or .user.login == $user));
  [.comments[] | select(.in_reply_to_id == null and (.user.login | IN($in.bots[])) and (answered(.) | not))] | length' <<<"$input") || fail "cannot count the threads"
pending=$(jq -c '. as $in | [.checks[] | select(.status != "completed" and (.app.slug // "") != "" and ((.app.slug + "[bot]") | IN($in.bots[]))) | .name]' <<<"$input") || fail "cannot list the running bot checks"
answered=$(jq -c --arg prefix "<!-- pipeline-bot-answer head=$head -->" --arg user "$user" --arg all 1 -f "$here/trusted-comment.jq" <<<"$(jq -c .issueComments <<<"$input")") || fail "cannot read the answer comments"
# The no-finding rule is in review-request.jq. A review counts unless a trusted answer comment lists its id on its second line.
bodies=$(jq -L "$here" --arg head "$head" --argjson answered "$answered" 'include "review-request";
  . as $in
  | [$answered[] | split("\n")[1] // "" | rtrimstr("\r") | capture("^<!-- pipeline-reviews (?<ids>[0-9]+(,[0-9]+)*) -->$") | .ids | split(",")[]] as $listed
  | [.reviews[] | select(.commit_id == $head and (.user.login | IN($in.bots[]))) | select((.id | tostring) as $id | $listed | index($id) | not) | (.body // "" | stripComments) as $b
    | select(($b | length) > 0 and ($b | nofinding | not))] | length' <<<"$input") || fail "cannot count the review bodies"
jq -n -c --arg head "$head" --argjson approved "$approved" --argjson seen "$seen" --argjson finished "$finished" --argjson pending "$pending" --argjson open "$open" --argjson bodies "$bodies" '{head: $head, approvedBy: $approved, seenHead: $seen, finishedOnHead: $finished, pending: $pending, openThreads: $open, reviewBodies: $bodies}'
