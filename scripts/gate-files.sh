#!/bin/bash
# usage: gate-files.sh <owner/repo> <pr>
#        gate-files.sh <owner/repo> --scope <branch>
# --scope prints "SCOPE <json array>": the files the branch changes against the default branch that no gate and no
# floor path matches. It exits 0, or 3 ("GATE ERROR") when the gates or the files cannot be read.
# Exit 0 when no changed file of the PR matches a gate; exit 1 ("GATED") when one does; exit 3
# ("GATE ERROR") when that cannot be told (fails closed); exit 2 on a usage error.
# A fixed floor is gated on top of the settings, and no settings file removes it: .github, .claude, AGENTS.md,
# CLAUDE.md (at any depth) and docs/goals.md, and in the plugin's own repo (plugin-repo.sh) also the plugin's code folders.
# The gates come from .github/pipeline.json on the default branch, or from templates/pipeline.json when the repo has no settings file. Both filename and previous_filename count.
R=$1; pr=$2; scope=
if [ "$pr" = "--scope" ]; then scope=$3; pr=$3; fi
[ -n "$pr" ] || { echo "usage: gate-files.sh <owner/repo> <pr> | --scope <branch>"; exit 2; }
here=$(dirname "$0")
gated() { echo "GATED #$pr: $*"; exit 1; }
err() { echo "GATE ERROR #$pr: $*"; exit 3; }

branch=$(gh api "repos/$R" --jq .default_branch 2>&1) || err "cannot read the default branch ($branch)"
settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=$branch" 2>&1)
if [ $? -ne 0 ]; then
  case $settings in
    *"HTTP 404"*) settings=$(cat "$here/../templates/pipeline.json" 2>/dev/null) || err "no settings file and no template" ;;
    *) err "cannot read .github/pipeline.json ($settings)" ;;
  esac
fi
gates=$(jq -c 'if (.gates | type) == "array" and all(.gates[]; type == "string") then .gates else error("gates") end' <<<"$settings" 2>/dev/null) \
  || err "settings have no valid gates list"

if [ -n "$scope" ]; then
  pages=$(gh api --paginate --slurp "repos/$R/compare/$branch...$scope?per_page=100" 2>&1) || err "cannot compare the branch ($pages)"
  list=$(jq -c 'if all(.[]; type == "object") then [.[] | .files // [] | .[]] else error("pages") end' <<<"$pages" 2>/dev/null) \
    || err "unexpected answer for the branch files"
  [ "$(jq length <<<"$list")" -lt 300 ] || err "300 changed files or more, the list may be cut"
else
  pages=$(gh api --paginate --slurp "repos/$R/pulls/$pr/files?per_page=100" 2>&1) || err "cannot list the changed files ($pages)"
  list=$(jq -c 'if all(.[]; type == "array") then add // [] else error("pages") end' <<<"$pages" 2>/dev/null) \
    || err "unexpected answer for the changed files"
  [ "$(jq length <<<"$list")" -lt 3000 ] || err "3000 changed files or more, the list may be cut"
fi

floor='[".github/**",".claude/**","**/AGENTS.md","**/CLAUDE.md","docs/goals.md"]'
if [ "$(bash "$here/plugin-repo.sh" 2>/dev/null)" = "$(tr '[:upper:]' '[:lower:]' <<<"$R")" ]; then
  floor=$(jq -c '. + ["agents/**","workflows/**","scripts/**","skills/**","routine/**","templates/**",".claude-plugin/**"]' <<<"$floor")
fi

# matches <gates> [free]: the changed files a gate matches, joined; with "free", the files no gate matches, as a JSON array.
matches() { jq -r --argjson gates "$1" --arg free "$2" '
  def rx: (if endswith("/") then . + "**" else . end)
    | gsub("(?<c>[.+^${}()|\\[\\]\\\\])"; "\\" + .c)
    | gsub("\\*\\*/"; "\u0001") | gsub("\\*\\*"; "\u0002") | gsub("\\*"; "\u0003") | gsub("\\?"; "\u0004")
    | gsub("\u0001"; "([\\s\\S]*/)?") | gsub("\u0002"; "[\\s\\S]*") | gsub("\u0003"; "[^/]*") | gsub("\u0004"; "[^/]")
    | "\\A" + . + "\\z";
  def hit: . as $f | any($gates[]; . as $g | $f | test($g | rx));
  if $free == "" then [.[] | (.filename, (.previous_filename // empty))] | unique | map(select(hit)) | join(", ")
  else map(select([.filename, (.previous_filename // empty)] | any(hit) | not) | .filename) | unique | tojson end' <<<"$list"; }
if [ -n "$scope" ]; then
  both=$(jq -nc --argjson a "$gates" --argjson b "$floor" '$a + $b') || err "cannot match the changed files"
  free=$(matches "$both" free) || err "cannot match the changed files"
  echo "SCOPE $free"; exit 0
fi
hit=$(matches "$gates") || err "cannot match the changed files"
[ -z "$hit" ] || gated "$hit"
hit=$(matches "$floor") || err "cannot match the changed files"
[ -z "$hit" ] || gated "floor: $hit"
echo "not gated #$pr"
