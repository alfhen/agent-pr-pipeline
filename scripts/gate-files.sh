#!/bin/bash
# usage: gate-files.sh <owner/repo> <pr>
#        gate-files.sh <owner/repo> --scope <branch>
#        gate-files.sh <owner/repo> --head <branch>
#        gate-files.sh <owner/repo> --same <sha> <branch>
#        gate-files.sh <owner/repo> --ci-checks
# --ci-checks prints "CICHECKS <json array>": the top-level ciChecks of .github/pipeline.json on the default branch, ["ci"] when the
# file or the key is missing. It exits 3 ("GATE ERROR") when the file or the value cannot be read.
# --same prints "SAME <sha>", the branch head, only when the branch tree equals the tree of <sha>. It exits 1 when the
# trees differ or cannot be read.
# --head prints "HEAD <sha>", the branch head on GitHub. It exits 1 when that cannot be read.
# --scope prints "SCOPE <json array>": the files the branch changes against the default branch that the fixed floor
# does not match. A gated file the branch already changes is listed; the plugin's code folders are not floor here. It exits 0, or 3 ("GATE ERROR") when the files cannot be read.
# Exit 0 when no changed file of the PR matches a gate; exit 1 ("GATED") when one does; exit 3
# ("GATE ERROR") when that cannot be told (fails closed); exit 2 on a usage error.
# A fixed floor is gated on top of the settings, and no settings file removes it: .github, .claude folders,
# AGENTS.md, CLAUDE.md and CLAUDE.local.md (at any depth, in any letter case) and docs/goals.md, and in the plugin's own repo (plugin-repo.sh) also the plugin's code folders.
# The gates come from .github/pipeline.json on the default branch, or from templates/pipeline.json when the repo has no settings file. Both filename and previous_filename count.
R=$1; pr=$2; scope=
if [ "$pr" = "--head" ]; then
  [ -n "$3" ] || { echo "usage: gate-files.sh <owner/repo> --head <branch>"; exit 2; }
  sha=$(gh api "repos/$R/branches/$3" --jq .commit.sha 2>&1) || { echo "cannot read the branch head ($sha)"; exit 1; }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "unexpected branch head: $sha"; exit 1; }
  echo "HEAD $sha"; exit 0
fi
if [ "$pr" = "--ci-checks" ]; then
  branch=$(gh api "repos/$R" --jq .default_branch 2>&1) || { echo "GATE ERROR: cannot read the default branch ($branch)"; exit 3; }
  settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=$branch" 2>&1)
  if [ $? -ne 0 ]; then
    case $settings in
      *"HTTP 404"*) echo 'CICHECKS ["ci"]'; exit 0 ;;
      *) echo "GATE ERROR: cannot read .github/pipeline.json ($settings)"; exit 3 ;;
    esac
  fi
  names=$(jq -c 'if has("ciChecks") | not then ["ci"] elif (.ciChecks | type) == "array" and all(.ciChecks[]; type == "string") then .ciChecks else error("ciChecks") end' <<<"$settings" 2>/dev/null) \
    || { echo "GATE ERROR: ciChecks is not a list of strings"; exit 3; }
  echo "CICHECKS $names"; exit 0
fi
if [ "$pr" = "--same" ]; then
  [ -n "$3" ] && [ -n "$4" ] || { echo "usage: gate-files.sh <owner/repo> --same <sha> <branch>"; exit 2; }
  [[ "$3" =~ ^[0-9a-f]{40}$ ]] || { echo "not a sha: $3"; exit 1; }
  sha=$(gh api "repos/$R/branches/$4" --jq .commit.sha 2>&1) || { echo "cannot read the branch head ($sha)"; exit 1; }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "unexpected branch head: $sha"; exit 1; }
  cmp=$(gh api "repos/$R/compare/$3...$sha" --jq '[.status, (if (.files | type) == "array" then (.files | length | tostring) else "nofiles" end), (.files | length > 299)] | @tsv' 2>&1) || { echo "cannot compare ($cmp)"; exit 1; }
  case $cmp in
    identical$'\t'0$'\t'false|ahead$'\t'0$'\t'false) ;;
    *) echo "branch tree differs from $3 ($cmp)"; exit 1 ;;
  esac
  echo "SAME $sha"; exit 0
fi
if [ "$pr" = "--scope" ]; then scope=$3; pr=$3; fi
[ -n "$pr" ] || { echo "usage: gate-files.sh <owner/repo> <pr> | --scope <branch>"; exit 2; }
here=$(dirname "$0")
gated() { echo "GATED #$pr: $*"; exit 1; }
err() { echo "GATE ERROR #$pr: $*"; exit 3; }

branch=$(gh api "repos/$R" --jq .default_branch 2>&1) || err "cannot read the default branch ($branch)"
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

floor='[".github/**","**/.claude","**/.claude/**","**/AGENTS.md","**/CLAUDE.md","**/CLAUDE.local.md","docs/goals.md"]'
scopefloor=$floor
# matches <gates> [flags] [free]: the changed files a gate matches, joined; with "free", the files no gate matches, as a JSON array.
matches() { jq -r --argjson gates "$1" --arg flags "${2:-}" --arg free "${3:-}" '
  def rx: (if endswith("/") then . + "**" else . end)
    | gsub("(?<c>[.+^${}()|\\[\\]\\\\])"; "\\" + .c)
    | gsub("\\*\\*/"; "\u0001") | gsub("\\*\\*"; "\u0002") | gsub("\\*"; "\u0003") | gsub("\\?"; "\u0004")
    | gsub("\u0001"; "([\\s\\S]*/)?") | gsub("\u0002"; "[\\s\\S]*") | gsub("\u0003"; "[^/]*") | gsub("\u0004"; "[^/]")
    | "\\A" + . + "\\z";
  def hit: . as $f | any($gates[]; . as $g | $f | test($g | rx; $flags));
  if $free == "" then [.[] | (.filename, (.previous_filename // empty))] | unique | map(select(hit)) | join(", ")
  else map(select([.filename, (.previous_filename // empty)] | any(hit) | not) | .filename) | unique | tojson end' <<<"$list"; }
if [ -n "$scope" ]; then
  free=$(matches "$scopefloor" i free) || err "cannot match the changed files"
  echo "SCOPE $free"; exit 0
fi
settings=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$R/contents/.github/pipeline.json?ref=$branch" 2>&1)
if [ $? -ne 0 ]; then
  case $settings in
    *"HTTP 404"*) settings=$(cat "$here/../templates/pipeline.json" 2>/dev/null) || err "no settings file and no template" ;;
    *) err "cannot read .github/pipeline.json ($settings)" ;;
  esac
fi
gates=$(jq -c 'if (.gates | type) == "array" and all(.gates[]; type == "string") then .gates else error("gates") end' <<<"$settings" 2>/dev/null) \
  || err "settings have no valid gates list"

plugin=$(bash "$here/plugin-repo.sh" 2>/dev/null) || err "cannot read the plugin repository from the plugin manifest"
if [ "$plugin" = "$(tr '[:upper:]' '[:lower:]' <<<"$R")" ]; then
  floor=$(jq -c '. + ["agents/**","workflows/**","scripts/**","skills/**","routine/**","templates/**",".claude-plugin/**"]' <<<"$floor")
fi

hit=$(matches "$gates") || err "cannot match the changed files"
[ -z "$hit" ] || gated "$hit"
hit=$(matches "$floor" i) || err "cannot match the changed files"
[ -z "$hit" ] || gated "floor: $hit"
echo "not gated #$pr"
