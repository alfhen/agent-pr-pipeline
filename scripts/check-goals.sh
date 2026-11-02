#!/bin/bash
# usage: check-goals.sh <owner/repo> <path, e.g. docs/goals.md>
#        check-goals.sh --local <file>
# Exit 0 if the goals document exists (on the default branch, or locally) and has Goals and Non-goals
# sections with at least one item each. Run it before starting the workflow; the workflow runs the same check.
if [ "$1" = "--local" ]; then
  F=$2; [ -f "$F" ] || { echo "MISSING: $F does not exist. Start from templates/goals.md."; exit 1; }
  body=$(cat "$F")
else
  R=$1; F=$2
  [ -n "$F" ] || { echo "usage: check-goals.sh <owner/repo> <path> | --local <file>"; exit 2; }
  body=$(gh api "repos/$R/contents/$F" --jq .content 2>/dev/null | base64 --decode 2>/dev/null)
  [ -n "$body" ] || { echo "MISSING: $F does not exist on the default branch of $R. Start from templates/goals.md."; exit 1; }
fi
count() {
  printf '%s\n' "$body" | awk -v re="$1" '
    /^#+[ \t]/ { h = tolower($0); sub(/^#+[ \t]+/, "", h); sub(/[ \t]+$/, "", h); inside = (h ~ re) }
    inside && /^[ \t]*([-*]|[0-9]+\.)[ \t]+[^ \t<]/ { n++ }
    END { print n + 0 }'
}
g=$(count '^goals$'); n=$(count '^(non-goals|non goals|out of scope)$')
echo "$F: goals=$g non-goals=$n"
[ "$g" -gt 0 ] && [ "$n" -gt 0 ] || { echo "INCOMPLETE: $F needs a Goals and a Non-goals section with at least one real item each."; exit 1; }
