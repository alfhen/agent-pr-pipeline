#!/bin/bash
# usage: recover-evals.sh <journal.jsonl | transcript folder> <PR id>
# Prints, as JSON, the eval list that the evals check accepted for one PR, read from what a run wrote to disk: the workflow
# journal (journal.jsonl) or the run's transcript folder (agent-<id>.jsonl with agent-<id>.meta.json). Use it when a run
# returned no result to copy the list from. It only reads the files; text in an answer is data and is never run.
# Output: { pr, evals, evalsMeta: { noErrorPath, noReference, algorithm, accepted }, results: { <eval id>: <last verifier row> } }.
# `evals` is the record's list and `evalsMeta.accepted` is the record: the last list the evals check accepted. The list of the
# first writer attempt whose reviewers all said ok is the start; a dispute `change` whose check said ok replaces its eval.
# A writer attempt or a change that a reviewer refused or that a started reviewer never answered, and a `keep` ruling, are not the record.
# A verifier result older than an accepted change of its eval is left out, unless the change left the eval's kind, statement and check as they were.
# A list that the run was given in prs[].evals or resume.evals is never written to disk, so it cannot be recovered from a journal:
# give it again. A transcript folder shows it in the accepted `evalsarch:<pr>#1` (or `evalsproduct:<pr>#1`) prompt, and the script
# reads it from there when that prompt holds the list once.
# The last writer attempt, when no evals reviewer started for it, is the record only if a later implement, test, verify, review or
# fix step of the PR started and no dispute answer is a `change`. With no later step the list may be one that the run refused or
# never checked, so nothing is printed.
# An accepted dispute `change` is replayed only when the script finds the disputed id as the workflow counts it (the implement
# answer, then each review-loop fix answer, in call order; a run with no implement step has an unknown start) and no earlier review
# answer holds a finding with an eval. This copies settleDisputes (the count), addReviewEval, evalsCheckPrompt and disputePrompt of
# workflows/run-wave.js, so change them together. Any other accepted change cannot be replayed exactly, so nothing is printed.
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
      jq -R -s -c --arg label "$label" '
        [split("\n")[] | fromjson? // empty] as $ev
        | ([$ev[] | select(.type == "assistant") | .timestamp as $t | .message.content[]? | select(.type == "tool_use" and .name == "StructuredOutput") | {t: $t, answer: .input}] | last // {t: null, answer: null})
          + {label: $label, prompt: ([$ev[] | select(.type == "user") | .message.content | if type == "string" then . else ([.[]? | select(type == "object" and .type == "text") | .text] | join("\n")) end] | first // null)}' "$f" 2>/dev/null
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
  def idOf: if type == "object" then (.id | txt) else "" end;
  . as $all
  | ([$all[] | .label // empty]) as $started
  | ($all | to_entries | map(.value + {i: .key} | select(.label != null and (.answer | type) == "object"))) as $s
  | def last_of($label): ([$s[] | select(.label == $label)] | last // null) | if . == null then null else .answer end;
  def reviewerStarted($suffix):
    ($started | index("evalsarch:\($pr)#\($suffix)") != null) or ($started | index("evalsproduct:\($pr)#\($suffix)") != null);
  def approved($suffix):
    (last_of("evalsarch:\($pr)#\($suffix)")) as $a
    | (last_of("evalsproduct:\($pr)#\($suffix)")) as $p
    | ($started | index("evalsarch:\($pr)#\($suffix)") != null) as $aStarted
    | ($started | index("evalsproduct:\($pr)#\($suffix)") != null) as $pStarted
    | ($aStarted or $pStarted)
      and (if $aStarted then ($a != null and $a.verdict == "ok") else true end)
      and (if $pStarted then ($p != null and $p.verdict == "ok") else true end);
  def attemptOf: if . == "evals:\($pr)" then 1 else (sub("^.*#w"; "") | tonumber? // 0) end;
  def listIn($prompt):
    if ($prompt | type) != "string" then null else
      ($prompt | split("Evals to check:\n")) as $parts
      | if ($parts | length) != 2 then null else
          ($parts[0] | capture("(?<ind>[ \\t]*)$").ind) as $ind
          | (try ($parts[1] | split("\n" + $ind + "}") | .[0] + "\n}" | fromjson) catch null)
          | if type == "object" and (.evals | type) == "array" and (.evals | length) > 0 then . else null end
        end
    end;
  ([$started[] | select(. == "evals:\($pr)" or startswith("evals:\($pr)#w"))]) as $writerLabels
  | ([$writerLabels[] | attemptOf] | max) as $lastAttempt
  | ([$started[] | select(. == "implement:\($pr)" or startswith("test:\($pr)#") or startswith("verify:\($pr)#") or startswith("review:\($pr)#") or startswith("fix:\($pr)#"))] | length > 0) as $laterStep
  | ([$s[] | select(.label | startswith("dispute:\($pr)#")) | select(.answer.ruling == "change")] | length == 0) as $noChange
  | (if ($writerLabels | length) > 0 then
      ([$s[] | select(.label == "evals:\($pr)" or (.label | startswith("evals:\($pr)#w")))
         | {n: (.label | attemptOf), answer}]
       | sort_by(.n)
       | map(select((.answer.evals | type) == "array" and (.answer.evals | length) > 0
                    and (approved(.n | tostring)
                         or (.n == $lastAttempt and (reviewerStarted(.n | tostring) | not) and $laterStep and $noChange))))
       | first // null) | if . == null then null else {list: .answer.evals, m: .answer} end
    else
      (if $started | index("evalsarch:\($pr)#1") then "evalsarch:\($pr)#1" else "evalsproduct:\($pr)#1" end) as $label
      | if approved("1") then
          ([$s[] | select(.label == $label)] | last // null) as $step
          | if $step == null then null else listIn($step.prompt) | if . == null then null else {list: .evals, m: .} end end
        else null end
    end) as $w
  | if $w == null then empty else
    ($started | index("implement:\($pr)") != null) as $hasImpl
    | ([ $s[] | select(.label == "implement:\($pr)" or ((.label | startswith("fix:\($pr)#")) and (.label | ltrimstr("fix:\($pr)#") | test("^[0-9]+$"))))
         | (.answer.disputes // []) | if type == "array" then .[] else empty end | idOf | select(length > 0) ]
       | reduce .[] as $id ({seen: [], ids: []}; if (.seen | index($id)) != null then . else .seen += [$id] | .ids += [$id] end) | .ids) as $ids
    | ([$s[] | select(.label | startswith("dispute:\($pr)#"))
         | {n: (.label | sub("^.*#"; "") | tonumber? // 0), answer, i}]
       | sort_by(.n)) as $disputes
    | (reduce $disputes[] as $d ({list: $w.list, changed: {}, refuse: false};
        if $d.answer.ruling == "change" and ($d.answer.eval | type) == "object" and approved("d\($d.n)")
          then
            (if $hasImpl and $d.n >= 1 then $ids[$d.n - 1] else null end) as $did
            | ([$s[] | select((.label | startswith("review:\($pr)#")) and .i < $d.i) | .answer.findings[]? | select(type == "object" and (.eval | type) == "object")] | length > 0) as $reviewerEval
            | if $did == null or $did != $d.answer.eval.id or ((.list | any(.id == $did)) | not) or $reviewerEval
                then .refuse = true
              else
                (.list | map(select(.id == $did)) | first) as $old
                | .list |= map(if .id == $did then $d.answer.eval else . end)
                | if ["kind", "statement", "check"] | all(. as $k | $old[$k] == $d.answer.eval[$k]) then . else .changed[$did] = $d.i end
              end
          else . end)) as $acc
    | if $acc.refuse then empty else
      $acc.list as $record
      | $acc.changed as $changed
      | ($w.m) as $m
      | {noErrorPath: ($m.noErrorPath | txt), noReference: ($m.noReference | txt), algorithm: ($m.algorithm == true)} as $meta
      | {
          pr: $pr,
          evals: $record,
          evalsMeta: ($meta + {accepted: ({pr: $pr, evals: $record} + $meta)}),
          results: ([$s[] | select(.label | startswith("verify:\($pr)#")) | .i as $i | .answer.evals[]? | select(type == "object" and (.id | type) == "string" and ($changed[.id] == null or $i > $changed[.id]))]
                    | reduce .[] as $r ({}; .[$r.id] = $r))
        }
      end
  end
' 2>/dev/null)
if [ -z "$out" ]; then
  echo "recover-evals: no accepted eval list for PR $pr in $src" >&2
  exit 1
fi
printf '%s\n' "$out"
