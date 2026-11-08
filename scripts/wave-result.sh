#!/bin/bash
# usage: wave-result.sh <workflow output file> <result file>
# Reads the output file that the Workflow completion notice names (summary, agentCount, logs, result), writes .result to
# <result file> and prints "<pr> <ready> <reasonCode>" for the first PR: <pr> is its prNumber or "none", <ready> is
# true or false, <reasonCode> is one of opened, triage-plan, triage-decline, rounds-exhausted, needs-human, other.
# Exit 0, 64 bad argument, 1 when the file is not JSON, has no object in result.prs[0], or says ready with no whole-number
# prNumber. Exit 1 writes no result file. The codes are the ones that routine-state.sh put built accepts.
set -u
[ $# -eq 2 ] || { echo "usage: wave-result.sh <workflow output file> <result file>" >&2; exit 64; }
in=$1; out=$2
[ -f "$in" ] || { echo "wave-result: $in is not a file" >&2; exit 1; }

line=$(jq -er '
  .result.prs[0] as $p
  | if ($p | type) != "object" then error("result.prs[0] is not an object") else . end
  | ($p.prNumber | type == "number" and . == floor and . > 0 and . < 1000000000) as $whole
  | ($p.ready == true) as $ready
  | if $ready and ($whole | not) then error("ready is true and prNumber is not a whole number") else . end
  | ($p.reason // "" | if type == "string" then . else "" end) as $why
  | (if $ready then "opened"
     elif ($why | test("^quick fix: plan\\b")) then "triage-plan"
     elif ($why | test("^quick fix: decline\\b")) then "triage-decline"
     elif ($why | test("rounds exhausted")) then "rounds-exhausted"
     elif ($why | test("^needs human")) then "needs-human"
     else "other" end) as $code
  | "\(if $whole then $p.prNumber else "none" end) \($ready) \($code)"' "$in" 2>&1) \
  || { echo "wave-result: ${line:-$in is not readable JSON}" >&2; exit 1; }

tmp=$(mktemp "$out.XXXXXX" 2>/dev/null) || { echo "wave-result: cannot write $out" >&2; exit 1; }
if jq '.result' "$in" > "$tmp" && mv -f "$tmp" "$out"; then echo "$line"; else rm -f "$tmp"; echo "wave-result: cannot write $out" >&2; exit 1; fi
