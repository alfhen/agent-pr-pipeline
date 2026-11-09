#!/bin/bash
# usage: token-report.sh <workflow output file> [<transcript folder>] [--feedback <file>]
# Prints the token cost of a finished wave. The output file is the pretty-printed JSON that the Workflow completion
# notice names (agentCount, totalTokens). With a transcript folder (agent-<id>.jsonl, with agent-<id>.meta.json beside it)
# it also prints input, cache write, cache read, output, agent count and average context per role, the top roles, and
# the PRs that used more than TOKEN_REPORT_FLAG_MULTIPLE (default 2) times the median of the wave (needs 3 PRs).
# A missing transcript folder prints the totals only. A message id that repeats in a transcript counts once.
# A PR is found from the "PR: <id> - " line of an agent's first prompt; an agent with no such line has no PR.
# --feedback writes a feedback list to <file> ([] when no PR is flagged). The item holds numbers and role names only,
# so it passes the denylist of file-feedback.sh like any other item.
# Exit: 0 done, 1 the output file is missing or is not a workflow output, 64 bad argument.
set -u
usage="usage: token-report.sh <workflow output file> [<transcript folder>] [--feedback <file>]"
out=""; dir=""; fb=""
while [ $# -gt 0 ]; do
  case "$1" in
    --feedback) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; fb=$2; shift 2 ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) if [ -z "$out" ]; then out=$1; elif [ -z "$dir" ]; then dir=$1; else echo "$usage" >&2; exit 64; fi; shift ;;
  esac
done
[ -n "$out" ] || { echo "$usage" >&2; exit 64; }
mult=${TOKEN_REPORT_FLAG_MULTIPLE:-2}
[[ $mult =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "token-report: TOKEN_REPORT_FLAG_MULTIPLE must be a number" >&2; exit 64; }
[ -f "$out" ] || { echo "token-report: $out is not a file" >&2; exit 1; }

totals=$(jq -er 'if (.totalTokens | type) == "number" and (.agentCount | type) == "number" then "total tokens: \(.totalTokens)\nagents: \(.agentCount)" else error("no totalTokens and agentCount") end' "$out" 2>&1) \
  || { echo "token-report: $out is not a workflow output file: $totals" >&2; exit 1; }
echo "$totals"
if [ -n "$fb" ]; then echo '[]' > "$fb" || { echo "token-report: cannot write $fb" >&2; exit 1; }; fi
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "transcripts: not available, totals only"
  exit 0
fi

rows=$(mktemp) || exit 1
trap 'rm -f "$rows"' EXIT
while IFS= read -r f; do
  meta="${f%.jsonl}.meta.json"
  role=$(jq -r '.agentType // "unknown" | sub("^[^:]*:"; "")' "$meta" 2>/dev/null) || role=unknown
  [ -n "$role" ] || role=unknown
  jq -c -s --arg role "$role" '
    ([.[] | select(.type == "user") | .message.content | strings] | first // "") as $first
    | ([to_entries[] | select(.value.message.usage != null) | {key: (.value.message.id // "line\(.key)"), value: .value.message.usage}] | from_entries | [.[]]) as $u
    | {role: $role,
       pr: (($first | capture("(^|\n)PR: (?<id>[^ \n]+) - ")? | .id) // null),
       input: ([$u[] | .input_tokens // 0] | add // 0),
       cacheWrite: ([$u[] | .cache_creation_input_tokens // 0] | add // 0),
       cacheRead: ([$u[] | .cache_read_input_tokens // 0] | add // 0),
       output: ([$u[] | .output_tokens // 0] | add // 0),
       messages: ($u | length)}' "$f" >> "$rows" 2>/dev/null || echo "token-report: skipped unreadable $f" >&2
done < <(find "$dir" -name 'agent-*.jsonl' | sort)

if [ ! -s "$rows" ]; then echo "transcripts: no agent files in the folder, totals only"; exit 0; fi

report=$(jq -s -r --argjson mult "$mult" '
  def tot: .input + .cacheWrite + .cacheRead + .output;
  (group_by(.role) | map({role: .[0].role, agents: length,
     input: (map(.input) | add), cacheWrite: (map(.cacheWrite) | add), cacheRead: (map(.cacheRead) | add), output: (map(.output) | add),
     messages: (map(.messages) | add)})
   | map(. + {total: tot, avgContext: (if .messages > 0 then ((.input + .cacheWrite + .cacheRead) / .messages | floor) else 0 end)})
   | sort_by(-.total)) as $roles
  | "transcripts: \(length) agents, \($roles | map(.total) | add) tokens",
    "role | agents | input | cache write | cache read | output | avg context",
    ($roles[] | "\(.role) | \(.agents) | \(.input) | \(.cacheWrite) | \(.cacheRead) | \(.output) | \(.avgContext)"),
    "top roles: \($roles[:3] | map("\(.role) \(.total)") | join(", "))",
    ( [.[] | select(.pr != null)] | group_by(.pr) | map({pr: .[0].pr, total: (map(tot) | add)}) | sort_by(.total) ) as $prs
    | if ($prs | length) < 3 then "PR flags: need 3 PRs with transcripts, have \($prs | length)"
      else (($prs | length) as $c | ($prs | map(.total)) as $t | (if $c % 2 == 1 then $t[($c - 1) / 2] else ($t[$c / 2 - 1] + $t[$c / 2]) / 2 end)) as $med
        | ($prs | map(select($med > 0 and .total > $med * $mult))) as $hot
        | "wave median per PR: \($med | floor) tokens",
          (if ($hot | length) == 0 then "PR flags: none" else ($hot[] | "FLAG \(.pr): \(.total) tokens, \((.total / $med * 10 | floor) / 10) times the median") end)
      end' "$rows") || { echo "token-report: could not read the transcripts" >&2; exit 1; }
echo "$report"

if [ -n "$fb" ]; then
  flags=$(printf '%s\n' "$report" | grep -c '^FLAG ')
  if [ "$flags" -gt 0 ]; then
    top=$(printf '%s\n' "$report" | grep '^top roles: ' | sed 's/^top roles: //')
    jq -n --argjson n "$flags" --arg top "$top" --arg mult "$mult" '[{
      title: "A PR used far more tokens than the rest of the wave",
      detail: "\($n) PR(s) in one wave used more than \($mult) times the median tokens of the wave.",
      evidence: "token-report.sh flagged \($n) PR(s). Top roles by tokens: \($top).",
      suggestedChange: "Look for rounds that found nothing or a reviewer that ran again, and cap them.",
      severity: "minor"}]' > "$fb" || { echo "token-report: cannot write $fb" >&2; exit 1; }
  fi
fi
exit 0
