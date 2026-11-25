#!/bin/bash
# usage: merge-pr.sh [--auto] [--person] <owner/repo> <pr> <head sha> <branch>
# Squash-merges only if the PR is mergeable, its head is <head sha> (the commit the pipeline checked),
# every check run and commit status passed (and there is at least one check run), and a review bot (BOT_LOGINS, a comma-separated
# list of exact logins, default coderabbitai[bot],gitar-bot[bot]) clears bot-approval.jq (four ways: an approval on the head, an approval
# on an older commit, answered comments on an older commit, or a clean CodeRabbit review that was asked for after the push). The merge call carries the sha. Deletes the branch
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
bots="${BOT_LOGINS:-coderabbitai[bot],gitar-bot[bot]}"
IFS=, read -ra logins <<<"$bots,"
for l in "${logins[@]}"; do
  [[ "$l" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || { echo "BOT_LOGINS must be a comma-separated list of logins (letters, digits and hyphens, with or without the ending [bot]), got: $bots"; exit 2; }
done
[ "$PIPELINE_TEST_FAST" = 1 ] && { tries=1; pause=0; }

mode=person
if [ "$person" = 0 ] && { [ "$auto" = 1 ] || [ -n "$CLAUDECODE" ]; }; then
  bash "$here/gate-files.sh" "$R" "$pr"; gate=$?
  if [ "$gate" = 3 ]; then echo "PR $pr NOT merged: the gate could not run, the maintainer merges it"; exit 7; fi
  [ "$gate" = 0 ] || { echo "PR $pr NOT merged: the gate holds it, the maintainer merges it"; exit 7; }
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
tmp=$(mktemp -d) || { echo "PR $pr NOT merged: cannot make a temporary folder"; exit 1; }
trap 'rm -rf "$tmp"' EXIT
user=$(gh api user --jq .login) && [ -n "$user" ] || { echo "PR $pr NOT merged: cannot read the user"; exit 1; }
gh api --paginate "repos/$R/commits/$head/check-runs?per_page=100" >"$tmp/checks" || { echo "PR $pr NOT merged: cannot read the check runs"; exit 1; }
gh api --paginate "repos/$R/pulls/$pr/reviews?per_page=100" >"$tmp/reviews" || { echo "PR $pr NOT merged: cannot read the reviews"; exit 1; }
gh api --paginate "repos/$R/pulls/$pr/comments?per_page=100" >"$tmp/comments" || { echo "PR $pr NOT merged: cannot read the review comments"; exit 1; }
gh api --paginate "repos/$R/issues/$pr/comments?per_page=100" >"$tmp/issue-comments" || { echo "PR $pr NOT merged: cannot read the PR comments"; exit 1; }
gh api --paginate "repos/$R/commits/$head/check-suites?per_page=100" >"$tmp/suites" || { echo "PR $pr NOT merged: cannot read the check suites"; exit 1; }
runs=$(jq -s -c '[.[].check_runs[] | {name, status, conclusion, started_at, head_sha, app: {slug: .app.slug}, output: {title: .output.title, summary: ((.output.summary // "")[0:200])}}]' "$tmp/checks") || { echo "PR $pr NOT merged: unexpected check runs answer"; exit 1; }
stat=$(gh api --paginate "repos/$R/commits/$head/status?per_page=100") || { echo "PR $pr NOT merged: cannot read the commit statuses"; exit 1; }
sts=$(jq -s -c '[.[].statuses[] | {context, state}]' <<<"$stat") || { echo "PR $pr NOT merged: unexpected commit status answer"; exit 1; }
# Files and --slurpfile, not --argjson: a busy PR passes the 128 KiB limit of one argument on Linux.
# A write that fails must stop here: a missing status list would read as no failed status.
echo "$runs" >"$tmp/runs" || { echo "PR $pr NOT merged: cannot write the check runs"; exit 1; }
input=$(jq -n -c --arg head "$head" --argjson bots "$(jq -n -c --arg b "$bots" '$b | split(",")')" --arg user "$user" --slurpfile reviews "$tmp/reviews" --slurpfile comments "$tmp/comments" --slurpfile checks "$tmp/runs" --slurpfile issue "$tmp/issue-comments" --slurpfile suites "$tmp/suites" \
  '{reviews: ($reviews | add // []), comments: ($comments | add // []), issueComments: ($issue | add // []), suites: [$suites[].check_suites[]], checks: $checks[0], head: $head, bots: $bots, user: $user}') || { echo "PR $pr NOT merged: cannot build the bot input"; exit 1; }
approved=$(jq -c -f "$here/bot-approval.jq" <<<"$input") || { echo "PR $pr NOT merged: cannot judge the reviews"; exit 1; }
appr=$(jq -r 'join(",")' <<<"$approved")
# The rule is ci-state.jq. The suffix of each name (the conclusion or state) is only for the message.
echo "$sts" >"$tmp/sts" || { echo "PR $pr NOT merged: cannot write the commit statuses"; exit 1; }
ci=$(jq -n -c --slurpfile r "$tmp/runs" --slurpfile s "$tmp/sts" '{runs: $r[0], statuses: $s[0]}' | jq -c -f "$here/ci-state.jq") && [ -n "$ci" ] || { echo "PR $pr NOT merged: cannot judge the check runs"; exit 1; }
fail=$(jq -r --slurpfile r "$tmp/runs" --slurpfile s "$tmp/sts" '
  [.failed[], .pending[]] as $bad
  | ($bad | map(. as $n | first(($r[0][] | select(.name == $n) | .name + ":" + (if .status != "completed" then "pending" else .conclusion end)),
                                ($s[0][] | select(.context == $n) | .context + ":" + .state)) // $n)) as $named
  | (if .noRuns then ["no-checks"] else [] end) + $named | join(",")' <<<"$ci") || { echo "PR $pr NOT merged: cannot judge the check runs"; exit 1; }
echo "PR $pr mergeable=$m head=${head:0:7} approved=[$appr] failing=[$fail] mode=$mode"
if [ -z "$appr" ]; then
  why=$(jq -r --arg why 1 -f "$here/bot-approval.jq" <<<"$input") || { echo "PR $pr NOT merged: cannot judge the clean review"; exit 1; }
  [ -n "$why" ] && echo "$why"
fi
if [ "$m" != "MERGEABLE" ] || [ "$head" != "$sha" ] || [ -z "$appr" ] || [ -n "$fail" ]; then
  echo "PR $pr NOT merged"; exit 1
fi
# The repo's squash setting builds the message from every commit message, so a "Closes #N" from removed work would still close
# that issue. The PR title and body are the one place that says what the PR does and closes.
# The text is read again here: an edit made after the first read, such as a removed "Closes #N", does not change the head sha.
now=$(gh api "repos/$R/pulls/$pr") || { echo "PR $pr NOT merged: cannot read the pull request"; exit 1; }
title="$(jq -r .title <<<"$now") (#$pr)"
body=$(jq -r '(.body // "") | gsub("\\s*---\\s*_Generated by \\[Claude Code\\]\\([^)]*\\)_\\s*"; "\n\n") | sub("\\s+$"; "")' <<<"$now")
gh api -X PUT "repos/$R/pulls/$pr/merge" -f merge_method=squash -f sha="$sha" -f commit_title="$title" -f commit_message="$body" >/dev/null || { echo "PR $pr NOT merged: the merge call failed"; exit 1; }
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
