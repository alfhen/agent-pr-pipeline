#!/bin/bash
# usage: token-report.sh <workflow output file> [<transcript folder>] [--feedback <file>] [--json <file>]
# Prints the token cost of a finished wave. The output file is the pretty-printed JSON that the Workflow completion
# notice names (agentCount, totalTokens). With a transcript folder (agent-<id>.jsonl, with agent-<id>.meta.json beside it)
# it also prints input, cache write, cache read, output, agent count and average context per role, the top roles, and
# the PRs that used more than TOKEN_REPORT_FLAG_MULTIPLE (default 2) times the median of the wave (needs 3 PRs).
# The transcript total counts cache reads. Top roles, the per-PR figure and the PR flags use the weighted figure instead:
# input 1, cache read 0.1, cache write 1.25, output 5, so a PR that only re-reads a big context is not the biggest one.
# A transcript line that is not valid JSON is skipped; the report then says it is incomplete and flags no PR.
# A missing transcript folder prints the totals only. A message id that repeats in a transcript counts once.
# A PR is found from the description in the agent's meta file (<role>:<PR id>#<step>, as run-wave.js labels agents); the
# labels wave and goals are no PR. Without a description it falls back to the indented or plain "PR: <id> - " line of the
# first prompt. An agent with neither has no PR.
# --feedback writes a feedback list to <file> ([] when no PR is flagged). The item holds numbers and role names only,
# so it passes the denylist of file-feedback.sh like any other item.
# --json writes, for ledger.sh, per PR: tokens by role (four counts), raw (the sum with cache reads), noCacheRead, weighted,
# agent count, wall minutes (first to last timestamp over the PR's transcripts) and the cost of the minor pass (agents labelled
# minorfix:, minorreview: and test:<id>#minor1). Without a transcript folder, or when a transcript line is unreadable, comparable is false.
# Exit: 0 done, 1 the output file is missing or is not a workflow output, 64 bad argument.
set -u
usage="usage: token-report.sh <workflow output file> [<transcript folder>] [--feedback <file>] [--json <file>]"
out=""; dir=""; fb=""; json=""
while [ $# -gt 0 ]; do
  case "$1" in
    --feedback) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; fb=$2; shift 2 ;;
    --json) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; json=$2; shift 2 ;;
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
if [ -n "$json" ]; then
  jq '{comparable: false, totals: {totalTokens, agentCount}, prs: []}' "$out" > "$json" || { echo "token-report: cannot write $json" >&2; exit 1; }
fi
if [ -z "$dir" ] || [ ! -d "$dir" ]; then
  echo "transcripts: not available, totals only"
  exit 0
fi

