#!/bin/bash
# usage: bot-status.sh <owner/repo> <pr>
# Prints one JSON line: {"head", "approvedBy", "seenHead", "pending", "openThreads", "reviewBodies"}. approvedBy is the output of bot-approval.jq,
# the rule merge-pr.sh uses. seenHead lists the approving bots that looked at the head: their latest review
# is on the head, or their check run on the head has completed. openThreads counts
# the inline threads a bot opened that have no reply. pending lists the bot check runs on the head that have not completed:
# a bot posts its review body just before its check run completes. reviewBodies counts the bot reviews on the head whose
# body can hold a finding: not empty, and not a known no-finding text. It is 0 once an answer comment for the head is on
# the PR: the comment starts with <!-- pipeline-bot-answer head=<sha> --> and is by the account from GET /user (trusted-comment.jq). Exits 1 when a GitHub read fails.
R=$1; pr=$2
[ -n "$pr" ] || { echo "usage: bot-status.sh <owner/repo> <pr>"; exit 2; }
here=$(dirname "$0")
bots="${BOT_LOGINS:-coderabbit|gitar|\\[bot\\]}"
fail() { echo "bot-status: $1" >&2; exit 1; }

tmp=$(mktemp -d) || fail "cannot make a temporary folder"
trap 'rm -rf "$tmp"' EXIT

user=$(gh api user --jq .login) || fail "cannot read GET /user"
[ -n "$user" ] || fail "GET /user returned no login"
pull=$(gh api "repos/$R/pulls/$pr") || fail "cannot read the pull request"
head=$(jq -r .head.sha <<<"$pull") || fail "unexpected pull request answer"
gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" >"$tmp/checks" || fail "cannot read the check runs"
gh api --paginate "repos/$R/pulls/$pr/reviews?per_page=100" >"$tmp/reviews" || fail "cannot read the reviews"
gh api --paginate "repos/$R/pulls/$pr/comments?per_page=100" >"$tmp/comments" || fail "cannot read the review comments"
gh api --paginate "repos/$R/issues/$pr/comments?per_page=100" >"$tmp/issue-comments" || fail "cannot read the PR comments"

# Files and --slurpfile, not --argjson: a busy PR passes the 128 KiB limit of one argument on Linux.
input=$(jq -n -c --arg head "$head" --arg bots "$bots" --slurpfile reviews "$tmp/reviews" --slurpfile comments "$tmp/comments" --slurpfile issue "$tmp/issue-comments" --slurpfile checks "$tmp/checks" \
  '{reviews: ($reviews | add // []), comments: ($comments | add // []), issueComments: ($issue | add // []), checks: [$checks[].check_runs[]], head: $head, bots: $bots}') || fail "cannot build the input"
approved=$(jq -c -f "$here/bot-approval.jq" <<<"$input") || fail "cannot judge the reviews"
seen=$(jq -c --argjson approved "$approved" '. as $in
  | [$approved[] | sub(" \\((answered|approved earlier)\\)$"; "") | . as $login
    | select(([$in.reviews[] | select(.user.login == $login)] | sort_by(.submitted_at) | last | .commit_id) == $in.head
        or ([$in.checks[] | select((.name | ascii_downcase) as $check | .status == "completed" and (($login | ascii_downcase) | contains($check)))] | length) > 0)]' <<<"$input") || fail "cannot judge which bots saw the head"
open=$(jq --arg bots "$bots" '[.comments[] | select(.in_reply_to_id != null) | .in_reply_to_id] as $answered
  | [.comments[] | select(.in_reply_to_id == null and (.user.login | test($bots)) and ([.id] | inside($answered) | not))] | length' <<<"$input") || fail "cannot count the threads"
pending=$(jq -c --arg bots "$bots" '[.checks[] | select(.status != "completed" and (.name | test($bots; "i"))) | .name]' <<<"$input") || fail "cannot list the running bot checks"
answered=$(jq -c --arg prefix "<!-- pipeline-bot-answer head=$head -->" --arg user "$user" --arg all 1 -f "$here/trusted-comment.jq" <<<"$(jq -c .issueComments <<<"$input")") || fail "cannot read the answer comments"
# The known no-finding texts live here. Any other text counts, so an unknown format never hides a finding.
bodies=$(jq --arg bots "$bots" --arg head "$head" --argjson answered "$answered" '
  def clean: gsub("<!--(.|\n)*?-->"; "") | gsub("^\\s+|\\s+$"; "");
  def nofinding: test("has auto-approved this PR"; "i")
    or (test("Actionable comments posted: 0") and (test("Outside diff range|Nitpick|Duplicate comments|comments \\([1-9]"; "i") | not));
  if ($answered | length) > 0 then 0
    else [.reviews[] | select(.commit_id == $head and (.user.login | test($bots))) | (.body // "" | clean) as $b
      | select(($b | length) > 0 and ($b | nofinding | not))] | length end' <<<"$input") || fail "cannot count the review bodies"
jq -n -c --arg head "$head" --argjson approved "$approved" --argjson seen "$seen" --argjson pending "$pending" --argjson open "$open" --argjson bodies "$bodies" '{head: $head, approvedBy: $approved, seenHead: $seen, pending: $pending, openThreads: $open, reviewBodies: $bodies}'
