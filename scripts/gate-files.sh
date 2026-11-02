#!/bin/bash
# usage: gate-files.sh <owner/repo> <pr>
# Exit 0 when no changed file of the PR matches a gate; exit 1 when one does or when that cannot be
# told (fails closed). The gates come from .github/pipeline.json on the default branch, or from
# templates/pipeline.json when the repo has no settings file. Both filename and previous_filename count.
R=$1; pr=$2
[ -n "$pr" ] || { echo "usage: gate-files.sh <owner/repo> <pr>"; exit 2; }
here=$(dirname "$0")
gated() { echo "GATED #$pr: $*"; exit 1; }

branch=$(gh api "repos/$R" --jq .default_branch 2>&1) || gated "cannot read the default branch ($branch)"
settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=$branch" 2>&1)
if [ $? -ne 0 ]; then
  case $settings in
    *"HTTP 404"*) settings=$(cat "$here/../templates/pipeline.json" 2>/dev/null) || gated "no settings file and no template" ;;
    *) gated "cannot read .github/pipeline.json ($settings)" ;;
  esac
fi
gates=$(jq -c 'if (.gates | type) == "array" and all(.gates[]; type == "string") then .gates else error("gates") end' <<<"$settings" 2>/dev/null) \
  || gated "settings have no valid gates list"

pages=$(gh api --paginate --slurp "repos/$R/pulls/$pr/files?per_page=100" 2>&1) || gated "cannot list the changed files ($pages)"
list=$(jq -c 'if all(.[]; type == "array") then add // [] else error("pages") end' <<<"$pages" 2>/dev/null) \
  || gated "unexpected answer for the changed files"
[ "$(jq length <<<"$list")" -lt 3000 ] || gated "3000 changed files or more, the list may be cut"

hit=$(jq -r --argjson gates "$gates" '
  def rx: gsub("(?<c>[.+^${}()|\\[\\]\\\\])"; "\\" + .c)
    | gsub("\\*\\*/"; "\u0001") | gsub("\\*\\*"; "\u0002") | gsub("\\*"; "\u0003") | gsub("\\?"; "\u0004")
    | gsub("\u0001"; "(.*/)?") | gsub("\u0002"; ".*") | gsub("\u0003"; "[^/]*") | gsub("\u0004"; "[^/]")
    | "^" + . + "$";
  [.[] | (.filename, (.previous_filename // empty))] | unique
  | map(select(. as $f | any($gates[]; . as $g | $f | test($g | rx)))) | join(", ")' <<<"$list") \
  || gated "cannot match the changed files"
[ -z "$hit" ] || gated "$hit"
echo "not gated #$pr"
