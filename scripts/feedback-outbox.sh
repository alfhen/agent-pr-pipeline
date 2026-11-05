#!/bin/bash
# usage: feedback-outbox.sh <owner/repo> <result.json> --run <run>
# Turns the feedback of a run-wave result (feedback, denylist, source, feedbackRepo) into one feedback-outbox record on
# the tracking issue of <owner/repo>, which must be the wave's source repo. Items that fail the quality bar or the
# denylist check of file-feedback.sh --auto are dropped, and at most feedbackItems are kept. The record is only a queue:
# file-feedback.sh --auto --outbox checks everything again before it files. Stage 0 is handled by routine-state.sh put.
# Prints "outbox <run>" or "no outbox: <reason>". Exit 0, 64 bad argument, 65 refused (another repo with an empty
# denylist), other codes from routine-state.sh.
set -u
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
RS="$here/routine-state.sh"
slug='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
usage() { echo "usage: feedback-outbox.sh <owner/repo> <result.json> --run <run>" >&2; exit 64; }
[ $# -eq 4 ] && [ "$3" = --run ] || usage
repo=$1; result=$2; run=$4
[[ $repo =~ $slug ]] || usage
[[ $run =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || { echo "feedback-outbox: the run must look like 20261105T120000Z-0a1b2c3d" >&2; exit 64; }
[ -f "$result" ] || { echo "feedback-outbox: $result is not a file" >&2; exit 64; }
jq -e '(type == "object") and (.feedback | type == "array") and (.denylist | type == "array" and all(.[]; type == "string"))
  and (.source | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and (.feedbackRepo | type == "string" and test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))' "$result" >/dev/null 2>&1 \
  || { echo "feedback-outbox: $result is not a run-wave result with feedback, denylist, source and feedbackRepo" >&2; exit 64; }

source=$(jq -r .source "$result"); fbrepo=$(jq -r .feedbackRepo "$result")
lc() { tr 'A-Z' 'a-z' <<<"$1"; }
[ "$(lc "$source")" = "$(lc "$repo")" ] || { echo "feedback-outbox: the result is from $source, not from $repo" >&2; exit 65; }
if [ "$(lc "$source")" != "$(lc "$fbrepo")" ] && [ "$(jq '.denylist | length' "$result")" = 0 ]; then
  echo "feedback-outbox: the source repo differs from the feedback repo and the denylist is empty" >&2; exit 65
fi
[ "$(jq '.feedback | length' "$result")" -gt 0 ] || { echo "no outbox: no feedback items"; exit 0; }

gate=$(bash "$RS" "$repo" gate) || { echo "feedback-outbox: cannot read the state of $repo" >&2; exit 3; }
case "$gate" in paused|"init needed") echo "no outbox: $gate"; exit 0 ;; esac

raw=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$repo/contents/.github/pipeline.json") || { echo "feedback-outbox: cannot read .github/pipeline.json in $repo" >&2; exit 3; }
max=$(jq -c --arg form pipeline -f "$here/../routine/config.jq" <<<"$raw" 2>/dev/null | jq -r '.routine.limits.feedbackItems // empty')
[[ $max =~ ^[0-9]+$ ]] || { echo "feedback-outbox: bad .github/pipeline.json in $repo" >&2; exit 3; }

tmp=$(mktemp -d) || exit 3
trap 'rm -rf "$tmp"' EXIT
jq -c .feedback "$result" > "$tmp/items.json"; jq -c .denylist "$result" > "$tmp/deny.json"
verdicts=$(bash "$here/file-feedback.sh" "$tmp/items.json" --denylist "$tmp/deny.json" --repo "$fbrepo" --source "$source" --auto --check) \
  || { echo "feedback-outbox: the item check failed" >&2; exit 3; }
keep=$(sed -n 's/^OK \([0-9][0-9]*\)$/\1/p' <<<"$verdicts" | head -n "$max" | jq -Rs 'split("\n") | map(select(. != "") | tonumber)')
jq -c --argjson keep "$keep" --slurpfile all "$tmp/items.json" '{source: .source, feedbackRepo: .feedbackRepo,
  items: [$keep[] as $i | $all[0][$i]], denylist: .denylist, dropped: ((.feedback | length) - ($keep | length))}' "$result" > "$tmp/record.json" || exit 3
[ "$(jq '.items | length' "$tmp/record.json")" -gt 0 ] || { echo "no outbox: no item passed the checks"; exit 0; }

out=$(bash "$RS" "$repo" put feedback-outbox "$run" "$tmp/record.json" 2>"$tmp/err"); rc=$?
if [ "$rc" != 0 ]; then echo "no outbox: $(head -n 1 "$tmp/err")"; exit "$rc"; fi
case "$out" in WOULD*) echo "$out" ;; *) echo "outbox $run" ;; esac