bad=0
rows=$(mktemp) || exit 1
trap 'rm -f "$rows"' EXIT
while IFS= read -r f; do
  meta="${f%.jsonl}.meta.json"
  role=$(jq -r '.agentType // "unknown" | sub("^[^:]*:"; "")' "$meta" 2>/dev/null) || role=unknown
  [ -n "$role" ] || role=unknown
  desc=$(jq -r '.description // ""' "$meta" 2>/dev/null) || desc=""
  jq -c . "$f" >/dev/null 2>&1 || bad=$((bad + 1))
  [ -s "$f" ] || bad=$((bad + 1))
  jq -R -c 'fromjson? // empty' "$f" | jq -c -s --arg role "$role" --arg desc "$desc" '
    ([.[] | select(.type == "user") | .message.content | strings] | first // "") as $first
    | ([to_entries[] | select(.value.message.usage != null) | {key: (.value.message.id // "line\(.key)"), value: .value.message.usage}] | from_entries | [.[]]) as $u
    | ([.[] | .timestamp? | strings] | {first: min, last: max}) as $t
    | {role: $role, first: $t.first, last: $t.last,
       minor: ($desc | test("^(minorfix|minorreview):") or test("^test:[^#]+#minor1")),
       pr: ((($desc | capture("^[^:]+:(?<id>[^#:]+)")? | .id) // ($first | capture("(^|\n)[ \t]*PR: (?<id>[^ \n]+) - ")? | .id) // null) as $id
            | if $id == "wave" or $id == "goals" then null else $id end),
       input: ([$u[] | .input_tokens // 0] | add // 0),
       cacheWrite: ([$u[] | .cache_creation_input_tokens // 0] | add // 0),
       cacheRead: ([$u[] | .cache_read_input_tokens // 0] | add // 0),
       output: ([$u[] | .output_tokens // 0] | add // 0),
       messages: ($u | length)}' >> "$rows" 2>/dev/null || { echo "token-report: skipped unreadable $f" >&2; bad=$((bad + 1)); }
done < <(find "$dir" -maxdepth 1 -name 'agent-*.jsonl' | sort)

if [ ! -s "$rows" ]; then echo "transcripts: no agent files in the folder, totals only"; exit 0; fi

report=$(jq -s -r --argjson mult "$mult" --argjson bad "$bad" '
  def tot: .input + .cacheWrite + .cacheRead + .output;
  def wt: (.input + .cacheRead * 0.1 + .cacheWrite * 1.25 + .output * 5 | round);
  (group_by(.role) | map({role: .[0].role, agents: length,
     input: (map(.input) | add), cacheWrite: (map(.cacheWrite) | add), cacheRead: (map(.cacheRead) | add), output: (map(.output) | add),
     messages: (map(.messages) | add)})
   | map(. + {total: tot, weighted: wt, avgContext: (if .messages > 0 then ((.input + .cacheWrite + .cacheRead) / .messages | floor) else 0 end)})
   | sort_by(-.weighted)) as $roles
  | "transcripts: \(length) agents, \($roles | map(.total) | add) tokens (cache reads included)",
    "role | agents | input | cache write | cache read | output | avg context",
    ($roles[] | "\(.role) | \(.agents) | \(.input) | \(.cacheWrite) | \(.cacheRead) | \(.output) | \(.avgContext)"),
    "weighted per role (input 1, cache read 0.1, cache write 1.25, output 5): \($roles | map("\(.role) \(.weighted)") | join(", "))",
    "top roles (weighted): \($roles[:3] | map("\(.role) \(.weighted)") | join(", "))",
    (if $bad > 0 then "transcripts: incomplete, \($bad) file(s) had unreadable lines" else empty end),
    ( [.[] | select(.pr != null)] | group_by(.pr) | map({pr: .[0].pr, total: (map(wt) | add)}) | sort_by(.total) ) as $prs
    | (if ($prs | length) > 0 then "weighted per PR: \($prs | map("\(.pr) \(.total)") | join(", "))" else empty end),
      (if $bad > 0 then "PR flags: none, the transcripts are incomplete"
      elif ($prs | length) < 3 then "PR flags: need 3 PRs with transcripts, have \($prs | length)"
      else (($prs | length) as $c | ($prs | map(.total)) as $t | (if $c % 2 == 1 then $t[($c - 1) / 2] else ($t[$c / 2 - 1] + $t[$c / 2]) / 2 end)) as $med
        | ($prs | map(select($med > 0 and .total > $med * $mult))) as $hot
        | "wave median per PR: \($med | floor) weighted tokens",
          (if ($hot | length) == 0 then "PR flags: none" else ($hot[] | "FLAG \(.pr): \(.total) weighted tokens, \((.total / $med * 10 | floor) / 10) times the median") end)
      end)' "$rows") || { echo "token-report: could not read the transcripts" >&2; exit 1; }
echo "$report"

if [ -n "$json" ]; then
  jq -s --slurpfile o "$out" --argjson bad "$bad" '
    def sums: {input: (map(.input) | add), cacheWrite: (map(.cacheWrite) | add), cacheRead: (map(.cacheRead) | add), output: (map(.output) | add)};
    def secs: sub("\\.[0-9]+"; "") | fromdateiso8601;
    def figures: sums as $s | {byRole: (group_by(.role) | map({key: .[0].role, value: sums}) | from_entries),
      raw: ($s.input + $s.cacheWrite + $s.cacheRead + $s.output), noCacheRead: ($s.input + $s.cacheWrite + $s.output),
      weighted: ($s.input + $s.cacheRead * 0.1 + $s.cacheWrite * 1.25 + $s.output * 5 | round), agents: length,
      wallMinutes: ([.[].first | strings] as $f | [.[].last | strings] as $l | if ($f | length) == 0 or ($l | length) == 0 then null else ((($l | max | secs) - ($f | min | secs)) / 6 | round / 10) end)};
    {comparable: ($bad == 0), totals: ($o[0] | {totalTokens, agentCount}),
     prs: ([.[] | select(.pr != null)] | group_by(.pr) | map({id: .[0].pr} + figures + {minorPass: ([.[] | select(.minor)] | if length == 0 then {agents: 0, weighted: 0} else figures | {agents, weighted} end)})),
     total: figures}' "$rows" > "$json" || { echo "token-report: cannot write $json" >&2; exit 1; }
fi

if [ -n "$fb" ]; then
  flags=$(printf '%s\n' "$report" | grep -c '^FLAG ')
  if [ "$flags" -gt 0 ]; then
    top=$(printf '%s\n' "$report" | grep '^top roles (weighted): ' | sed 's/^top roles (weighted): //')
    jq -n --argjson n "$flags" --arg top "$top" --arg mult "$mult" '[{
      title: "A PR used far more tokens than the rest of the wave",
      detail: "\($n) PR(s) in one wave used more than \($mult) times the median tokens of the wave.",
      evidence: "token-report.sh flagged \($n) PR(s). Top roles by weighted tokens: \($top).",
      suggestedChange: "Look for rounds that found nothing or a reviewer that ran again, and cap them.",
      severity: "minor"}]' > "$fb" || { echo "token-report: cannot write $fb" >&2; exit 1; }
  fi
fi
exit 0
