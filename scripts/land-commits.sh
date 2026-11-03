#!/bin/bash
# usage: land-commits.sh <owner/repo> <before> <after> <tmp dir>
# Prints the code a land fix added to a PR branch, from a fresh clone under <tmp dir>: every non-merge commit in
# <before>..<after> that is not on the default branch, and for each merge commit its own content (the combined diff).
# A clean merge of the default branch has an empty combined diff, so a hand-resolved conflict is printed and a clean merge is not.
# Empty output means the fixer added no code of its own. Exits 1 when it cannot read the range.
# LAND_COMMITS_REMOTE: a local path used in place of the GitHub URL, for tests.
R=$1; before=$2; after=$3; tmp=$4
[ -n "$tmp" ] || { echo "usage: land-commits.sh <owner/repo> <before> <after> <tmp dir>"; exit 2; }
fail() { echo "land-commits: $1" >&2; exit 1; }
for sha in "$before" "$after"; do
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || fail "not a commit sha: $sha"
done

dir="$tmp/land-commits"
rm -rf "$dir"
git clone --quiet "${LAND_COMMITS_REMOTE:-https://github.com/$R.git}" "$dir" || fail "cannot clone"
cd "$dir" || fail "cannot enter the clone"
git rev-parse --quiet --verify origin/HEAD >/dev/null || fail "the clone has no default branch"
git rev-parse --quiet --verify "$before^{commit}" >/dev/null || fail "cannot read $before"
git rev-parse --quiet --verify "$after^{commit}" >/dev/null || fail "cannot read $after"

git log --no-merges --reverse -p --format='commit %H%n%s' "$before..$after" --not origin/HEAD || fail "cannot list the commits"
merges=$(git rev-list --merges --reverse "$before..$after" --not origin/HEAD) || fail "cannot list the merges"
for m in $merges; do
  diff=$(git diff-tree --cc -p --no-commit-id "$m") || fail "cannot diff merge $m"
  if [ -n "$diff" ]; then printf 'merge %s\n%s\n' "$m" "$diff"; fi
done
exit 0
