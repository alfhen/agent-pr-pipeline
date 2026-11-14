#!/bin/bash
# usage: land-commits.sh <owner/repo> <before> <after> <tmp dir>
# Prints the code a land fix added to a PR branch, from a fresh clone under <tmp dir>: every non-merge commit in
# <before>..<after> that is not on the default branch, and for each merge commit its own content (the combined diff).
# A clean merge of the default branch has an empty combined diff, so a hand-resolved conflict is printed and a clean merge is not.
# The combined diff omits a conflict resolved to exactly one side, which can drop the PR's change. For a file either parent
# changed whose merged blob equals one parent's, the diff against each other parent that differs from the merge and the base
# is printed too.
# The last line is `land-commits: sum <crc>:<bytes>`, the POSIX cksum and byte length of the text before that line, without the line end that comes before it, or the one line
# `land-commits: no code added by the land fix` when there is nothing else. It is printed only after every git command succeeded,
# so a cut or failed read has no such line. Exits 1 when it cannot read the range.
# LAND_COMMITS_REMOTE: a local path used in place of the GitHub URL, for tests.
R=$1; before=$2; after=$3; tmp=$4
[ -n "$tmp" ] || { echo "usage: land-commits.sh <owner/repo> <before> <after> <tmp dir>"; exit 2; }
exec 3>&2
# Git warnings, also those of a successful clone, must not reach the output, which is summed.
exec 2>/dev/null
fail() { echo "land-commits: $1" >&3; exit 1; }
blob() { git rev-parse -q --verify "$1:$2" 2>/dev/null || echo none; }
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

out=""
add() { out+="$1"$'\n'; }
logged=$(git log --no-merges --reverse -p --format='commit %H%n%s' "$before..$after" --not origin/HEAD) || fail "cannot list the commits"
[ -z "$logged" ] || add "$logged"
merges=$(git rev-list --merges --reverse "$before..$after" --not origin/HEAD) || fail "cannot list the merges"
for m in $merges; do
  diff=$(git diff-tree --cc -p --no-commit-id "$m") || fail "cannot diff merge $m"
  if [ -n "$diff" ]; then add "$(printf 'merge %s\n%s' "$m" "$diff")"; fi
  line=$(git rev-list --parents -n 1 "$m") || fail "cannot read the parents of merge $m"
  parents=${line#* }
  base=$(git merge-base --octopus $parents) || fail "cannot find the merge base of merge $m"
  changed=""
  for p in $parents; do
    names=$(git diff --name-only "$base" "$p") || fail "cannot list the files of merge $m"
    changed+="$names"$'\n'
  done
  changed=$(printf '%s\n' "$changed" | sort -u)
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    mine=$(blob "$m" "$f")
    was=$(blob "$base" "$f")
    for p in $parents; do
      [ "$(blob "$p" "$f")" = "$mine" ] || continue
      for q in $parents; do
        [ "$(blob "$q" "$f")" != "$was" ] || continue
        d=$(git diff "$q" "$m" -- "$f") || fail "cannot diff merge $m"
        if [ -n "$d" ]; then add "$(printf 'merge %s took one side of %s; diff against %s\n%s' "$m" "$f" "$q" "$d")"; fi
      done
      break
    done
  done <<< "$changed"
done
# The workflow reads the answer as a UTF-8 string. Text that is not valid UTF-8 is never converted by a tool that may drop
# bytes: each byte outside ASCII becomes `?` one for one, and a result of another length is refused.
if [ -n "$out" ]; then
  out=$(printf '%s' "$out")
  if ! printf '%s' "$out" | iconv -f utf-8 -t utf-8 >/dev/null 2>&1; then
    safe=$(printf '%s' "$out" | LC_ALL=C tr '\200-\377' '?') || fail "cannot replace the bytes outside ASCII"
    [ "$(printf '%s' "$safe" | wc -c)" -eq "$(printf '%s' "$out" | wc -c)" ] || fail "the byte replacement changed the length"
    out=$safe$'\n'"land-commits: the output was not valid UTF-8; each byte outside ASCII is shown as ?"
  fi
fi
if [ -z "$out" ]; then
  echo "land-commits: no code added by the land fix"
else
  printf '%s\n' "$out"
  set -- $(printf '%s' "$out" | cksum)
  echo "land-commits: sum $1:$2"
fi
exit 0
