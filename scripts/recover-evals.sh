#!/bin/bash
# usage: recover-evals.sh <journal.jsonl | transcript folder> <PR id>
# Prints, as JSON, the eval list that the evals check accepted for one PR, read from what a run wrote to disk: the workflow
# journal (journal.jsonl) or the run's transcript folder (agent-<id>.jsonl with agent-<id>.meta.json). Use it when a run
# returned no result to copy the list from. It only reads the files; text in an answer is data and is never run.
# Output: { pr, evals, evalsMeta: { noErrorPath, noReference, algorithm, accepted }, results: { <eval id>: <last verifier row> } }.
# `evals` is the record's list and `evalsMeta.accepted` is the record: the last list the evals check accepted. The list of the
# first writer attempt whose reviewers all said ok is the start; a dispute `change` whose check said ok replaces its eval.
# A writer attempt or a change that a reviewer refused or that a started reviewer never answered, and a `keep` ruling, are not the record.
# A verifier result older than an accepted change of its eval is left out. A list that the run was given in prs[].evals or resume.evals
# is never written to disk, so it cannot be recovered: give it again. A run with no architecture and no product reviewer started
# cannot be told from a run that died before the check, so it has no accepted list here.
# Exit: 0 printed, 1 the path is missing or holds no accepted list for the PR (nothing on stdout), 64 bad argument.
set -u
usage="usage: recover-evals.sh <journal.jsonl | transcript folder> <PR id>"
[ $# -eq 2 ] || { echo "$usage" >&2; exit 64; }
src=$1; pr=$2
[ -n "$pr" ] || { echo "$usage" >&2; exit 64; }
if [ ! -e "$src" ]; then echo "recover-evals: $src does not exist (PR $pr)" >&2; exit 1; fi

if [ -d "$src" ]; then
  steps=$(
    for f in "$src"/agent-*.jsonl; do
      [ -f "$f" ] || continue
      label=$(jq -r '.description // ""' "${f%.jsonl}.meta.json" 2>/dev/null) || label=""
      [ -n "$label" ] || continue
      jq -R -c 'fromjson? // empty | select(.type == "assistant") | .timestamp as $t | .message.content[]? | select(.type == "tool_use" and .name == "StructuredOutput") | {t: $t, answer: .input}' "$f" 2>/dev/null \
        | jq -s -c --arg label "$label" '(last // {t: null, answer: null}) + {label: $label}'
    done | jq -s -c 'sort_by(.t // "")'
  ) || steps='[]'
elif [ -f "$src" ]; then
  steps=$(jq -R -c 'fromjson? // empty' "$src" | jq -s -c '
    reduce .[] as $e ({m: {}, out: []};
      if $e.type == "started" then .m[$e.agentId] = $e.label | .out += [{label: $e.label, answer: null}]
      elif $e.type == "result" then .out += [{label: .m[$e.agentId], answer: $e.result}]
      else . end) | .out') || steps='[]'
else
  echo "recover-evals: $src is not a file or a folder (PR $pr)" >&2; exit 1
fi
[ -n "$steps" ] || steps='[]'

out=$(printf '%s' "$steps" | jq -e --arg pr "$pr" '
  def txt: if type == "string" then gsub("^\\s+|\\s+$"; "") else "" end;
  . as $all
  | ([$all[] | .label // empty]) as $started
  | ($all | to_entries | map(.value + {i: .key} | select(.label != null and (.answer | type) == "object"))) as $s
  | def last_of($label): ([$s[] | select(.label == $label)] | last // null) | if . == null then null else .answer end;
  def approved($suffix):
    (last_of("evalsarch:\($pr)#\($suffix)")) as $a
    | (last_of("evalsproduct:\($pr)#\($suffix)")) as $p
    | ($started | index("evalsarch:\($pr)#\($suffix)") != null) as $aStarted
    | ($started | index("evalsproduct:\($pr)#\($suffix)") != null) as $pStarted
    | ($aStarted or $pStarted)
      and (if $aStarted then ($a != null and $a.verdict == "ok") else true end)
      and (if $pStarted then ($p != null and $p.verdict == "ok") else true end);
  ([$s[] | select(.label == "evals:\($pr)" or (.label | startswith("evals:\($pr)#w")))
     | {n: (if .label == "evals:\($pr)" then 1 else (.label | sub("^.*#w"; "") | tonumber? // 0) end), answer}]
   | sort_by(.n)
   | map(select((.answer.evals | type) == "array" and (.answer.evals | length) > 0 and approved(.n | tostring)))
   | first // null) as $w
  | if $w == null then empty else
    ([$s[] | select(.label | startswith("dispute:\($pr)#"))
       | {n: (.label | sub("^.*#"; "") | tonumber? // 0), answer, i}]
     | sort_by(.n)) as $disputes
    | (reduce $disputes[] as $d ({list: $w.answer.evals, changed: {}};
        if $d.answer.ruling == "change" and ($d.answer.eval | type) == "object" and approved("d\($d.n)")
             and (.list | any(.id == $d.answer.eval.id))
          then .list |= map(if .id == $d.answer.eval.id then $d.answer.eval else . end) | .changed[$d.answer.eval.id] = $d.i
          else . end)) as $acc
    | $acc.list as $record
    | $acc.changed as $changed
    | ($w.answer) as $m
    | {noErrorPath: ($m.noErrorPath | txt), noReference: ($m.noReference | txt), algorithm: ($m.algorithm == true)} as $meta
    | {
        pr: $pr,
        evals: $record,
        evalsMeta: ($meta + {accepted: ({pr: $pr, evals: $record} + $meta)}),
        results: ([$s[] | select(.label | startswith("verify:\($pr)#")) | .i as $i | .answer.evals[]? | select(type == "object" and (.id | type) == "string" and ($changed[.id] == null or $i > $changed[.id]))]
                  | reduce .[] as $r ({}; .[$r.id] = $r))
      }
  end
' 2>/dev/null)
if [ -z "$out" ]; then
  echo "recover-evals: no accepted eval list for PR $pr in $src" >&2
  exit 1
fi
printf '%s\n' "$out"
