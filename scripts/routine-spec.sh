#!/bin/bash
# usage: routine-spec.sh <owner/repo> [--tags <tag>...] [--k2 <file>]
# Prints one JSON object {repo, routines, setupScript} for the cloud routines of a repo, from its
# .github/pipeline.json on the default branch, the repo name, the --tags and the K2 file. It reads nothing else
# and creates nothing. Each routine carries allowedTools: the tools its prompts and the agents they start use. A repo with no routine key gets an empty list and a note.
# Exit: 0 done, 1 bad K2 file or setup script, 2 usage, 3 settings unreadable or invalid.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
usage() { echo "usage: routine-spec.sh <owner/repo> [--tags <tag>...] [--k2 <file>]" >&2; exit 2; }

[ $# -ge 1 ] || usage
repo=$1; shift
[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "routine-spec.sh: refused repo '$repo'" >&2; exit 2; }
tags=(); k2="$here/../routine/cloud/k2.json"; mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tags) mode=tags; shift ;;
    --k2) [ $# -ge 2 ] || usage; k2=$2; mode=""; shift 2 ;;
    -*) usage ;;
    *) [ "$mode" = tags ] || usage; tags+=("$1"); shift ;;
  esac
done

bad_k2() { echo "routine-spec.sh: $k2 is not a K2 file {authorFilter, labelFilter} of booleans" >&2; exit 1; }
k2_json=$(jq -ce 'select(type == "object" and (.authorFilter | type) == "boolean" and (.labelFilter | type) == "boolean") | {authorFilter, labelFilter}' "$k2" 2>/dev/null) || bad_k2
[ -n "$k2_json" ] || bad_k2

raw=$(gh api -H "Accept: application/vnd.github.raw+json" "repos/$repo/contents/.github/pipeline.json") \
  || { echo "routine-spec.sh: cannot read .github/pipeline.json of $repo" >&2; exit 3; }
out=$(printf '%s' "$raw" | jq -c --arg form pipeline -f "$here/../routine/config.jq" 2>&1) \
  || { echo "routine-spec.sh: ${out:-config.jq failed}" >&2; exit 3; }
cfg=$(jq -c '.routine' <<<"$out") || exit 3

if [ "$cfg" = null ]; then
  jq -nc --arg r "$repo" '{repo: $r, routines: [], note: "no routine key in .github/pipeline.json: no routine is made"}'
  exit 0
fi

# The pin is always first, so the environment holds the release the repo's apl-start asks for.
all=("$(jq -r .pipelineVersion <<<"$cfg")")
for t in "${tags[@]+"${tags[@]}"}"; do
  case " ${all[*]} " in *" $t "*) ;; *) all+=("$t") ;; esac
done
setup=$(bash "$here/cloud-setup.sh" --print --latest "${all[@]}") || exit 1

# The minute and hour come from the name, so the routines of different repos do not start together.
base=$(printf '%s' "$repo" | tr '[:upper:]/' '[:lower:]-')
sums=$(for kind in triage build collect; do echo "$kind $(printf '%s' "apl-$base-$kind" | cksum | cut -d' ' -f1)"; done)

jq -nc --arg repo "$repo" --argjson cfg "$cfg" --argjson k2 "$k2_json" --arg base "$base" --arg sums "$sums" \
  --rawfile prompt "$here/../routine/cloud/prompt.md" --rawfile setup <(printf "%s" "$setup") '
  ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "PushNotification", "Agent", "Workflow", "ToolSearch", "Skill"] as $tools
  | ($sums | split("\n") | map(split(" ") | {key: .[0], value: (.[1] | tonumber)}) | from_entries) as $sum
  | def promptFor($kind): $prompt | split("<repo>") | join($repo) | split("<kind>") | join($kind);
    def cron($kind): "\($sum[$kind] % 60) \(($sum[$kind] / 60 | floor) % 24) * * *";
    def routine($kind): {name: "apl-\($base)-\($kind)", prompt: promptFor($kind), sources: [$repo], schedule: cron($kind), allowedTools: $tools, webhooks: []};
  {repo: $repo, routines: (
    [ (routine("triage") | .webhooks = (if $k2.authorFilter then [{event: "issues.opened", filter: {author: $cfg.trustedAuthors}}] else [] end)),
      (routine("build") | .webhooks = (if $k2.labelFilter then [{event: "issues.labeled", filter: {labels: ["ready-to-build", "maintainer-approved"]}}] else [] end)) ]
    + (if ($cfg.feedbackRepo | ascii_downcase) == ($repo | ascii_downcase)
       then [(routine("collect") | .sources = (reduce ([$repo] + $cfg.collectFrom)[] as $s ([]; if any(.[]; ascii_downcase == ($s | ascii_downcase)) then . else . + [$s] end)))] else [] end)),
   setupScript: $setup}' || exit 1
