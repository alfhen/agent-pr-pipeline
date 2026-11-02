#!/bin/bash
# usage: merge-pr.sh <owner/repo> <pr> <head sha> <branch>
# Squash-merges only if the PR is mergeable, its head is <head sha> (the commit the pipeline checked),
# every check passed (and there is at least one), and the latest review by a bot login (BOT_LOGINS regex,
# default coderabbit|gitar|[bot]) is APPROVED. Deletes the branch only after GitHub shows MERGED.
R=$1; pr=$2; sha=$3; branch=$4
[ -n "$branch" ] || { echo "usage: merge-pr.sh <owner/repo> <pr> <head sha> <branch>"; exit 2; }
for _ in 1 2 3 4 5 6; do
  m=$(gh pr view "$pr" -R "$R" --json mergeable --jq .mergeable)
  [ "$m" != "UNKNOWN" ] && break
  sleep 5
done
head=$(gh pr view "$pr" -R "$R" --json headRefOid --jq .headRefOid)
export BOTS_RE="${BOT_LOGINS:-coderabbit|gitar|\\[bot\\]}"
appr=$(gh pr view "$pr" -R "$R" --json reviews --jq '[.reviews|group_by(.author.login)[]|last|select(.state=="APPROVED" and (.author.login|test(env.BOTS_RE)))|.author.login]|join(",")')
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
