#!/bin/bash
# usage: merge-pr.sh <owner/repo> <pr> <head sha> <branch>
# Squash-merges only if the PR is mergeable, its head is <head sha> (the commit the pipeline checked),
# every check passed (and there is at least one), and a review bot (BOT_LOGINS regex, default
# coderabbit|gitar|[bot]) clears bot-approval.jq. Deletes the branch only after GitHub shows MERGED.
R=$1; pr=$2; sha=$3; branch=$4
[ -n "$branch" ] || { echo "usage: merge-pr.sh <owner/repo> <pr> <head sha> <branch>"; exit 2; }
for _ in 1 2 3 4 5 6; do
  m=$(gh pr view "$pr" -R "$R" --json mergeable --jq .mergeable)
  [ "$m" != "UNKNOWN" ] && break
  sleep 5
done
head=$(gh pr view "$pr" -R "$R" --json headRefOid --jq .headRefOid)
bots="${BOT_LOGINS:-coderabbit|gitar|\\[bot\\]}"
appr=$(jq -n --arg head "$head" --arg bots "$bots" \
  --slurpfile reviews <(gh api --paginate "repos/$R/pulls/$pr/reviews?per_page=100") \
  --slurpfile comments <(gh api --paginate "repos/$R/pulls/$pr/comments?per_page=100") \
  --slurpfile checks <(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" --jq '.check_runs') \
  '{reviews: ($reviews | add // []), comments: ($comments | add // []), checks: ($checks | add // []), head: $head, bots: $bots}' \
  | jq -f "$(dirname "$0")/bot-approval.jq" | jq -r 'join(",")')
fail=$(gh pr checks "$pr" -R "$R" --json name,bucket --jq 'if length==0 then "no-checks" else [.[]|select(.bucket!="pass" and .bucket!="skipping")|.name+":"+.bucket]|join(",") end')
echo "PR $pr mergeable=$m head=${head:0:7} approved=[$appr] failing=[$fail]"
if [ "$m" != "MERGEABLE" ] || [ "$head" != "$sha" ] || [ -z "$appr" ] || [ -n "$fail" ]; then
  echo "PR $pr NOT merged"; exit 1
fi
gh pr merge "$pr" -R "$R" --squash --match-head-commit "$sha"
sleep 3
state=$(gh pr view "$pr" -R "$R" --json state --jq .state)
echo "PR $pr state=$state"
[ "$state" = "MERGED" ] && git push -q "https://github.com/$R.git" --delete "$branch" && echo "deleted $branch"
