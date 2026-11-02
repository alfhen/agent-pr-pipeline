#!/bin/bash
# usage: merge-pr.sh [--auto] [--person] <owner/repo> <pr> <head sha> <branch>
# Squash-merges only if the PR is mergeable, its head is <head sha> (the commit the pipeline checked),
# every check run and commit status passed (and there is at least one check run), and a review bot (BOT_LOGINS regex, default
# coderabbit|gitar|[bot]) clears bot-approval.jq. The merge call carries the sha. Deletes the branch
# only after GitHub shows merged: true.
# An agent merge runs gate-files.sh first and needs --auto: that is --auto, or CLAUDECODE set in the shell.
# --person skips only the gate and the --auto requirement, for a merge the maintainer asked for.
auto=0; person=0
while [ "${1#--}" != "$1" ]; do
  case "$1" in
    --auto) auto=1 ;;
    --person) person=1 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
  shift
done
R=$1; pr=$2; sha=$3; branch=$4
[ -n "$branch" ] || { echo "usage: merge-pr.sh [--auto] [--person] <owner/repo> <pr> <head sha> <branch>"; exit 2; }
here=$(dirname "$0")
tries=6; pause=5
[ "$PIPELINE_TEST_FAST" = 1 ] && { tries=1; pause=0; }

mode=person
if [ "$person" = 0 ] && { [ "$auto" = 1 ] || [ -n "$CLAUDECODE" ]; }; then
  bash "$here/gate-files.sh" "$R" "$pr" || { echo "PR $pr NOT merged: the gate holds it, the maintainer merges it"; exit 7; }
  [ "$auto" = 1 ] || { echo "PR $pr NOT merged: an agent merge needs --auto (a :auto land pair); use --person only for a merge the maintainer asked for"; exit 8; }
  mode=auto
fi

for _ in $(seq 1 "$tries"); do
  pull=$(gh api "repos/$R/pulls/$pr") || { echo "PR $pr NOT merged: cannot read the pull request"; exit 1; }
  m=$(jq -r 'if .mergeable == true then "MERGEABLE" elif .mergeable == false then "CONFLICTING" else "UNKNOWN" end' <<<"$pull")
  [ "$m" != "UNKNOWN" ] && break
  sleep "$pause"
done
head=$(jq -r .head.sha <<<"$pull")
bots="${BOT_LOGINS:-coderabbit|gitar|\\[bot\\]}"
checks=$(gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100") || { echo "PR $pr NOT merged: cannot read the check runs"; exit 1; }
runs=$(jq -s -c '[.[].check_runs[]]' <<<"$checks") || { echo "PR $pr NOT merged: unexpected check runs answer"; exit 1; }
stat=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100") || { echo "PR $pr NOT merged: cannot read the commit statuses"; exit 1; }
sts=$(jq -s -c '[.[].statuses[]]' <<<"$stat") || { echo "PR $pr NOT merged: unexpected commit status answer"; exit 1; }
appr=$(jq -n --arg head "$head" --arg bots "$bots" \
  --slurpfile reviews <(gh api --paginate "repos/$R/pulls/$pr/reviews?per_page=100") \
  --slurpfile comments <(gh api --paginate "repos/$R/pulls/$pr/comments?per_page=100") \
  --argjson checks "$runs" \
  '{reviews: ($reviews | add // []), comments: ($comments | add // []), checks: $checks, head: $head, bots: $bots}' \
  | jq -f "$here/bot-approval.jq" | jq -r 'join(",")')
fail=$(jq -r 'if length == 0 then "no-checks" else [.[] | select(.status != "completed" or (.conclusion | IN("success", "skipped", "neutral") | not)) | .name + ":" + (if .status != "completed" then "pending" else .conclusion end)] | join(",") end' <<<"$runs")
sfail=$(jq -r '[.[] | select(.state != "success") | .context + ":" + .state] | join(",")' <<<"$sts")
[ -n "$sfail" ] && fail="${fail:+$fail,}$sfail"
echo "PR $pr mergeable=$m head=${head:0:7} approved=[$appr] failing=[$fail] mode=$mode"
if [ "$m" != "MERGEABLE" ] || [ "$head" != "$sha" ] || [ -z "$appr" ] || [ -n "$fail" ]; then
  echo "PR $pr NOT merged"; exit 1
fi
gh api -X PUT "repos/$R/pulls/$pr/merge" -f merge_method=squash -f sha="$sha" >/dev/null || { echo "PR $pr NOT merged: the merge call failed"; exit 1; }
merged=false
for _ in $(seq 1 "$tries"); do
  merged=$(gh api "repos/$R/pulls/$pr" --jq .merged)
  [ "$merged" = true ] && break
  sleep "$((pause / 2))"
done
echo "PR $pr merged=$merged"
[ "$merged" = true ] || exit 1
gh api -X POST "repos/$R/issues/$pr/comments" -f body="<!-- pipeline:merge-cleared $mode $sha -->" >/dev/null \
  || echo "warning: the merge record comment was not posted"
# The branch comes from the pull, not the caller. Each segment is encoded because gh api reads '#' as a URL fragment.
ref=$(jq -r .head.ref <<<"$pull")
headrepo=$(jq -r '.head.repo.full_name // ""' <<<"$pull")
enc=$(jq -rn --arg b "$ref" '$b | split("/") | map(@uri) | join("/")')
if [ "$headrepo" != "$R" ]; then
  echo "clean-up: $ref is not in $R, not deleted"
elif gh api -X DELETE "repos/$R/git/refs/heads/$enc" >/dev/null 2>&1; then
  echo "clean-up: deleted $ref"
elif ! gh api "repos/$R/git/ref/heads/$enc" >/dev/null 2>&1; then
  echo "clean-up: $ref already gone"
else
  echo "clean-up: could not delete $ref (the PR is merged)"
fi
