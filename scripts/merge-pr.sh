#!/bin/bash
# usage: merge-pr.sh <owner/repo> <pr> <head sha> <branch>
# Squash-merges only if the PR is mergeable, its head is the checked commit, a review bot approved
# and no check failed. Deletes the branch only after GitHub shows MERGED.
R=$1; pr=$2; sha=$3; branch=$4
[ -n "$branch" ] || { echo "usage: merge-pr.sh <owner/repo> <pr> <head sha> <branch>"; exit 2; }
for _ in 1 2 3 4 5 6; do
  m=$(gh pr view "$pr" -R "$R" --json mergeable --jq .mergeable)
  [ "$m" != "UNKNOWN" ] && break
  sleep 5
done
head=$(gh pr view "$pr" -R "$R" --json headRefOid --jq .headRefOid)
appr=$(gh pr view "$pr" -R "$R" --json reviews --jq '[.reviews[]|select(.state=="APPROVED")|.author.login]|unique|join(",")')
fail=$(gh pr checks "$pr" -R "$R" --json name,bucket --jq '[.[]|select(.bucket=="fail")|.name]|join(",")')
echo "PR $pr mergeable=$m head=${head:0:7} approved=[$appr] failing=[$fail]"
if [ "$m" != "MERGEABLE" ] || [ "$head" != "$sha" ] || [ -z "$appr" ] || [ -n "$fail" ]; then
  echo "PR $pr NOT merged"; exit 1
fi
gh pr merge "$pr" -R "$R" --squash --match-head-commit "$sha"
sleep 3
state=$(gh pr view "$pr" -R "$R" --json state --jq .state)
echo "PR $pr state=$state"
[ "$state" = "MERGED" ] && git push -q "https://github.com/$R.git" --delete "$branch" && echo "deleted $branch"
