#!/bin/bash
# usage: land-commits.sh <owner/repo> <before> <after> <tmp dir>
# Prints the code a land fix added to a PR branch, from a fresh clone under <tmp dir>: every non-merge commit in
# <before>..<after> that is not on the default branch, and for each merge commit its own content (the combined diff).
# A clean merge of the default branch has an empty combined diff, so a hand-resolved conflict is printed and a clean merge is not.
# The combined diff omits a conflict resolved to exactly one side, which can drop the PR's change. For a file changed on both
# sides whose merged blob equals one parent's, the diff against each differing parent is printed too.
# Empty output means the fixer added no code of its own. Exits 1 when it cannot read the range.
# LAND_COMMITS_REMOTE: a local path used in place of the GitHub URL, for tests.
R=$1; before=$2; after=$3; tmp=$4
[ -n "$tmp" ] || { echo "usage: land-commits.sh <owner/repo> <before> <after> <tmp dir>"; exit 2; }
fail() { echo "land-commits: $1" >&2; exit 1; }
for sha in "$before" "$after"; do
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || fail "not a commit sha: $sha"
done

mkdir -p "$tmp" && dir=$(mktemp -d "$tmp/land-commits.XXXXXX") || fail "cannot make a clone folder"
trap 'rm -rf "$dir"' EXIT
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
  parents=$(git rev-list --parents -n 1 "$m" | cut -d' ' -f2-)
  base=$(git merge-base --octopus $parents) || continue
  changed=$(for p in $parents; do git diff --name-only "$base" "$p"; done | sort | uniq -d)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    mine=$(git rev-parse "$m:$f" 2>/dev/null || echo none)
    for p in $parents; do
      [ "$(git rev-parse "$p:$f" 2>/dev/null || echo none)" = "$mine" ] || continue
      for q in $parents; do
        d=$(git diff "$q" "$m" -- "$f") || fail "cannot diff merge $m"
        if [ -n "$d" ]; then printf 'merge %s took one side of %s; diff against %s\n%s\n' "$m" "$f" "$q" "$d"; fi
      done
      break
    done
  done <<< "$changed"
done
exit 0
