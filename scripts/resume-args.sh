#!/bin/bash
# usage: resume-args.sh <workflow output file | recover-evals.sh output file> <PR id> [--max-rounds <n> --cap <c>]
# Prints the id, prNumber and resume to add to the PR's own prs[] item (it has no branch or title): { id, prNumber, resume: { history, minors, findings, evals, designRules,
# evalDisputes, deviations } }. Every field is copied from the input as it is, and a field the input lacks is left out.
# resume.evals is the object form { evals, ...evalsMeta }, so the accepted record is resume.evals.accepted. A workflow result
# keeps its minors in lateMinors and its findings in lastFindings. A large list is never typed by hand, so use this script.
# --max-rounds and --cap together print one WARN line on stderr when the rounds in the history (rows whose round is not
# "stop") plus n are more than c. The item is still printed.
# Exit: 0 printed, 1 the PR id is not in the input, 64 bad argument, 65 the input is missing, not JSON, or not a result.
# Nothing is printed on stdout unless the exit is 0.
set -u
usage="usage: resume-args.sh <workflow output file | recover-evals.sh output file> <PR id> [--max-rounds <n> --cap <c>]"
pos=(); n=""; cap=""
while [ $# -gt 0 ]; do
  case "$1" in
    --max-rounds) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; n=$2; shift 2 ;;
    --cap) [ $# -ge 2 ] || { echo "$usage" >&2; exit 64; }; cap=$2; shift 2 ;;
    -*) echo "$usage" >&2; exit 64 ;;
    *) pos+=("$1"); shift ;;
  esac
done
{ [ ${#pos[@]} -eq 2 ] && [ -n "${pos[1]}" ]; } || { echo "$usage" >&2; exit 64; }
if [ -n "$n$cap" ]; then
  { [[ $n =~ ^[0-9]+$ ]] && [[ $cap =~ ^[0-9]+$ ]]; } || { echo "$usage" >&2; exit 64; }
fi
src=${pos[0]}; id=${pos[1]}
[ -f "$src" ] || { echo "resume-args: $src is not a file (PR $id)" >&2; exit 65; }

item=$(jq -ce --arg id "$id" '
  def idpart: {id: .id} + (if has("prNumber") then {prNumber} else {} end);
  def resume($p): {}
    + (if $p | has("history") then {history: $p.history} else {} end)
    + (if $p | has("lateMinors") then {minors: $p.lateMinors} else {} end)
    + (if $p | has("lastFindings") then {findings: $p.lastFindings} else {} end)
    + (if ($p | has("evals")) or (($p.evalsMeta | type) == "object")
       then {evals: ((if $p | has("evals") then {evals: $p.evals} else {} end) + (($p.evalsMeta | objects) // {}))} else {} end)
    + (if $p | has("designRules") then {designRules: $p.designRules} else {} end)
    + (if $p | has("evalDisputes") then {evalDisputes: $p.evalDisputes} else {} end)
    + (if $p | has("deviations") then {deviations: $p.deviations} else {} end);
  if type != "object" then error("not a result")
  elif ((.result.prs // .prs) | type) == "array" then
    ([(.result.prs // .prs)[] | objects | select((.id | tostring) == $id)] | first) as $p
    | if $p == null then "missing" else ($p | idpart) + {resume: resume($p)} end
  elif has("pr") and has("evals") and has("evalsMeta") then
    if (.pr | tostring) == $id then {id: .pr, resume: resume({evals, evalsMeta})} else "missing" end
  else error("not a result") end
' "$src" 2>&1) || { echo "resume-args: $src is not JSON or is neither a workflow output nor a recover-evals output" >&2; exit 65; }
if [ "$item" = '"missing"' ]; then echo "resume-args: PR $id is not in $src" >&2; exit 1; fi

if [ -n "$n" ]; then
  rounds=$(jq -r '[.resume.history // [] | .[] | objects | select(.round != "stop")] | length' <<<"$item")
  if [ $((rounds + n)) -gt "$cap" ]; then
    echo "WARN: the history has $rounds rounds and this run adds up to $n, more than the cap of $cap" >&2
  fi
fi
echo "$item"
